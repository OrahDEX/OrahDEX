/**
 * coinPaprikaImporter.ts
 *
 * Bulk-fetches ~9 000 coins from CoinPaprika in ONE HTTP request (no rate limits,
 * no API key required) and upserts their name + logo URL into coin_metadata.
 *
 * Logo URL pattern: https://static.coinpaprika.com/coin/{id}/logo.png
 *
 * ON CONFLICT strategy: COALESCE preserves higher-quality CoinGecko data if it
 * already exists in the row; only fills in missing values from CoinPaprika.
 */

import { pool } from "@workspace/db";

interface PaprikaCoin {
  id:        string;
  name:      string;
  symbol:    string;
  rank:      number;
  is_active: boolean;
  type:      string;
}

interface PaprikaStatus {
  running:     boolean;
  lastRunAt:   string | null;
  upserted:    number;
  error:       string | null;
}

let running   = false;
let lastRunAt: Date | null = null;
let upserted  = 0;
let lastError: string | null = null;

export function getPaprikaStatus(): PaprikaStatus {
  return { running, lastRunAt: lastRunAt?.toISOString() ?? null, upserted, error: lastError };
}

export async function runCoinPaprikaImport(): Promise<{ upserted: number }> {
  if (running) return { upserted: 0 };
  running   = true;
  lastError = null;

  try {
    // Single request — returns ALL ~9 000 coins CoinPaprika tracks
    const res = await fetch("https://api.coinpaprika.com/v1/coins", {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`CoinPaprika HTTP ${res.status}`);

    const coins = (await res.json()) as PaprikaCoin[];

    // Deduplicate by symbol: prefer active coins, then lower rank
    const bySymbol = new Map<string, PaprikaCoin>();
    for (const c of coins) {
      const sym = c.symbol?.toUpperCase?.();
      if (!sym || sym.length > 20 || !c.id) continue;
      const existing = bySymbol.get(sym);
      if (!existing) { bySymbol.set(sym, c); continue; }
      const existScore = (existing.is_active ? 0 : 100_000) + (existing.rank || 50_000);
      const newScore   = (c.is_active       ? 0 : 100_000) + (c.rank        || 50_000);
      if (newScore < existScore) bySymbol.set(sym, c);
    }

    if (bySymbol.size === 0) { upserted = 0; return { upserted: 0 }; }

    const syms:   string[]           = [];
    const names:  string[]           = [];
    const imgs:   string[]           = [];
    const ranks:  (number | null)[]  = [];

    for (const [sym, c] of bySymbol) {
      syms.push(sym);
      names.push(c.name ?? sym);
      imgs.push(`https://static.coinpaprika.com/coin/${c.id}/logo.png`);
      ranks.push(c.rank > 0 ? c.rank : null);
    }

    // Bulk upsert — ON CONFLICT preserves existing CoinGecko data via COALESCE
    await pool.query(
      `INSERT INTO coin_metadata (symbol, name, image_url, market_cap_rank, updated_at)
       SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), unnest($4::int[]), NOW()
       ON CONFLICT (symbol) DO UPDATE SET
         name            = COALESCE(coin_metadata.name,            EXCLUDED.name),
         image_url       = COALESCE(coin_metadata.image_url,       EXCLUDED.image_url),
         market_cap_rank = COALESCE(coin_metadata.market_cap_rank, EXCLUDED.market_cap_rank),
         updated_at      = NOW()`,
      [syms, names, imgs, ranks],
    );

    upserted  = syms.length;
    lastRunAt = new Date();
    return { upserted };
  } catch (err: any) {
    lastError = err?.message ?? String(err);
    throw err;
  } finally {
    running = false;
  }
}
