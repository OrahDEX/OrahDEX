import { Router } from "express";
import { db } from "@workspace/db";
import { marketsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { fetchRealCandles } from "../lib/candleFetcher.js";
import { FALLBACK_PRICES } from "../lib/priceUpdater.js";

const router = Router();

const STABLE_QUOTES = new Set(["USDT", "USDC", "USD", "BUSD", "TUSD", "USDD", "DAI", "FDUSD"]);

/** Normalize a URL path symbol (e.g. "BTC-USDT", "btc_usdt") to "BTC/USDT". */
function normSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[-_]/g, "/");
}

/**
 * Resolve a USD-denominated price for a pair.
 * Prefers the live DB lastPrice; falls back to a cross-rate derived from
 * FALLBACK_PRICES when the DB row is missing, stale, or zero.
 */
function resolveCrossPrice(symbol: string, lastPrice: number): number {
  if (Number.isFinite(lastPrice) && lastPrice > 0) return lastPrice;
  const [base, quote] = symbol.split("/");
  if (!base || !quote) return 0;
  const baseUsd  = FALLBACK_PRICES[base] ?? 0;
  const quoteUsd = STABLE_QUOTES.has(quote) ? 1 : (FALLBACK_PRICES[quote] ?? 0);
  if (baseUsd > 0 && quoteUsd > 0) return baseUsd / quoteUsd;
  return 0;
}

router.get("/markets/:symbol/candles", async (req, res) => {
  try {
    const symbol   = normSymbol(req.params.symbol);
    const interval = (req.query.interval as string) || "1h";
    const limit    = Math.min(parseInt(req.query.limit as string) || 200, 1500);

    // Wrap DB lookup so a transient DB failure falls through to FALLBACK_PRICES
    let market: (typeof marketsTable.$inferSelect) | undefined;
    try {
      [market] = await db.select().from(marketsTable).where(eq(marketsTable.symbol, symbol));
    } catch (dbErr) {
      logger.warn({ err: dbErr, symbol }, "markets: DB lookup failed, using FALLBACK_PRICES");
      market = undefined;
    }

    let price: number;
    let sym: string;
    if (!market) {
      // Unknown pair or DB unavailable — derive from fallback prices
      price = resolveCrossPrice(symbol, 0);
      sym   = symbol;
    } else {
      // Prefer live DB price; fall back to cross-rate computation if DB is stale/zero
      price = resolveCrossPrice(market.symbol, parseFloat(market.lastPrice));
      sym   = market.symbol;
    }

    if (!price || price <= 0) {
      logger.warn({ symbol, interval }, "No price available for candles");
      res.json([]);
      return;
    }

    try {
      const candles = await fetchRealCandles(sym, price, interval, limit);
      if (candles && candles.length > 0) {
        res.json(candles);
        return;
      }
    } catch (fetchErr) {
      logger.warn({ err: fetchErr, symbol, interval }, "fetchRealCandles failed, returning empty");
    }

    // Fallback: return empty array if fetch completely failed
    // (Frontend will use prior data via fallback mechanism)
    res.json([]);
  } catch (err) {
    req.log.error({ err }, "Failed to get candles");
    res.status(500).json({ error: "Internal server error" });
  }
});
export default router;
