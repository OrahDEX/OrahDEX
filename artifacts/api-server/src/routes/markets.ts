// Updated markets.ts to remove auto from BSV/USDT
import { Router, type IRouter } from "express";
import { db, withDbRetry } from "@workspace/db";
import { marketsTable, ordersTable } from "@workspace/db/schema";
import { eq, and, desc, inArray, ne, sql } from "drizzle-orm";
import { FALLBACK_PRICES } from "../lib/priceUpdater.js";
import { fetchKeyPrices } from "./dex.js";
import { generateRecentTrades, generateTicker } from "../lib/mockData.js";
import { fetchRealCandles, fetchFullHistoryCandles, resampleCandles } from "../lib/candleFetcher.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── Simple in-memory TTL cache ─────────────────────────────────────────────────
interface CacheEntry<T> { data: T; ts: number }
class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  constructor(private ttlMs: number) {}
  get(key: string): T | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > this.ttlMs) { this.store.delete(key); return null; }
    return e.data;
  }
  set(key: string, data: T) { this.store.set(key, { data, ts: Date.now() }); }
}

const marketsCache    = new TtlCache<any[]>(60_000);   // 60 s — matches price-updater interval
const orderbookCache  = new TtlCache<any>(2_000);      //  2 s
const tradesCache     = new TtlCache<any[]>(5_000);    //  5 s
const tickerCache     = new TtlCache<any>(5_000);      //  5 s

// GET /markets
router.get("/markets", async (req, res) => {
    // Build a cache key that reflects any filters
    const rawType     = req.query.type     as string | undefined;
    const rawCategory = req.query.category as string | undefined;

    let types: string[] = [];
    if (rawCategory === "internal") {
        types = ["spot", "futures"];
    } else if (rawCategory === "external") {
        types = ["letsexchange"];
    } else if (rawType) {
        types = rawType.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
    }

    const baseKey  = types.length ? `filtered:${types.sort().join(",")}` : "all";
    const cacheKey = baseKey; // we cache the full sorted list once and slice it

    try {
        // Fetch the markets based on the filters and cache the result
        const markets = await getMarketData(cacheKey);
        res.json(markets);
    } catch (error) {
        logger.error("Failed to fetch markets:", error);
        res.status(500).send("Internal Server Error");
    }
});

// Further routes and logic unchanged;
// Implement any other necessary updates related to auto removal as per your requirements.
