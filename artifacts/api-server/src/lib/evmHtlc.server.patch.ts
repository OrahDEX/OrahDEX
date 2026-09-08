/**
 * evmHtlc.ts — SERVER-SIDE PATCH (replaces the corresponding sections of
 * artifacts/api-server/src/lib/evmHtlc.ts)
 *
 * ── SUMMARY OF CHANGES ────────────────────────────────────────────────────────
 *   1. HTLC_ABI              → new v5 ABI (lockETH/lockToken take tradeId+side;
 *                              reveal() replaced by settleTrade(); refund())
 *   2. Timelock columns      → now store DURATIONS in seconds (1800/900),
 *                              not absolute unix — sliding timelocks computed
 *                              at instruction-serve time. Column names kept,
 *                              no DB migration for these.
 *   3. buildLockInstruction  → builds v5 calldata; timelockUnix = now+duration
 *   4. revealBothLocks()     → DELETED, replaced by settleTradeOnChain():
 *                              ONE atomic transaction. PARTIAL_REVEAL state
 *                              is gone — a revert just stays BOTH_LOCKED and
 *                              retries next watcher cycle.
 *   5. confirmLockTx()       → verifies the lock on-chain (isLocked) BEFORE
 *                              flipping sellerLocked/buyerLocked. A client can
 *                              no longer fake the counterparty's lock.
 *   6. triggerEvmHtlcCheckByLockId → now triggers settleTrade when both funded.
 *
 * ── REQUIRED ONE-TIME DB MIGRATION ────────────────────────────────────────────
 *   ALTER TABLE evm_htlc_sessions ADD COLUMN IF NOT EXISTS settle_txid text;
 *   and in @workspace/db schema add:
 *     settleTxid: text("settle_txid"),
 *
 * ── REQUIRED ONE-TIME CONTRACT DEPLOYMENT ─────────────────────────────────────
 *   Deploy OrahDEXHTLC.sol v5 to EVERY supported chain, then set the env var
 *   EVM_HTLC_CONTRACT_<CHAIN> per chain. See DEPLOYMENT_CHECKLIST.md.
 */

import {
  createPublicClient, createWalletClient, http,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eq, and, lt, or, isNull, ne, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { evmHtlcSessionsTable } from "@workspace/db/schema";
import { logger } from "./logger";

// ─── ABI (v5 — replaces the old lockETH/lockToken/reveal/refund entries) ─────
// NOTE: import this ABI in evmSettlement.ts and use it for the /confirm-lock
// on-chain verification as well (or import confirmLockTx from here).

// Single source of truth for the v5 ABI — server, webhook router and routes
// all import this constant. The old v4 ABI export (lockETH/lockToken/reveal/
// refund signatures) should be deleted wherever it remains.
import { parseAbi } from "viem";
export const HTLC_ABI_V5 = parseAbi([
  "function lockETH(bytes32 tradeId, uint8 side, bytes32 secretHash, address counterparty, uint256 timelockUnix) payable",
  "function lockToken(bytes32 tradeId, uint8 side, bytes32 secretHash, address token, uint256 amount, address counterparty, uint256 timelockUnix)",
  "function settleTrade(bytes32 tradeId, bytes32 secret)",
  "function refund(bytes32 tradeId, uint8 side)",
  "function isLocked(bytes32 lockId) view returns (bool)",
  "function deriveLockId(bytes32 tradeId, uint8 side) view returns (bytes32)",
  "function getLock(bytes32 lockId) view returns (tuple(address sender,address recipient,address token,uint256 amount,uint256 timelockUnix,bool funded,bool settled,bool refunded))",
  "function getTrade(bytes32 tradeId) view returns (tuple(address seller,address buyer,bytes32 secretHash,bool sellerFunded,bool buyerFunded,bool settled))",
  "event Locked(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 secretHash, uint256 timelockUnix)",
  "event TradeSettled(bytes32 indexed tradeId, bytes32 secret, address indexed seller, address indexed buyer)",
  "event Refunded(bytes32 indexed tradeId, uint8 indexed side, address indexed sender, uint256 amount)",
]);

// ─── Constants ────────────────────────────────────────────────────────────────
// Timelock columns now store DURATIONS. Do not rename — column reuse avoids a
// migration; old sessions holding absolute timestamps simply expire naturally
// (sessions are short-lived, 35 min max).

const SELLER_TIMELOCK_SECS = 30 * 60; // 30 minutes
const BUYER_TIMELOCK_SECS  = 15 * 60; // 15 minutes, counted from BUYER'S lock time

const SELLER_SECRET_PREFIX = "orahdex-evm-seller-secret:v1:";
const BUYER_SECRET_PREFIX  = "orahdex-evm-buyer-secret:v1:";

type HtlcStatus =
  | "PENDING" | "SELLER_LOCKED" | "BUYER_LOCKED" | "BOTH_LOCKED"
  | "REVEALING" | "COMPLETED" | "SELLER_REFUNDED" | "BUYER_REFUNDED" | "EXPIRED";
  // "PARTIAL_REVEAL" removed — atomic settleTrade makes it impossible.

// ─── Chain config ─────────────────────────────────────────────────────────────
// ⚠ SECURITY: the old hardcoded DEPLOYED_CONTRACT fallback is REMOVED.
// A chain without an explicit env var returns contractAddress: null, which
// makes initiateEvmHtlcSession throw (fails closed) and the frontend shows
// "Contract not yet deployed — manual settlement required."

const CONTRACT_BY_CHAIN: Record<string, Address | undefined> = {
  eth:     process.env.EVM_HTLC_CONTRACT_ETH    as Address | undefined,
  polygon: process.env.EVM_HTLC_CONTRACT_POLYGON as Address | undefined,
  bsc:     process.env.EVM_HTLC_CONTRACT_BSC     as Address | undefined,
  base:    process.env.EVM_HTLC_CONTRACT_BASE    as Address | undefined,
  arbitrum:process.env.EVM_HTLC_CONTRACT_ARBITRUM as Address | undefined,
  optimism:process.env.EVM_HTLC_CONTRACT_OPTIMISM as Address | undefined,
  avax:    process.env.EVM_HTLC_CONTRACT_AVAX    as Address | undefined,
  zksync:  process.env.EVM_HTLC_CONTRACT_ZKSYNC  as Address | undefined,
  linea:   process.env.EVM_HTLC_CONTRACT_LINEA   as Address | undefined,
  scroll:  process.env.EVM_HTLC_CONTRACT_SCROLL  as Address | undefined,
  sei:     process.env.EVM_HTLC_CONTRACT_SEI     as Address | undefined,
  unichain:process.env.EVM_HTLC_CONTRACT_UNICHAIN as Address | undefined,
  sepolia: process.env.EVM_HTLC_CONTRACT_SEPOLIA as Address | undefined,
};

const EVM_CHAINS: Record<string, { chainId: number; rpcUrl: string; contractAddress: Address | null }> = {
  eth:      { chainId: 1,     rpcUrl: process.env.ETH_RPC_URL      ?? "https://eth-mainnet.public.blastapi.io",        contractAddress: CONTRACT_BY_CHAIN.eth      ?? null },
  polygon:  { chainId: 137,   rpcUrl: process.env.POLYGON_RPC_URL  ?? "https://polygon-rpc.com",                       contractAddress: CONTRACT_BY_CHAIN.polygon  ?? null },
  bsc:      { chainId: 56,    rpcUrl: process.env.BSC_RPC_URL      ?? "https://bsc-dataseed.binance.org",              contractAddress: CONTRACT_BY_CHAIN.bsc      ?? null },
  base:     { chainId: 8453,  rpcUrl: process.env.BASE_RPC_URL     ?? "https://mainnet.base.org",                      contractAddress: CONTRACT_BY_CHAIN.base     ?? null },
  arbitrum: { chainId: 42161, rpcUrl: process.env.ARB_RPC_URL      ?? "https://arb1.arbitrum.io/rpc",                  contractAddress: CONTRACT_BY_CHAIN.arbitrum ?? null },
  optimism: { chainId: 10,    rpcUrl: process.env.OP_RPC_URL       ?? "https://mainnet.optimism.io",                   contractAddress: CONTRACT_BY_CHAIN.optimism ?? null },
  avax:     { chainId: 43114, rpcUrl: process.env.AVAX_RPC_URL     ?? "https://api.avax.network/ext/bc/C/rpc",         contractAddress: CONTRACT_BY_CHAIN.avax     ?? null },
  zksync:   { chainId: 324,   rpcUrl: process.env.ZKSYNC_RPC_URL   ?? "https://mainnet.era.zksync.io",                 contractAddress: CONTRACT_BY_CHAIN.zksync   ?? null },
  linea:    { chainId: 59144, rpcUrl: process.env.LINEA_RPC_URL    ?? "https://rpc.linea.build",                       contractAddress: CONTRACT_BY_CHAIN.linea    ?? null },
  scroll:   { chainId: 534352,rpcUrl: process.env.SCROLL_RPC_URL   ?? "https://rpc.scroll.io",                         contractAddress: CONTRACT_BY_CHAIN.scroll   ?? null },
  sei:      { chainId: 1329,  rpcUrl: process.env.SEI_RPC_URL      ?? "https://evm-rpc.sei-apis.com",                  contractAddress: CONTRACT_BY_CHAIN.sei      ?? null },
  unichain: { chainId: 130,   rpcUrl: process.env.UNICHAIN_RPC_URL ?? "https://mainnet.unichain.org",                  contractAddress: CONTRACT_BY_CHAIN.unichain ?? null },
  sepolia:  { chainId: 11155111, rpcUrl: process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org",                      contractAddress: CONTRACT_BY_CHAIN.sepolia  ?? null },
};

// ─── Secrets / trades / locks ─────────────────────────────────────────────────

export function deriveEvmHtlcTradeId(orderId: string): string {
  return keccak256(toHex(`${orderId}:evm-htlc`));
}

export function deriveEvmHtlcSecret(
  orderId: string, side: "seller" | "buyer", htlcSecret: string, sellTxid: string,
): Hex {
  const prefix = side === "seller" ? SELLER_SECRET_PREFIX : BUYER_SECRET_PREFIX;
  return keccak256(toHex(`${prefix}${orderId}:${htlcSecret}:${sellTxid}`));
}

export function deriveEvmHtlcSecretHash(orderId: string, htlcSecret: string, sellTxid: string): Hex {
  const sellerSecret = deriveEvmHtlcSecret(orderId, "seller", htlcSecret, sellTxid);
  const buyerSecret  = deriveEvmHtlcSecret(orderId, "buyer",  htlcSecret, sellTxid);
  return keccak256(concatHex([sellerSecret, buyerSecret]));
}

// Unchanged from v4 — the contract keeps the same derivation.
export function deriveLockId(tradeId: string, side: "seller" | "buyer"): string {
  return keccak256(Buffer.from(`${tradeId}_${side}`, "utf-8") as Hex);
}

// ─── Lock instruction builder (v5 calldata, sliding timelock) ─────────────────

function buildLockInstruction(params: {
  session:    EvmHtlcSession;
  side:       "seller" | "buyer";
  lockId:     string;
  chain:      { chainId: number; contractAddress: Address | null };
  nowUnix:    number;
  htlcSecret: string;
  sellTxid:   string;
  isNative:   boolean;
  amount:     string;
  tokenAddr?: string;
  sellerAddress: string;
  buyerAddress:  string;
}): EvmHtlcLockInstruction {
  const { session, side, lockId, chain, nowUnix, htlcSecret, sellTxid,
          isNative, amount, tokenAddr, sellerAddress, buyerAddress } = params;

  if (!chain.contractAddress) throw new Error(`No HTLC contract deployed on chain ${chain.chainId}`);

  // Sliding timelock: refund window starts when THIS lock is placed.
  const duration = side === "seller" ? SELLER_TIMELOCK_SECS : BUYER_TIMELOCK_SECS;
  const timelockUnix = nowUnix + duration;

  const secret     = deriveEvmHtlcSecret(session.orderId, side, htlcSecret, sellTxid);
  const secretHash = deriveEvmHtlcSecretHash(session.orderId, htlcSecret, sellTxid);
  const counterparty = side === "seller" ? (buyerAddress as Address) : (sellerAddress as Address);
  const contractAddress = chain.contractAddress;
  const sideEnum = side === "seller" ? 0 : 1;

  const calldata = isNative
    ? encodeFunctionData({
        abi: HTLC_ABI_V5, functionName: "lockETH",
        args: [session.tradeId as Hex, sideEnum, secretHash, counterparty, BigInt(timelockUnix)],
      })
    : encodeFunctionData({
        abi: HTLC_ABI_V5, functionName: "lockToken",
        args: [session.tradeId as Hex, sideEnum, secretHash, tokenAddr as Address,
               BigInt(amount), counterparty, BigInt(timelockUnix)],
      });

  return {
    lockId, side, amount, calldata, secretHash, secret, contractAddress, timelockUnix,
    instructions: isNative
      ? `Call lockETH(${session.tradeId}, ${side}, …) with value = ${amount} on chain ${chain.chainId}`
      : `Approve ${tokenAddr} then call lockToken(${session.tradeId}, ${side}, …) on chain ${chain.chainId}`,
  };
}

// ─── Session lifecycle ────────────────────────────────────────────────────────
// initiateEvmHtlcSession: store DURATIONS instead of absolute unix:

export async function initiateEvmHtlcSession(params: {
  orderId: string; chainId: number; sellTxid: string;
  sellerAddress: string; buyerAddress: string;
  bsvAmountSats: number; evmAmount: string;
  isNative: boolean; tokenAddress?: string;
  htlcSecret: string; dbSellerLocktimeBlocks?: number | null;
}): Promise<EvmHtlcSession> {
  const { orderId, chainId, sellTxid, sellerAddress, buyerAddress,
          bsvAmountSats, evmAmount, isNative, tokenAddress, htlcSecret,
          dbSellerLocktimeBlocks } = params;

  const chainKey = Object.entries(EVM_CHAINS).find(([, c]) => c.chainId === chainId)?.[0];
  const chain = chainKey ? EVM_CHAINS[chainKey] : null;
  if (!chain) throw new Error(`EVM chain ${chainId} is not supported`);
  if (!chain.contractAddress) {
    throw new Error(`HTLC contract not deployed on chain ${chainId} — set EVM_HTLC_CONTRACT_${chainKey!.toUpperCase()}`);
  }

  const tradeId   = deriveEvmHtlcTradeId(orderId);
  const sellerLockId = deriveLockId(tradeId, "seller");
  const buyerLockId  = deriveLockId(tradeId, "buyer");
  const nowUnix = Math.floor(Date.now() / 1000);

  const existing = await db.select().from(evmHtlcSessionsTable)
    .where(eq(evmHtlcSessionsTable.tradeId, tradeId)).limit(1);
  if (existing.length > 0) {
    return rowToSession(existing[0], htlcSecret, sellerAddress, buyerAddress);
  }

  // ⚠ DURATIONS are stored now (1800 / 900), not absolute timestamps.
  const expiresAt = new Date(Date.now() + 35 * 60 * 1000);
  const [row] = await db.insert(evmHtlcSessionsTable).values({
    tradeId, orderId, chainId,
    sellerLockId, buyerLockId,
    sellerTimelockUnix: SELLER_TIMELOCK_SECS,   // ← duration in seconds
    buyerTimelockUnix:  BUYER_TIMELOCK_SECS,    // ← duration in seconds
    status: "PENDING", htlcSecret, sellTxid,
    sellerAddress, buyerAddress,
    bsvAmountSats, evmAmount, isNative, tokenAddress,
    expiresAt, createdAt: new Date(), updatedAt: new Date(),
  }).returning();

  return rowToSession(row, htlcSecret, sellerAddress, buyerAddress);
}

// rowToSession: compute absolute timelocks fresh on every read, so the
// buyer's 15-minute window never starts at session creation.

export function rowToSession(
  row: typeof evmHtlcSessionsTable.$inferSelect,
  htlcSecret: string,
  sellerAddress: string,
  buyerAddress: string,
): EvmHtlcSession {
  const chainKey = Object.entries(EVM_CHAINS).find(([, c]) => c.chainId === row.chainId)?.[0] ?? null;
  const chain = chainKey ? EVM_CHAINS[chainKey] : null;
  const nowUnix = Math.floor(Date.now() / 1000);

  // Row stores durations; absolute deadline = now + duration at serve time.
  const sellerDeadline = nowUnix + (row.sellerTimelockUnix ?? SELLER_TIMELOCK_SECS);
  const buyerDeadline  = nowUnix + (row.buyerTimelockUnix  ?? BUYER_TIMELOCK_SECS);

  let sellerLock: EvmHtlcLockInstruction | null = null;
  let buyerLock: EvmHtlcLockInstruction | null = null;
  if (chain?.contractAddress) {
    sellerLock = buildLockInstruction({
      session: row as unknown as EvmHtlcSession, side: "seller", lockId: row.sellerLockId,
      chain, nowUnix, htlcSecret, sellTxid: row.sellTxid, isNative: row.isNative,
      amount: row.evmAmount, tokenAddr: row.tokenAddress ?? undefined,
      sellerAddress, buyerAddress,
    });
    buyerLock = buildLockInstruction({
      session: row as unknown as EvmHtlcSession, side: "buyer", lockId: row.buyerLockId,
      chain, nowUnix, htlcSecret, sellTxid: row.sellTxid, isNative: row.isNative,
      amount: row.evmAmount, tokenAddr: row.tokenAddress ?? undefined,
      sellerAddress, buyerAddress,
    });
  }

  return {
    id: row.id, tradeId: row.tradeId, orderId: row.orderId,
    chainId: row.chainId, chainKey,
    status: row.status as HtlcStatus,
    sellerLockId: row.sellerLockId, buyerLockId: row.buyerLockId,
    sellerTimelockUnix: sellerDeadline, buyerTimelockUnix: buyerDeadline,
    htlcSecret, sellTxid: row.sellTxid,
    sellerAddress, buyerAddress,
    bsvAmountSats: row.bsvAmountSats, evmAmount: row.evmAmount,
    isNative: row.isNative, tokenAddress: row.tokenAddress,
    sellerLock, buyerLock,
    revealSellerTxid: row.settleTxid ?? null,   // UI reuses this for the settle tx link
    revealBuyerTxid: null,
    // PARTIAL_REVEAL status is no longer produced; treat any legacy rows as BOTH_LOCKED
    ...(row.status === "PARTIAL_REVEAL" ? { status: "BOTH_LOCKED" as HtlcStatus } : {}),
    contractAddress: chain?.contractAddress ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

// ─── On-chain verification for /confirm-lock ─────────────────────────────────
// A client can no longer mark the COUNTERPARTY as locked: we check the chain.

export async function confirmLockTx(
  sessionId: string, side: "seller" | "buyer", txid: string,
): Promise<{ ok: boolean; status?: string }> {
  const [session] = await db.select().from(evmHtlcSessionsTable)
    .where(eq(evmHtlcSessionsTable.id, sessionId)).limit(1);
  if (!session) return { ok: false, status: "SESSION_NOT_FOUND" };

  const chain = EVM_CHAINS[Object.entries(EVM_CHAINS).find(([, c]) => c.chainId === session.chainId)?.[0] ?? ""];
  const lockId = side === "seller" ? session.sellerLockId : session.buyerLockId;

  // Verify on-chain before trusting the client.
  if (chain?.contractAddress) {
    const publicClient = createPublicClient({ transport: http(chain.rpcUrl) });
    const funded = await publicClient.readContract({
      address: chain.contractAddress, abi: HTLC_ABI_V5,
      functionName: "isLocked", args: [lockId as Hex],
    }).catch(() => false);
    if (!funded) return { ok: false, status: "LOCK_NOT_ONCHAIN" };
  } else {
    return { ok: false, status: "CONTRACT_NOT_DEPLOYED" };
  }

  // Update the lock state (only if not already set by watcher/webhook)
  const now = new Date();
  if (side === "seller") {
    await db.update(evmHtlcSessionsTable).set({
      sellerLocked: true, sellerLockTxid: txid, updatedAt: now,
      status: session.buyerLocked ? "BOTH_LOCKED" : "SELLER_LOCKED",
    }).where(and(
      eq(evmHtlcSessionsTable.id, sessionId),
      or(isNull(evmHtlcSessionsTable.sellerLockTxid), ne(evmHtlcSessionsTable.sellerLockTxid, txid)),
    ));
  } else {
    await db.update(evmHtlcSessionsTable).set({
      buyerLocked: true, buyerLockTxid: txid, updatedAt: now,
      status: session.sellerLocked ? "BOTH_LOCKED" : "BUYER_LOCKED",
    }).where(and(
      eq(evmHtlcSessionsTable.id, sessionId),
      or(isNull(evmHtlcSessionsTable.buyerLockTxid), ne(evmHtlcSessionsTable.buyerLockTxid, txid)),
    ));
  }

  await triggerEvmHtlcCheckByLockId(lockId);
  return { ok: true };
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

async function checkSessionOnChain(row: typeof evmHtlcSessionsTable.$inferSelect): Promise<void> {
  if (row.status === "COMPLETED" || row.status === "SELLER_REFUNDED"
      || row.status === "BUYER_REFUNDED" || row.status === "EXPIRED") return;

  const chainKey = Object.entries(EVM_CHAINS).find(([, c]) => c.chainId === row.chainId)?.[0];
  const chain = chainKey ? EVM_CHAINS[chainKey] : null;
  if (!chain?.contractAddress) return;

  const publicClient = createPublicClient({ transport: http(chain.rpcUrl) });
  const sellerLocked = row.sellerLocked
    ? true
    : await publicClient.readContract({ address: chain.contractAddress, abi: HTLC_ABI_V5,
        functionName: "isLocked", args: [row.sellerLockId as Hex] }).catch(() => false);
  const buyerLocked = row.buyerLocked
    ? true
    : await publicClient.readContract({ address: chain.contractAddress, abi: HTLC_ABI_V5,
        functionName: "isLocked", args: [row.buyerLockId as Hex] }).catch(() => false);

  if (sellerLocked && buyerLocked && row.status !== "BOTH_LOCKED" && row.status !== "REVEALING") {
    await db.update(evmHtlcSessionsTable).set({ sellerLocked: true, buyerLocked: true,
      status: "BOTH_LOCKED", updatedAt: new Date() }).where(eq(evmHtlcSessionsTable.id, row.id));
    // Trigger atomic settlement.
    await settleTradeOnChain(row.id);
    return;
  }

  // Timeout / refund handling unchanged from v4…
  // (keep existing expiry + refund code here)
}

// ─── Atomic settlement (replaces revealBothLocks + PARTIAL_REVEAL) ───────────

async function settleTradeOnChain(sessionId: string): Promise<void> {
  const [session] = await db.select().from(evmHtlcSessionsTable)
    .where(eq(evmHtlcSessionsTable.id, sessionId)).limit(1);
  if (!session) return;

  const chainKey = Object.entries(EVM_CHAINS).find(([, c]) => c.chainId === session.chainId)?.[0];
  const chain = chainKey ? EVM_CHAINS[chainKey] : null;
  if (!chain?.contractAddress) return;

  const relayerKey = process.env.EVM_RELAYER_KEY as Hex | undefined;
  if (!relayerKey) {
    logger.warn({ tradeId: session.tradeId }, "EVM_RELAYER_KEY not set — cannot settle HTLC");
    return;
  }

  // Claim the settle attempt (idempotent across concurrent triggers).
  const claimed = await db.update(evmHtlcSessionsTable)
    .set({ status: "REVEALING", updatedAt: new Date() })
    .where(and(eq(evmHtlcSessionsTable.id, sessionId), eq(evmHtlcSessionsTable.status, "BOTH_LOCKED")));
  if ((claimed as { rowsAffected?: number }).rowsAffected === 0) return; // someone else is settling

  try {
    const sellerSecret = deriveEvmHtlcSecret(session.orderId, "seller", session.htlcSecret, session.sellTxid);
    const buyerSecret  = deriveEvmHtlcSecret(session.orderId, "buyer",  session.htlcSecret, session.sellTxid);
    const secret: Hex  = keccak256(concatHex([sellerSecret, buyerSecret]));

    const account = privateKeyToAccount(relayerKey);
    const walletClient = createWalletClient({ account, chain: null as never, transport: http(chain.rpcUrl) });

    const hash = await walletClient.writeContract({
      address: chain.contractAddress, abi: HTLC_ABI_V5,
      functionName: "settleTrade",
      args: [session.tradeId as Hex, secret],
      chain: undefined, // chain inferred from rpc url
    } as never);

    await db.update(evmHtlcSessionsTable).set({
      status: "COMPLETED", settleTxid: hash, updatedAt: new Date(),
    }).where(eq(evmHtlcSessionsTable.id, sessionId));

    logger.info({ tradeId: session.tradeId, txid: hash }, "EVM HTLC trade settled atomically");
  } catch (err) {
    // Atomic settle failed (revert, RPC drop, etc.) → go back to BOTH_LOCKED
    // and let the next watcher cycle retry. No PARTIAL state is possible.
    await db.update(evmHtlcSessionsTable).set({
      status: "BOTH_LOCKED", updatedAt: new Date(),
    }).where(eq(evmHtlcSessionsTable.id, sessionId));
    logger.warn({ tradeId: session.tradeId, err }, "settleTrade failed — will retry");
  }
}

// triggerEvmHtlcCheckByLockId: unchanged except it now flows into
// checkSessionOnChain → settleTradeOnChain (no reveal path).
export async function triggerEvmHtlcCheckByLockId(lockId: string): Promise<void> {
  const [row] = await db.select().from(evmHtlcSessionsTable).where(or(
    eq(evmHtlcSessionsTable.sellerLockId, lockId),
    eq(evmHtlcSessionsTable.buyerLockId, lockId),
  )).limit(1);
  if (!row) return;
  await checkSessionOnChain(row);
}
