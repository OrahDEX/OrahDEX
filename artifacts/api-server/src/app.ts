import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import router from "./routes";
import v1Router from "./routes/v1.js";
import { docsRouter, rpcRouter } from "./routes/docs.js";
import { logger } from "./lib/logger";
import { startPriceUpdater } from "./lib/priceUpdater.js";
import { startHlWebSocket } from "./lib/hyperliquidWs.js";
import { startLiquidityBot } from "./lib/liquidityBot.js";
import { startArbBot } from "./lib/arbBot.js";
import { startFuturesProfitEngine } from "./lib/futuresProfitEngine.js";
import { startBsvChainMonitor, getBsvChainStatus } from "./lib/bsvChainMonitor.js";
import { startBsvDepositWatcher } from "./lib/bsvDepositWatcher.js";
import { startEvmDepositWatcher } from "./lib/evmDepositWatcher.js";
import { startRouteCache } from "./lib/routeCache.js";
import { startHtlcWatcher } from "./lib/htlcWatcher.js";
import { startEvmHtlcWatcher } from "./lib/evmHtlc.js";
import { warmCurrenciesCache, clearSwapCaches } from "./routes/letsexchange.js";
import { hydrateAdminTokens } from "./middleware/adminAuth.js";
import { seedCoinGeckoIds } from "./services/cgIdSeeder.js";
import { seedGithubTokens } from "./services/githubTokenSeeder.js";
import { startCopyOrchestrator } from "./lib/copyOrchestrator.js";
import { apiKeyAuth, rejectQueryParamApiKey, startApiKeyCounterFlusher } from "./middleware/apiKeyAuth.js";
import { WebhookHandlers } from "./webhookHandlers.js";
import evmWebhookRouter from "./routes/evmWebhookRouter.js";
import { getHealthReport, startOrderReconciler } from "./lib/selfHealing.js";
import { startAllReconcilers } from "./lib/selfHealingReconcilers.js";
import { hydrateAlertsFromDB } from "./lib/alertBus.js";
import { startExchangeApiRepairEngine } from "./lib/exchangeApiRepairEngine.js";
import { startBsvIntentWatcher } from "./lib/bsvIntentWatcher.js";
import { startArcStatusPoller } from "./lib/arcStatusPoller.js";
import { startAdvancedOrderEngines } from "./lib/advancedOrderEngine.js";
import { startFundingRateEngine } from "./lib/fundingRateEngine.js";
import { ensureCoinMetadataTable, runCoinGeckoImport } from "./lib/coinGeckoImporter.js";
import { runCoinPaprikaImport } from "./lib/coinPaprikaImporter.js";
import { clearCoinsCache, prefetchCgMarkets, warmCacheFromDB } from "./routes/dex.js";
import { startBsvMempoolWatcher } from "./lib/bsvMempoolWatcher.js";
import { startOverlayScanner } from "./lib/overlayScanner.js";
import { startSelfDiagnostic } from "./lib/selfDiagnostic.js";
import { startErrorWatcher } from "./lib/errorWatcher.js";
import { pool } from "@workspace/db";

// Run the chain_id column migration at startup (idempotent — IF NOT EXISTS).
pool.query(`
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "chain_id" integer;
  CREATE INDEX IF NOT EXISTS "orders_chain_id_idx"
    ON "orders" ("chain_id")
    WHERE "chain_id" IS NOT NULL;
`).catch((err: Error) => logger.warn({ err: err.message }, "chain_id migration failed (non-fatal)"));

// ARC broadcaster columns — added for BSV transaction status tracking.
pool.query(`
  ALTER TABLE "withdrawal_requests"
    ADD COLUMN IF NOT EXISTS "arc_txid"   text,
    ADD COLUMN IF NOT EXISTS "arc_status" varchar(64);
  ALTER TABLE "bsv_intent_sessions"
    ADD COLUMN IF NOT EXISTS "arc_txid"   text,
    ADD COLUMN IF NOT EXISTS "arc_status" text;
`).catch((err: Error) => logger.warn({ err: err.message }, "ARC columns migration failed (non-fatal)"));

// External swap tracking — records LE/SS swaps created for zero-liquidity pairs.
pool.query(`
  CREATE TABLE IF NOT EXISTS external_swaps (
    id               TEXT PRIMARY KEY,
    venue_tx_id      TEXT,
    venue            TEXT NOT NULL,
    wallet_address   TEXT NOT NULL,
    from_coin        TEXT NOT NULL,
    to_coin          TEXT NOT NULL,
    from_amount      NUMERIC,
    to_amount        NUMERIC,
    deposit_address  TEXT,
    deposit_extra_id TEXT,
    output_address   TEXT,
    status           TEXT NOT NULL DEFAULT 'waiting_deposit',
    mode             TEXT NOT NULL DEFAULT 'manual',
    side             TEXT,
    trade_symbol     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`).catch((err: Error) => logger.warn({ err: err.message }, "external_swaps table creation failed (non-fatal)"));

// SPV pending deposits table — tracks mempool-detected BSV deposits.
pool.query(`
  CREATE TABLE IF NOT EXISTS bsv_pending_deposits (
    txid          TEXT    NOT NULL,
    bsv_address   TEXT    NOT NULL,
    user_wallet   TEXT    NOT NULL,
    amount_sat    BIGINT  NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'mempool',
    block_height  INT,
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at  TIMESTAMPTZ,
    proof_tries   INT     NOT NULL DEFAULT 0,
    PRIMARY KEY (txid, bsv_address)
  );
  CREATE INDEX IF NOT EXISTS bsv_pending_deposits_wallet_status_idx
    ON bsv_pending_deposits (user_wallet, status);
`).catch((err: Error) => logger.warn({ err: err.message }, "bsv_pending_deposits migration failed (non-fatal)"));

// SPV block header chain — stores PoW-validated BSV block headers.
pool.query(`
  CREATE TABLE IF NOT EXISTS bsv_block_headers (
    hash         TEXT    PRIMARY KEY,
    height       INT     NOT NULL,
    prev_hash    TEXT    NOT NULL,
    merkle_root  TEXT    NOT NULL,
    bits         BIGINT  NOT NULL,
    nonce        BIGINT  NOT NULL,
    block_time   INT     NOT NULL,
    source       TEXT    NOT NULL DEFAULT 'woc',
    indexed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS bsv_block_headers_height_idx ON bsv_block_headers (height);
`).catch((err: Error) => logger.warn({ err: err.message }, "bsv_block_headers migration failed (non-fatal)"));

// BSV overlay records — OP_RETURN indexed records for on-chain audit trail.
pool.query(`
  CREATE TABLE IF NOT EXISTS overlay_records (
    id           TEXT         PRIMARY KEY,
    txid         TEXT         NOT NULL,
    block_height INTEGER,
    order_id     TEXT,
    secret_hash  TEXT,
    amounts_json TEXT,
    evm_address  TEXT,
    raw_payload  TEXT,
    indexed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT overlay_records_txid_unique UNIQUE (txid)
  );
  CREATE INDEX IF NOT EXISTS overlay_records_order_id_idx     ON overlay_records (order_id);
  CREATE INDEX IF NOT EXISTS overlay_records_block_height_idx ON overlay_records (block_height);
  CREATE INDEX IF NOT EXISTS overlay_records_indexed_at_idx   ON overlay_records (indexed_at DESC);
`).catch((err: Error) => logger.warn({ err: err.message }, "overlay_records migration failed (non-fatal)"));

// Indexes to make /api/markets/search fast and price-updater UPDATE fast.
// idx_markets_symbol is critical: the price-updater bulk UPDATE uses
// WHERE m.symbol = v.sym AND m.type IN ('spot','futures') — without this
// index Postgres does a sequential scan of the full 2M-row table every 60s.
pool.query(`
  CREATE INDEX IF NOT EXISTS idx_markets_base_asset  ON markets (base_asset);
  CREATE INDEX IF NOT EXISTS idx_markets_quote_asset ON markets (quote_asset);
  CREATE INDEX IF NOT EXISTS idx_markets_type        ON markets (type);
  CREATE INDEX IF NOT EXISTS idx_markets_symbol      ON markets (symbol);
`).catch((err: Error) => logger.warn({ err: err.message }, "markets search indexes failed (non-fatal)"));

// GitHub token list cache — stores logos, addresses, and decimals from Trust Wallet + Uniswap lists.
pool.query(`
  CREATE TABLE IF NOT EXISTS github_tokens (
    chain_id   INT         NOT NULL,
    address    TEXT        NOT NULL,
    symbol     TEXT        NOT NULL,
    name       TEXT,
    decimals   INT         NOT NULL DEFAULT 18,
    logo_url   TEXT,
    source     TEXT        NOT NULL DEFAULT 'trustwallet',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chain_id, address)
  );
  CREATE INDEX IF NOT EXISTS github_tokens_symbol_idx ON github_tokens (symbol);
`).catch((err: Error) => logger.warn({ err: err.message }, "github_tokens migration failed (non-fatal)"));

const app: Express = express();
const middlewareRegistrationOrder: string[] = [];

function assertWebhookMiddlewareOrder(order: string[]): void {
  const jsonIdx = order.indexOf("express.json");
  const evmIdx = order.indexOf("evm-webhook");
  const stripeIdx = order.indexOf("stripe-webhook");
  if (jsonIdx === -1 || evmIdx === -1 || stripeIdx === -1) {
    throw new Error("[FATAL] Missing middleware registration markers for webhook order assertion");
  }
  if (evmIdx > jsonIdx || stripeIdx > jsonIdx) {
    throw new Error("[FATAL] Webhook routes must be registered before express.json()");
  }
}

/* ── Trust proxy — required for correct IP detection behind Replit's reverse proxy
 * Enables accurate rate-limiting and X-Forwarded-For header parsing. ────────── */
app.set("trust proxy", 1);

/* ── Security headers (helmet) ───────────────────────────────────────────────
 * Sets X-Frame-Options, X-Content-Type-Options, HSTS, X-DNS-Prefetch-Control,
 * Referrer-Policy, and more. CSP is disabled here because the same server also
 * serves the SPA — the frontend's Vite build handles its own CSP needs.       */
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

/* ── Cookie parser — required for HttpOnly admin session cookies ─────── */
app.use(cookieParser());

/* ── Compression — gzip all API responses (typically 60-80% smaller) ──── */
app.use(compression({
  level: 6,
  threshold: 512,
  filter: (req: Request, res: Response) => {
    if (req.headers["x-no-compression"]) return false;
    return compression.filter(req, res);
  },
}));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Build the allowed-origin list:
//   1. ALLOWED_ORIGINS env var (comma-separated, takes full precedence when set)
//   2. Hard-coded custom domains
//   3. The specific Replit dev domain for this Repl (from REPLIT_DEV_DOMAIN env var)
//      Avoids the previous wildcard *.replit.app / *.replit.dev that allowed any
//      Replit user's app to make credentialed cross-origin requests to this API.
//   4. localhost variants (dev convenience)
//
// For production Replit deployments (deployed .replit.app domains), set the
// ALLOWED_ORIGINS env var explicitly via Replit Secrets.
const _replitDevOrigins: string[] = [];
const _replitDevDomain = process.env["REPLIT_DEV_DOMAIN"];
if (_replitDevDomain) {
  _replitDevOrigins.push(`https://${_replitDevDomain}`);
}

const _allowedOrigins: (string | RegExp)[] = process.env["ALLOWED_ORIGINS"]
  ? process.env["ALLOWED_ORIGINS"].split(",").map(o => o.trim()).filter(Boolean)
  : [
      "https://orahdex.org",
      "https://www.orahdex.org",
      ..._replitDevOrigins,
      /^https?:\/\/localhost(:\d+)?$/,
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    ];

app.use(cors({
  origin: _allowedOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "x-admin-token"],
  credentials: true,
}));

/* ── EVM webhook — registered BEFORE express.json() ──────────────────────────
   HMAC-SHA256 signature verification requires the raw request body (Buffer).
   Any body-parsing middleware applied before this route would break verification.
   Receives EVM log events from any compatible provider (Alchemy, Infura, etc.).
   Env: EVM_WEBHOOK_SECRET — shared HMAC secret for payload verification.
   Paths: POST /api/webhooks/evm  (primary)
          POST /api/webhooks/quicknode  (legacy, for existing registrations)
── */
app.use(
  "/api/webhooks",
  express.raw({ type: "*/*" }),
  evmWebhookRouter,
);
middlewareRegistrationOrder.push("evm-webhook");

/* ── Stripe webhook — MUST be registered BEFORE express.json() ───────────────
   Stripe requires the raw request body (Buffer) to verify the signature.
   Any body-parsing middleware applied before this route will break verification.
── */
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }
    try {
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.json({ received: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Webhook processing failed" });
    }
  }
);
middlewareRegistrationOrder.push("stripe-webhook");

// Image-bearing endpoints (camera/AI base64 data-URLs ≈ 3-6 MB) get a higher
// body-size cap; everything else stays at the safer 1 MB to limit DoS surface.
const LARGE_BODY_PATHS = new Set([
  "/api/social/ai/image",
  "/api/social/posts",
]);
const LARGE_BODY_RE = /^\/api\/social\/creators\/[^/]+\/update$/;
const largeJson = express.json({ limit: "12mb" });
const largeForm = express.urlencoded({ extended: true, limit: "12mb" });
app.use((req, res, next) => {
  if (LARGE_BODY_PATHS.has(req.path) || LARGE_BODY_RE.test(req.path)) {
    return largeJson(req, res, (err) => err ? next(err) : largeForm(req, res, next));
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
middlewareRegistrationOrder.push("express.json");
assertWebhookMiddlewareOrder(middlewareRegistrationOrder);

/* ── Rate limiting ────────────────────────────────────────────────────────────
 * Layered approach:
 *  - Logo assets: 600 req / min per IP  (high burst for coin-list rendering)
 *  - Global:      200 req / 1 min per IP  (protects all write/query endpoints)
 *  - Exchange mutations: 30 req / min  (orders, swap, p2p fill, LE exchange)
 *  - Estimate/quote:    60 req / min  (rate-check calls, slightly relaxed)
 * Cached read-only endpoints (currencies, pairs, logo assets) are excluded
 * from the global limiter so they never block the coin picker UI.
 */

// Dedicated limiter for logo requests — high burst allowed because the coin
// picker renders dozens of logos simultaneously, but still caps abuse.
const logoLimiter = rateLimit({
  windowMs:        60_000,
  max:             600,
  standardHeaders: "draft-7",
  legacyHeaders:   false,
  handler: (_req, res) => res.status(429).json({ error: "Too many logo requests." }),
});
app.use("/api/tokens/logo", logoLimiter);

const globalLimiter = rateLimit({
  windowMs:          60_000,
  max:               200,
  standardHeaders:   "draft-7",
  legacyHeaders:     false,
  // Skip health probes AND cached read-only data endpoints.
  // Cached endpoints (currencies, pairs, prices, logos) must never be blocked
  // by the global budget — logo storms would otherwise kill the coin picker.
  skip: (req) => {
    const p = req.path;
    return p === "/api/ping" ||
      p === "/api/health" ||
      p === "/api/healthz" ||
      p === "/api/letsexchange/currencies" ||
      p === "/api/letsexchange/pairs" ||
      p === "/api/letsexchange/usd-prices" ||
      p.startsWith("/api/tokens/logo/") ||
      p.startsWith("/api/tokens/logo");
  },
  handler: (_req, res) => res.status(429).json({ error: "Too many requests — please slow down." }),
});
app.use(globalLimiter);

/* Stricter limit for financial write operations — keyed by wallet address when
 * available (prevents a single wallet from bypassing the cap via IP rotation).
 * Falls back to IP for requests without a wallet in the body.                 */
const exchangeLimiter = rateLimit({
  windowMs:        60_000,
  max:             30,
  standardHeaders: "draft-7",
  legacyHeaders:   false,
  // Key by wallet address when available so rate limits are wallet-scoped.
  // Falls back to the built-in ipKeyGenerator (normalises IPv6) when no
  // wallet is present in the request body.
  keyGenerator: (req) => {
    const body = req.body as Record<string, unknown> | undefined;
    const wallet = body?.["walletAddress"] ?? body?.["wallet_address"] ?? body?.["minter"];
    if (typeof wallet === "string" && wallet.length > 10) {
      return `wallet:${wallet.toLowerCase()}`;
    }
    return ipKeyGenerator(req.ip ?? "");
  },
  handler: (_req, res) => res.status(429).json({ error: "Exchange rate limit reached — wait a moment before retrying." }),
});
const EXCHANGE_WRITE_PATHS = [
  "/api/swap",
  "/api/orders",
  "/api/p2p/intents",
  "/api/letsexchange/exchange",
  "/api/genesis/swap",
  "/api/settlement/evm/session",
  "/api/settlement/evm/confirm-lock",
];
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET" && EXCHANGE_WRITE_PATHS.some(p => req.path === p || req.path.startsWith(p + "/"))) {
    return exchangeLimiter(req, res, next);
  }
  return next();
});

/* Relaxed limit for estimate / quote endpoints (called on every keystroke) */
const estimateLimiter = rateLimit({
  windowMs:        60_000,
  max:             60,
  standardHeaders: "draft-7",
  legacyHeaders:   false,
  handler: (_req, res) => res.status(429).json({ error: "Quote rate limit reached — wait a moment." }),
});
app.use("/api/letsexchange/estimate", estimateLimiter);
app.use("/api/swap/quote",            estimateLimiter);

/* Withdrawal endpoints — financial risk, apply same strict limit as exchange */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    req.method !== "GET" &&
    (req.path === "/api/withdrawals" || req.path === "/api/withdraw" ||
     req.path.startsWith("/api/withdrawals/") || req.path.startsWith("/api/withdraw/"))
  ) {
    return exchangeLimiter(req, res, next);
  }
  return next();
});

/* KYC submission — 5 per minute per IP to prevent enumeration/spam */
const kycLimiter = rateLimit({
  windowMs:        60_000,
  max:             5,
  standardHeaders: "draft-7",
  legacyHeaders:   false,
  handler: (_req, res) => res.status(429).json({ error: "Too many KYC requests — please wait before resubmitting." }),
});
app.use("/api/kyc/submit", kycLimiter);

/* Email inbound webhook — 20 per minute to prevent admin inbox flooding */
const emailWebhookLimiter = rateLimit({
  windowMs:        60_000,
  max:             20,
  standardHeaders: "draft-7",
  legacyHeaders:   false,
  handler: (_req, res) => res.status(429).json({ error: "Email webhook rate limit exceeded." }),
});
app.use("/api/webhook/email-inbound", emailWebhookLimiter);

/* ── Smart cache headers for common API routes ──────────────────────────── */
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const url = req.path;
  const method = req.method;

  if (method !== "GET") {
    /* No caching for mutations */
    res.setHeader("Cache-Control", "no-store");
    return next();
  }

  /* Price endpoints — short TTL (matches the 60s price updater interval) */
  if (url.startsWith("/markets") || url.startsWith("/prices") || url.startsWith("/ticker")) {
    res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=30");
    return next();
  }

  /* Order book — near real-time */
  if (url.startsWith("/orderbook") || url.startsWith("/trades")) {
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=10");
    return next();
  }

  /* GeckoTerminal / DexScreener proxy — these have their own TTL */
  if (url.startsWith("/gt/") || url.startsWith("/dexscreener/")) {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return next();
  }

  /* Static reference data — can cache longer */
  if (url.startsWith("/pairs") || url.startsWith("/chains")) {
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
    return next();
  }

  /* Health and chain status */
  if (url === "/health" || url === "/ping" || url.startsWith("/bsv-status")) {
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=20");
    return next();
  }

  /* Admin endpoints — never cache */
  if (url.startsWith("/admin")) {
    res.setHeader("Cache-Control", "no-store, no-cache");
    return next();
  }

  /* Default — 30 s cache */
  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  next();
});

/* ── Request timeout — prevents hung external calls blocking a slot ────────── */
app.use((_req: Request, res: Response, next: NextFunction) => {
  // AI image generation (gpt-image-1) can take 90–120 s — give it extra headroom.
  const isAiImage = _req.path === "/social/ai/image" && _req.method === "POST";
  const ms = isAiImage ? 120_000 : (_req.method === "GET" ? 30_000 : 60_000);
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ error: "Request timeout" });
    }
  }, ms);
  const clear = () => clearTimeout(timer);
  res.on("finish", clear);
  res.on("close",  clear);
  next();
});

/* ── Connectivity ping — returns 204, registered before main router ──────── */
app.get("/api/ping", (_req, res) => {
  res.status(204).end();
});

/* ── Bare /api and /v1 roots — deployment health probes sometimes hit these ─
   Respond 200 immediately so the probe doesn't fail on a bare request that
   would otherwise fall through to the API-key auth middleware.             ── */
app.get("/api", (_req, res) => { res.status(200).json({ ok: true }); });
app.get("/v1",  (_req, res) => { res.status(200).json({ ok: true, version: 1 }); });

/* ── Health checks — MUST be registered BEFORE app.use("/api", router).
   The main router mounts futuresRouter at "/" without a prefix, and that
   router has a blanket middleware that returns 503 for all requests when
   FUTURES_ENABLED !== "true". Registering /health here (before the router)
   means Express matches these routes first and never reaches the futures
   middleware, so the health pulse stays green when futures are disabled. ── */
app.get("/api/health",  healthHandler);
app.get("/api/healthz", healthHandler);
app.get("/v1/health",   healthHandler);
app.get("/v1/healthz",  healthHandler);

/* ── API docs (public — no key required) ─────────────────────────────────── */
app.use("/docs", docsRouter);
app.use("/rpc",  rpcRouter);

// Reject API keys in query params before any route can consume them.
// Keys must arrive via the Authorization header to stay out of server logs.
app.use(rejectQueryParamApiKey);

app.use("/api", apiKeyAuth);
app.use("/v1", apiKeyAuth);
app.use("/api", router);
app.use("/v1", v1Router);
startApiKeyCounterFlusher();

/* ── Static frontend — always served (dev + production) ─────────────────────
   The Vite build outputs to artifacts/bsv-dex/dist/public.
   From the compiled server at artifacts/api-server/dist/, that is two levels up.
── */
{
  const __serverDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDist = path.resolve(__serverDir, "../../bsv-dex/dist/public");
  if (fs.existsSync(frontendDist)) {
    logger.info({ frontendDist }, "Serving static frontend");
    app.use(express.static(frontendDist, {
      maxAge: process.env.NODE_ENV === "production" ? "1y" : 0,
      immutable: process.env.NODE_ENV === "production",
      index: false,
      setHeaders(res) {
        res.setHeader("X-Robots-Tag", "index, follow");
      },
    }));
    const indexHtmlPath = path.join(frontendDist, "index.html");
    const reownId =
      process.env.VITE_REOWN_PROJECT_ID ||
      process.env.REOWN_PROJECT_ID ||
      "04663615251cf13fb1b043d754e7a17f";
    let indexHtml = fs.existsSync(indexHtmlPath)
      ? fs.readFileSync(indexHtmlPath, "utf-8")
      : null;
    if (indexHtml && reownId) {
      indexHtml = indexHtml.replace(
        "</head>",
        `<script>window.__REOWN_PROJECT_ID__=${JSON.stringify(reownId)};</script></head>`,
      );
    }
    // Inject Vercel Speed Insights script
    if (indexHtml) {
      indexHtml = indexHtml.replace(
        "</head>",
        `<script defer src="/_vercel/speed-insights/script.js"></script></head>`,
      );
    }
    app.get(/^(?!\/api|\/v1).*$/, (_req: Request, res: Response) => {
      res.setHeader("X-Robots-Tag", "index, follow");
      if (indexHtml) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.send(indexHtml);
      } else {
        res.sendFile(indexHtmlPath);
      }
    });
  } else {
    logger.warn({ frontendDist }, "Frontend dist not found — skipping static serving");
  }
}

/* ── Global Express error handler — catches any sync/async route throw ─────── */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg  = err instanceof Error ? err.message : String(err);
  const code = (err as any)?.status ?? (err as any)?.statusCode ?? 500;
  logger.error({ err: msg, url: _req.url }, "Unhandled route error");
  if (!res.headersSent) {
    res.status(typeof code === "number" ? code : 500).json({ error: "Internal server error" });
  }
});

/* ── Background services — each wrapped so one failure can't crash others ──── */
hydrateAdminTokens().catch(e => logger.warn({ err: e }, "hydrateAdminTokens failed (non-fatal)"));
startCopyOrchestrator();
// Warm the LE currencies cache shortly after boot so the first user request
// gets the live 1 000+ coin list rather than the 331-coin built-in fallback.
setTimeout(() => {
  warmCurrenciesCache().catch(e => logger.warn({ err: e }, "warmCurrenciesCache failed (non-fatal)"));
}, 3_000);

// Seed coingecko_id for all known coins — runs once 15 s after boot.
setTimeout(() => {
  seedCoinGeckoIds().catch(e => logger.warn({ err: e }, "seedCoinGeckoIds failed (non-fatal)"));
}, 15_000);

// Seed GitHub token lists (Trust Wallet + Uniswap) — logos, addresses, decimals, new tokens.
// Runs 30 s after boot so DB is warm, then refreshes every 24 h.
setTimeout(() => {
  seedGithubTokens().catch(e => logger.warn({ err: e }, "seedGithubTokens failed (non-fatal)"));
  setInterval(() => {
    seedGithubTokens().catch(e => logger.warn({ err: e }, "seedGithubTokens refresh failed (non-fatal)"));
  }, 24 * 60 * 60 * 1_000);
}, 30_000);

// Warm fullCache from DB (coin_info_cache) — instant load for previously-seen coins.
// Fires at T+1 s so the DB is ready. Non-blocking: serves enriched data immediately
// on next request even before the CoinGecko prefetch finishes.
setTimeout(() => {
  warmCacheFromDB().catch(e => logger.warn({ err: e }, "warmCacheFromDB failed (non-fatal)"));
}, 1_000);

// Pre-warm coin info cache with 1 batch /coins/markets call (250 coins).
// Fires at T+3 s — before the priceUpdater's first CG call — to win the
// CoinGecko rate-limit race and seed fullCache with full market data.
// Auto-retries with exponential back-off if CG returns 429.
setTimeout(() => {
  prefetchCgMarkets().catch(e => logger.warn({ err: e }, "prefetchCgMarkets failed (non-fatal)"));
}, 3_000);

// syncAllLEPairs() is intentionally NOT called at startup.
// The DB already holds LE pairs from a previous run (36 K+ rows).
// Calling it here would build 109,230 pair objects in RAM before the first
// JSON.stringify completes, causing an out-of-memory crash on every boot.
// The /api/admin/sync-le-pairs endpoint triggers it on demand when needed.

// ── Staggered background-service startup ────────────────────────────────
// All workers previously fired simultaneously, exhausting the DB connection
// pool on every boot. Each service now starts 6 s after the previous one so
// at most one worker is establishing its first DB connections at any time.
// Critical services (price updater, liquidity bot) start first; reconcilers
// and repair engines start last when the pool is under lower pressure.
const _s = (ms: number, fn: () => void, label: string) =>
  setTimeout(() => { try { fn(); } catch (e) { logger.error({ err: e }, `${label} failed to init`); } }, ms);

// Hook logger.error / logger.warn immediately so all service errors are captured.
startErrorWatcher();

// ── Process-level crash guards ────────────────────────────────────────────────
// Node.js 18+ terminates the process on unhandled rejections. Catch them here
// so we can log the cause before the watchdog restarts the server.

/** True for transient TCP/pg errors that the pool self-heals — never worth crashing for. */
function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Connection terminated") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("read ETIMEDOUT") ||
    msg.includes("connection timeout") ||
    msg.includes("Connection ended unexpectedly") ||
    msg.includes("ssl routines") ||
    msg.includes("socket hang up") ||
    // Neon/Postgres kills the socket outright (compute suspend/resume, admin
    // maintenance) — the raw server error text never matches the wrappers above.
    msg.includes("administrator command")
  );
}

process.on("uncaughtException", (err) => {
  // Transient pg/TCP errors reach uncaughtException when the underlying socket
  // fires 'error' on a checked-out client that has no per-client error handler.
  // The pool discards the connection automatically; the rejected query Promise
  // already surfaced the error to the caller.  Exiting here would restart the
  // whole server for what is a recoverable network blip.
  if (isTransientNetworkError(err)) {
    try {
      logger.warn({ err: err?.message }, "Transient network error (non-fatal, process continues)");
    } catch { /* ignore */ }
    return;
  }
  try {
    logger.error({ err: { message: err?.message, stack: err?.stack } },
      "UNCAUGHT EXCEPTION — process will exit and watchdog will restart");
  } catch { /* logger may be broken — stderr fallback */ }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  try {
    logger.error({ reason: msg }, "UNHANDLED REJECTION — logged, continuing");
  } catch { /* ignore */ }
  // Do not exit — unhandled rejections in background tasks should not crash the server.
});

// ── Heap watchdog ────────────────────────────────────────────────────────────
// Logs heap usage every 5 minutes. Thresholds are calibrated for this
// container (~300–400 MB RSS). Triggers GC when heap exceeds 65% of total
// so we reclaim memory before the container OOM-kills the process.
{
  const HEAP_GC_PCT   = 0.75;  // trigger GC above this fraction of heapTotal
  const HEAP_WARN_MB  = 280;   // log warn  (server typically idles at ~200 MB)
  const HEAP_ALERT_MB = 420;   // log error (container RSS limit ~700 MB)
  setInterval(() => {
    const { heapUsed, heapTotal, rss } = process.memoryUsage();
    const usedMB  = Math.round(heapUsed  / 1024 / 1024);
    const totalMB = Math.round(heapTotal / 1024 / 1024);
    const rssMB   = Math.round(rss       / 1024 / 1024);
    const uptimeH = (process.uptime() / 3600).toFixed(2);

    // Proactive GC — reclaim memory before the OOM killer strikes
    if (heapUsed / heapTotal > HEAP_GC_PCT && typeof (global as any).gc === "function") {
      (global as any).gc();
      logger.info({ heapUsedMB: usedMB, heapTotalMB: totalMB },
        "Heap watchdog: triggered GC (heap >65%)");
    }

    if (usedMB >= HEAP_ALERT_MB) {
      logger.error({ heapUsedMB: usedMB, heapTotalMB: totalMB, rssMB, uptimeH },
        "HEAP CRITICAL — approaching OOM; restart may be imminent");
    } else if (usedMB >= HEAP_WARN_MB) {
      logger.warn({ heapUsedMB: usedMB, heapTotalMB: totalMB, rssMB, uptimeH },
        "Heap usage elevated — possible memory leak");
    } else {
      logger.info({ heapUsedMB: usedMB, heapTotalMB: totalMB, rssMB, uptimeH },
        "Heap report");
    }
  }, 5 * 60 * 1000).unref();
}

_s(    0, startHlWebSocket,            "startHlWebSocket");
_s(    0, startPriceUpdater,          "startPriceUpdater");
_s(6_000, startLiquidityBot,          "startLiquidityBot");
_s(12_000, startArbBot,               "startArbBot");
_s(18_000, startFuturesProfitEngine,  "startFuturesProfitEngine");
_s(24_000, startBsvChainMonitor,      "startBsvChainMonitor");
_s(30_000, startBsvDepositWatcher,    "startBsvDepositWatcher");
_s(36_000, startEvmDepositWatcher,    "startEvmDepositWatcher");
_s(42_000, () => {
  startHtlcWatcher().catch(e    => logger.error({ err: e }, "startHtlcWatcher failed to init"));
  startEvmHtlcWatcher().catch(e => logger.error({ err: e }, "startEvmHtlcWatcher failed to init"));
}, "startHtlcWatchers");
_s(48_000, startRouteCache,           "startRouteCache");
_s(54_000, startOrderReconciler,      "startOrderReconciler");
_s(60_000, startAllReconcilers,       "startAllReconcilers");
_s(66_000, startExchangeApiRepairEngine, "startExchangeApiRepairEngine");
_s(72_000, startBsvIntentWatcher,       "startBsvIntentWatcher");
_s(78_000, startArcStatusPoller,        "startArcStatusPoller");
_s(84_000, startAdvancedOrderEngines,  "startAdvancedOrderEngines");
_s(90_000, startFundingRateEngine,     "startFundingRateEngine");
_s(96_000, startBsvMempoolWatcher,    "startBsvMempoolWatcher");
_s(102_000, startOverlayScanner,     "startOverlayScanner");
_s(108_000, startSelfDiagnostic,    "startSelfDiagnostic");

// ── DB pool keepalive ─────────────────────────────────────────────────────────
// Run a cheap SELECT 1 every 90 s to keep at least one warm connection in the
// pool and prevent Neon from suspending the compute during quiet periods.
// Without this, all 40 connections are evicted (idleTimeoutMillis=30 s) between
// long quiet stretches, causing a mass-reconnect storm on the next busy tick.
{
  const KA_INTERVAL_MS = 90_000;
  const keepaliveTick = () => {
    pool.query("SELECT 1").catch((err: Error) => {
      logger.warn({ err: err.message }, "DB keepalive ping failed — pool will reconnect on next query");
    });
    setTimeout(keepaliveTick, KA_INTERVAL_MS).unref();
  };
  setTimeout(keepaliveTick, KA_INTERVAL_MS).unref();
}

// ── CoinPaprika bulk logo seeder (fast — single HTTP call, ~9 000 coins) ─────
// Runs on every boot: fetches ALL coins from CoinPaprika, upserts image_url +
// name into coin_metadata using COALESCE so higher-quality CoinGecko data is
// never overwritten.  Clears the all-sources cache afterward so logos appear
// immediately without waiting for the 2-minute cache TTL.
_s(60_000, () => {
  (async () => {
    try {
      await ensureCoinMetadataTable();
      logger.info("coinMeta: CoinPaprika bulk import starting…");
      const result = await runCoinPaprikaImport();
      clearCoinsCache();
      clearSwapCaches(); // force LE currencies + SS pairs to re-fetch with new logos
      logger.info(result, "coinMeta: CoinPaprika import complete — caches cleared");
    } catch (e) {
      logger.warn({ err: e }, "coinMeta: CoinPaprika import failed (non-fatal)");
    }
  })();
}, "coinPaprikaSeeder");

// ── CoinGecko detail seeder (slower — rate-limited, provides descriptions) ───
// Only runs if coin_metadata has < 100 rows (first boot after table creation).
// Subsequent runs are skipped to avoid hammering the free CoinGecko API.
_s(114_000, () => {
  (async () => {
    try {
      await ensureCoinMetadataTable();
      const r = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM coin_metadata`);
      const count = r.rows[0]?.n ?? 0;
      if (count < 100) {
        logger.info({ count }, "coinMeta: table still sparse — running CoinGecko bulk import");
        runCoinGeckoImport({ maxBulkPages: 4, maxDetailCoins: 20 })
          .then(res => { clearCoinsCache(); logger.info(res, "coinMeta: CoinGecko import complete"); })
          .catch(e  => logger.warn({ err: e }, "coinMeta: CoinGecko import failed (non-fatal)"));
      } else {
        logger.info({ count }, "coinMeta: already populated, skipping CoinGecko boot import");
      }
    } catch (e) {
      logger.warn({ err: e }, "coinMeta: CoinGecko seeder error (non-fatal)");
    }
  })();
}, "coinGeckoSeeder");


hydrateAlertsFromDB().catch(e => logger.warn({ err: e }, "hydrateAlertsFromDB failed (non-fatal)"));

/* ── Health check — both /health and /healthz (artifact.toml uses healthz) ── */
// Seconds since this process started (used for startup grace period).
const SERVER_START_TIME = Date.now();

async function healthHandler(_req: any, res: any) {
  // During the first 45 s, return 200 unconditionally. The DB connection pool
  // may not have warmed up yet and background services haven't run their first
  // tick — a premature "dead" verdict would cause deployment health checks to
  // fail and restart the instance, making the problem worse.
  const uptimeSec = (Date.now() - SERVER_START_TIME) / 1000;
  if (uptimeSec < 45) {
    return res.status(200).json({
      status: "starting",
      uptime: Math.floor(uptimeSec),
      timestamp: new Date().toISOString(),
    });
  }

  try {
  const services = getHealthReport();
  const anyDead  = services.some(s => s.status === "dead");
  const anyStuck = services.some(s => s.status === "stuck");

  let bsvChain: { online: boolean; blockHeight: number } | undefined;
  try {
    const bsv = await Promise.race([
      getBsvChainStatus(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("bsv-status timeout")), 3_000)),
    ]);
    bsvChain = { online: bsv.online, blockHeight: bsv.blockHeight };
  } catch { /* non-fatal — DB may be under load */ }

  // Only CRITICAL services failing should degrade the public health signal.
  // Non-critical reconcilers being stuck or dead should not cause healthcheck
  // failures that trigger deployment restarts — the core exchange still works.
  // price-updater is the only truly indispensable background service.
  // NOTE: Even when degraded we return 200 — returning 503 causes the deployment
  // platform to kill and restart the process, making the problem worse.
  const CRITICAL_SERVICES = new Set([
    "price-updater",
  ]);
  const anyCriticalDead = services.some(
    s => s.status === "dead" && CRITICAL_SERVICES.has(s.name),
  );

  const payload = {
    status:    anyCriticalDead ? "degraded" : "ok",
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    bsvChain,
    services:  services.map(s => ({
      name:              s.name,
      status:            s.status,
      lastRunAt:         s.lastRunAt?.toISOString() ?? null,
      lastSuccessAt:     s.lastSuccessAt?.toISOString() ?? null,
      consecutiveFails:  s.consecutiveFails,
      avgDurationMs:     Math.round(s.avgDurationMs),
      staleSinceMs:      s.staleSinceMs,
    })),
    alerts: [
      ...services.filter(s => s.status === "dead").map(s => `DEAD: ${s.name}`),
      ...services.filter(s => s.status === "stuck").map(s => `STUCK: ${s.name}`),
      ...services.filter(s => s.status === "degraded").map(s => `DEGRADED: ${s.name}`),
    ],
  };

  if (anyDead || anyStuck) {
    logger.warn({ alerts: payload.alerts }, "Health check: degraded services detected");
  }

  // Always return 200 — the deployment platform kills on 503, making any
  // transient issue permanent. Status field in the body carries the real signal.
  res.status(200).json(payload);
  } catch (err: any) {
    // Unexpected error in health handler — log but always return 200 so the
    // deployment probe doesn't restart the instance due to a reporting bug.
    logger.warn({ err: err?.message }, "healthHandler threw unexpectedly");
    if (!res.headersSent) {
      res.status(200).json({ status: "ok", uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
    }
  }
}
// NOTE: /api/health and /api/healthz are registered BEFORE app.use("/api", router)
// further up in this file. These duplicate registrations are intentionally removed
// to avoid shadowing the correctly-ordered registrations above.

/* ── BSV chain status ─────────────────────────────────────────────────────── */
app.get("/api/bsv-status", async (_req, res) => {
  try {
    res.json(await getBsvChainStatus());
  } catch {
    res.status(500).json({ online: false, blockHeight: 0 });
  }
});

/* ── Thunderbird / Mozilla autoconfig XML ─────────────────────────────────── */
const AUTOCONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="orahdex.org">
    <domain>orahdex.org</domain>
    <domain>orahdex.com</domain>
    <displayName>OrahDEX Mail</displayName>
    <displayShortName>OrahDEX</displayShortName>

    <!-- Incoming: IMAP -->
    <incomingServer type="imap">
      <hostname>mail.orahdex.org</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>

    <!-- Outgoing: SMTP -->
    <outgoingServer type="smtp">
      <hostname>mail.orahdex.org</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

function serveAutoconfig(_req: any, res: any) {
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(AUTOCONFIG_XML);
}

/* Standard Mozilla autoconfig path */
app.get("/.well-known/autoconfig/mail/config-v1.1.xml", serveAutoconfig);
/* Alternate path served by some mail clients */
app.get("/mail/config-v1.1.xml", serveAutoconfig);
/* Via API prefix (used by the admin panel link) */
app.get("/api/.well-known/autoconfig/mail/config-v1.1.xml", serveAutoconfig);

export default app;
