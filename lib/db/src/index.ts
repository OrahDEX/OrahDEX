import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// pg-connection-string warns that 'require', 'prefer', and 'verify-ca' will
// change semantics in pg v9.  Explicitly upgrading to 'verify-full' adopts
// the current (stricter) behaviour and silences the deprecation warning.
function resolvedDatabaseUrl(raw: string): string {
  return raw
    .replace(/sslmode=prefer/g,    "sslmode=verify-full")
    .replace(/sslmode=require/g,   "sslmode=verify-full")
    .replace(/sslmode=verify-ca/g, "sslmode=verify-full");
}

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error(
    "[OrahDEX] WARNING: DATABASE_URL is not set. " +
    "The server will start but all database operations will fail. " +
    "Provision a PostgreSQL database and set DATABASE_URL to enable full functionality."
  );
}

// When DATABASE_URL is missing, use a placeholder URL. The pool will fail
// at connection time (not at import time), so the server can start and serve
// static files, health checks, and clearly-structured 503 responses.
const _connectionString = dbUrl
  ? resolvedDatabaseUrl(dbUrl)
  : "postgresql://nodb:nodb@localhost:5432/nodb";

export const pool = new Pool({
  connectionString: _connectionString,
  // Send TCP keepalive probes immediately when a connection becomes idle.
  keepAlive: true,
  keepAliveInitialDelayMillis: 0,
  // Evict idle connections after 30 s.  Background services fire every 30–120 s,
  // so a 5 s idle timeout caused pure churn: connections were destroyed between
  // every tick and recreated from scratch (TCP + TLS + auth) on the next one.
  // 30 s keeps connections warm across price-updater cycles (60 s) and avoids
  // the thundering-herd creation storm that saturated the pool.
  // Neon kills server-side after ~60 s, so 30 s still gives us headroom.
  idleTimeoutMillis: 30_000,
  // Allow up to 15 s for a slot to free up when all connections are busy.
  // With 12+ concurrent background services the old 5 s limit caused a cascade
  // of "timeout exceeded when trying to connect" across every engine.
  connectionTimeoutMillis: 15_000,
  // 20 connections: production runs with 2 replicas (Replit deployment), so
  // 2 × 20 = 40 total connections — within Neon plan limits while leaving
  // headroom for HTTP routes when background services are active.
  // max=15 was too tight: the liquidity bot holds one connection for several
  // seconds (80K-row UNNEST bulk write), and with 12+ other services + HTTP
  // routes competing, the pool exhausted under peak load.
  // max=40 was too high: 80 simultaneous reconnects during a Neon 57P01
  // suspend/resume storm overwhelmed recovery.  20 is the balanced sweet spot.
  max: 20,
  // Keep the pool alive between tick cycles.
  allowExitOnIdle: false,
  // Kill runaway queries after 30 s. The liquidity bot's bulk DELETE of 48 k
  // bot orders is a legitimate long operation that exceeds the old 8 s limit on
  // the production DB (large table + 4 indexes to update + WAL overhead).
  query_timeout: 30_000,
});

// Catch errors on idle clients in the pool (e.g. a connection dropped by the
// server while sitting unused). Without this handler Node.js would emit an
// unhandled 'error' event and potentially crash the process.
pool.on("error", (err, _client) => {
  console.error("[pg-pool] idle client error — connection will be discarded:", err.message);
});

// Attach an error handler to every client the moment it is created.
// This covers the gap where pg emits an 'error' event on the underlying
// socket of a CHECKED-OUT client (i.e. one actively running a query).
// That error is NOT caught by the pool's own 'error' event — it propagates
// to the EventEmitter as an uncaughtException, which our app.ts handler
// treats as fatal and calls process.exit(1).  By registering a listener
// here we silence it; the query's rejected Promise already surfaces the
// error to the caller, so no information is lost.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("[pg-client] socket error on checked-out client (non-fatal):", err.message);
  });
});

export const db = drizzle(pool, { schema });

/** Return true for transient network-level Postgres errors that are safe to retry. */
function isTransientPgError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // Also check the raw pg error code so we catch the error regardless of how
  // the driver formats the message string (driver versions vary).
  const code = (err as Record<string, unknown>).code;
  return (
    msg.includes("Connection terminated") ||
    msg.includes("connection timeout") ||
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("read ETIMEDOUT") ||
    msg.includes("connect ETIMEDOUT") ||
    // Neon/Postgres kills the socket outright (compute suspend/resume, admin
    // maintenance) — the pg driver surfaces the server's raw error text
    // verbatim, so it never matches the "Connection terminated" wrapper above.
    msg.includes("administrator command") ||
    // pg-pool surfaces connection-acquisition timeout (connectionTimeoutMillis
    // exceeded) as "Query read timeout".  This happens during a thundering-herd
    // reconnect storm after a Neon 57P01 suspend: all 20 pool slots are being
    // created simultaneously, queued acquirers time out, and workers see this
    // error instead of a real query failure.  It is always safe to retry.
    msg.includes("Query read timeout") ||
    // 57P01 = pg_terminate_backend() / Neon compute suspend
    code === "57P01"
  );
}

/**
 * Run `fn` with up to MAX_RETRIES retries on transient pg connection errors.
 * Uses exponential backoff with ±25 % jitter so simultaneous background
 * services don't all hammer the pool in lock-step after a Neon blip.
 *
 * Delays: ~500 ms, ~1 s, ~2 s  (base × 2^attempt  ± jitter)
 *
 * @example
 *   await withDbRetry(() => db.insert(t).values(row).onConflictDoUpdate(...));
 */
// 500 ms base keeps total retry time (500+1000+2000 ms backoff + connection
// waits) well under the selfHealing 25 s tick timeout.  The old 2 s base meant
// 3 retries could take up to 59 s (backoff + 3×15 s connection waits), which
// always exceeded the timeout and made retries useless.
const RETRY_BASE_MS  = 500;
const RETRY_MAX      = 3;

export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientPgError(err)) throw err;
      lastErr = err;
      if (attempt === RETRY_MAX) break;
      const base  = RETRY_BASE_MS * Math.pow(2, attempt);   // 500, 1000, 2000
      const jitter = base * 0.25 * (Math.random() * 2 - 1); // ±25 %
      await new Promise(r => setTimeout(r, Math.round(base + jitter)));
    }
  }
  throw lastErr;
}

export * from "./schema";
export type { PoolClient } from "pg";
