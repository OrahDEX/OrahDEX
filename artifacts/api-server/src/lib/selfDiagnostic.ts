/**
 * selfDiagnostic.ts — OrahDEX Automated System Health Scanner
 *
 * Runs every 10 minutes via guardedInterval. Scans for:
 *   1. Stale USDT price data (last_price not updated in > 2 hours)
 *   2. ArbBot anomalies (arb stats look like phantom data-artifact trades)
 *   3. DB connectivity and basic row-count sanity
 *   4. Order reconciliation (stuck open orders with no recent activity)
 *
 * On detecting an issue it:
 *   - Logs a structured WARN with actionable detail
 *   - Writes a platform_settings entry so the admin dashboard can surface it
 *   - Auto-remediates where safe (e.g. resets phantom arb counters)
 */

import { db, pool, withDbRetry } from "@workspace/db";
import { marketsTable, ordersTable, platformSettingsTable } from "@workspace/db/schema";
import { eq, and, lt, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { guardedInterval } from "./selfHealing.js";

const SCAN_INTERVAL_MS  = 10 * 60 * 1000;   // every 10 minutes
const STALE_PRICE_MS    = 2 * 60 * 60 * 1000; // 2 hours — USDT-pair prices must be fresher
const ARB_PHANTOM_PPT   = 50;    // if >50% of arb trades were at >500% gross → phantom

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function getSetting(key: string): Promise<string | null> {
  try {
    const rows = await withDbRetry(() =>
      db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, key))
    );
    return rows[0]?.value ?? null;
  } catch { return null; }
}

async function setSetting(key: string, value: string) {
  await withDbRetry(() =>
    db.insert(platformSettingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value, updatedAt: new Date() } })
  );
}

/* ── individual checks ───────────────────────────────────────────────────── */

interface DiagResult {
  name:    string;
  status:  "ok" | "warn" | "fixed";
  detail:  string;
}

async function checkStalePrices(): Promise<DiagResult> {
  try {
    const cutoff = new Date(Date.now() - STALE_PRICE_MS);
    const rows = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
         FROM markets
        WHERE quote_asset = 'USDT'
          AND status      = 'active'
          AND updated_at  < $1`,
      [cutoff],
    );
    const stale = parseInt(rows.rows[0]?.cnt ?? "0");
    if (stale > 0) {
      logger.warn({ staleCount: stale, olderThanMs: STALE_PRICE_MS },
        "[SelfDiag] Stale USDT prices detected — price-updater may be lagging");
      await setSetting("diag_stale_prices", `${stale} USDT pairs stale as of ${new Date().toISOString()}`);
      return { name: "stale-prices", status: "warn", detail: `${stale} USDT pairs not updated in >2h` };
    }
    await setSetting("diag_stale_prices", "ok");
    return { name: "stale-prices", status: "ok", detail: "all USDT prices fresh" };
  } catch (err: any) {
    return { name: "stale-prices", status: "warn", detail: `check failed: ${err?.message}` };
  }
}

async function checkArbStats(): Promise<DiagResult> {
  try {
    const [profitStr, tradesStr] = await Promise.all([
      getSetting("arb_bot_total_profit"),
      getSetting("arb_bot_total_trades"),
    ]);
    const profit = parseFloat(profitStr ?? "0") || 0;
    const trades = parseInt(tradesStr  ?? "0") || 0;

    // Heuristic: if average profit per trade is > $5 it's almost certainly phantom
    const avgPerTrade = trades > 0 ? profit / trades : 0;
    if (trades > 100 && avgPerTrade > 5) {
      logger.warn({ profit, trades, avgPerTrade: avgPerTrade.toFixed(4) },
        "[SelfDiag] ArbBot stats look like data-artifact phantom trades — resetting");
      await Promise.all([
        setSetting("arb_bot_total_profit",      "0.000000"),
        setSetting("arb_bot_total_trades",      "0"),
        setSetting("arb_bot_total_cycles",      "0"),
        setSetting("arb_bot_last_cycle_profit", "0.000000"),
        setSetting("arb_bot_last_opps_found",   "0"),
        setSetting("arb_bot_start_time",        new Date().toISOString()),
      ]);
      await setSetting("diag_arb_reset", `Reset at ${new Date().toISOString()} (was $${profit.toFixed(2)} / ${trades} trades, avg $${avgPerTrade.toFixed(2)}/trade)`);
      return {
        name:   "arb-stats",
        status: "fixed",
        detail: `Reset phantom arb stats ($${profit.toFixed(2)} across ${trades} phantom trades)`,
      };
    }
    await setSetting("diag_arb_stats", "ok");
    return { name: "arb-stats", status: "ok", detail: `$${profit.toFixed(2)} profit / ${trades} trades looks sane` };
  } catch (err: any) {
    return { name: "arb-stats", status: "warn", detail: `check failed: ${err?.message}` };
  }
}

async function checkDbConnectivity(): Promise<DiagResult> {
  try {
    const start = Date.now();
    await pool.query("SELECT 1");
    const latencyMs = Date.now() - start;
    if (latencyMs > 2000) {
      logger.warn({ latencyMs }, "[SelfDiag] DB ping slow");
      return { name: "db-ping", status: "warn", detail: `slow ping: ${latencyMs}ms` };
    }
    return { name: "db-ping", status: "ok", detail: `ping ${latencyMs}ms` };
  } catch (err: any) {
    logger.error({ err }, "[SelfDiag] DB connectivity failed");
    return { name: "db-ping", status: "warn", detail: `DB error: ${err?.message}` };
  }
}

async function checkAiHealth(): Promise<DiagResult> {
  try {
    const port = process.env.PORT ?? "3000";
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 5_000);
    const res  = await fetch(`http://127.0.0.1:${port}/api/ai/insights`, {
      signal: ctrl.signal,
      headers: { "x-internal-probe": "1" },
    });
    clearTimeout(t);
    if (!res.ok) {
      return { name: "ai-health", status: "warn", detail: `AI insights endpoint returned HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as { insights?: unknown; cached?: boolean } | null;
    const hasInsights = Array.isArray(body?.insights) && body.insights.length > 0;
    if (!hasInsights) {
      return { name: "ai-health", status: "warn", detail: "AI insights returned empty or malformed response" };
    }
    return { name: "ai-health", status: "ok", detail: `AI insights responsive (${body.cached ? "cached" : "fresh"})` };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { name: "ai-health", status: "warn", detail: "AI insights endpoint timed out (>5s)" };
    }
    return { name: "ai-health", status: "warn", detail: `AI endpoint unreachable: ${err?.message}` };
  }
}

async function checkStuckOrders(): Promise<DiagResult> {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
    const rows = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
         FROM orders
        WHERE status      = 'open'
          AND wallet_address NOT IN ('BOT_LIQUIDITY_ENGINE', 'BOT_ARB_ENGINE')
          AND updated_at  < $1`,
      [cutoff],
    );
    const stuck = parseInt(rows.rows[0]?.cnt ?? "0");
    if (stuck > 0) {
      logger.warn({ stuckCount: stuck }, "[SelfDiag] User orders stuck open for >24h");
      await setSetting("diag_stuck_orders", `${stuck} orders stuck open >24h as of ${new Date().toISOString()}`);
      return { name: "stuck-orders", status: "warn", detail: `${stuck} user orders open >24h` };
    }
    await setSetting("diag_stuck_orders", "ok");
    return { name: "stuck-orders", status: "ok", detail: "no stuck user orders" };
  } catch (err: any) {
    return { name: "stuck-orders", status: "warn", detail: `check failed: ${err?.message}` };
  }
}

/* ── main scan ───────────────────────────────────────────────────────────── */

async function runDiagnosticScan(): Promise<void> {
  const results = await Promise.all([
    checkDbConnectivity(),
    checkStalePrices(),
    checkArbStats(),
    checkStuckOrders(),
    checkAiHealth(),
  ]);

  const warns  = results.filter(r => r.status === "warn");
  const fixed  = results.filter(r => r.status === "fixed");
  const ok     = results.filter(r => r.status === "ok");

  const summary = {
    ok:    ok.length,
    warns: warns.length,
    fixed: fixed.length,
    issues: [...warns, ...fixed].map(r => `${r.name}: ${r.detail}`),
  };

  await setSetting("diag_last_scan", new Date().toISOString());
  await setSetting("diag_last_summary", JSON.stringify(summary));

  if (warns.length > 0 || fixed.length > 0) {
    logger.warn({ summary }, "[SelfDiag] Scan complete — issues detected");
  } else {
    logger.info({ ok: ok.length }, "[SelfDiag] Scan complete — all systems nominal");
  }
}

/* ── public start ────────────────────────────────────────────────────────── */

export function startSelfDiagnostic(): void {
  logger.info("[SelfDiag] Self-diagnostic engine starting");
  // Run first scan 2 minutes after startup, then every 10 minutes
  setTimeout(() => {
    runDiagnosticScan().catch(err => logger.warn({ err }, "[SelfDiag] First scan failed"));
    guardedInterval("self-diagnostic", runDiagnosticScan, SCAN_INTERVAL_MS, {
      timeoutMs: SCAN_INTERVAL_MS - 30_000,
    });
  }, 2 * 60 * 1000);
}

export { runDiagnosticScan };
