/**
 * errorWatcher.ts — OrahDEX Auto-Debug & Self-Healing Error Monitor
 *
 * Intercepts every logger.error / logger.warn call, matches it against a
 * pattern library, and:
 *
 *   1. Classifies the error (db | system | price | rpc | ...)
 *   2. Applies a remediation action (emit alert, ping pool, log incident)
 *   3. Enforces a per-pattern circuit breaker — cooldown + hourly cap —
 *      so the same error can only trigger N remediations per hour
 *   4. Exposes watcher state to the admin dashboard via getWatcherState()
 *
 * Patterns are tried in order (most specific first). The catch-all at the
 * end matches anything not already classified.
 *
 * startErrorWatcher() must be called once at server startup (before other
 * services start, so all their errors are captured from the beginning).
 */

import { logger } from "./logger.js";
import { logIncident } from "./serviceState.js";
import { emit as emitAlert } from "./alertBus.js";
import { pool, type PoolClient } from "@workspace/db";
import type { AlertCategory, AlertSeverity } from "./alertBus.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface ErrorPattern {
  id:          string;
  description: string;
  /** Any of these substrings (lowercased) in the error message triggers the pattern. */
  keywords:    string[];
  category:    AlertCategory;
  severity:    AlertSeverity;
  /** Minimum ms between remediation actions for this pattern (circuit breaker). */
  cooldownMs:  number;
  /** Maximum remediation actions per rolling hour (circuit breaker). */
  maxPerHour:  number;
  /** Perform the remediation. Return a human-readable outcome string. */
  remediate:   (ctx: ErrorContext) => Promise<string>;
}

interface ErrorContext {
  message:          string;
  pattern:          ErrorPattern;
  hitCount:         number;
  hitsLastHour:     number;
}

interface PatternState {
  hitCount:          number;
  remediationCount:  number;
  suppressedCount:   number;
  lastHitAt:         number | null;
  lastRemediatedAt:  number | null;
  lastOutcome:       string | null;
  recentHits:        number[];   // timestamps within last hour
  recentActions:     number[];   // timestamps within last hour
}

// ── Remediation helpers ────────────────────────────────────────────────────

async function pingDbPool(): Promise<string> {
  try {
    const client = await Promise.race<PoolClient>([
      pool.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ping timeout")), 4_000)
      ),
    ]);
    client.release();
    return "DB pool ping OK — connection healthy";
  } catch (e: any) {
    return `DB pool ping failed: ${e?.message ?? "unknown"}`;
  }
}

// ── Pattern library ────────────────────────────────────────────────────────
// Ordered most-specific → least-specific. Catch-all has empty keywords[].

const PATTERNS: ErrorPattern[] = [

  // ── DB: pool connection failures ────────────────────────────────────────
  {
    id:          "db-conn-timeout",
    description: "PostgreSQL pool connection timeout (cold-start or DB restart)",
    keywords:    ["timeout exceeded when trying to connect", "econnrefused", "connection refused"],
    category:    "db",
    severity:    "warning",
    cooldownMs:  60_000,
    maxPerHour:  10,
    remediate:   () => pingDbPool(),
  },
  {
    id:          "db-query-timeout",
    description: "Query read timeout — pool saturated or DB slow",
    keywords:    ["query read timeout"],
    category:    "db",
    severity:    "warning",
    cooldownMs:  60_000,
    maxPerHour:  10,
    remediate:   () => pingDbPool(),
  },
  {
    id:          "db-terminated",
    description: "DB connection terminated unexpectedly — drain stale connections",
    keywords:    ["connection terminated unexpectedly", "connection terminated due to"],
    category:    "db",
    severity:    "warning",
    cooldownMs:  30_000,
    maxPerHour:  20,
    remediate:   async () => {
      // Drain the pool so stale/dead connections are evicted, then verify
      // connectivity with a fresh connection.
      try {
        await (pool as any).drain?.();
      } catch { /* drain is best-effort */ }
      return pingDbPool();
    },
  },

  // ── Advanced order engines ──────────────────────────────────────────────
  {
    id:          "iceberg-engine-error",
    description: "Iceberg order engine uncaught error",
    keywords:    ["iceberg engine uncaught error"],
    category:    "system",
    severity:    "high",
    cooldownMs:  300_000,
    maxPerHour:  3,
    remediate:   async (ctx) => {
      await emitAlert("high", "system", "Iceberg engine error detected", ctx.message.slice(0, 300));
      logIncident("error", "iceberg-engine", ctx.message.slice(0, 200));
      return "Alert emitted + incident logged";
    },
  },
  {
    id:          "trailing-stop-engine-error",
    description: "Trailing stop engine uncaught error",
    keywords:    ["trailing stop engine uncaught error"],
    category:    "system",
    severity:    "high",
    cooldownMs:  300_000,
    maxPerHour:  3,
    remediate:   async (ctx) => {
      await emitAlert("high", "system", "Trailing stop engine error detected", ctx.message.slice(0, 300));
      logIncident("error", "trailing-stop-engine", ctx.message.slice(0, 200));
      return "Alert emitted + incident logged";
    },
  },
  {
    id:          "twap-engine-error",
    description: "TWAP engine uncaught error",
    keywords:    ["twap engine uncaught error"],
    category:    "system",
    severity:    "high",
    cooldownMs:  300_000,
    maxPerHour:  3,
    remediate:   async (ctx) => {
      await emitAlert("high", "system", "TWAP engine error detected", ctx.message.slice(0, 300));
      logIncident("error", "twap-engine", ctx.message.slice(0, 200));
      return "Alert emitted + incident logged";
    },
  },

  // ── HTLC / settlement ───────────────────────────────────────────────────
  {
    id:          "htlc-poll-error",
    description: "EVM HTLC watcher poll cycle error",
    keywords:    ["evmhtlc: poll cycle error", "htlc: poll cycle", "evmhtlc: unexpected db error"],
    category:    "system",
    severity:    "warning",
    cooldownMs:  120_000,
    maxPerHour:  5,
    remediate:   async (ctx) => {
      logIncident("warn", "htlc-watcher", ctx.message.slice(0, 200));
      return "Incident logged for HTLC poll error";
    },
  },
  {
    id:          "bsv-htlc-error",
    description: "BSV HTLC watcher error",
    keywords:    ["htlc watcher", "htlcwatcher", "htlc registry"],
    category:    "system",
    severity:    "warning",
    cooldownMs:  120_000,
    maxPerHour:  5,
    remediate:   async (ctx) => {
      logIncident("warn", "bsv-htlc-watcher", ctx.message.slice(0, 200));
      return "Incident logged for BSV HTLC error";
    },
  },

  // ── Price engine ────────────────────────────────────────────────────────
  {
    id:          "price-seed-failed",
    description: "Market price seeding failed",
    keywords:    ["failed to seed markets"],
    category:    "price",
    severity:    "warning",
    cooldownMs:  120_000,
    maxPerHour:  5,
    remediate:   async (ctx) => {
      logIncident("warn", "price-updater", ctx.message.slice(0, 200));
      return "Incident logged for price seed failure";
    },
  },
  {
    id:          "price-fetch-failed",
    description: "External price feed fetch failed",
    keywords:    ["binance 24h-ticker fetch failed", "coingecko fetch failed", "price fetch"],
    category:    "price",
    severity:    "info",
    cooldownMs:  300_000,
    maxPerHour:  3,
    remediate:   async (ctx) => {
      logIncident("warn", "price-feed", ctx.message.slice(0, 200));
      return "Price feed failure noted";
    },
  },

  // ── External API / RPC ──────────────────────────────────────────────────
  {
    id:          "external-api-timeout",
    description: "External API fetch timed out (Binance, WoC, CoinGecko, etc.)",
    keywords:    [
      "the operation was aborted due to timeout", "fetch failed",
      "etimedout", "network request failed",
    ],
    category:    "rpc",
    severity:    "info",
    cooldownMs:  300_000,
    maxPerHour:  3,
    remediate:   async (ctx) => {
      logIncident("warn", "external-api", ctx.message.slice(0, 200));
      return "External API timeout noted";
    },
  },

  // ── Overlay scanner ─────────────────────────────────────────────────────
  {
    id:          "overlay-scan-error",
    description: "Overlay scanner tick error",
    keywords:    ["overlay scanner tick error", "overlay scanner: db unavailable"],
    category:    "system",
    severity:    "info",
    cooldownMs:  300_000,
    maxPerHour:  3,
    remediate:   async (ctx) => {
      logIncident("warn", "overlay-scanner", ctx.message.slice(0, 200));
      return "Overlay scanner error noted";
    },
  },

  // ── Deployment / health probes ──────────────────────────────────────────
  {
    id:          "healthcheck-fail",
    description: "Deployment health probe returned non-2xx",
    keywords:    ["healthcheck", "returned status 500", "returned status 502", "returned status 503"],
    category:    "system",
    severity:    "high",
    cooldownMs:  600_000,
    maxPerHour:  2,
    remediate:   async (ctx) => {
      await emitAlert("high", "system", "Deployment healthcheck failing", ctx.message.slice(0, 300));
      return "Alert emitted for healthcheck failure";
    },
  },

  // ── AI provider ─────────────────────────────────────────────────────────
  {
    id:          "ai-provider-auth",
    description: "AI provider authentication or quota failure",
    keywords:    ["ai provider unavailable (auth error)", "backing off 5 min", "401", "403", "restricted"],
    category:    "system",
    severity:    "high",
    cooldownMs:  300_000,
    maxPerHour:  3,
    remediate:   async (ctx) => {
      logIncident("error", "ai-provider", ctx.message.slice(0, 200));
      return "AI auth failure logged — circuit breaker will auto-reset in 5 min";
    },
  },
  {
    id:          "ai-provider-timeout",
    description: "AI provider timeout or repeated slowness",
    keywords:    [
      "ai provider repeatedly timing out", "ai chat error", "ai insights error",
      "ai market analysis error", "ai trade signal timeout",
      "ai portfolio analysis failed", "ai news sentiment failed",
    ],
    category:    "system",
    severity:    "warning",
    cooldownMs:  120_000,
    maxPerHour:  6,
    remediate:   async (ctx) => {
      logIncident("warn", "ai-provider", ctx.message.slice(0, 200));
      return "AI timeout incident logged";
    },
  },
  {
    id:          "ai-route-crash",
    description: "Uncaught error in an AI route — caught by error middleware safety net",
    keywords:    ["[ai] uncaught route error", "[ai] unhandled route error"],
    category:    "system",
    severity:    "high",
    cooldownMs:  60_000,
    maxPerHour:  5,
    remediate:   async (ctx) => {
      await emitAlert("high", "system", "AI route crash caught by safety net", ctx.message.slice(0, 300));
      logIncident("error", "ai-route", ctx.message.slice(0, 200));
      return "AI route crash alert emitted";
    },
  },

  // ── Catch-all (matches everything not caught above) ─────────────────────
  {
    id:          "unknown-error",
    description: "Unclassified server error",
    keywords:    [],
    category:    "system",
    severity:    "warning",
    cooldownMs:  120_000,
    maxPerHour:  10,
    remediate:   async (ctx) => {
      logIncident("error", "unknown", ctx.message.slice(0, 200));
      return "Unclassified error logged as incident";
    },
  },
];

// ── Per-pattern state ──────────────────────────────────────────────────────

const _state = new Map<string, PatternState>();

function getOrCreate(id: string): PatternState {
  if (!_state.has(id)) {
    _state.set(id, {
      hitCount:         0,
      remediationCount: 0,
      suppressedCount:  0,
      lastHitAt:        null,
      lastRemediatedAt: null,
      lastOutcome:      null,
      recentHits:       [],
      recentActions:    [],
    });
  }
  return _state.get(id)!;
}

// ── Circuit breaker ────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60_000;

function pruneOld(arr: number[]): number[] {
  const cutoff = Date.now() - ONE_HOUR_MS;
  return arr.filter(t => t > cutoff);
}

function canRemediate(ps: PatternState, pattern: ErrorPattern): boolean {
  ps.recentActions = pruneOld(ps.recentActions);
  if (ps.lastRemediatedAt && Date.now() - ps.lastRemediatedAt < pattern.cooldownMs) return false;
  if (ps.recentActions.length >= pattern.maxPerHour) return false;
  return true;
}

// ── Pattern matching ───────────────────────────────────────────────────────

function matchPattern(message: string): ErrorPattern | null {
  const lower = message.toLowerCase();
  // First pass: specific patterns (non-empty keywords)
  for (const p of PATTERNS) {
    if (p.keywords.length === 0) continue;
    if (p.keywords.some(k => lower.includes(k))) return p;
  }
  // Second pass: catch-all
  return PATTERNS.find(p => p.keywords.length === 0) ?? null;
}

// ── Core dispatch ──────────────────────────────────────────────────────────

async function dispatch(rawMessage: string): Promise<void> {
  // Do not dispatch messages originating from the watcher itself
  if (rawMessage.includes("[ErrorWatcher]")) return;

  const pattern = matchPattern(rawMessage);
  if (!pattern) return;

  const ps  = getOrCreate(pattern.id);
  const now = Date.now();

  ps.hitCount++;
  ps.lastHitAt  = now;
  ps.recentHits = pruneOld(ps.recentHits);
  ps.recentHits.push(now);

  if (!canRemediate(ps, pattern)) {
    ps.suppressedCount++;
    return;
  }

  ps.lastRemediatedAt = now;
  ps.recentActions.push(now);
  ps.remediationCount++;

  const ctx: ErrorContext = {
    message:      rawMessage,
    pattern,
    hitCount:     ps.hitCount,
    hitsLastHour: ps.recentHits.length,
  };

  try {
    const outcome  = await pattern.remediate(ctx);
    ps.lastOutcome = outcome;
    logger.info(
      {
        patternId:         pattern.id,
        hitCount:          ps.hitCount,
        remediationCount:  ps.remediationCount,
        outcome,
      },
      `[ErrorWatcher] Auto-remediated: ${pattern.description}`,
    );
  } catch (e: any) {
    ps.lastOutcome = `Remediation threw: ${e?.message ?? "unknown"}`;
    logger.warn(
      { patternId: pattern.id, err: e?.message },
      "[ErrorWatcher] Remediation action failed",
    );
  }
}

// ── Logger hook ────────────────────────────────────────────────────────────

/**
 * Extract a plain-text message from pino call args.
 * pino accepts: logger.error(msg) or logger.error(obj, msg).
 */
function extractMessage(args: unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === "string") {
      parts.push(a);
    } else if (a && typeof a === "object") {
      const o = a as Record<string, unknown>;
      // Pull the error message if present
      if (o.err && typeof o.err === "object") {
        const e = o.err as Record<string, unknown>;
        if (typeof e.message === "string") parts.push(e.message);
      }
      if (typeof o.message === "string") parts.push(o.message);
      if (typeof o.msg === "string") parts.push(o.msg);
    }
  }
  return parts.join(" ");
}

let _hooked = false;

function hookLogger() {
  if (_hooked) return;
  _hooked = true;

  const origError = logger.error.bind(logger);
  const origWarn  = logger.warn.bind(logger);

  // Patch error
  (logger as any).error = (...args: unknown[]) => {
    (origError as (...a: unknown[]) => void)(...args);
    const msg = extractMessage(args);
    if (msg) dispatch(msg).catch(() => {});
  };

  // Patch warn — many runtime errors surface at WARN level
  (logger as any).warn = (...args: unknown[]) => {
    (origWarn as (...a: unknown[]) => void)(...args);
    const msg = extractMessage(args);
    if (msg) dispatch(msg).catch(() => {});
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface WatcherPatternSummary {
  id:                string;
  description:       string;
  category:          string;
  severity:          string;
  hitCount:          number;
  hitsLastHour:      number;
  remediationCount:  number;
  suppressedCount:   number;
  lastHitAt:         string | null;
  lastRemediatedAt:  string | null;
  lastOutcome:       string | null;
  circuitOpen:       boolean;
}

/** Returns the current watcher state for every registered pattern. */
export function getWatcherState(): WatcherPatternSummary[] {
  return PATTERNS.map(p => {
    const ps = _state.get(p.id);
    if (!ps) {
      return {
        id: p.id, description: p.description,
        category: p.category, severity: p.severity,
        hitCount: 0, hitsLastHour: 0,
        remediationCount: 0, suppressedCount: 0,
        lastHitAt: null, lastRemediatedAt: null, lastOutcome: null,
        circuitOpen: false,
      };
    }
    const recentHits = pruneOld([...ps.recentHits]).length;
    return {
      id:               p.id,
      description:      p.description,
      category:         p.category,
      severity:         p.severity,
      hitCount:         ps.hitCount,
      hitsLastHour:     recentHits,
      remediationCount: ps.remediationCount,
      suppressedCount:  ps.suppressedCount,
      lastHitAt:        ps.lastHitAt ? new Date(ps.lastHitAt).toISOString() : null,
      lastRemediatedAt: ps.lastRemediatedAt ? new Date(ps.lastRemediatedAt).toISOString() : null,
      lastOutcome:      ps.lastOutcome,
      circuitOpen:      !canRemediate(ps, p),
    };
  });
}

/** Returns summary stats for the dashboard (active patterns only). */
export function getWatcherSummary() {
  const all = getWatcherState();
  return {
    patternsMonitored: PATTERNS.length,
    patternsHit:       all.filter(s => s.hitCount > 0).length,
    totalHits:         all.reduce((n, s) => n + s.hitCount, 0),
    totalRemediations: all.reduce((n, s) => n + s.remediationCount, 0),
    totalSuppressed:   all.reduce((n, s) => n + s.suppressedCount, 0),
    active:            all.filter(s => s.hitsLastHour > 0),
  };
}

/**
 * Start the error watcher. Call once at server startup, before other services.
 * Hooks into logger.error and logger.warn so all subsequent error calls are
 * intercepted and pattern-matched automatically.
 */
export function startErrorWatcher(): void {
  hookLogger();
  logger.info(
    { patterns: PATTERNS.length },
    `[ErrorWatcher] Started — monitoring ${PATTERNS.length} error patterns`,
  );
}
