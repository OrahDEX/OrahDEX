import { pool, type PoolClient } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { randomUUID } from "node:crypto";
import { isDbConnError } from "./dbErrors.js";
import { guardedInterval, withRetry } from "./selfHealing.js";

async function runTrailingStopEngine(): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await withRetry(() => pool.connect(), { maxAttempts: 2, baseDelayMs: 500 });
  } catch (err) {
    logger.warn({ err }, "Trailing stop engine: DB connect failed, skipping cycle");
    return;
  }
  try {
    const { rows: activeStops } = await client.query<{
      id: string;
      wallet_address: string;
      symbol: string;
      side: string;
      quantity: string;
      trail_percent: string;
      activation_price: string | null;
      current_stop_price: string;
      high_watermark: string;
      low_watermark: string;
      status: string;
      network_type: string | null;
      chain_id: number | null;
    }>(
      `SELECT * FROM trailing_stop_orders WHERE status IN ('active', 'pending')`
    );

    for (const stop of activeStops) {
      try {
        const { rows: marketRows } = await client.query<{ mark_price: string }>(
          `SELECT mark_price FROM markets WHERE symbol = $1 LIMIT 1`,
          [stop.symbol]
        );
        if (!marketRows[0]?.mark_price) continue;

        const currentPrice = parseFloat(marketRows[0].mark_price);
        const trailPercent = parseFloat(stop.trail_percent);
        const highWatermark = parseFloat(stop.high_watermark);
        const lowWatermark = parseFloat(stop.low_watermark);
        const currentStopPrice = parseFloat(stop.current_stop_price);

        if (stop.status === "pending" && stop.activation_price !== null) {
          const activationPrice = parseFloat(stop.activation_price);
          const activated =
            stop.side === "sell" ? currentPrice >= activationPrice : currentPrice <= activationPrice;
          if (!activated) continue;

          await client.query(
            `UPDATE trailing_stop_orders SET status = 'active', updated_at = NOW() WHERE id = $1`,
            [stop.id]
          );
          stop.status = "active";
        }

        let newHigh = highWatermark;
        let newLow = lowWatermark;
        let newStopPrice = currentStopPrice;

        if (stop.side === "sell") {
          if (currentPrice > newHigh) {
            newHigh = currentPrice;
            newStopPrice = newHigh * (1 - trailPercent / 100);
          }
          if (currentPrice <= newStopPrice) {
            const orderId = randomUUID();
            // Wrap INSERT + UPDATE atomically so a crash between the two can't
            // spawn duplicate market orders from a single trailing stop trigger.
            await client.query("BEGIN");
            try {
              await client.query(
                `INSERT INTO orders (id, symbol, wallet_address, network_type, side, type, status, quantity, filled_quantity, remaining_quantity, fee, is_bot, is_synthetic, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'market', 'open', $6, '0', $6, '0', false, false, NOW(), NOW())`,
                [orderId, stop.symbol, stop.wallet_address, stop.network_type ?? "evm", "sell", stop.quantity]
              );
              await client.query(
                `UPDATE trailing_stop_orders SET status = 'triggered', triggered_order_id = $1, updated_at = NOW() WHERE id = $2`,
                [orderId, stop.id]
              );
              await client.query("COMMIT");
            } catch (triggerErr) {
              await client.query("ROLLBACK").catch(() => {});
              logger.error({ err: triggerErr, stopId: stop.id }, "Trailing stop sell-trigger transaction failed");
              continue;
            }
            logger.info({ stopId: stop.id, orderId, symbol: stop.symbol }, "Trailing stop triggered (sell)");
            continue;
          }
        } else {
          if (currentPrice < newLow) {
            newLow = currentPrice;
            newStopPrice = newLow * (1 + trailPercent / 100);
          }
          if (currentPrice >= newStopPrice) {
            const orderId = randomUUID();
            // Atomic: INSERT order + UPDATE stop status in one transaction
            await client.query("BEGIN");
            try {
              await client.query(
                `INSERT INTO orders (id, symbol, wallet_address, network_type, side, type, status, quantity, filled_quantity, remaining_quantity, fee, is_bot, is_synthetic, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'market', 'open', $6, '0', $6, '0', false, false, NOW(), NOW())`,
                [orderId, stop.symbol, stop.wallet_address, stop.network_type ?? "evm", "buy", stop.quantity]
              );
              await client.query(
                `UPDATE trailing_stop_orders SET status = 'triggered', triggered_order_id = $1, updated_at = NOW() WHERE id = $2`,
                [orderId, stop.id]
              );
              await client.query("COMMIT");
            } catch (triggerErr) {
              await client.query("ROLLBACK").catch(() => {});
              logger.error({ err: triggerErr, stopId: stop.id }, "Trailing stop buy-trigger transaction failed");
              continue;
            }
            logger.info({ stopId: stop.id, orderId, symbol: stop.symbol }, "Trailing stop triggered (buy)");
            continue;
          }
        }

        await client.query(
          `UPDATE trailing_stop_orders
           SET high_watermark = $1, low_watermark = $2, current_stop_price = $3, updated_at = NOW()
           WHERE id = $4`,
          [newHigh.toString(), newLow.toString(), newStopPrice.toString(), stop.id]
        );
      } catch (err) {
        if (isDbConnError(err)) logger.warn({ stopId: stop.id }, "Trailing stop: DB unavailable, skipping order");
        else logger.error({ err, stopId: stop.id }, "Error processing trailing stop");
      }
    }
  } catch (err) {
    if (isDbConnError(err)) logger.warn({ err }, "runTrailingStopEngine: DB error, skipping cycle");
    else logger.error({ err }, "runTrailingStopEngine error");
  } finally {
    client!.release();
  }
}

async function runIcebergEngine(): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await withRetry(() => pool.connect(), { maxAttempts: 2, baseDelayMs: 500 });
  } catch (err) {
    logger.warn({ err }, "Iceberg engine: DB connect failed, skipping cycle");
    return;
  }
  try {
    const { rows: icebergs } = await client.query<{
      id: string;
      wallet_address: string;
      symbol: string;
      side: string;
      price: string;
      total_quantity: string;
      filled_quantity: string;
      visible_quantity: string;
      active_order_id: string | null;
      status: string;
      network_type: string | null;
      chain_id: number | null;
    }>(
      `SELECT * FROM iceberg_orders WHERE status = 'active'`
    );

    for (const iceberg of icebergs) {
      try {
        const totalQty = parseFloat(iceberg.total_quantity);
        let filledQty = parseFloat(iceberg.filled_quantity);
        const visibleQty = parseFloat(iceberg.visible_quantity);

        if (filledQty >= totalQty) {
          await client.query(
            `UPDATE iceberg_orders SET status = 'completed' WHERE id = $1`,
            [iceberg.id]
          );
          continue;
        }

        if (iceberg.active_order_id !== null) {
          const { rows: orderRows } = await client.query<{ status: string; filled_quantity: string }>(
            `SELECT status, filled_quantity FROM orders WHERE id = $1`,
            [iceberg.active_order_id]
          );
          const activeOrder = orderRows[0];
          if (!activeOrder) {
            await client.query(
              `UPDATE iceberg_orders SET active_order_id = NULL WHERE id = $1`,
              [iceberg.id]
            );
          } else if (activeOrder.status !== "filled") {
            continue;
          } else {
            filledQty += parseFloat(activeOrder.filled_quantity);
            await client.query(
              `UPDATE iceberg_orders SET filled_quantity = $1, active_order_id = NULL WHERE id = $2`,
              [filledQty.toString(), iceberg.id]
            );
            if (filledQty >= totalQty) {
              await client.query(
                `UPDATE iceberg_orders SET status = 'completed' WHERE id = $1`,
                [iceberg.id]
              );
              continue;
            }
          }
        }

        const remaining = totalQty - filledQty;
        const sliceQty = Math.min(visibleQty, remaining);
        const orderId = randomUUID();

        await client.query(
          `INSERT INTO orders (id, symbol, wallet_address, network_type, side, type, status, price, quantity, filled_quantity, remaining_quantity, fee, is_bot, is_synthetic, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'limit', 'open', $6, $7, '0', $7, '0', false, false, NOW(), NOW())`,
          [
            orderId,
            iceberg.symbol,
            iceberg.wallet_address,
            iceberg.network_type ?? "evm",
            iceberg.side,
            iceberg.price,
            sliceQty.toString(),
          ]
        );

        await client.query(
          `UPDATE iceberg_orders SET active_order_id = $1 WHERE id = $2`,
          [orderId, iceberg.id]
        );

        logger.info({ icebergId: iceberg.id, orderId, sliceQty }, "Iceberg slice placed");
      } catch (err) {
        if (isDbConnError(err)) logger.warn({ icebergId: iceberg.id }, "Iceberg: DB unavailable, skipping order");
        else logger.error({ err, icebergId: iceberg.id }, "Error processing iceberg order");
      }
    }
  } catch (err) {
    if (isDbConnError(err)) logger.warn({ err }, "runIcebergEngine: DB error, skipping cycle");
    else logger.error({ err }, "runIcebergEngine error");
  } finally {
    client!.release();
  }
}

async function runTwapEngine(): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await withRetry(() => pool.connect(), { maxAttempts: 2, baseDelayMs: 500 });
  } catch (err) {
    logger.warn({ err }, "TWAP engine: DB connect failed, skipping cycle");
    return;
  }
  try {
    const { rows: twaps } = await client.query<{
      id: string;
      wallet_address: string;
      symbol: string;
      side: string;
      total_quantity: string;
      filled_quantity: string;
      slices: number;
      completed_slices: number;
      interval_seconds: number;
      start_at: Date;
      end_at: Date;
      max_slippage_percent: string;
      average_fill_price: string | null;
      status: string;
      network_type: string | null;
      chain_id: number | null;
    }>(
      `SELECT * FROM twap_orders WHERE status = 'active' AND start_at <= NOW() AND end_at > NOW()`
    );

    for (const twap of twaps) {
      try {
        const startAt = twap.start_at.getTime();
        const elapsedSeconds = (Date.now() - startAt) / 1000;
        const expectedSlices = Math.floor(elapsedSeconds / twap.interval_seconds);
        const slicesToExecute = Math.min(expectedSlices, twap.slices) - twap.completed_slices;

        if (slicesToExecute <= 0) continue;

        const sliceQty = parseFloat(twap.total_quantity) / twap.slices;

        for (let i = 0; i < slicesToExecute; i++) {
          if (twap.completed_slices + i >= twap.slices) break;

          const orderId = randomUUID();
          await client.query(
            `INSERT INTO orders (id, symbol, wallet_address, network_type, side, type, status, quantity, filled_quantity, remaining_quantity, fee, is_bot, is_synthetic, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'market', 'open', $6, '0', $6, '0', false, false, NOW(), NOW())`,
            [
              orderId,
              twap.symbol,
              twap.wallet_address,
              twap.network_type ?? "evm",
              twap.side,
              sliceQty.toString(),
            ]
          );

          logger.info({ twapId: twap.id, orderId, sliceQty, slice: twap.completed_slices + i + 1 }, "TWAP slice placed");
        }

        const newCompletedSlices = Math.min(twap.completed_slices + slicesToExecute, twap.slices);
        const newFilledQty = (parseFloat(twap.filled_quantity) + sliceQty * slicesToExecute).toString();

        const { rows: marketRows } = await client.query<{ mark_price: string }>(
          `SELECT mark_price FROM markets WHERE symbol = $1 LIMIT 1`,
          [twap.symbol]
        );
        const markPrice = marketRows[0]?.mark_price ?? null;

        let newAvgFillPrice: string | null = twap.average_fill_price;
        if (markPrice !== null) {
          const prevAvg = twap.average_fill_price !== null ? parseFloat(twap.average_fill_price) : parseFloat(markPrice);
          const totalSlicesFilled = newCompletedSlices;
          const prevWeight = twap.completed_slices / (totalSlicesFilled || 1);
          const newWeight = slicesToExecute / (totalSlicesFilled || 1);
          newAvgFillPrice = (prevAvg * prevWeight + parseFloat(markPrice) * newWeight).toString();
        }

        const isComplete = newCompletedSlices >= twap.slices;

        await client.query(
          `UPDATE twap_orders
           SET completed_slices = $1, filled_quantity = $2, average_fill_price = $3, status = $4
           WHERE id = $5`,
          [
            newCompletedSlices,
            newFilledQty,
            newAvgFillPrice,
            isComplete ? "completed" : "active",
            twap.id,
          ]
        );

        if (isComplete) {
          logger.info({ twapId: twap.id }, "TWAP order completed");
        }
      } catch (err) {
        if (isDbConnError(err)) logger.warn({ twapId: twap.id }, "TWAP: DB unavailable, skipping order");
        else logger.error({ err, twapId: twap.id }, "Error processing TWAP order");
      }
    }

    const { rows: expired } = await client.query<{ id: string }>(
      `SELECT id FROM twap_orders WHERE status = 'active' AND end_at <= NOW()`
    );
    for (const row of expired) {
      await client.query(
        `UPDATE twap_orders SET status = 'completed' WHERE id = $1`,
        [row.id]
      );
    }
  } catch (err) {
    if (isDbConnError(err)) logger.warn({ err }, "runTwapEngine: DB error, skipping cycle");
    else logger.error({ err }, "runTwapEngine error");
  } finally {
    client!.release();
  }
}

export function startAdvancedOrderEngines(): void {
  // guardedInterval replaces the raw setInterval + busy-flag pattern.
  // Engines are staggered 10 s apart so they never compete for pool connections.
  guardedInterval("trailing-stop-engine", runTrailingStopEngine, 30_000, {
    timeoutMs: 25_000,
    initialDelayMs: 0,
  });
  guardedInterval("iceberg-engine", runIcebergEngine, 30_000, {
    timeoutMs: 25_000,
    initialDelayMs: 10_000,
  });
  guardedInterval("twap-engine", runTwapEngine, 30_000, {
    timeoutMs: 25_000,
    initialDelayMs: 20_000,
  });

  logger.info("Advanced order engines started (trailing-stop / iceberg / TWAP — 30 s intervals, staggered)");
}
