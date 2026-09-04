/**
 * staking.ts — OrahDEX Staking Hub
 *
 * Two products in one:
 *   1. Providers directory — for each PoS coin, list external staking providers
 *      (Validatrium, Everstake, Lido, Ankr, …) with deep-link URLs.
 *      Mirrors the LetsExchange "Staking providers" widget.
 *   2. Native staking — users lock their OrahDEX balance for a fixed APY;
 *      positions are tracked in the staking_positions table.
 *
 * Routes:
 *   GET  /api/staking/coins              — all stakeable PoS coins with APY + providers
 *   GET  /api/staking/providers          — all providers (optionally filter by ?coin=)
 *   GET  /api/staking/positions          — user positions (?walletAddress=)
 *   POST /api/staking/stake              — open a native position
 *   POST /api/staking/unstake/:id        — request early/final unstake
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { stakingPositionsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { issueStakeChallenge, verifyStakeSignature } from "../lib/walletAuth.js";
import crypto from "node:crypto";

const router: IRouter = Router();

// ── PoS coin catalogue ───────────────────────────────────────────────────────
// apy: estimated on-chain APY (%), lockDays: unbonding period (0 = liquid)
// nativeApy: OrahDEX-native fixed APY offered for that coin
export const POS_COINS = [
  { symbol: "ETH",   name: "Ethereum",        apy: 3.5,  nativeApy: 3.2,  lockDays: 0,   minStake: 0.01,    chain: "ETH"  },
  { symbol: "SOL",   name: "Solana",           apy: 6.8,  nativeApy: 6.2,  lockDays: 0,   minStake: 0.1,     chain: "SOL"  },
  { symbol: "ADA",   name: "Cardano",          apy: 3.2,  nativeApy: 3.0,  lockDays: 5,   minStake: 5,       chain: "ADA"  },
  { symbol: "DOT",   name: "Polkadot",         apy: 14.1, nativeApy: 12.5, lockDays: 28,  minStake: 10,      chain: "DOT"  },
  { symbol: "ATOM",  name: "Cosmos",           apy: 19.1, nativeApy: 17.0, lockDays: 21,  minStake: 1,       chain: "ATOM" },
  { symbol: "MATIC", name: "Polygon",          apy: 4.8,  nativeApy: 4.2,  lockDays: 0,   minStake: 1,       chain: "MATIC"},
  { symbol: "BNB",   name: "BNB Chain",        apy: 8.0,  nativeApy: 7.0,  lockDays: 0,   minStake: 0.1,     chain: "BNB"  },
  { symbol: "AVAX",  name: "Avalanche",        apy: 8.2,  nativeApy: 7.5,  lockDays: 14,  minStake: 25,      chain: "AVAX" },
  { symbol: "NEAR",  name: "NEAR Protocol",    apy: 9.5,  nativeApy: 8.8,  lockDays: 0,   minStake: 1,       chain: "NEAR" },
  { symbol: "ALGO",  name: "Algorand",         apy: 4.5,  nativeApy: 4.0,  lockDays: 0,   minStake: 1,       chain: "ALGO" },
  { symbol: "XTZ",   name: "Tezos",            apy: 5.5,  nativeApy: 5.0,  lockDays: 0,   minStake: 0.1,     chain: "XTZ"  },
  { symbol: "TRX",   name: "TRON",             apy: 4.1,  nativeApy: 3.8,  lockDays: 3,   minStake: 1,       chain: "TRX"  },
  { symbol: "ONE",   name: "Harmony",          apy: 5.0,  nativeApy: 4.5,  lockDays: 7,   minStake: 100,     chain: "ONE"  },
  { symbol: "EGLD",  name: "MultiversX",       apy: 9.2,  nativeApy: 8.5,  lockDays: 10,  minStake: 1,       chain: "EGLD" },
  { symbol: "FTM",   name: "Fantom",           apy: 3.5,  nativeApy: 3.2,  lockDays: 0,   minStake: 1,       chain: "FTM"  },
  { symbol: "ROSE",  name: "Oasis",            apy: 10.0, nativeApy: 9.0,  lockDays: 14,  minStake: 100,     chain: "ROSE" },
  { symbol: "KAVA",  name: "Kava",             apy: 17.5, nativeApy: 15.5, lockDays: 21,  minStake: 10,      chain: "KAVA" },
  { symbol: "INJ",   name: "Injective",        apy: 14.0, nativeApy: 12.5, lockDays: 21,  minStake: 0.1,     chain: "INJ"  },
  { symbol: "OSMO",  name: "Osmosis",          apy: 14.5, nativeApy: 13.0, lockDays: 14,  minStake: 0.1,     chain: "OSMO" },
  { symbol: "STARS", name: "Stargaze",         apy: 20.0, nativeApy: 18.0, lockDays: 14,  minStake: 1,       chain: "STARS"},
  { symbol: "JUNO",  name: "Juno",             apy: 8.0,  nativeApy: 7.0,  lockDays: 28,  minStake: 0.1,     chain: "JUNO" },
  { symbol: "AKT",   name: "Akash",            apy: 16.0, nativeApy: 14.5, lockDays: 21,  minStake: 0.1,     chain: "AKT"  },
  { symbol: "SCRT",  name: "Secret",           apy: 18.5, nativeApy: 16.5, lockDays: 21,  minStake: 0.1,     chain: "SCRT" },
  { symbol: "DYM",   name: "Dymension",        apy: 30.0, nativeApy: 26.0, lockDays: 21,  minStake: 1,       chain: "DYM"  },
  { symbol: "NTRN",  name: "Neutron",          apy: 8.0,  nativeApy: 7.0,  lockDays: 21,  minStake: 1,       chain: "NTRN" },
  { symbol: "BAND",  name: "Band Protocol",    apy: 12.0, nativeApy: 10.5, lockDays: 21,  minStake: 1,       chain: "BAND" },
  { symbol: "KSM",   name: "Kusama",           apy: 16.0, nativeApy: 14.0, lockDays: 28,  minStake: 0.1,     chain: "KSM"  },
  { symbol: "LUNA",  name: "Terra Luna",       apy: 8.0,  nativeApy: 7.0,  lockDays: 21,  minStake: 1,       chain: "LUNA" },
  { symbol: "SEI",   name: "Sei Network",      apy: 10.0, nativeApy: 9.0,  lockDays: 21,  minStake: 1,       chain: "SEI"  },
  { symbol: "SUI",   name: "Sui",              apy: 3.5,  nativeApy: 3.2,  lockDays: 0,   minStake: 1,       chain: "SUI"  },
  { symbol: "APT",   name: "Aptos",            apy: 7.0,  nativeApy: 6.5,  lockDays: 0,   minStake: 11,      chain: "APT"  },
  { symbol: "FLR",   name: "Flare",            apy: 4.0,  nativeApy: 3.5,  lockDays: 0,   minStake: 1,       chain: "FLR"  },
  { symbol: "EVMOS", name: "Evmos",            apy: 35.0, nativeApy: 30.0, lockDays: 14,  minStake: 1,       chain: "EVMOS"},
  { symbol: "STRD",  name: "Stride",           apy: 15.0, nativeApy: 13.5, lockDays: 21,  minStake: 1,       chain: "STRD" },
  { symbol: "CELO",  name: "Celo",             apy: 4.0,  nativeApy: 3.6,  lockDays: 3,   minStake: 10000,   chain: "CELO" },
  { symbol: "ICX",   name: "ICON",             apy: 6.5,  nativeApy: 6.0,  lockDays: 0,   minStake: 1000,    chain: "ICX"  },
  { symbol: "ZIL",   name: "Zilliqa",          apy: 8.0,  nativeApy: 7.2,  lockDays: 0,   minStake: 1000,    chain: "ZIL"  },
  { symbol: "VET",   name: "VeChain",          apy: 1.8,  nativeApy: 1.6,  lockDays: 0,   minStake: 1000000, chain: "VET"  },
  { symbol: "ICP",   name: "Internet Computer",apy: 12.0, nativeApy: 10.5, lockDays: 180, minStake: 1,       chain: "ICP"  },
  { symbol: "KDA",   name: "Kadena",           apy: 3.5,  nativeApy: 3.2,  lockDays: 0,   minStake: 1,       chain: "KDA"  },
  { symbol: "GLMR",  name: "Moonbeam",         apy: 8.0,  nativeApy: 7.0,  lockDays: 28,  minStake: 1,       chain: "GLMR" },
  { symbol: "MOVR",  name: "Moonriver",        apy: 9.5,  nativeApy: 8.5,  lockDays: 28,  minStake: 1,       chain: "MOVR" },
  { symbol: "CFX",   name: "Conflux",          apy: 12.5, nativeApy: 11.0, lockDays: 14,  minStake: 100,     chain: "CFX"  },
];

// ── Staking providers directory ──────────────────────────────────────────────
// coins: which PoS coins this provider supports
const PROVIDERS = [
  {
    id: "lido",
    name: "Lido",
    logo: "https://lido.fi/favicon-32x32.png",
    url: "https://lido.fi",
    description: "Liquid staking — stake without locking. Receive stETH/stSOL instantly.",
    coins: ["ETH", "SOL", "MATIC"],
    tvl: "32B",
    rating: 4.9,
  },
  {
    id: "everstake",
    name: "Everstake",
    logo: "https://everstake.one/favicon.ico",
    url: "https://everstake.one",
    description: "Trusted non-custodial validator. 650k+ stakers across 70+ networks.",
    coins: ["ETH","SOL","ADA","ATOM","DOT","AVAX","NEAR","ALGO","XTZ","ONE","EGLD",
            "OSMO","JUNO","AKT","SCRT","BAND","KSM","LUNA","SEI","APT","FTM","INJ"],
    tvl: "3.5B",
    rating: 4.8,
  },
  {
    id: "validatrium",
    name: "Validatrium",
    logo: "https://validatrium.com/favicon.ico",
    url: "https://validatrium.com",
    description: "Professional validator infrastructure. High uptime, institutional-grade security.",
    coins: ["ETH","SOL","ATOM","DOT","MATIC","AVAX","NEAR","INJ","OSMO","STARS",
            "JUNO","AKT","SCRT","DYM","NTRN","BAND","STRD","EVMOS","SEI"],
    tvl: "280M",
    rating: 4.7,
  },
  {
    id: "ankr",
    name: "Ankr",
    logo: "https://www.ankr.com/favicon.ico",
    url: "https://www.ankr.com/staking/",
    description: "DeFi-native liquid staking. Stake and use ankr tokens across DeFi.",
    coins: ["ETH","SOL","MATIC","BNB","AVAX","DOT","FTM","ONE"],
    tvl: "580M",
    rating: 4.5,
  },
  {
    id: "chorus-one",
    name: "Chorus One",
    logo: "https://chorus.one/favicon.ico",
    url: "https://chorus.one",
    description: "Institutional-grade staking. Research-driven validator across 40+ networks.",
    coins: ["ETH","SOL","ATOM","DOT","NEAR","AVAX","INJ","OSMO","EGLD","KSM","BAND"],
    tvl: "1.2B",
    rating: 4.8,
  },
  {
    id: "rocket-pool",
    name: "Rocket Pool",
    logo: "https://rocketpool.net/favicon.ico",
    url: "https://rocketpool.net",
    description: "Decentralized ETH staking. Run your own node or stake as little as 0.01 ETH.",
    coins: ["ETH"],
    tvl: "2.8B",
    rating: 4.9,
  },
  {
    id: "marinade",
    name: "Marinade Finance",
    logo: "https://marinade.finance/favicon.ico",
    url: "https://marinade.finance",
    description: "SOL liquid staking. Receive mSOL and keep earning across Solana DeFi.",
    coins: ["SOL"],
    tvl: "540M",
    rating: 4.8,
  },
  {
    id: "stakefish",
    name: "Stakefish",
    logo: "https://stake.fish/favicon.ico",
    url: "https://stake.fish",
    description: "Leading staking service for PoS blockchains. Institutional & retail.",
    coins: ["ETH","SOL","ADA","DOT","ATOM","AVAX","MATIC","NEAR","ALGO","FTM","TRX"],
    tvl: "900M",
    rating: 4.6,
  },
  {
    id: "figment",
    name: "Figment",
    logo: "https://figment.io/favicon.ico",
    url: "https://figment.io/staking/",
    description: "Enterprise staking infrastructure. 200+ institutional clients.",
    coins: ["ETH","SOL","ADA","DOT","ATOM","AVAX","NEAR","ALGO","KSM","EGLD"],
    tvl: "12B",
    rating: 4.9,
  },
  {
    id: "p2p",
    name: "P2P.org",
    logo: "https://p2p.org/favicon.ico",
    url: "https://p2p.org",
    description: "Non-custodial staking for institutions. 45B+ AUM, 25+ networks.",
    coins: ["ETH","SOL","ADA","DOT","ATOM","BNB","AVAX","NEAR","INJ","OSMO",
            "EVMOS","JUNO","SCRT","AKT","BAND","KSM","SEI","DYM","STRD"],
    tvl: "8B",
    rating: 4.8,
  },
];

// ── GET /api/staking/coins ────────────────────────────────────────────────────
router.get("/staking/coins", (_req, res) => {
  const coins = POS_COINS.map(c => ({
    ...c,
    providers: PROVIDERS
      .filter(p => p.coins.includes(c.symbol))
      .map(p => ({ id: p.id, name: p.name, logo: p.logo, url: p.url, tvl: p.tvl, rating: p.rating })),
  }));
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    coins,
    dataSource: "static",
    custodialDisclosure: {
      nativeStaking: {
        type: "off-chain-custodial",
        description:
          "OrahDEX Native Staking records positions in an internal ledger. " +
          "Your staked assets remain under OrahDEX custody and are NOT locked " +
          "in any on-chain smart contract. Rewards are credited by OrahDEX off-chain. " +
          "This is a custodial product — not permissionless on-chain DeFi staking.",
        riskWarning: "Custodial staking carries platform risk. Consider using the listed third-party providers for non-custodial staking.",
      },
    },
  });
});

// ── GET /api/staking/providers ────────────────────────────────────────────────
router.get("/staking/providers", (req, res) => {
  const coin = typeof req.query.coin === "string" ? req.query.coin.toUpperCase() : null;
  const result = coin
    ? PROVIDERS.filter(p => p.coins.includes(coin))
    : PROVIDERS;
  res.set("Cache-Control", "public, max-age=300");
  res.json(result);
});

// ── GET /api/staking/positions ────────────────────────────────────────────────
router.get("/staking/positions", async (req, res) => {
  const walletAddress = typeof req.query.walletAddress === "string" ? req.query.walletAddress.toLowerCase() : null;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress required" }); return; }
  try {
    const positions = await db
      .select()
      .from(stakingPositionsTable)
      .where(eq(stakingPositionsTable.walletAddress, walletAddress));

    const now = Date.now();
    const enriched = positions.map(p => {
      const started    = p.startedAt.getTime();
      const unlocks    = p.unlocksAt.getTime();
      const elapsedMs  = Math.max(0, now - started);
      const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
      const amount     = parseFloat(String(p.amount));
      const apy        = parseFloat(String(p.apy));
      const rewardAccrued = amount * (apy / 100) * (elapsedDays / 365);
      const daysRemaining = Math.max(0, Math.ceil((unlocks - now) / (1000 * 60 * 60 * 24)));
      return {
        ...p,
        rewardAccrued: rewardAccrued.toFixed(8),
        daysRemaining,
        canUnstake: daysRemaining === 0 && p.status === "active",
      };
    });
    res.json(enriched);
  } catch (err: any) {
    logger.error({ err }, "staking /positions failed");
    res.status(500).json({ error: "Failed to fetch staking positions" });
  }
});

// ── POST /api/staking/challenge ───────────────────────────────────────────────
// Issues a single-use, 5-minute signing challenge for EVM wallets.
// The client signs the returned `message` and includes nonce+signature in /stake.
router.post("/staking/challenge", (req, res) => {
  const { walletAddress, coin, amount, lockDays } = req.body ?? {};
  if (!walletAddress || !coin || !amount || lockDays == null || lockDays === "") {
    res.status(400).json({ error: "walletAddress, coin, amount and lockDays are required" });
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/i.test(String(walletAddress))) {
    res.status(400).json({ error: "Signing challenge is only required for EVM wallets (0x…)" });
    return;
  }
  const challenge = issueStakeChallenge({
    walletAddress: String(walletAddress).toLowerCase(),
    coin:          String(coin).toUpperCase(),
    amount:        String(amount),
    lockDays:      parseInt(String(lockDays), 10),
  });
  res.json(challenge);
});

// ── POST /api/staking/stake ───────────────────────────────────────────────────
router.post("/staking/stake", async (req, res) => {
  const { walletAddress, coin, amount, lockDays, nonce, signature } = req.body ?? {};
  if (!walletAddress || !coin || !amount || !lockDays) {
    res.status(400).json({ error: "walletAddress, coin, amount and lockDays are required" });
    return;
  }
  const amt = parseFloat(String(amount));
  if (!isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be positive" });
    return;
  }
  const days = parseInt(String(lockDays), 10);
  if (isNaN(days) || days < 0) {
    res.status(400).json({ error: "lockDays must be 0 or a positive integer" });
    return;
  }
  const coinMeta = POS_COINS.find(c => c.symbol === String(coin).toUpperCase());
  if (!coinMeta) {
    res.status(400).json({ error: "Coin not supported for staking" });
    return;
  }
  if (amt < coinMeta.minStake) {
    res.status(400).json({ error: `Minimum stake is ${coinMeta.minStake} ${coinMeta.symbol}` });
    return;
  }

  // ── Signature verification (required for external EVM wallets) ───────────
  const addrStr = String(walletAddress);
  const isEvmWallet = /^0x[0-9a-fA-F]{40}$/i.test(addrStr);
  if (isEvmWallet) {
    if (!nonce || !signature) {
      res.status(401).json({
        error: "EVM wallets must sign a staking challenge. " +
               "Obtain a challenge via POST /staking/challenge and include nonce + signature.",
      });
      return;
    }
    try {
      verifyStakeSignature({
        walletAddress: addrStr,
        nonce:         String(nonce),
        signature:     String(signature),
        coin:          coinMeta.symbol,
        lockDays:      days,
      });
    } catch (err: any) {
      logger.warn({ err: err?.message, walletAddress: addrStr }, "staking: signature verification failed");
      res.status(401).json({ error: "Invalid stake signature" });
      return;
    }
  }

  const apy       = coinMeta.nativeApy;
  const now       = new Date();
  const unlocksAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const id        = crypto.randomUUID();

  try {
    const [inserted] = await db.insert(stakingPositionsTable).values({
      id,
      walletAddress:  String(walletAddress).toLowerCase(),
      coin:           coinMeta.symbol,
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
      message: `Staking ${amt} ${coinMeta.symbol} for ${days} days at ${apy}% APY`,
    });
  } catch (err: any) {
    logger.error({ err }, "staking /stake failed");
    res.status(500).json({ error: "Failed to create staking position" });
  }
});

// ── POST /api/staking/unstake/:id ─────────────────────────────────────────────
router.post("/staking/unstake/:id", async (req, res) => {
  const { id } = req.params;
  const { walletAddress } = req.body ?? {};
  if (!id || !walletAddress) {
    res.status(400).json({ error: "id and walletAddress are required" });
    return;
  }
  try {
    const [existing] = await db
      .select()
      .from(stakingPositionsTable)
      .where(and(
        eq(stakingPositionsTable.id, id),
        eq(stakingPositionsTable.walletAddress, String(walletAddress).toLowerCase()),
      ));

    if (!existing) {
      res.status(404).json({ error: "Position not found" });
      return;
    }
    if (existing.status !== "active") {
      res.status(400).json({ error: `Position is already ${existing.status}` });
      return;
    }

    // Enforce lock period — server-side guard (canUnstake in /positions is UI-only)
    if (existing.unlocksAt && new Date(existing.unlocksAt) > new Date()) {
      const msLeft = new Date(existing.unlocksAt).getTime() - Date.now();
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
      res.status(400).json({
        error: `Position is still locked for ${daysLeft} more day${daysLeft === 1 ? "" : "s"}`,
        unlocksAt: existing.unlocksAt,
      });
      return;
    }

    const [updated] = await db
      .update(stakingPositionsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(stakingPositionsTable.id, id))
      .returning();

    res.json({ ...updated, message: "Position unstaked successfully" });
  } catch (err: any) {
    logger.error({ err }, "staking /unstake failed");
    res.status(500).json({ error: "Failed to unstake position" });
  }
});

export default router;
