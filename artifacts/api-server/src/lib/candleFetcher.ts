/**
 * candleFetcher.ts — Sovereign candle engine
 *
 * Priority order:
 *   1. Own trades table  →  aggregate into OHLCV candles (most authoritative)
 *   2. OKX public candles API (no key, not geo-blocked — primary real-data source)
 *   3. Binance public klines API (no key required) — geo-blocked from some regions
 *   4. Gate.io public candles API (no key required) — broad pair coverage
 *   5. Poloniex — for BSV (listed as BCHSV) and other renamed coins
 *   6. Synthetic fallback — generated from lastPrice when no external data available
 */

import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db/schema";
import { gte, and, eq } from "drizzle-orm";
import { logger } from "./logger.js";

/* ── Asset inception timestamps (Unix seconds) ─────────────────────────────
   Synthetic candle series will not extend before the asset existed.         */
const ASSET_INCEPTION: Record<string, number> = {
  "BTC":  1231006505, "LTC":  1317513600, "XRP":  1356998400,
  "DOGE": 1388534400, "ETH":  1438300800, "ETC":  1469404800,
  "ZEC":  1477929600, "BNB":  1503014400, "BCH":  1501545600,
  "ADA":  1506643200, "XLM":  1404172800, "TRX":  1504224000,
  "VET":  1533081600, "BSV":  1542240000, "LINK": 1503619200,
  "ATOM": 1552953600, "MATIC":1557273600, "SOL":  1568502000,
  "DOT":  1594684800, "AVAX": 1597622400, "UNI":  1600473600,
  "AAVE": 1601856000, "SHIB": 1619222400, "MANA": 1511136000,
  "SAND": 1575504000, "APE":  1645574400, "ARB":  1678924800,
  "OP":   1655251200, "SUI":  1683072000, "PEPE": 1681948800,
  "WIF":  1702944000, "BONK": 1672531200,
};
const CRYPTO_FLOOR_TS = 1483228800; // Jan 1 2017 — safe floor for unknown assets

function getInceptionTs(symbol: string): number {
  const base = symbol.split(/[-_/]/)[0]?.toUpperCase() ?? "";
  return ASSET_INCEPTION[base] ?? CRYPTO_FLOOR_TS;
}

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200,
  "1d": 86400, "3d": 259200, "1w": 604800, "1M": 2592000,
};

/* ── OKX interval map ─────────────────────────────────────────────────────── */
const OKX_INTERVAL_MAP: Record<string, string> = {
  "1m":  "1m",  "3m":  "3m",  "5m":  "5m",
  "15m": "15m", "30m": "30m",
  "1h":  "1H",  "2h":  "2H",  "4h":  "4H",
  "6h":  "6H",  "12h": "12H",
  "1d":  "1D",  "3d":  "3D",  "1w":  "1W",  "1M":  "1M",
};

/* ── Binance interval map ─────────────────────────────────────────────────── */
const BINANCE_INTERVAL_MAP: Record<string, string> = {
  "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m",
  "1h":"1h","2h":"2h","4h":"4h","6h":"6h","12h":"12h",
  "1d":"1d","3d":"3d","1w":"1w","1M":"1M",
};

/* ── Binance USDT pair list — try Binance for these, fall to OKX if blocked ─ */
const BINANCE_USDT_PAIRS = new Set([
  "BTC","ETH","SOL","XRP","BNB","ADA","DOGE","DOT","AVAX","MATIC",
  "LINK","UNI","ATOM","LTC","BCH","TRX","ETC","NEAR","ICP","VET",
  "FIL","SAND","MANA","APT","ARB","OP","SUI","INJ","PEPE","SHIB",
  "MKR","AAVE","CRV","ENS","LDO","SUSHI","COMP","GRT","SNX","YFI",
  "RUNE","FTM","ALGO","XLM","HBAR","THETA","ZEC","DASH","CRO",
  "BONK","WIF","JUP","PYTH","JTO","ORCA","RAY","W",
  "FET","RNDR","TAO","WLD","GLM","STORJ","LPT",
  "APE","AXS","ENJ","GALA","RON","CAKE","GMX","DYDX","PENDLE",
  "TON","KAS","SEI","TIA","KAVA","NEO","ZIL","WAVES","ICX",
  "OSMO","LUNA","LUNC","BAND","ONDO","OKB","KCS","ORDI",
  "KSM","TRUMP","STX","FLOKI","TURBO","EIGEN","ZRO","MNT",
  "STRK","IMX","METIS","AERO","BEAM","PRIME","PIXEL",
]);

/* ── Tokens not listed on OKX — skip straight to Binance/Gate.io ───────────
   OKX returns "Instrument ID doesn't exist" for these, generating noisy warn
   logs and an unnecessary extra RTT on every candle request.               ── */
const OKX_SKIP_PAIRS = new Set(["BSV", "BB", "BGB"]);

/* ── Poloniex symbol overrides (BSV → BCHSV etc.) ─────────────────────────── */
const POLONIEX_SYMBOL_MAP: Record<string, string> = {
  "BSV": "BCHSV",
};

const POLONIEX_INTERVAL_MAP: Record<string, string> = {
  "1m":"MINUTE_1","3m":"MINUTE_5","5m":"MINUTE_5","15m":"MINUTE_15",
  "30m":"MINUTE_30","1h":"HOUR_1","2h":"HOUR_2","4h":"HOUR_4",
  "6h":"HOUR_6","12h":"HOUR_12","1d":"DAY_1","3d":"DAY_3",
  "1w":"WEEK_1","1M":"MONTH_1",
};

/* ── Gate.io interval map ─────────────────────────────────────────────────── */
const GATE_INTERVAL_MAP: Record<string, string> = {
  "1m":"1m","3m":"5m","5m":"5m","15m":"15m","30m":"30m",
  "1h":"1h","2h":"4h","4h":"4h","6h":"8h","12h":"1d",
  "1d":"1d","3d":"1d","1w":"7d","1M":"30d",
};

interface Candle {
  time:   number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

/* ── In-memory candle cache — 1 min TTL ─────────────────────────────────────── */
interface CacheEntry { data: Candle[]; ts: number }
const candleCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000;

function getCached(key: string): Candle[] | null {
  const e = candleCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { candleCache.delete(key); return null; }
  return e.data;
}
function setCached(key: string, data: Candle[]) {
  if (candleCache.size >= 200) {
    const oldest = [...candleCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) candleCache.delete(oldest[0]);
  }
  candleCache.set(key, { data, ts: Date.now() });
}

/* ── 1. Own trades → OHLCV candles ──────────────────────────────────────────── */
async function buildCandlesFromOwnTrades(
  symbol: string,
  intervalSec: number,
  limit: number,
): Promise<Candle[]> {
  const lookback = intervalSec * limit;
  const since    = new Date(Date.now() - lookback * 1000);

  const rows = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.symbol, symbol), gte(tradesTable.timestamp, since)));

  if (!rows.length) return [];

  const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  for (const row of rows) {
    const ts     = Math.floor(row.timestamp.getTime() / 1000);
    const bucket = Math.floor(ts / intervalSec) * intervalSec;
    const price  = parseFloat(row.price);
    const qty    = parseFloat(row.quantity);
    const e = buckets.get(bucket);
    if (!e) {
      buckets.set(bucket, { o: price, h: price, l: price, c: price, v: qty });
    } else {
      e.h = Math.max(e.h, price);
      e.l = Math.min(e.l, price);
      e.c = price;
      e.v += qty;
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-limit)
    .map(([t, b]) => ({ time: t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

/* ── 2. OKX public candles (primary real-data source — not geo-blocked) ─────── */
async function fetchOkxCandles(
  base:     string,
  interval: string,
  limit:    number,
): Promise<Candle[]> {
  const bar = OKX_INTERVAL_MAP[interval] || "1H";
  // OKX max 300 per call; for larger limits make up to 5 paginated calls
  const perPage = 300;
  const pages   = Math.min(5, Math.ceil(limit / perPage));
  const all: Candle[] = [];

  // OKX returns newest-first; to paginate backwards we pass `after` (older timestamp)
  let after = "";
  for (let p = 0; p < pages; p++) {
    const qs = `instId=${base}-USDT&bar=${bar}&limit=${Math.min(perPage, limit - all.length)}${after ? `&after=${after}` : ""}`;
    const res = await fetch(`https://www.okx.com/api/v5/market/candles?${qs}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`OKX candles HTTP ${res.status}`);
    const json = await res.json() as { code: string; msg: string; data: string[][] };
    if (json.code !== "0") throw new Error(`OKX: ${json.msg}`);
    if (!json.data?.length) break;

    const batch = json.data
      .filter(k => k.length >= 6 && Number(k[0]) > 0)
      .map(k => ({
        time:   Math.floor(Number(k[0]) / 1000),
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));

    all.push(...batch);
    if (all.length >= limit || batch.length < perPage) break;
    // next page: `after` = oldest ts in current batch (already newest-first)
    after = json.data[json.data.length - 1]![0];
  }

  // OKX returns newest first — reverse to chronological order and deduplicate
  return all
    .sort((a, b) => a.time - b.time)
    .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1]!.time)
    .slice(-limit);
}

/* ── 3. Binance public klines ─────────────────────────────────────────────────── */
async function fetchBinanceCandles(
  binanceSym: string,
  interval:   string,
  limit:      number,
): Promise<Candle[]> {
  const bInterval = BINANCE_INTERVAL_MAP[interval] || "1h";
  const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=${bInterval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
  const data = await res.json() as number[][];
  return data.map(k => ({
    time:   Math.floor(k[0] / 1000),
    open:   parseFloat(k[1] as unknown as string),
    high:   parseFloat(k[2] as unknown as string),
    low:    parseFloat(k[3] as unknown as string),
    close:  parseFloat(k[4] as unknown as string),
    volume: parseFloat(k[5] as unknown as string),
  }));
}

/* ── 4. Gate.io public candles ─────────────────────────────────────────────────── */
async function fetchGateCandles(
  base:     string,
  interval: string,
  limit:    number,
): Promise<Candle[]> {
  const gInterval = GATE_INTERVAL_MAP[interval] || "1h";
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${base}_USDT&interval=${gInterval}&limit=${Math.min(limit, 1000)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Gate.io candles HTTP ${res.status}`);
  const data = await res.json() as string[][];
  // Format: [ts_sec, quote_vol, close, high, low, open, base_vol, closed]
  return data
    .filter(k => k.length >= 6)
    .map(k => ({
      time:   Number(k[0]),
      open:   parseFloat(k[5]),
      high:   parseFloat(k[3]),
      low:    parseFloat(k[4]),
      close:  parseFloat(k[2]),
      volume: parseFloat(k[6]),
    }))
    .sort((a, b) => a.time - b.time);
}

/* ── 5. Poloniex public candles ─────────────────────────────────────────────────── */
async function fetchPoloniexCandles(
  poloniexSym: string,
  interval:    string,
  limit:       number,
): Promise<Candle[]> {
  const pInterval = POLONIEX_INTERVAL_MAP[interval] || "HOUR_1";
  const clampedLimit = Math.min(limit, 500);
  const url = `https://api.poloniex.com/markets/${poloniexSym}_USDT/candles?interval=${pInterval}&limit=${clampedLimit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Poloniex candles HTTP ${res.status}`);
  const data = await res.json() as string[][];
  // Format: [low, high, open, close, amount, qty, buyTakerAmt, buyTakerQty, tradeCount, ts_ms, ...]
  return data
    .filter(k => k.length >= 10 && Number(k[9]) > 0)
    .map(k => ({
      time:   Math.floor(Number(k[9]) / 1000),
      open:   parseFloat(k[2]),
      high:   parseFloat(k[1]),
      low:    parseFloat(k[0]),
      close:  parseFloat(k[3]),
      volume: parseFloat(k[5]),
    }))
    .sort((a, b) => a.time - b.time);
}

/* ── 6. Synthetic fallback — proper random walk ────────────────────────────────── */
function makeRng(seed: number) {
  let s = (seed | 0) >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function intervalVol(sec: number): number {
  const annualVol = 0.80;
  const secsPerYear = 365 * 24 * 3600;
  return annualVol * Math.sqrt(sec / secsPerYear);
}

function generateFallbackCandles(lastPrice: number, interval: string, limit: number, inceptionTs: number = CRYPTO_FLOOR_TS): Candle[] {
  const sec   = INTERVAL_SECONDS[interval] || 3600;
  const now   = Math.floor(Date.now() / 1000);
  const vol   = intervalVol(sec);

  const maxCandles  = Math.max(1, Math.floor((now - inceptionTs) / sec));
  const actualLimit = Math.min(limit, maxCandles);

  const timeBucket = Math.floor(now / 60);
  const rng = makeRng(timeBucket ^ (lastPrice * 1000 | 0));

  const logCloses = new Array<number>(actualLimit);
  logCloses[actualLimit - 1] = Math.log(Math.max(lastPrice, 1e-12));
  for (let i = actualLimit - 2; i >= 0; i--) {
    logCloses[i] = logCloses[i + 1] + (rng() * 2 - 1) * vol;
  }

  const candles: Candle[] = [];
  for (let i = 0; i < actualLimit; i++) {
    const close   = Math.exp(logCloses[i]);
    const open    = i === 0 ? close * Math.exp((rng() - 0.5) * vol * 0.5) : Math.exp(logCloses[i - 1]);
    const body    = Math.abs(close - open);
    const minWick = close * 0.0008;
    const high    = Math.max(open, close) + Math.max(body * (0.4 + rng() * 1.2), minWick);
    const low     = Math.min(open, close) - Math.max(body * (0.4 + rng() * 1.2), minWick);
    const volume  = Math.exp(Math.log(500 * (sec / 3600)) + (rng() - 0.5) * 1.2);
    candles.push({ time: now - sec * (actualLimit - i), open, high, low, close, volume });
  }
  return candles;
}

/* ── Bitfinex symbol map (our base → Bitfinex pair suffix, no t-prefix) ─────── */
const BITFINEX_SYM: Record<string, string> = {
  BTC:"BTCUSD", ETH:"ETHUSD", XRP:"XRPUSD", LTC:"LTCUSD",
  BCH:"BCHUSD", EOS:"EOSUSD", XLM:"XLMUSD", DASH:"DSHUSD",
  ZEC:"ZECUSD", XMR:"XMRUSD", DOGE:"DOGEUSD", NEO:"NEOUSD",
  LINK:"LINKUSD", ADA:"ADAUSD", DOT:"DOTUSD", SOL:"SOLUSD",
  ATOM:"ATOMUSD", AVAX:"AVAXUSD", MATIC:"MATICUSD", UNI:"UNIUSD",
  AAVE:"AAVEUSD", MKR:"MKRUSD", SNX:"SNXUSD", COMP:"COMPUSD",
  CRV:"CRVUSD", GRT:"GRTUSD", ENJ:"ENJUSD", SAND:"SANDUSD",
  MANA:"MANAUSD", THETA:"THETAUSD", FTM:"FTMUSD", NEAR:"NEARUSD",
  ALGO:"ALGOUSD", VET:"VETUSD", HBAR:"HBARUSD", AXS:"AXSUSD",
  GALA:"GALAUSD", APE:"APEUSD", IMX:"IMXUSD", OP:"OPUSD",
  ARB:"ARBUSD", APT:"APTUSD", SUI:"SUIUSD", TIA:"TIAUSD",
  INJ:"INJUSD", RUNE:"RUNEUSD", ZIL:"ZILUSD", FIL:"FILUSD",
  SUSHI:"SUSHIUSD", CHZ:"CHZUSD", FLOW:"FLOWUSD", KSM:"KSMUSD",
  OCEAN:"OCEANUSD", STORJ:"STORJUSD", XTZ:"XTZUSD", WAVES:"WAVESUSD",
  KAVA:"KAVAUSD", TON:"TONUSD", PENDLE:"PENDLEUSD",
};

/* ── Bitfinex public candles — free, up to 10 000 daily candles per call ─────── */
async function fetchBitfinexHistory(base: string): Promise<Candle[]> {
  const pair = BITFINEX_SYM[base];
  if (!pair) return [];
  const url = `https://api-pub.bitfinex.com/v2/candles/trade:1D:t${pair}/hist?limit=10000&sort=1`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(18_000),
  });
  if (!res.ok) throw new Error(`Bitfinex history HTTP ${res.status}`);
  const data = await res.json() as number[][];
  if (!Array.isArray(data) || data.length < 3) throw new Error("Bitfinex returned empty history");
  // Format: [MTS_ms, OPEN, CLOSE, HIGH, LOW, VOLUME]
  return data
    .filter(k => Array.isArray(k) && k.length >= 6 && k[0] > 0 && k[1] > 0)
    .map(k => ({
      time:   Math.floor(k[0] / 1000),
      open:   k[1],
      close:  k[2],
      high:   k[3],
      low:    k[4],
      volume: Math.abs(k[5] ?? 0), // volume can be negative on Bitfinex (sell side)
    }))
    .sort((a, b) => a.time - b.time);
}

/* ── 6-hour cache for full history (static data changes very slowly) ─────────── */
interface HistoryCacheEntry { data: Candle[]; ts: number }
const historyCache = new Map<string, HistoryCacheEntry>();
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * fetchFullHistoryCandles — returns A-to-Z OHLCV for a symbol:
 *   1. Bitfinex daily candles from 2013+ (up to 10 000 candles, free, no key)
 *   2. OKX daily candles paginated (up to 1500 = ~4 years) — for coins not on Bitfinex
 *   3. Gate.io daily (fallback for obscure pairs)
 *   4. Synthetic random walk anchored to lastPrice
 *
 * Results are cached for 6 hours — historical data barely changes.
 */
export async function fetchFullHistoryCandles(
  symbol:    string,
  lastPrice: number,
): Promise<Candle[]> {
  const cacheKey = `history:${symbol}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < HISTORY_TTL_MS) {
    return pinLastCandle([...cached.data], lastPrice);
  }

  const parts = symbol.split("/");
  const base  = parts[0]?.toUpperCase() ?? "";

  /* 1. Bitfinex — full daily history from inception (2013+ for major coins) */
  let merged: Candle[] = [];
  try {
    const bfx = await fetchBitfinexHistory(base);
    if (bfx.length >= 10) {
      merged = bfx;
      logger.info({ symbol, count: merged.length, first: merged[0]?.time }, "Bitfinex full history loaded");
    }
  } catch (err) {
    logger.warn({ err, symbol }, "Bitfinex history failed");
  }

  /* 2. OKX extended daily pagination — for coins not on Bitfinex or to supplement */
  if (merged.length < 10 && !OKX_SKIP_PAIRS.has(base)) {
    try {
      const okx = await fetchOkxCandles(base, "1d", 1500);
      if (okx.length >= 5) {
        if (merged.length >= 10) {
          // Stitch: Bitfinex historical + OKX recent (OKX is more precise for recent data)
          const cutoff = okx[0]!.time;
          const pre = merged.filter(c => c.time < cutoff);
          merged = [...pre, ...okx]
            .sort((a, b) => a.time - b.time)
            .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1]!.time);
        } else {
          merged = okx;
        }
        logger.info({ symbol, count: merged.length, source: "okx+bfx" }, "OKX extended history");
      }
    } catch (_) {}
  }

  /* 3. Gate.io — fallback for obscure pairs not on Bitfinex/OKX */
  if (merged.length < 5) {
    try {
      const gate = await fetchGateCandles(base, "1d", 1000);
      if (gate.length >= 5) merged = gate;
    } catch (_) {}
  }

  /* 4. Synthetic fallback */
  if (merged.length < 5) {
    const inception = getInceptionTs(symbol);
    merged = generateFallbackCandles(lastPrice, "1w", 2000, inception);
  }

  historyCache.set(cacheKey, { data: merged, ts: Date.now() });
  logger.info({ symbol, total: merged.length }, "Full history assembled");
  return pinLastCandle([...merged], lastPrice);
}

/* ── Resample daily candles into weekly or monthly OHLCV bars ────────────────── */
export function resampleCandles(candles: Candle[], targetInterval: '1w' | '1M'): Candle[] {
  if (!candles.length) return candles;

  const bucketKey = (ts: number): string => {
    const d = new Date(ts * 1000);
    if (targetInterval === '1M') {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    /* Weekly: Monday-aligned */
    const dow  = d.getUTCDay(); // 0=Sun
    const diff = dow === 0 ? -6 : 1 - dow;
    const mon  = new Date(d.getTime() + diff * 86_400_000);
    return `${mon.getUTCFullYear()}-${String(mon.getUTCMonth() + 1).padStart(2, '0')}-${String(mon.getUTCDate()).padStart(2, '0')}`;
  };

  const startTs = (ts: number): number => {
    const d = new Date(ts * 1000);
    if (targetInterval === '1M') {
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    }
    const dow  = d.getUTCDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    return Math.floor((d.getTime() + diff * 86_400_000) / 1000 / 86_400) * 86_400;
  };

  type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
  const buckets = new Map<string, Bar>();

  for (const c of candles) {
    const key = bucketKey(c.time);
    const b   = buckets.get(key);
    if (!b) {
      buckets.set(key, { time: startTs(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: (c as any).volume ?? 0 });
    } else {
      if (c.high > b.high) b.high = c.high;
      if (c.low  < b.low)  b.low  = c.low;
      b.close   = c.close;
      b.volume += (c as any).volume ?? 0;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time) as unknown as Candle[];
}

/* ── Pin the last candle's close to the live price (guarded) ─────────────────
   Only adjust when lastPrice is within 2% of the exchange bar close.
   Prevents bad DB/cross-rate prices (e.g. 62617 vs OKX ~64000) from creating
   a huge wick that collapses the chart on 1m/1h and other intervals.        */
function pinLastCandle(candles: Candle[], lastPrice: number): Candle[] {
  if (!candles.length || !(lastPrice > 0)) return candles;
  const last = candles[candles.length - 1]!;
  const ref = last.close > 0 ? last.close : last.open;
  if (!(ref > 0)) return candles;
  const ratio = lastPrice / ref;
  if (ratio < 0.98 || ratio > 1.02) return candles;
  candles[candles.length - 1] = {
    ...last,
    close: lastPrice,
    high:  Math.max(last.high, lastPrice),
    low:   Math.min(last.low,  lastPrice),
  };
  return candles;
}

/* ── Validate that a candle array looks like real price data ─────────────────── */
function isValidCandleSet(candles: Candle[], minCount: number): boolean {
  if (candles.length < minCount) return false;
  // Reject if all candles have the same close (flat line = bad data)
  const closes = candles.map(c => c.close);
  const unique  = new Set(closes.map(v => v.toFixed(6)));
  return unique.size > 1;
}

/* ── Main export ─────────────────────────────────────────────────────────────── */
export async function fetchRealCandles(
  symbol:    string,
  lastPrice: number,
  interval:  string,
  limit:     number,
): Promise<Candle[]> {
  const cacheKey = `${symbol}:${interval}:${limit}`;
  const cached   = getCached(cacheKey);
  if (cached) return pinLastCandle([...cached.slice(0, -1), { ...cached[cached.length - 1]! }], lastPrice);

  const parts     = symbol.split("/");
  const base      = parts[0]?.toUpperCase() ?? "";
  const quote     = parts[1]?.toUpperCase() ?? "";
  const isUsdtPair = quote === "USDT" && base.length > 0;
  const minRequired = Math.min(3, limit);

  // ── 1. Own trades (sovereign source of truth) ──────────────────────────────
  try {
    const intervalSec = INTERVAL_SECONDS[interval] || 3600;
    const ownCandles  = await buildCandlesFromOwnTrades(symbol, intervalSec, limit);
    if (isValidCandleSet(ownCandles, minRequired)) {
      setCached(cacheKey, ownCandles);
      return pinLastCandle(ownCandles, lastPrice);
    }
  } catch (err) {
    logger.warn({ err, symbol }, "Own-trades candle build failed");
  }

  // ── 2. OKX (primary real-data source — global, not geo-blocked) ────────────
  if (isUsdtPair && !OKX_SKIP_PAIRS.has(base)) {
    try {
      const candles = await fetchOkxCandles(base, interval, limit);
      if (isValidCandleSet(candles, minRequired)) {
        setCached(cacheKey, candles);
        logger.debug({ symbol, count: candles.length, source: "okx" }, "Candles from OKX");
        return pinLastCandle(candles, lastPrice);
      }
    } catch (err) {
      logger.warn({ err, symbol }, "OKX candle fetch failed — trying Binance");
    }
  }

  // ── 3. Binance (works from some regions; try as secondary) ─────────────────
  if (isUsdtPair && BINANCE_USDT_PAIRS.has(base)) {
    try {
      const candles = await fetchBinanceCandles(`${base}USDT`, interval, limit);
      if (isValidCandleSet(candles, minRequired)) {
        setCached(cacheKey, candles);
        logger.debug({ symbol, count: candles.length, source: "binance" }, "Candles from Binance");
        return pinLastCandle(candles, lastPrice);
      }
    } catch (err) {
      logger.warn({ err, symbol }, "Binance candle fetch failed — trying Gate.io");
    }
  }

  // ── 4. Gate.io (broad coverage, USDT pairs, not geo-blocked) ───────────────
  if (isUsdtPair) {
    try {
      const candles = await fetchGateCandles(base, interval, limit);
      if (isValidCandleSet(candles, minRequired)) {
        setCached(cacheKey, candles);
        logger.debug({ symbol, count: candles.length, source: "gateio" }, "Candles from Gate.io");
        return pinLastCandle(candles, lastPrice);
      }
    } catch (err) {
      logger.warn({ err, symbol }, "Gate.io candle fetch failed — trying Poloniex");
    }
  }

  // ── 5. Poloniex (for coins with different tickers, e.g. BSV → BCHSV) ────────
  if (isUsdtPair && POLONIEX_SYMBOL_MAP[base]) {
    try {
      const candles = await fetchPoloniexCandles(POLONIEX_SYMBOL_MAP[base]!, interval, limit);
      if (isValidCandleSet(candles, minRequired)) {
        setCached(cacheKey, candles);
        logger.debug({ symbol, count: candles.length, source: "poloniex" }, "Candles from Poloniex");
        return pinLastCandle(candles, lastPrice);
      }
    } catch (err) {
      logger.warn({ err, symbol }, "Poloniex candle fetch failed — using synthetic");
    }
  }

  // ── 6. Synthetic fallback ───────────────────────────────────────────────────
  logger.warn({ symbol, interval }, "All real candle sources failed — using synthetic fallback");
  const inception = getInceptionTs(symbol);
  const candles   = generateFallbackCandles(lastPrice, interval, limit, inception);
  setCached(cacheKey, candles);
  return pinLastCandle(candles, lastPrice);
}
