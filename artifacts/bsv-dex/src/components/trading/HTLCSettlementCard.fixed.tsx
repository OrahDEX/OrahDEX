import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "@workspace/api-client";
import { cn } from "@workspace/ui-kit/lib/utils";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  LockOpen,
  RefreshCw,
  ShieldCheck,
  Timer,
  Wallet,
  X,
} from "lucide-react";
import { useWalletStore } from "@/store/useWalletStore";

/**
 * HTLCSettlementCard v2 — fixes applied:
 *
 *   1. WalletConnect/Reown support: sendTx() now resolves the EIP-1193
 *      provider from wagmi connectors FIRST (window.ethereum is never
 *      injected for WalletConnect users — the old code always failed with
 *      "No wallet found" for them).
 *   2. Chain safety: every approve/lock transaction now carries an explicit
 *      `chainId` and the wallet is switched to the session chain FIRST.
 *      A wrong-chain lock can no longer silently send funds into the void.
 *   3. USDT-safe approve: allowance is checked on-chain; if a residual
 *      allowance exists we zero it before approving the exact amount
 *      (USDT requires approve(0) before a new non-zero value).
 *   4. Chain helpers cover all 13 supported chains (names, colors,
 *      explorer tx URLs) instead of only Ethereum/Polygon/BSC.
 *   5. Legacy "PARTIAL_REVEAL" status is rendered as BOTH_LOCKED (the v5
 *      atomic settleTrade makes partial reveal impossible going forward).
 */

interface EvmHtlcLockInstruction {
  lockId: string;
  side: "seller" | "buyer";
  amount: string;
  calldata: `0x${string}`;
  secretHash: string;
  secret: string;
  contractAddress: string;
  timelockUnix: number;
  instructions: string;
}

interface EvmHtlcSession {
  id: string;
  tradeId: string;
  orderId: string;
  chainId: number;
  status: string;
  sellerLockId: string;
  buyerLockId: string;
  sellerTimelockUnix: number;
  buyerTimelockUnix: number;
  htlcSecret: string;
  sellTxid: string;
  sellerAddress: string;
  buyerAddress: string;
  bsvAmountSats: number;
  evmAmount: string;
  isNative: boolean;
  tokenAddress?: string | null;
  sellerLock?: EvmHtlcLockInstruction | null;
  buyerLock?: EvmHtlcLockInstruction | null;
  revealSellerTxid?: string | null;
  revealBuyerTxid?: string | null;
  contractAddress?: string | null;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Awaiting locks",
  SELLER_LOCKED: "Seller locked · waiting for buyer",
  BUYER_LOCKED: "Buyer locked · waiting for seller",
  BOTH_LOCKED: "Both locked · settling on-chain…",
  REVEALING: "Settling on-chain…",
  PARTIAL_REVEAL: "Settling on-chain…",
  COMPLETED: "Trade settled ✓",
  SELLER_REFUNDED: "Seller refunded",
  BUYER_REFUNDED: "Buyer refunded",
  EXPIRED: "Session expired",
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "text-yellow-400",
  SELLER_LOCKED: "text-blue-400",
  BUYER_LOCKED: "text-blue-400",
  BOTH_LOCKED: "text-violet-400",
  REVEALING: "text-violet-400",
  PARTIAL_REVEAL: "text-violet-400",
  COMPLETED: "text-emerald-400",
  SELLER_REFUNDED: "text-orange-400",
  BUYER_REFUNDED: "text-orange-400",
  EXPIRED: "text-red-400",
};

function chainName(chainId: number): string {
  switch (chainId) {
    case 1: return "Ethereum";
    case 137: return "Polygon";
    case 56: return "BNB Chain";
    case 8453: return "Base";
    case 42161: return "Arbitrum";
    case 10: return "Optimism";
    case 43114: return "Avalanche";
    case 324: return "zkSync Era";
    case 59144: return "Linea";
    case 534352: return "Scroll";
    case 1329: return "Sei";
    case 130: return "Unichain";
    case 11155111: return "Sepolia";
    default: return `Chain ${chainId}`;
  }
}

function chainColor(chainId: number): string {
  switch (chainId) {
    case 1: return "text-blue-400";
    case 137: return "text-purple-400";
    case 56: return "text-yellow-400";
    case 8453: return "text-blue-300";
    case 42161: return "text-blue-500";
    case 10: return "text-red-400";
    case 43114: return "text-red-500";
    case 324: return "text-sky-400";
    case 59144: return "text-teal-400";
    case 534352: return "text-amber-400";
    case 1329: return "text-orange-300";
    case 130: return "text-pink-400";
    case 11155111: return "text-gray-400";
    default: return "text-muted-foreground";
  }
}

function explorerTxUrl(chainId: number, txid: string): string {
  switch (chainId) {
    case 1: return `https://etherscan.io/tx/${txid}`;
    case 137: return `https://polygonscan.com/tx/${txid}`;
    case 56: return `https://bscscan.com/tx/${txid}`;
    case 8453: return `https://basescan.org/tx/${txid}`;
    case 42161: return `https://arbiscan.io/tx/${txid}`;
    case 10: return `https://optimistic.etherscan.io/tx/${txid}`;
    case 43114: return `https://snowtrace.io/tx/${txid}`;
    case 324: return `https://explorer.zksync.io/tx/${txid}`;
    case 59144: return `https://lineascan.build/tx/${txid}`;
    case 534352: return `https://scrollscan.com/tx/${txid}`;
    case 1329: return `https://seitrace.com/tx/${txid}`;
    case 130: return `https://explorer.unichain.org/tx/${txid}`;
    case 11155111: return `https://sepolia.etherscan.io/tx/${txid}`;
    default: return "";
  }
}

async function getEip1193Provider(): Promise<any> {
  // Tier 1: wagmi/Reown connectors (WalletConnect mobile, injected via wagmi).
  const { wagmiAdapter } = await import("../../lib/reown-appkit");
  const connectors = wagmiAdapter.wagmiConfig.connectors as any[];
  const preferred = [
    ...connectors.filter((c) => c.id === "walletConnect" || c.type === "walletConnect"),
    ...connectors.filter((c) => c.id !== "walletConnect" && c.type !== "walletConnect"),
  ];
  for (const connector of preferred) {
    try {
      const provider = await connector.getProvider?.();
      if (provider) return provider;
    } catch {
      // try the next connector
    }
  }
  // Tier 2: injected browser wallet
  const injected = (window as any).ethereum;
  if (injected) return injected;
  throw new Error("No wallet provider found. Reconnect your wallet and try again.");
}

async function switchToChain(provider: any, chainId: number): Promise<void> {
  const hexChainId = "0x" + chainId.toString(16);
  if (provider.chainId === hexChainId) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
  } catch (e: any) {
    if (e?.code === 4902) {
      throw new Error(`${chainName(chainId)} is not added to your wallet. Add the network and try again.`);
    }
    throw e;
  }
}

async function sendTx(provider: any, params: Record<string, unknown>, chainId: number): Promise<string> {
  await switchToChain(provider, chainId);
  return provider.request({
    method: "eth_sendTransaction",
    params: [{ ...params, chainId: "0x" + chainId.toString(16) }],
  });
}

const ERC20_ABI = {
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
};

function encodeAddress(addr: string): string {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

async function readAllowance(provider: any, token: string, owner: string, spender: string): Promise<bigint> {
  const data = ERC20_ABI.allowance + encodeAddress(owner) + encodeAddress(spender);
  const result: string = await provider.request({
    method: "eth_call",
    params: [{ to: token, data }, "latest"],
  });
  return BigInt(result);
}

// ─── Lock Panel ───────────────────────────────────────────────────────────────

function LockPanel({
  session, lock, userAddress, isUserSide,
}: {
  session: EvmHtlcSession;
  lock: EvmHtlcLockInstruction;
  userAddress: string;
  isUserSide: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const addPendingTx = useWalletStore((s) => s.addPendingTx);

  const isNative = session.isNative;
  const tokenAddr = session.tokenAddress;
  const remaining = Math.max(0, lock.timelockUnix - Math.floor(Date.now() / 1000));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;

  async function handleLock() {
    if (!userAddress || loading) return;
    setLoading(true);
    setError(null);
    try {
      const provider = await getEip1193Provider();
      await switchToChain(provider, session.chainId);

      // USDT-safe approve: zero the allowance first if a residual one exists.
      if (!isNative && tokenAddr) {
        const allowance = await readAllowance(provider, tokenAddr, userAddress, lock.contractAddress);
        const needed = BigInt(lock.amount);
        if (allowance > 0n && allowance < needed) {
          await sendTx(provider, { from: userAddress, to: tokenAddr, data: "0x095ea7b3" + encodeAddress(lock.contractAddress) + "0".padStart(64, "0") }, session.chainId);
        }
        if (allowance < needed) {
          const approveData = ERC20_ABI.approve + encodeAddress(lock.contractAddress) + BigInt(lock.amount).toString(16).padStart(64, "0");
          await sendTx(provider, { from: userAddress, to: tokenAddr, data: approveData }, session.chainId);
        }
      }

      const lockTxHash = await sendTx(provider, {
        from: userAddress, to: lock.contractAddress, data: lock.calldata,
        ...(isNative ? { value: "0x" + BigInt(lock.amount).toString(16) } : {}),
      }, session.chainId);

      setTxHash(lockTxHash);
      setConfirming(true);
      addPendingTx({
        network: "evm", txid: lockTxHash,
        description: `Lock ${lock.amount} ${isNative ? "native" : "token"} in OrahDEX HTLC`,
      });

      // Report to backend
      const res = await fetch(`${API_BASE}/evm-htlc/${session.id}/confirm-lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side: lock.side, txid: lockTxHash }),
      });

      if (res.ok) {
        setConfirming(false);
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j?.error ?? "Lock submitted on-chain but confirmation failed. It will be detected automatically.");
        setConfirming(false);
      }
    } catch (e: any) {
      setError(e?.message ?? "Lock transaction failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl border p-3 space-y-2.5",
        isUserSide
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-border bg-secondary/30",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        <span className={cn("uppercase", isUserSide ? "text-emerald-400" : "text-muted-foreground")}>
          {lock.side} lock
        </span>
        {isUserSide && <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1 py-0.5 rounded">Your lock</span>}
        <span className="ml-auto text-[9px] text-muted-foreground font-mono">#{lock.lockId.slice(0, 8)}…</span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
        <span className="text-muted-foreground">Amount</span>
        <span className="text-right font-mono">{lock.amount}</span>
        <span className="text-muted-foreground">Secret hash</span>
        <span className="text-right font-mono truncate">{lock.secretHash.slice(0, 10)}…{lock.secretHash.slice(-6)}</span>
        <span className="text-muted-foreground">Timelock</span>
        <span className="text-right font-mono">
          {mins}:{secs.toString().padStart(2, "0")}
        </span>
      </div>

      {!isUserSide && (
        <p className="text-[9px] text-muted-foreground">
          {session.status === "PENDING"
            ? "Waiting for counterparty to lock…"
            : "Waiting for counterparty…"}
        </p>
      )}

      {isUserSide && session.status !== "COMPLETED" && !txHash && (
        <button
          onClick={handleLock}
          disabled={loading}
          className={cn(
            "w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-bold transition-all",
            "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
            "hover:bg-emerald-500/30",
            loading && "opacity-60 cursor-not-allowed",
          )}
        >
          {loading ? (
            <><Loader2 className="w-3 h-3 animate-spin" /> {isNative ? "Locking…" : "Approve & Lock…"}</>
          ) : isNative ? (
            <><Lock className="w-3 h-3" /> Lock Funds</>
          ) : (
            <><Lock className="w-3 h-3" /> Approve & Lock</>
          )}
        </button>
      )}

      {txHash && (
        <div className="flex items-center gap-1.5 text-[10px] text-emerald-400">
          <CheckCircle2 className="w-3 h-3 shrink-0" />
          <span className="truncate">Lock tx: {txHash.slice(0, 10)}…{txHash.slice(-6)}</span>
          <a
            href={explorerTxUrl(session.chainId, txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-emerald-400/60 hover:text-emerald-400"
          >
            <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </div>
      )}

      {confirming && (
        <p className="text-[9px] text-muted-foreground animate-pulse">Confirming on-chain…</p>
      )}
      {error && (
        <p className="text-[9px] text-red-400">{error}</p>
      )}
    </div>
  );
}

// ─── Main Card ────────────────────────────────────────────────────────────────

export function HTLCSettlementCard({ sessionId, userAddress, onDismiss }: { sessionId: string; userAddress: string; onDismiss?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showDetails, setShowDetails] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: session, isLoading, error, refetch, isFetching } = useQuery<EvmHtlcSession>({
    queryKey: ["evm-htlc-session", sessionId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/evm-htlc/${sessionId}`);
      if (!res.ok) throw new Error("Failed to load HTLC session");
      return res.json();
    },
    refetchInterval: (query) => {
      const s = query.state.data;
      if (!s) return 5000;
      if (["COMPLETED", "SELLER_REFUNDED", "BUYER_REFUNDED", "EXPIRED"].includes(s.status)) return false;
      return 5000;
    },
    staleTime: 3000,
  });

  useEffect(() => {
    if (!session?.id) return;
    if (["COMPLETED", "SELLER_REFUNDED", "BUYER_REFUNDED", "EXPIRED"].includes(session.status)) {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["balances"] });
    }
  }, [session?.status]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading settlement session…
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-center gap-2 text-red-400">
          <X className="w-4 h-4" /> Failed to load settlement session
          <button onClick={() => refetch()} className="ml-auto text-xs underline">Retry</button>
        </div>
      </div>
    );
  }

  const isSeller = userAddress.toLowerCase() === session.sellerAddress.toLowerCase();
  const isBuyer = userAddress.toLowerCase() === session.buyerAddress.toLowerCase();
  const isUserSide = isSeller || isBuyer;
  // Legacy v4 sessions only — v5 settles atomically in one tx.
  const status = session.status === "PARTIAL_REVEAL" ? "BOTH_LOCKED" : session.status;
  const statusLabel = STATUS_LABELS[session.status] ?? status;
  const statusColor = STATUS_COLORS[session.status] ?? "text-muted-foreground";
  const expiresIn = session.expiresAt
    ? Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000))
    : 0;
  const expiresMins = Math.floor(expiresIn / 60);
  const expiresSecs = expiresIn % 60;

  const copy = (field: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const settleTxid = session.revealSellerTxid ?? null;
  const settleUrl = settleTxid ? explorerTxUrl(session.chainId, settleTxid) : "";

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-transparent p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
        <span className="text-xs font-bold text-emerald-400">EVM HTLC Settlement</span>
        <span className="text-[9px] text-muted-foreground">#{session.tradeId.slice(0, 8)}…</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto text-muted-foreground hover:text-emerald-400 transition-colors"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
        </button>
        {onDismiss && (
          <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Trade Summary */}
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div className="bg-secondary/50 border border-border rounded-lg p-2 space-y-0.5">
          <p className="text-muted-foreground">You give</p>
          <p className="font-mono text-foreground text-xs">
            {isSeller ? `${session.evmAmount} (EVM)` : `${(session.bsvAmountSats / 1e8).toFixed(8)} BSV`}
          </p>
        </div>
        <div className="bg-secondary/50 border border-border rounded-lg p-2 space-y-0.5">
          <p className="text-muted-foreground">You receive</p>
          <p className="font-mono text-foreground text-xs">
            {isSeller ? `${(session.bsvAmountSats / 1e8).toFixed(8)} BSV` : `${session.evmAmount} (EVM)`}
          </p>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2 text-[11px]">
        <span className={cn("font-semibold", statusColor)}>{statusLabel}</span>
        {!["COMPLETED", "SELLER_REFUNDED", "BUYER_REFUNDED", "EXPIRED"].includes(status) && expiresIn > 0 && (
          <span className="ml-auto flex items-center gap-1 text-muted-foreground">
            <Timer className="w-3 h-3" />
            {expiresMins}:{expiresSecs.toString().padStart(2, "0")}
          </span>
        )}
      </div>

      {!isUserSide && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] text-amber-400">
          <Wallet className="w-3 h-3 inline mr-1" />
          Your connected wallet is not part of this trade. Switch to the wallet that placed the order to lock funds.
        </div>
      )}

      {/* Contract not deployed safety */}
      {!session.contractAddress && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] text-amber-400">
          Contract not yet deployed on {chainName(session.chainId)}. Manual settlement is required — contact support with trade ID {session.tradeId}.
        </div>
      )}

      {/* Settlement tx (v5: single atomic settle tx) */}
      {settleTxid && (
        <div className="flex items-center gap-1.5 text-[10px] text-emerald-400">
          <CheckCircle2 className="w-3 h-3 shrink-0" />
          <span className="truncate">Settlement tx: {settleTxid.slice(0, 10)}…{settleTxid.slice(-6)}</span>
          {settleUrl && (
            <a href={settleUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-emerald-400/60 hover:text-emerald-400">
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>
      )}

      {/* Lock Panels */}
      {session.sellerLock && (
        <LockPanel session={session} lock={session.sellerLock} userAddress={userAddress} isUserSide={isUserSide && isSeller} />
      )}
      {session.buyerLock && (
        <LockPanel session={session} lock={session.buyerLock} userAddress={userAddress} isUserSide={isUserSide && isBuyer} />
      )}

      {/* Completed / refunded actions */}
      {status === "COMPLETED" && (
        <button
          onClick={() => navigate("/orders")}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[11px] font-bold hover:bg-emerald-500/30 transition-all"
        >
          View in Orders <ArrowRight className="w-3 h-3" />
        </button>
      )}

      {(status === "SELLER_REFUNDED" || status === "BUYER_REFUNDED") && (
        <p className="text-[10px] text-muted-foreground text-center">
          Funds were refunded back to the original sender.
        </p>
      )}

      {status === "EXPIRED" && (
        <p className="text-[10px] text-red-400 text-center">
          Session expired. If your funds are still locked, use refund after the timelock.
        </p>
      )}

      {/* Details toggle */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className={cn("w-3 h-3 transition-transform", showDetails && "rotate-180")} />
        Technical details
      </button>

      {showDetails && (
        <div className="space-y-1.5 text-[9px] font-mono bg-secondary/30 border border-border rounded-lg p-2.5">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Trade ID</span>
            <button onClick={() => copy("tradeId", session.tradeId)} className="text-right hover:text-emerald-400 flex items-center gap-0.5">
              {copiedField === "tradeId" ? <CheckCircle2 className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
              {session.tradeId.slice(0, 12)}…{session.tradeId.slice(-6)}
            </button>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Chain</span>
            <span className={chainColor(session.chainId)}>{chainName(session.chainId)} ({session.chainId})</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Seller</span>
            <button onClick={() => copy("seller", session.sellerAddress)} className="text-right hover:text-emerald-400 flex items-center gap-0.5">
              {copiedField === "seller" ? <CheckCircle2 className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
              {session.sellerAddress.slice(0, 6)}…{session.sellerAddress.slice(-4)}
            </button>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Buyer</span>
            <button onClick={() => copy("buyer", session.buyerAddress)} className="text-right hover:text-emerald-400 flex items-center gap-0.5">
              {copiedField === "buyer" ? <CheckCircle2 className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
              {session.buyerAddress.slice(0, 6)}…{session.buyerAddress.slice(-4)}
            </button>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Contract</span>
            <button onClick={() => copy("contract", session.contractAddress ?? "")} className="text-right hover:text-emerald-400 flex items-center gap-0.5">
              {copiedField === "contract" ? <CheckCircle2 className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
              {session.contractAddress ? `${session.contractAddress.slice(0, 6)}…${session.contractAddress.slice(-4)}` : "—"}
            </button>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">BSV Settlement</span>
            <a
              href={`https://whatsonchain.com/tx/${session.sellTxid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-right text-primary hover:underline flex items-center gap-0.5"
            >
              <ExternalLink className="w-2.5 h-2.5" />
              {session.sellTxid.slice(0, 8)}…{session.sellTxid.slice(-6)}
            </a>
          </div>
        </div>
      )}

      {/* Escrow note */}
      <p className="text-[8px] text-muted-foreground/60 text-center flex items-center justify-center gap-1">
        <LockOpen className="w-2.5 h-2.5" />
        Non-custodial P2P settlement. OrahDEX never holds your funds.
      </p>
    </div>
  );
}
