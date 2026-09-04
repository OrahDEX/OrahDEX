/**
 * lpStaking.ts — OrahDEX Liquidity Staking
 *
 * Users deposit a single coin into a liquidity pool to back exchange depth
 * and earn trading-fee rewards + a lock-period APY bonus.
 *
 * Routes:
 *   GET  /api/lp/pools              — all pools with TVL, APY, 24h fee share
 *   GET  /api/lp/positions          — user's active/withdrawn LP positions
 *   POST /api/lp/deposit            — open a new LP position
 *   POST /api/lp/withdraw/:id       — withdraw principal + accrued rewards
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { lpPositionsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { debitAvailable, creditAvailable } from "../lib/ledger.js";
import crypto from "node:crypto";

const router: IRouter = Router();

// ── Pool catalogue ────────────────────────────────────────────────────────────
// baseApy: trading-fee share APY (% of 0.25% fee pool)
// Pools are single-sided — user deposits ONE side (coinA or coinB)

export const LP_POOLS = [
  {
    id:       "BSV/USDT",
    coinA:    "BSV",
    coinB:    "USDT",
    baseApy:  12.0,
    label:    "BSV / USDT",
    featured: true,
    description: "The core BSV settlement pool. Powers all BSV↔USDT spot trades on OrahDEX.",
  },
  {
    id:       "BTC/USDT",
    coinA:    "BTC",
    coinB:    "USDT",
    baseApy:  8.5,
    label:    "BTC / USDT",
    featured: true,
    description: "High-volume Bitcoin pool. Earns a share of all BTC↔USDT trading fees.",
  },
  {
    id:       "ETH/USDT",
    coinA:    "ETH",
    coinB:    "USDT",
    baseApy:  9.0,
    label:    "ETH / USDT",
    featured: true,
    description: "Ethereum liquidity pool. Backs ETH↔USDT spot and bridge settlement.",
  },
  {
    id:       "SOL/USDT",
    coinA:    "SOL",
    coinB:    "USDT",
    baseApy:  10.5,
    label:    "SOL / USDT",
    featured: false,
    description: "Solana pool with elevated APY due to higher price volatility.",
  },
  {
    id:       "BNB/USDT",
    coinA:    "BNB",
    coinB:    "USDT",
    baseApy:  8.0,
    label:    "BNB / USDT",
    featured: false,
    description: "BNB Chain pool backing BNB↔USDT trades and BEP-20 bridge flows.",
  },
];

// Lock-period bonus APY on top of baseApy
export const LP_LOCK_TIERS = [
  { days: 0,  label: "Flexible", bonus: 0 },
  { days: 7,  label: "7 days",   bonus: 2 },
  { days: 30, label: "30 days",  bonus: 5 },
  { days: 90, label: "90 days",  bonus: 10 },
];

// Minimum deposit per coin
const MIN_DEPOSIT: Record<string, number> = {
  BSV:  1,
  BTC:  0.0001,
  ETH:  0.005,
  SOL:  0.05,
  BNB:  0.01,
  USDT: 5,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcReward(amount: number, apy: number, startedAt: Date): number {
  const elapsedDays = (Date.now() - startedAt.getTime()) / (1000 * 60 * 60 * 24);
  return amount * (apy / 100) * (elapsedDays / 365);
}

// ── GET /api/lp/pools ─────────────────────────────────────────────────────────
router.get("/lp/pools", async (_req, res) => {
  try {
    // Aggregate active positions per pool for real TVL
    const tvlRows = await db
      .select({
        pool:   lpPositionsTable.pool,
        coin:   lpPositionsTable.coin,
        total:  sql<string>`SUM(${lpPositionsTable.amount})`,
        count:  sql<number>`COUNT(*)`,
      })
      .from(lpPositionsTable)
      .where(eq(lpPositionsTable.status, "active"))
      .groupBy(lpPositionsTable.pool, lpPositionsTable.coin);

    const tvlMap: Record<string, Record<string, number>> = {};
    for (const row of tvlRows) {
      if (!tvlMap[row.pool]) tvlMap[row.pool] = {};
      tvlMap[row.pool][row.coin] = parseFloat(row.total ?? "0");
    }

    const pools = LP_POOLS.map(p => ({
      ...p,
      lockTiers: LP_LOCK_TIERS,
      minDeposit: {
        [p.coinA]: MIN_DEPOSIT[p.coinA] ?? 1,
        [p.coinB]: MIN_DEPOSIT[p.coinB] ?? 5,
      },
      tvl: tvlMap[p.id] ?? {},
    }));

    res.json(pools);
  } catch (err: any) {
    logger.error({ err }, "lp /pools failed");
    res.status(500).json({ error: "Failed to load pools" });
  }
});

// ── GET /api/lp/positions ─────────────────────────────────────────────────────
router.get("/lp/positions", async (req, res) => {
  const walletAddress = String(req.query.walletAddress ?? "").toLowerCase().trim();
  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress is required" });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(lpPositionsTable)
      .where(eq(lpPositionsTable.walletAddress, walletAddress))
      .orderBy(lpPositionsTable.startedAt);

    const positions = rows.map(r => {
      const amt       = parseFloat(String(r.amount));
      const apy       = parseFloat(String(r.apy));
      const startedAt = new Date(r.startedAt);
      const unlocksAt = new Date(r.unlocksAt);
      const reward    = r.status === "active" ? calcReward(amt, apy, startedAt) : parseFloat(String(r.rewardAccrued));
      const daysLeft  = Math.max(0, Math.ceil((unlocksAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
      return {
        ...r,
        rewardAccrued: reward.toFixed(8),
        daysRemaining: daysLeft,
        canWithdraw:   r.status === "active" && new Date(r.unlocksAt) <= new Date(),
      };
    });

    res.json(positions);
  } catch (err: any) {
    logger.error({ err }, "lp /positions failed");
    res.status(500).json({ error: "Failed to load positions" });
  }
});

// ── POST /api/lp/deposit ──────────────────────────────────────────────────────
router.post("/lp/deposit", async (req, res) => {
  const { walletAddress, pool, coin, amount, lockDays } = req.body ?? {};

  if (!walletAddress || !pool || !coin || !amount) {
    res.status(400).json({ error: "walletAddress, pool, coin and amount are required" });
    return;
  }

  const poolMeta = LP_POOLS.find(p => p.id === pool);
  if (!poolMeta) {
    res.status(400).json({ error: `Unknown pool: ${pool}` });
    return;
  }

  if (coin !== poolMeta.coinA && coin !== poolMeta.coinB) {
    res.status(400).json({ error: `${coin} is not part of the ${pool} pool` });
    return;
  }

  const amt  = parseFloat(String(amount));
  const days = parseInt(String(lockDays ?? 0), 10);

  if (!isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const minDeposit = MIN_DEPOSIT[coin] ?? 1;
  if (amt < minDeposit) {
    res.status(400).json({ error: `Minimum deposit for ${coin} is ${minDeposit}` });
    return;
  }

  const tier = LP_LOCK_TIERS.find(t => t.days === days) ?? LP_LOCK_TIERS[0];
  const apy  = poolMeta.baseApy + tier.bonus;

  const now       = new Date();
  const unlocksAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const id        = crypto.randomUUID();

  try {
    // ── Debit the user's exchange balance first ───────────────────────────────
    // Throws INSUFFICIENT_FUNDS if they don't have enough available.
    await debitAvailable(String(walletAddress), coin, String(amt));

    const [inserted] = await db.insert(lpPositionsTable).values({
      id,
      walletAddress:  String(walletAddress).toLowerCase(),
      pool:           poolMeta.id,
      coin,
      amount:         String(amt),
      apy:            String(apy),
      lockDays:       String(days),
      status:         "active",
      rewardAccrued:  "0",
      startedAt:      now,
      unlocksAt,
    }).returning();

    res.json({
      ...inserted,
      message: `Deposited ${amt} ${coin} into ${pool} pool at ${apy}% APY`,
    });
  } catch (err: any) {
    if (String(err?.message).startsWith("INSUFFICIENT_FUNDS")) {
      const parts = String(err.message).split(":");
      const have = parts[2]?.replace("have ", "") ?? "0";
      res.status(400).json({ error: `Insufficient ${coin} balance. Available: ${parseFloat(have).toFixed(8)} ${coin}` });
      return;
    }
    logger.error({ err }, "lp /deposit failed");
    res.status(500).json({ error: "Failed to create LP position" });
  }
});

// ── POST /api/lp/withdraw/:id ─────────────────────────────────────────────────
router.post("/lp/withdraw/:id", async (req, res) => {
  const { id } = req.params;
  const { walletAddress } = req.body ?? {};

  if (!id || !walletAddress) {
    res.status(400).json({ error: "id and walletAddress are required" });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(lpPositionsTable)
      .where(and(
        eq(lpPositionsTable.id, id),
        eq(lpPositionsTable.walletAddress, String(walletAddress).toLowerCase()),
      ));

    if (!existing) {
      res.status(404).json({ error: "Position not found" });
      return;
    }
    if (existing.status !== "active") {
      res.status(400).json({ error: `Position is already ${existing.status}` });
      return;
    }
    if (existing.unlocksAt && new Date(existing.unlocksAt) > new Date()) {
      const msLeft   = new Date(existing.unlocksAt).getTime() - Date.now();
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
      res.status(400).json({
        error: `Position is still locked for ${daysLeft} more day${daysLeft === 1 ? "" : "s"}`,
        unlocksAt: existing.unlocksAt,
      });
      return;
    }

    const amt       = parseFloat(String(existing.amount));
    const apy       = parseFloat(String(existing.apy));
    const reward    = calcReward(amt, apy, new Date(existing.startedAt));
    const total     = (amt + reward).toFixed(18);

    // ── Mark withdrawn first, then credit — any credit failure is logged
    //    but the position is still closed to prevent re-withdrawal ────────────
    const [updated] = await db
      .update(lpPositionsTable)
      .set({ status: "withdrawn", withdrawnAt: new Date(), rewardAccrued: String(reward.toFixed(8)) })
      .where(eq(lpPositionsTable.id, id))
      .returning();

    // Credit principal + accrued rewards back to exchange balance
    try {
      await creditAvailable(String(walletAddress), existing.coin, total);
    } catch (creditErr: any) {
      logger.error({ creditErr, walletAddress, coin: existing.coin, total }, "lp /withdraw: credit failed after marking withdrawn");
      // Position is already marked withdrawn — don't fail the response, but log for manual reconciliation
    }

    res.json({
      ...updated,
      rewardAccrued: reward.toFixed(8),
      message: `Withdrawn ${existing.amount} ${existing.coin} + ${reward.toFixed(8)} ${existing.coin} rewards`,
    });
  } catch (err: any) {
    logger.error({ err }, "lp /withdraw failed");
    res.status(500).json({ error: "Failed to withdraw position" });
  }
});

export default router;
