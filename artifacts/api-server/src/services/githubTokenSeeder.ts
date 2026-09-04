/**
 * githubTokenSeeder.ts — Pull token lists from GitHub to get logos,
 * EVM contract addresses, decimals, and discover new coins automatically.
 *
 * Sources:
 *   • Trust Wallet assets repo — token lists per chain + logo URLs
 *   • Uniswap default token list — broad EVM coverage
 *
 * Data flow:
 *   1. On startup: warm in-memory cache from DB (fast path)
 *   2. Then fetch fresh lists from GitHub (background, every 24 h)
 *   3. Newly discovered symbols → added to markets as type='catalog'
 */

import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

/* ── Trust Wallet chain slugs → EVM chainIds ─────────────────────────────── */
const TW_CHAINS: { slug: string; chainId: number }[] = [
  { slug: "ethereum",   chainId: 1      },
  { slug: "smartchain", chainId: 56     },
  { slug: "polygon",    chainId: 137    },
  { slug: "avalanchec", chainId: 43114  },
  { slug: "arbitrum",   chainId: 42161  },
  { slug: "optimism",   chainId: 10     },
  { slug: "base",       chainId: 8453   },
];

const TW_BASE = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";

/* ── Native-coin logo map (no contract address needed) ────────────────────── */
const NATIVE_LOGOS: Record<string, string> = {
  BTC: "bitcoin",    ETH: "ethereum",   BNB: "smartchain",
  MATIC: "polygon",  POL: "polygon",    AVAX: "avalanchec",
  SOL: "solana",     TRX: "tron",       XRP: "ripple",
  DOT: "polkadot",   ADA: "cardano",    ATOM: "cosmos",
  LTC: "litecoin",   BCH: "bitcoincash",DOGE: "dogecoin",
  XLM: "stellar",    XMR: "monero",     ZEC: "zcash",
  NEAR: "near",      APT: "aptos",      SUI: "sui",
  BSV: "bitcoinsv",  FTM: "fantom",     ALGO: "algorand",
  VET: "vechain",    EOS: "eos",        XTZ: "tezos",
  ONE: "harmony",    HBAR: "hedera",
};

export function nativeLogoUrl(symbol: string): string | null {
  const chain = NATIVE_LOGOS[symbol.toUpperCase()];
  return chain ? `${TW_BASE}/${chain}/info/logo.png` : null;
}

/* ── In-memory caches ─────────────────────────────────────────────────────── */
/** symbol (uppercase) → best logo URL */
const logoCache  = new Map<string, string>();
/** symbol (uppercase) → chainId → { address, decimals } */
const tokenMeta  = new Map<string, Record<number, { address: string; decimals: number }>>();

export function getCachedLogoUrl(symbol: string): string | null {
  return nativeLogoUrl(symbol) ?? logoCache.get(symbol.toUpperCase()) ?? null;
}

export function getCachedTokenMeta(
  symbol: string, chainId: number,
): { address: string; decimals: number } | null {
  return tokenMeta.get(symbol.toUpperCase())?.[chainId] ?? null;
}

export function getAllCachedSymbols(): string[] {
  const set = new Set(Object.keys(NATIVE_LOGOS));
  for (const sym of tokenMeta.keys()) set.add(sym);
  return Array.from(set).sort();
}

/* ── Internal helpers ─────────────────────────────────────────────────────── */
async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "OrahDEX/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

interface RawToken {
  chainId: number; address: string; symbol: string;
  name: string; decimals: number; logoUrl: string; source: string;
}

function loadIntoCache(tokens: RawToken[]): void {
  for (const t of tokens) {
    const sym = t.symbol.toUpperCase();
    if (t.logoUrl && !logoCache.has(sym)) logoCache.set(sym, t.logoUrl);
    if (!tokenMeta.has(sym)) tokenMeta.set(sym, {});
    tokenMeta.get(sym)![t.chainId] = {
      address:  t.address.toLowerCase(),
      decimals: t.decimals,
    };
  }
}

async function upsertTokens(tokens: RawToken[]): Promise<void> {
  if (!tokens.length) return;
  const n = tokens.length;
  await pool.query(`
    INSERT INTO github_tokens (chain_id, address, symbol, name, decimals, logo_url, source, fetched_at)
    SELECT * FROM UNNEST(
      $1::int[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[],
      ARRAY_FILL(NOW()::timestamptz, ARRAY[$8::int])
    ) AS t(chain_id, address, symbol, name, decimals, logo_url, source, fetched_at)
    ON CONFLICT (chain_id, address) DO UPDATE SET
      symbol     = EXCLUDED.symbol,
      name       = EXCLUDED.name,
      decimals   = EXCLUDED.decimals,
      logo_url   = COALESCE(EXCLUDED.logo_url, github_tokens.logo_url),
      source     = EXCLUDED.source,
      fetched_at = NOW()
  `, [
    tokens.map(t => t.chainId),
    tokens.map(t => t.address.toLowerCase()),
    tokens.map(t => t.symbol.toUpperCase()),
    tokens.map(t => t.name),
    tokens.map(t => t.decimals),
    tokens.map(t => t.logoUrl),
    tokens.map(t => t.source),
    n,
  ]);
}

async function fetchTrustWalletChain(slug: string, chainId: number): Promise<number> {
  const url = `${TW_BASE}/${slug}/tokenlist.json`;
  const data = await fetchJson(url);
  const tokens: RawToken[] = (data.tokens ?? []).map((t: any) => ({
    chainId,
    address:  t.address ?? "",
    symbol:   (t.symbol ?? "").toUpperCase(),
    name:     t.name ?? "",
    decimals: t.decimals ?? 18,
    logoUrl:  t.logoURI ?? `${TW_BASE}/${slug}/assets/${t.address}/logo.png`,
    source:   "trustwallet",
  })).filter((t: RawToken) => t.address && t.symbol);

  await upsertTokens(tokens);
  loadIntoCache(tokens);
  return tokens.length;
}

async function fetchUniswapList(): Promise<number> {
  const url = "https://raw.githubusercontent.com/Uniswap/default-token-list/main/build/uniswap-default.tokenlist.json";
  const data = await fetchJson(url);
  const tokens: RawToken[] = (data.tokens ?? [])
    .filter((t: any) => t.chainId && t.address && t.symbol)
    .map((t: any) => ({
      chainId:  t.chainId,
      address:  t.address,
      symbol:   (t.symbol as string).toUpperCase(),
      name:     t.name ?? "",
      decimals: t.decimals ?? 18,
      logoUrl:  t.logoURI ?? "",
      source:   "uniswap",
    }));

  await upsertTokens(tokens);
  loadIntoCache(tokens);
  return tokens.length;
}

/** Warm the in-memory cache from what's already in the DB (fast on restart) */
async function warmFromDB(): Promise<void> {
  const { rows } = await pool.query<{
    symbol: string; chain_id: number; address: string; decimals: number; logo_url: string | null;
  }>(`SELECT symbol, chain_id, address, decimals, logo_url FROM github_tokens`);

  loadIntoCache(rows.map(r => ({
    chainId:  r.chain_id,
    address:  r.address,
    symbol:   r.symbol,
    name:     "",
    decimals: r.decimals,
    logoUrl:  r.logo_url ?? "",
    source:   "db",
  })));
  logger.info({ count: rows.length }, "GitHub token cache warmed from DB");
}

/** Add newly-discovered symbols to markets catalog (USDT pairs, type='catalog') */
async function discoverNewTokens(): Promise<void> {
  const { rows } = await pool.query<{ symbol: string }>(`
    SELECT DISTINCT gt.symbol
    FROM github_tokens gt
    WHERE gt.symbol NOT IN (
      SELECT DISTINCT base_asset FROM markets WHERE type IN ('spot','catalog','letsexchange','simpleswap')
    )
    AND length(gt.symbol) BETWEEN 2 AND 12
    ORDER BY gt.symbol
    LIMIT 300
  `);

  if (!rows.length) return;

  /* Build VALUES list — safe since symbols are uppercased alphanumeric */
  const vals = rows
    .map(r => r.symbol.replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean)
    .map(sym => `('${sym}', 'USDT', '${sym}/USDT', 'catalog', 0, 'active')`)
    .join(",\n    ");

  await pool.query(`
    INSERT INTO markets (base_asset, quote_asset, symbol, type, last_price, status)
    VALUES ${vals}
    ON CONFLICT (symbol) DO NOTHING
  `);
  logger.info({ count: rows.length }, "GitHub: new tokens added to markets catalog");
}

/* ── Public API ───────────────────────────────────────────────────────────── */
let running = false;

export async function seedGithubTokens(): Promise<void> {
  if (running) return;
  running = true;
  try {
    /* Fast path: warm from DB so logos are available immediately */
    await warmFromDB().catch(err => logger.warn({ err }, "GitHub DB warm failed (non-fatal)"));

    /* Fetch fresh data from GitHub — sequential to avoid rate limiting */
    let total = 0;
    for (const { slug, chainId } of TW_CHAINS) {
      try {
        const n = await fetchTrustWalletChain(slug, chainId);
        total += n;
        logger.info({ chain: slug, count: n }, "Trust Wallet tokens seeded");
      } catch (err) {
        logger.warn({ err, chain: slug }, "Trust Wallet chain fetch failed (non-fatal)");
      }
      await new Promise(r => setTimeout(r, 400)); // polite delay between chains
    }

    try {
      const n = await fetchUniswapList();
      total += n;
      logger.info({ count: n }, "Uniswap token list seeded");
    } catch (err) {
      logger.warn({ err }, "Uniswap list fetch failed (non-fatal)");
    }

    await discoverNewTokens().catch(err => logger.warn({ err }, "Token discovery failed (non-fatal)"));
    logger.info({ total }, "GitHub token seeder complete");
  } finally {
    running = false;
  }
}
