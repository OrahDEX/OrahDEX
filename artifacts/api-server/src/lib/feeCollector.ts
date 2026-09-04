/**
 * feeCollector.ts — Exchange platform revenue tracking.
 *
 * Every revenue-generating route calls recordPlatformFee() to log the
 * fee to keeper_earnings under wallet "EXCHANGE_TREASURY" with the
 * source identifying which product generated it.
 *
 * Sources:
 *  "swap"         — AMM swap (0.3%)
 *  "orderbook"    — spot maker/taker fee (0.1%)
 *  "copy_trade"   — platform cut of performance fee
 *  "lp_spread"    — exchange LP spread / liquidity provision
 *  "p2p"          — P2P intent fill fee (0.05%)
 *  "withdrawal"   — flat withdrawal fee
 */

import { db } from "@workspace/db";
import { keeperEarningsTable } from "@workspace/db/schema";
import { logger } from "./logger.js";

export const EXCHANGE_TREASURY = "EXCHANGE_TREASURY";

export type FeeSource =
  | "swap"
  | "buy"
  | "orderbook"
  | "copy_trade"
  | "lp_spread"
  | "p2p"
  | "withdrawal"
  | "bridge"
  | "le_autoroute";

/**
 * Record a platform fee. Non-throwing — logs errors silently so that
 * the calling route is never interrupted by a bookkeeping failure.
 */
export async function recordPlatformFee(params: {
  source:  FeeSource;
  amount:  number | string;
  asset:   string;
  txRef?:  string;
}): Promise<void> {
  const { source, amount, asset, txRef = "" } = params;
  const amt = parseFloat(String(amount));
  if (!Number.isFinite(amt) || amt <= 0) return;
  try {
    await db.insert(keeperEarningsTable).values({
      walletAddress: EXCHANGE_TREASURY,
      asset:         asset.toUpperCase(),
      source,
      amount:        amt.toFixed(18),
      txRef,
    });
  } catch (err: any) {
    logger.warn({ err: err?.message, source, amount, asset }, "feeCollector: insert failed");
  }
}
