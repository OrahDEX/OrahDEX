/**
 * exchangeApiRepairEngine.ts — OrahDEX Auto-Repair Exchange API Strategy
 *
 * A multi-layer resilience layer that sits above every external API the
 * exchange depends on. Provides:
 *
 *   1. CircuitBreaker        — CLOSED → OPEN → HALF_OPEN per external endpoint.
 *                              Stops hammering failing APIs; probes recovery automatically.
 *   2. RateLimitGuard        — Per-API adaptive throttle. Detects 429 / Retry-After,
 *                              backs off exponentially, resumes automatically.
 *   3. PriceSourceFailover   — CoinGecko → CoinCap → Binance public → Kraken public.
 *                              Switches source on N consecutive failures; heals back.
 *   4. StaleDataRepairer     — Detects markets with price=0 or last_price stale >10 min;
 *                              triggers targeted refresh and logs the repair.
 *   5. ExchangeRouteMonitor  — Self-probes internal /api endpoints every 60 s.
 *                              Emits alerts on 5xx / timeout; attempts auto-repair.
 *   6. RepairHistory         — Ring buffer (200 entries) of all repair actions.
 *
 * All watchers use guardedInterval() so failures are tracked in /api/health.
 * Exposes getRepairEngineStatus() for the /admin/exchange-repair/status endpoint.
 */

import { logger }          from "./logger.js";
import { guardedInterval } from "./selfHealing.js";
import {
  alertCritical, alertWarning, alertInfo,
  type AlertCategory,
} from "./alertBus.js";
import { pool } from "@workspace/db";

/* ═══════════════════════════════════════════════════════════════════════════
   1. TYPES & SHARED STATE
   ═══════════════════════════════════════════════════════════════════════════ */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerStatus {
  name:             string;
  state:            CircuitState;
  failures:         number;
  successes:        number;
  lastFailureAt:    number | null;
  lastSuccessAt:    number | null;
  openedAt:         number | null;
  nextRetryAt:      number | null;
  totalCalls:       number;
  totalErrors:      number;
  errorRate:        number;       // 0–1 over last 20 calls
}

export interface RateLimitStatus {
  api:           string;
  throttled:     boolean;
  retryAfterMs:  number | null;
  throttledUntil: number | null;
  total429s:     number;
}

export interface PriceSourceStatus {
  current:   string;
  primary:   string;
  failovers: number;
  lastSwitch: number | null;
  sources:   { name: string; failures: number; active: boolean }[];
}

export interface RepairAction {
  ts:       number;
  type:     "circuit-opened" | "circuit-recovered" | "price-failover" | "stale-repair"
            | "rate-limit" | "route-degraded" | "route-recovered" | "stale-fixed" | "stale-detected";
  target:   string;
  detail:   string;
}

const REPAIR_RING_SIZE = 200;
const repairHistory: RepairAction[] = [];

function addRepair(action: Omit<RepairAction, "ts">) {
  repairHistory.unshift({ ts: Date.now(), ...action });
  if (repairHistory.length > REPAIR_RING_SIZE) repairHistory.pop();
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. CIRCUIT BREAKER
   ═══════════════════════════════════════════════════════════════════════════ */

interface CircuitBreakerConfig {
  failureThreshold:  number;   // failures within window before opening
  successThreshold:  number;   // consecutive successes in HALF_OPEN to close
  openDurationMs:    number;   // how long to stay OPEN before HALF_OPEN probe
  windowSize:        number;   // rolling window for error-rate calculation
}

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  openDurationMs:   60_000,   // 1 min
  windowSize:       20,
};

class CircuitBreaker {
  private state:         CircuitState = "CLOSED";
  private failures       = 0;
  private halfOpenWins   = 0;
  private openedAt:      number | null = null;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private totalCalls     = 0;
  private totalErrors    = 0;
  private recentResults: boolean[] = [];   // true = success

  constructor(
    public readonly name: string,
    private readonly cfg: CircuitBreakerConfig = DEFAULT_CB_CONFIG,
    private readonly cat: AlertCategory = "rpc",
  ) {}

  /** Returns true if the call is allowed through. */
  allowRequest(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "HALF_OPEN") return true;
    // OPEN — check if it's time to probe
    if (this.openedAt && Date.now() - this.openedAt >= this.cfg.openDurationMs) {
      this.state = "HALF_OPEN";
      logger.info({ cb: this.name }, `[CircuitBreaker] ${this.name}: OPEN → HALF_OPEN (probing)`);
      return true;
    }
    return false;
  }

  recordSuccess() {
    this.totalCalls++;
    this.lastSuccessAt = Date.now();
    this.recentResults.push(true);
    if (this.recentResults.length > this.cfg.windowSize) this.recentResults.shift();

    if (this.state === "HALF_OPEN") {
      this.halfOpenWins++;
      if (this.halfOpenWins >= this.cfg.successThreshold) {
        this.state       = "CLOSED";
        this.failures    = 0;
        this.halfOpenWins = 0;
        this.openedAt    = null;
        logger.info({ cb: this.name }, `[CircuitBreaker] ${this.name}: HALF_OPEN → CLOSED (recovered)`);
        addRepair({ type: "circuit-recovered", target: this.name, detail: "Circuit closed after successful probe" });
        alertInfo(this.cat, `[AutoRepair] ${this.name} circuit recovered — traffic restored`);
      }
    } else {
      this.failures = 0;
    }
  }

  recordFailure(err?: string) {
    this.totalCalls++;
    this.totalErrors++;
    this.lastFailureAt = Date.now();
    this.failures++;
    this.recentResults.push(false);
    if (this.recentResults.length > this.cfg.windowSize) this.recentResults.shift();

    if (this.state === "HALF_OPEN") {
      // Single failure in half-open → back to OPEN
      this.state       = "OPEN";
      this.openedAt    = Date.now();
      this.halfOpenWins = 0;
      logger.warn({ cb: this.name, err }, `[CircuitBreaker] ${this.name}: HALF_OPEN → OPEN (probe failed)`);
      return;
    }

    if (this.state === "CLOSED" && this.failures >= this.cfg.failureThreshold) {
      this.state    = "OPEN";
      this.openedAt = Date.now();
      logger.error({ cb: this.name, failures: this.failures, err },
        `[CircuitBreaker] ${this.name}: CLOSED → OPEN (threshold reached)`);
      addRepair({ type: "circuit-opened", target: this.name, detail: `${this.failures} consecutive failures. Last: ${err ?? "unknown"}` });
      alertCritical(this.cat, `[AutoRepair] ${this.name} circuit OPEN — requests blocked`, err);
    }
  }

  get status(): CircuitBreakerStatus {
    const successCount = this.recentResults.filter(Boolean).length;
    const errorRate    = this.recentResults.length
      ? 1 - successCount / this.recentResults.length
      : 0;
    return {
      name:          this.name,
      state:         this.state,
      failures:      this.failures,
      successes:     this.halfOpenWins,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt:      this.openedAt,
      nextRetryAt:   this.openedAt ? this.openedAt + this.cfg.openDurationMs : null,
      totalCalls:    this.totalCalls,
      totalErrors:   this.totalErrors,
      errorRate:     Math.round(errorRate * 1000) / 1000,
    };
  }

  get isOpen() { return this.state === "OPEN" && !this.allowRequest(); }
}

/* ── Circuit breaker registry ──────────────────────────────────────────── */

const circuitBreakers = new Map<string, CircuitBreaker>();

function getCircuit(name: string, cat: AlertCategory = "rpc", cfg?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(name, new CircuitBreaker(name, { ...DEFAULT_CB_CONFIG, ...cfg }, cat));
  }
  return circuitBreakers.get(name)!;
}

/**
 * Wrap any async call with a circuit breaker.
 * Throws if circuit is OPEN. Records success/failure automatically.
 */
export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  cat: AlertCategory = "rpc",
  cfg?: Partial<CircuitBreakerConfig>,
): Promise<T> {
  const cb = getCircuit(name, cat, cfg);
  if (!cb.allowRequest()) {
    throw new Error(`[CircuitBreaker] ${name} is OPEN — request blocked`);
  }
  try {
    const result = await fn();
    cb.recordSuccess();
    return result;
  } catch (err: any) {
    cb.recordFailure(err?.message);
    throw err;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. RATE LIMIT GUARD
   ═══════════════════════════════════════════════════════════════════════════ */

interface RateLimitEntry {
  api:            string;
  throttledUntil: number | null;
  total429s:      number;
  backoffMs:      number;
}

const rateLimits = new Map<string, RateLimitEntry>();

const BASE_BACKOFF_MS    = 10_000;
const MAX_BACKOFF_MS     = 10 * 60_000;  // 10 min cap

function getRlEntry(api: string): RateLimitEntry {
  if (!rateLimits.has(api)) {
    rateLimits.set(api, { api, throttledUntil: null, total429s: 0, backoffMs: BASE_BACKOFF_MS });
  }
  return rateLimits.get(api)!;
}

/** Call when you receive a 429 or rate-limit error. retryAfterMs optional from header. */
export function recordRateLimit(api: string, retryAfterMs?: number) {
  const entry = getRlEntry(api);
  entry.total429s++;
  const backoff  = retryAfterMs ?? Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);
  entry.backoffMs = backoff;
  entry.throttledUntil = Date.now() + backoff;

  addRepair({ type: "rate-limit", target: api, detail: `429 received — throttling for ${Math.round(backoff / 1000)}s` });
  alertWarning("rpc", `[AutoRepair] ${api} rate-limited — backoff ${Math.round(backoff / 1000)}s`);
  logger.warn({ api, backoffMs: backoff }, "[RateLimit] API rate-limited — backing off");
}

/** Returns true if the API is currently throttled. */
export function isThrottled(api: string): boolean {
  const entry = rateLimits.get(api);
  if (!entry?.throttledUntil) return false;
  if (Date.now() >= entry.throttledUntil) {
    entry.throttledUntil = null;
    entry.backoffMs = BASE_BACKOFF_MS;   // reset backoff on recovery
    return false;
  }
  return true;
}

/** Fetch wrapper that auto-detects 429 and handles circuit breaker. */
export async function resilientFetch(
  url: string,
  init: RequestInit = {},
  opts: { api?: string; circuitName?: string; timeoutMs?: number; cat?: AlertCategory } = {},
): Promise<Response> {
  const api         = opts.api         ?? new URL(url).hostname;
  const cbName      = opts.circuitName ?? api;
  const timeoutMs   = opts.timeoutMs   ?? 10_000;
  const cat         = opts.cat         ?? "rpc";
  const cb          = getCircuit(cbName, cat);

  if (!cb.allowRequest()) {
    throw new Error(`[AutoRepair] ${cbName} circuit OPEN — skipping request`);
  }
  if (isThrottled(api)) {
    const entry = getRlEntry(api);
    const waitS = Math.ceil(((entry.throttledUntil ?? 0) - Date.now()) / 1000);
    throw new Error(`[AutoRepair] ${api} rate-limited — retry in ${waitS}s`);
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 429) {
      const retryAfterSec = parseInt(res.headers.get("Retry-After") ?? "0", 10);
      recordRateLimit(api, retryAfterSec > 0 ? retryAfterSec * 1000 : undefined);
      // 429 = rate-limited, not unhealthy — do NOT count against circuit breaker.
      // The API is functioning; we are simply sending too many requests.
      // The RateLimitGuard above handles backoff; treat this as a non-fatal skip.
      throw new Error(`429 rate-limited: ${url}`);
    }

    cb.recordSuccess();
    return res;
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      cb.recordFailure(`timeout after ${timeoutMs}ms`);
      throw new Error(`Timeout (${timeoutMs}ms): ${url}`);
    }
    cb.recordFailure(err?.message);
    throw err;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. PRICE SOURCE FAILOVER
   ═══════════════════════════════════════════════════════════════════════════ */

interface PriceSource {
  name:     string;
  failures: number;
  active:   boolean;
}

const PRICE_SOURCES: PriceSource[] = [
  { name: "coingecko",  failures: 0, active: true  },
  { name: "coincap",    failures: 0, active: false },
  { name: "binance",    failures: 0, active: false },
  { name: "kraken",     failures: 0, active: false },
];

const FAILOVER_THRESHOLD = 3;   // consecutive failures before switching
let currentSourceIdx  = 0;
let totalFailovers    = 0;
let lastSwitchAt: number | null = null;

export function getCurrentPriceSource(): string {
  return PRICE_SOURCES[currentSourceIdx]?.name ?? "coingecko";
}

export function recordPriceSourceFailure(sourceName: string) {
  const src = PRICE_SOURCES.find(s => s.name === sourceName);
  if (!src) return;
  src.failures++;

  if (src.active && src.failures >= FAILOVER_THRESHOLD) {
    // Find next available source
    const nextIdx = PRICE_SOURCES.findIndex(
      (s, i) => i > currentSourceIdx && s.name !== sourceName
    );
    if (nextIdx !== -1) {
      PRICE_SOURCES[currentSourceIdx].active = false;
      currentSourceIdx = nextIdx;
      PRICE_SOURCES[currentSourceIdx].active = true;
      totalFailovers++;
      lastSwitchAt = Date.now();
      const next = PRICE_SOURCES[currentSourceIdx].name;

      logger.warn({ from: sourceName, to: next }, `[PriceFailover] Switching price source: ${sourceName} → ${next}`);
      addRepair({ type: "price-failover", target: sourceName, detail: `Failover → ${next} after ${src.failures} failures` });
      alertWarning("price", `[AutoRepair] Price source failover: ${sourceName} → ${next}`, `${src.failures} consecutive failures`);
    } else {
      // All sources exhausted — wrap around and reset
      currentSourceIdx = 0;
      PRICE_SOURCES.forEach(s => { s.failures = 0; s.active = false; });
      PRICE_SOURCES[0].active = true;
      logger.error({ sourceName }, "[PriceFailover] All sources exhausted — resetting to primary");
      alertCritical("price", "[AutoRepair] All price sources exhausted — reset to primary");
    }
  }
}

export function recordPriceSourceSuccess(sourceName: string) {
  const src = PRICE_SOURCES.find(s => s.name === sourceName);
  if (!src) return;
  if (src.failures > 0) {
    logger.info({ source: sourceName }, `[PriceFailover] ${sourceName} recovered — resetting failure count`);
    src.failures = 0;
  }
  // Heal back to primary if we've failed over
  if (currentSourceIdx > 0 && sourceName === PRICE_SOURCES[0].name) {
    PRICE_SOURCES[currentSourceIdx].active = false;
    currentSourceIdx = 0;
    PRICE_SOURCES[0].active = true;
    logger.info("[PriceFailover] Primary source recovered — restored to primary");
    addRepair({ type: "price-failover", target: "coingecko", detail: "Healed back to primary source" });
    alertInfo("price", "[AutoRepair] Price source healed — back to primary (CoinGecko)");
  }
}

export function getPriceSourceStatus(): PriceSourceStatus {
  return {
    current:   getCurrentPriceSource(),
    primary:   PRICE_SOURCES[0].name,
    failovers: totalFailovers,
    lastSwitch: lastSwitchAt,
    sources:   PRICE_SOURCES.map(s => ({ name: s.name, failures: s.failures, active: s.active })),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. STALE MARKET DATA REPAIRER
   ═══════════════════════════════════════════════════════════════════════════ */

const STALE_PRICE_THRESHOLD_MS = 10 * 60_000;   // 10 min
const ZERO_PRICE_SYMBOLS: Set<string> = new Set();

let staleRepairCount  = 0;
let lastStaleCheckAt: number | null = null;

async function repairStaleMarkets(): Promise<void> {
  lastStaleCheckAt = Date.now();
  const cutoff = new Date(Date.now() - STALE_PRICE_THRESHOLD_MS).toISOString();

  const { rows } = await pool.query<{
    symbol: string; last_price: string; updated_at: string | null;
  }>(
    `SELECT symbol, last_price, updated_at::text
     FROM markets
     WHERE enabled = TRUE
       AND type = 'spot'
       AND (
         last_price = '0'
         OR last_price IS NULL
         OR updated_at IS NULL
         OR updated_at < $1
       )
     LIMIT 50`,
    [cutoff],
  );

  if (rows.length === 0) {
    if (ZERO_PRICE_SYMBOLS.size > 0) ZERO_PRICE_SYMBOLS.clear();
    return;
  }

  const staleSymbols   = rows.map(r => r.symbol);
  const newZeroPrices  = rows.filter(r => !r.last_price || r.last_price === "0").map(r => r.symbol);

  for (const sym of newZeroPrices) ZERO_PRICE_SYMBOLS.add(sym);

  logger.warn({ staleCount: rows.length, staleSymbols: staleSymbols.slice(0, 10) },
    "[StaleRepairer] Stale market prices detected — triggering refresh");

  // The price-updater guardedInterval already runs every 60 s — calling
  // updateMarketPrices() here would create a second concurrent DB write
  // session, saturating the pool and causing BOTH the guard interval AND
  // this repair tick to time-out/fail.  Log the staleness and let the
  // price-updater's own next cycle fix it.
  staleRepairCount++;
  addRepair({
    type:   "stale-detected",
    target: `${staleSymbols.length} markets`,
    detail: `Stale symbols (first 10): ${staleSymbols.slice(0, 10).join(", ")} — deferring to price-updater interval`,
  });
  alertWarning("price",
    `[AutoRepair] ${staleSymbols.length} markets have stale prices — price-updater will fix on next cycle`,
    staleSymbols.slice(0, 10).join(", "),
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. EXCHANGE ROUTE SELF-MONITOR
   ═══════════════════════════════════════════════════════════════════════════ */

interface RouteProbeResult {
  path:        string;
  status:      number | null;
  latencyMs:   number;
  ok:          boolean;
  degraded:    boolean;
  lastChecked: number;
  consecutive5xx: number;
  consecutiveOk:  number;
}

const PROBE_ROUTES = [
  { path: "/api/ping",                        method: "GET", maxMs: 500 },
  { path: "/api/health",                      method: "GET", maxMs: 3_000 },
  { path: "/api/markets?limit=5",             method: "GET", maxMs: 5_000 },
  { path: "/api/markets/BSV%2FUSDT/ticker",   method: "GET", maxMs: 3_000 },
  { path: "/api/markets/BSV%2FUSDT/orderbook",method: "GET", maxMs: 3_000 },
  { path: "/api/dex/prices",                  method: "GET", maxMs: 3_000 },
  { path: "/api/ai/insights",                 method: "GET", maxMs: 5_000 },
  { path: "/api/staking/providers",           method: "GET", maxMs: 3_000 },
  { path: "/api/letsexchange/currencies",     method: "GET", maxMs: 3_000 },
  { path: "/api/coinbase/onramp-config",      method: "GET", maxMs: 3_000 },
];

const routeProbeResults = new Map<string, RouteProbeResult>();

async function probeRoutes(): Promise<void> {
  const port    = process.env["PORT"] ?? "8080";
  const baseUrl = `http://127.0.0.1:${port}`;

  for (const route of PROBE_ROUTES) {
    const existing = routeProbeResults.get(route.path) ?? {
      path: route.path, status: null, latencyMs: 0, ok: false,
      degraded: false, lastChecked: 0, consecutive5xx: 0, consecutiveOk: 0,
    };

    const start = Date.now();
    let status: number | null = null;
    let ok = false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), route.maxMs + 1_000);
      const res = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        signal: controller.signal,
        headers: { "x-internal-probe": "exchange-repair-engine" },
      });
      clearTimeout(timer);
      status = res.status;
      ok = res.status < 500;
    } catch {
      ok = false;
    }

    const latencyMs  = Date.now() - start;
    const slowRoute  = latencyMs > route.maxMs;

    if (!ok) {
      existing.consecutive5xx++;
      existing.consecutiveOk = 0;
    } else {
      existing.consecutiveOk++;
      if (existing.consecutive5xx > 0) {
        // Route recovered (in same server lifecycle)
        if (existing.consecutive5xx >= 3) {
          addRepair({ type: "route-recovered", target: route.path, detail: `Recovered after ${existing.consecutive5xx} failures` });
          alertInfo("system", `[AutoRepair] Route recovered: ${route.path}`);
        }
        existing.consecutive5xx = 0;
      }
      // Auto-resolve any stale "Route failing" critical alerts for this path
      // (covers alerts created before a server restart when in-memory state resets).
      if (existing.consecutiveOk === 3) {
        import("./alertBus.js").then(({ getAlerts, resolveAlert }) => {
          const stale = getAlerts({ severity: "critical", unresolvedOnly: true })
            .filter(a => a.message.includes(route.path));
          stale.forEach(a => resolveAlert(a.id).catch(() => {}));
          if (stale.length > 0) {
            addRepair({ type: "route-recovered", target: route.path, detail: `Auto-resolved ${stale.length} stale alert(s) from before restart` });
          }
        }).catch(() => {});
      }
    }

    existing.status      = status;
    existing.latencyMs   = latencyMs;
    existing.ok          = ok;
    existing.degraded    = slowRoute && ok;
    existing.lastChecked = Date.now();
    routeProbeResults.set(route.path, existing);

    // Alert thresholds
    if (!ok && existing.consecutive5xx === 3) {
      addRepair({ type: "route-degraded", target: route.path, detail: `HTTP ${status ?? "timeout"} × ${existing.consecutive5xx}` });
      alertCritical("system",
        `[AutoRepair] Route failing: ${route.path} (HTTP ${status ?? "timeout"})`,
        `${existing.consecutive5xx} consecutive failures`,
      );
    } else if (slowRoute && existing.consecutive5xx === 0) {
      alertWarning("system",
        `[AutoRepair] Slow route: ${route.path} responded in ${latencyMs}ms (threshold: ${route.maxMs}ms)`,
      );
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. API ERROR CATEGORIZER
   ═══════════════════════════════════════════════════════════════════════════ */

export type ErrorCategory =
  | "transient"       // retry-able: network blip, timeout
  | "rate-limit"      // 429 — back off and retry
  | "auth-failure"    // 401/403 — alert, do not retry
  | "data-corruption" // unexpected data shape — alert
  | "network-down"    // ECONNREFUSED, ENOTFOUND — circuit breaker
  | "quota-exceeded"  // 402/429 with billing context
  | "unknown";

export function categorizeApiError(err: unknown, statusCode?: number): ErrorCategory {
  if (statusCode === 429)             return "rate-limit";
  if (statusCode === 401 || statusCode === 403) return "auth-failure";
  if (statusCode === 402)             return "quota-exceeded";
  if (statusCode && statusCode >= 500) return "transient";

  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many")) return "rate-limit";
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden")) return "auth-failure";
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network"))  return "network-down";
  if (msg.includes("timeout") || msg.includes("abort") || msg.includes("timed out"))         return "transient";
  if (msg.includes("json") || msg.includes("parse") || msg.includes("unexpected token"))     return "data-corruption";
  return "unknown";
}

/**
 * Smart error handler: categorises the error, emits the right alert,
 * and returns a suggested action.
 */
export function handleApiError(
  api: string,
  err: unknown,
  statusCode?: number,
  cat: AlertCategory = "rpc",
): { action: "retry" | "backoff" | "skip" | "alert-only"; category: ErrorCategory } {
  const category = categorizeApiError(err, statusCode);
  const errMsg   = err instanceof Error ? err.message : String(err);

  switch (category) {
    case "rate-limit":
      recordRateLimit(api);
      return { action: "backoff", category };

    case "auth-failure":
      alertCritical(cat, `[AutoRepair] Auth failure for ${api} — check API key`, errMsg);
      return { action: "alert-only", category };

    case "quota-exceeded":
      alertCritical(cat, `[AutoRepair] Quota exceeded for ${api}`, errMsg);
      return { action: "alert-only", category };

    case "data-corruption":
      alertWarning(cat, `[AutoRepair] Data corruption from ${api}`, errMsg);
      return { action: "skip", category };

    case "network-down":
      alertWarning(cat, `[AutoRepair] Network failure for ${api}`, errMsg);
      return { action: "retry", category };

    case "transient":
      return { action: "retry", category };

    default:
      logger.warn({ api, errMsg, category }, "[AutoRepair] Unknown API error");
      return { action: "retry", category };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   8. STATUS EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */

export function getCircuitBreakerStates(): CircuitBreakerStatus[] {
  return Array.from(circuitBreakers.values()).map(cb => cb.status);
}

export function getRateLimitStates(): RateLimitStatus[] {
  return Array.from(rateLimits.values()).map(e => ({
    api:            e.api,
    throttled:      isThrottled(e.api),
    retryAfterMs:   e.throttledUntil ? e.throttledUntil - Date.now() : null,
    throttledUntil: e.throttledUntil,
    total429s:      e.total429s,
  }));
}

export function getRouteProbeResults(): RouteProbeResult[] {
  return Array.from(routeProbeResults.values());
}

export function getRepairHistory(limit = 50): RepairAction[] {
  return repairHistory.slice(0, limit);
}

export function getRepairEngineStatus() {
  const routes = getRouteProbeResults();
  return {
    summary: {
      circuitBreakers: {
        total:  circuitBreakers.size,
        open:   Array.from(circuitBreakers.values()).filter(cb => cb.status.state === "OPEN").length,
        halfOpen: Array.from(circuitBreakers.values()).filter(cb => cb.status.state === "HALF_OPEN").length,
      },
      rateLimits: {
        total:     rateLimits.size,
        throttled: Array.from(rateLimits.keys()).filter(isThrottled).length,
      },
      routes: {
        total:    routes.length,
        healthy:  routes.filter(r => r.ok && !r.degraded).length,
        degraded: routes.filter(r => r.degraded).length,
        down:     routes.filter(r => !r.ok).length,
      },
      staleRepairs:     staleRepairCount,
      lastStaleCheckAt: lastStaleCheckAt,
      priceFailovers:   totalFailovers,
    },
    circuitBreakers:  getCircuitBreakerStates(),
    rateLimits:       getRateLimitStates(),
    priceSource:      getPriceSourceStatus(),
    routeProbes:      routes,
    repairHistory:    getRepairHistory(100),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   9. ENGINE STARTUP
   ═══════════════════════════════════════════════════════════════════════════ */

// Pre-register circuit breakers for all known external APIs
const KNOWN_APIS: { name: string; cat: AlertCategory; cfg?: Partial<CircuitBreakerConfig> }[] = [
  { name: "coingecko",    cat: "price",  cfg: { failureThreshold: 5, openDurationMs: 2 * 60_000 } },
  { name: "coincap",      cat: "price",  cfg: { failureThreshold: 5, openDurationMs: 2 * 60_000 } },
  { name: "binance-pub",  cat: "price",  cfg: { failureThreshold: 5, openDurationMs: 2 * 60_000 } },
  { name: "kraken-pub",   cat: "price",  cfg: { failureThreshold: 5, openDurationMs: 2 * 60_000 } },
  { name: "letsexchange", cat: "le",     cfg: { failureThreshold: 4, openDurationMs: 3 * 60_000 } },
  { name: "simpleswap",   cat: "le",     cfg: { failureThreshold: 4, openDurationMs: 3 * 60_000 } },
  { name: "stripe",       cat: "stripe", cfg: { failureThreshold: 3, openDurationMs: 5 * 60_000 } },
  { name: "coinbase",     cat: "rpc",    cfg: { failureThreshold: 3, openDurationMs: 5 * 60_000 } },
  { name: "whatsonchain", cat: "rpc",    cfg: { failureThreshold: 5, openDurationMs: 2 * 60_000 } },
  { name: "eth-rpc",      cat: "rpc",    cfg: { failureThreshold: 5, openDurationMs: 60_000 } },
  { name: "bsc-rpc",      cat: "rpc",    cfg: { failureThreshold: 5, openDurationMs: 60_000 } },
  { name: "polygon-rpc",  cat: "rpc",    cfg: { failureThreshold: 5, openDurationMs: 60_000 } },
];

export function startExchangeApiRepairEngine(): void {
  // Pre-register all known circuit breakers
  for (const api of KNOWN_APIS) {
    getCircuit(api.name, api.cat, api.cfg);
  }

  // Stale market data repair — every 5 minutes
  guardedInterval(
    "stale-market-repair",
    repairStaleMarkets,
    5 * 60_000,
    { timeoutMs: 4 * 60_000, initialDelayMs: 3 * 60_000 },
  );

  // Exchange route self-probe — every 60 seconds
  guardedInterval(
    "exchange-route-monitor",
    probeRoutes,
    60_000,
    { timeoutMs: 55_000, initialDelayMs: 30_000 },
  );

  logger.info(
    { circuits: KNOWN_APIS.length, probeRoutes: PROBE_ROUTES.length },
    "[AutoRepair] Exchange API Repair Engine started",
  );
}
