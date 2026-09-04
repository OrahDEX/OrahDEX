/**
 * CrossChainSwapPanel — Bidirectional BSV ↔ EVM atomic swap UI.
 *
 * Direction: BSV → EVM  (user funds BSV HTLC, receives EVM token)
 *            EVM → BSV  (user locks EVM token via escrow, receives BSV)
 *
 * BSV→EVM flow  POST /api/bsv-intent → fund BSV P2SH → poll status
 * EVM→BSV flow  POST /api/evm-to-bsv-intent → lockEthUniversal/lockErc20Universal
 *               → PUT /api/evm-to-bsv-intent/:id/lock → poll GET every 5s
 */

import { useState, useCallback, useEffect } from "react";
import { useSignMessage } from "wagmi";
import { parseUnits } from "viem";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { useWalletStore } from "@/store/useWalletStore";
import { useWalletPrices } from "@/hooks/useWalletPrices";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  ArrowRight, CheckCircle2, AlertCircle, Loader2, Copy,
  ExternalLink, Zap, Shield, RotateCcw, X, Clock,
  ArrowLeftRight, Lock,
} from "lucide-react";
import { lockEthUniversal, lockErc20Universal, escrowAddress } from "@/lib/escrow";

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

const CHAINS: { id: number; name: string }[] = [
  { id: 11155111, name: "Sepolia"  },
  { id: 1,        name: "Ethereum" },
  { id: 8453,     name: "Base"     },
  { id: 42161,    name: "Arbitrum" },
  { id: 137,      name: "Polygon"  },
  { id: 56,       name: "BSC"      },
];

const BSV_OUT_TOKENS = [
  { symbol: "ETH",  decimals: 18 },
  { symbol: "USDT", decimals: 6  },
  { symbol: "USDC", decimals: 6  },
  { symbol: "WBTC", decimals: 8  },
  { symbol: "BNB",  decimals: 18 },
];

const EVM_IN_TOKENS: {
  symbol:   string;
  decimals: number;
  address:  Record<number, string | "native">;
}[] = [
  {
    symbol: "ETH", decimals: 18,
    address: { 1: "native", 11155111: "native", 8453: "native", 42161: "native" },
  },
  {
    symbol: "USDT", decimals: 6,
    address: {
      1:   "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      137: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      56:  "0x55d398326f99059fF775485246999027B3197955",
    },
  },
  {
    symbol: "USDC", decimals: 6,
    address: {
      1:        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      8453:     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      42161:    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      11155111: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
      137:      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    },
  },
  {
    symbol: "WBTC", decimals: 8,
    address: {
      1:     "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      137:   "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
      42161: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    },
  },
];

const MIN_BSV_SAT = 2000;
const SLIPPAGE    = 0.02;

// ── BSV intent types ──────────────────────────────────────────────────────────

type BsvSwapStatus =
  | "PENDING_FUNDING" | "FUNDED" | "CONFIRMED"
  | "FILLED" | "CLAIMING" | "CLAIMED"
  | "EXPIRED" | "REFUNDING" | "REFUNDED" | "CANCELLED";

interface BsvIntentData {
  id:                 string;
  status:             BsvSwapStatus;
  htlcAddress:        string;
  amountInSat:        number;
  tokenOut:           string;
  minAmountOut:       string;
  destinationChain:   string;
  destinationAddress: string;
  deadlineTs:         number;
  deadlineBlocks:     number;
  redeemScript:       string;
  confirmations:      number | null;
  fundingTxid:        string | null;
  claimTxid:          string | null;
  refundTxid:         string | null;
  solverPaymentTxid:  string | null;
}

const BSV_TERMINAL = new Set<BsvSwapStatus>(["CLAIMED", "REFUNDED", "CANCELLED"]);

const BSV_STATUS_LABELS: Record<BsvSwapStatus, string> = {
  PENDING_FUNDING: "Waiting for BSV deposit",
  FUNDED:          "Deposit detected",
  CONFIRMED:       "Deposit confirmed (≥3 conf)",
  FILLED:          "Solver filled EVM side",
  CLAIMING:        "Claiming BSV from HTLC…",
  CLAIMED:         "Swap complete!",
  EXPIRED:         "HTLC expired — refund available",
  REFUNDING:       "Broadcasting refund…",
  REFUNDED:        "BSV refunded",
  CANCELLED:       "Cancelled",
};

const BSV_ACTIVE_STEPS: BsvSwapStatus[] = [
  "PENDING_FUNDING", "FUNDED", "CONFIRMED", "FILLED", "CLAIMED",
];

function bsvStepIndex(s: BsvSwapStatus): number {
  const i = BSV_ACTIVE_STEPS.indexOf(s);
  return i !== -1 ? i : s === "CLAIMING" ? 4 : 0;
}

// ── EVM→BSV API types ─────────────────────────────────────────────────────────

type EvmBsvApiStatus =
  | "PENDING_LOCK" | "LOCKED" | "AWAITING_BSV"
  | "BSV_SENT" | "COMPLETE" | "FAILED" | "REFUNDED";

interface EvmBsvSwapData {
  swapId:          string;
  status:          EvmBsvApiStatus;
  userEvmAddress:  string;
  bsvReceiveAddr:  string;
  tokenIn:         string;
  amountInHuman:   string;
  chainId:         number;
  estimatedBsvOut: string | null;
  evmLockTxHash:   string | null;
  solverBsvTxid:   string | null;
  expiresAt:       string;
}

const EVM_BSV_TERMINAL = new Set<EvmBsvApiStatus>(["COMPLETE", "FAILED", "REFUNDED"]);

const EVM_STATUS_LABELS: Record<EvmBsvApiStatus, string> = {
  PENDING_LOCK: "Registering swap…",
  LOCKED:       "EVM tokens locked",
  AWAITING_BSV: "Solver delivering BSV…",
  BSV_SENT:     "BSV broadcast — awaiting confirmation",
  COMPLETE:     "Swap complete!",
  FAILED:       "Swap failed",
  REFUNDED:     "EVM tokens refunded",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch {}
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="p-1 rounded text-zinc-400 hover:text-zinc-200 transition-colors shrink-0"
      title="Copy"
    >
      {copied
        ? <CheckCircle2 size={12} className="text-emerald-400" />
        : <Copy size={12} />}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="text-zinc-500 shrink-0 whitespace-nowrap">{label}</span>
      <span className="text-zinc-200 text-right break-all">{children}</span>
    </div>
  );
}

function StatusStep({ labels, currentIndex }: { labels: string[]; currentIndex: number }) {
  return (
    <div className="flex items-start justify-between gap-1 pb-1">
      {labels.map((lbl, i) => {
        const done   = i < currentIndex;
        const active = i === currentIndex;
        return (
          <div key={i} className="flex flex-col items-center flex-1 min-w-0 gap-0.5">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ring-2 shrink-0",
              done   ? "bg-emerald-500 text-white ring-emerald-500/30"
                     : active
                     ? "bg-violet-600 text-white ring-violet-500/30 animate-pulse"
                     : "bg-zinc-800 text-zinc-500 ring-zinc-800/30"
            )}>
              {done ? <CheckCircle2 size={11} /> : i + 1}
            </div>
            <span className={cn(
              "text-[8px] text-center leading-tight px-0.5 w-full truncate",
              done ? "text-emerald-400" : active ? "text-violet-300" : "text-zinc-600"
            )}>{lbl}</span>
          </div>
        );
      })}
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
      <AlertCircle size={13} className="shrink-0" /> {msg}
    </div>
  );
}

function TxLink({
  href, txid, className,
}: { href: string; txid: string; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className={cn("flex items-center gap-1 hover:underline", className ?? "text-violet-300")}>
      {txid.slice(0, 10)}… <ExternalLink size={9} />
    </a>
  );
}

function StatusBadge({
  label, isComplete, isFailed, isWarning, sub,
}: {
  label: string; isComplete: boolean; isFailed: boolean; isWarning: boolean; sub?: string;
}) {
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-lg border px-3 py-2.5",
      isComplete ? "border-emerald-500/30 bg-emerald-500/10"
        : isFailed  ? "border-zinc-700 bg-zinc-900"
        : isWarning ? "border-amber-500/30 bg-amber-500/10"
        : "border-violet-500/20 bg-violet-500/8",
    )}>
      {isComplete
        ? <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
        : isFailed
        ? <X size={15} className="text-zinc-500 shrink-0" />
        : isWarning
        ? <AlertCircle size={15} className="text-amber-400 shrink-0" />
        : <Loader2 size={15} className="animate-spin text-violet-400 shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className={cn(
          "text-sm font-semibold",
          isComplete ? "text-emerald-300" : isWarning ? "text-amber-300" : "text-violet-300"
        )}>{label}</p>
        {sub && <p className="text-[10px] text-zinc-400">{sub}</p>}
      </div>
    </div>
  );
}

function explorerTx(chainId: number, txHash: string): string {
  const bases: Record<number, string> = {
    1:        "https://etherscan.io",
    8453:     "https://basescan.org",
    42161:    "https://arbiscan.io",
    137:      "https://polygonscan.com",
    56:       "https://bscscan.com",
    11155111: "https://sepolia.etherscan.io",
  };
  return `${bases[chainId] ?? "https://etherscan.io"}/tx/${txHash}`;
}

// ── Panel shell ────────────────────────────────────────────────────────────────

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
}

type Direction = "bsv-to-evm" | "evm-to-bsv";
type PanelStep = "configure" | "funding" | "locking" | "tracking";

export function CrossChainSwapPanel({ open, onOpenChange }: Props) {
  // Pull `chainId` (not `walletChainId`) from the store — the store field is chainId.
  const { address, internalBsvAddress, provider, chainId: walletChainId } = useWalletStore();
  const { prices } = useWalletPrices();
  const { signMessageAsync } = useSignMessage();
  const isOrahWallet = provider === "orah-wallet";
  const bsvUsd       = prices.BSV?.usd ?? 16;

  // ── Direction ──────────────────────────────────────────────────────────────
  const [direction, setDirection] = useState<Direction>("bsv-to-evm");
  const isBsvToEvm = direction === "bsv-to-evm";

  // ── BSV→EVM form ───────────────────────────────────────────────────────────
  const [amtBsv,   setAmtBsv]  = useState("");
  const [tokenOut, setTokenOut] = useState("ETH");
  const [chainId,  setChainId]  = useState(11155111);
  const [destAddr, setDestAddr] = useState("");

  // ── EVM→BSV form ───────────────────────────────────────────────────────────
  const [evmToken,    setEvmToken]    = useState("ETH");
  const [evmAmtStr,   setEvmAmtStr]   = useState("");
  const [bsvRecvAddr, setBsvRecvAddr] = useState("");
  const [evmChainId,  setEvmChainId]  = useState<number>(() => walletChainId ?? 11155111);

  // ── Step ───────────────────────────────────────────────────────────────────
  const [step,      setStep]      = useState<PanelStep>("configure");
  const [formErr,   setFormErr]   = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // BSV→EVM intent
  const [intentId,   setIntentId]   = useState<string | null>(null);
  const [creating,   setCreating]   = useState(false);
  const [sending,    setSending]    = useState(false);
  const [bsvTxid,    setBsvTxid]    = useState<string | null>(null);
  const [sendErr,    setSendErr]    = useState<string | null>(null);
  const [refunding,  setRefunding]  = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [fundingData, setFundingData] = useState<BsvIntentData | null>(null);

  // EVM→BSV swap
  const [evmSwapId,     setEvmSwapId]     = useState<string | null>(null);
  const [lockingEvm,    setLockingEvm]    = useState(false);
  const [lockErr,       setLockErr]       = useState<string | null>(null);
  const [localLockHash, setLocalLockHash] = useState<string | null>(null);

  // ── Reset on open ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setStep("configure");
    setIntentId(null);
    setBsvTxid(null);
    setSendErr(null);
    setFormErr(null);
    setActionMsg(null);
    setFundingData(null);
    setEvmSwapId(null);
    setLockingEvm(false);
    setLockErr(null);
    setLocalLockHash(null);
  }, [open]);

  // ── BSV→EVM derived values ─────────────────────────────────────────────────
  const amtSat = Math.round(parseFloat(amtBsv || "0") * 1e8);
  const tokenUsd = (() => {
    if (tokenOut === "USDT" || tokenOut === "USDC") return 1;
    if (tokenOut === "WBTC") return prices.BTC?.usd ?? 85000;
    if (tokenOut === "BNB")  return prices.BNB?.usd  ?? 580;
    return prices.ETH?.usd ?? 2400;
  })();
  const bsvValueUsd  = amtSat > 0 ? (amtSat / 1e8) * bsvUsd : 0;
  const estimatedOut = tokenUsd > 0 && bsvValueUsd > 0
    ? (bsvValueUsd * (1 - SLIPPAGE)) / tokenUsd : 0;
  const minAmountOut = estimatedOut > 0
    ? estimatedOut.toFixed(
        Math.min(BSV_OUT_TOKENS.find(t => t.symbol === tokenOut)?.decimals ?? 18, 8)
      )
    : "0";
  const chainName = CHAINS.find(c => c.id === chainId)?.name ?? "Sepolia";

  // ── EVM→BSV derived values ─────────────────────────────────────────────────
  const evmTokenMeta = EVM_IN_TOKENS.find(t => t.symbol === evmToken);
  const evmAmtNum    = parseFloat(evmAmtStr || "0");
  const evmUsdRate   = (() => {
    if (evmToken === "USDT" || evmToken === "USDC") return 1;
    if (evmToken === "WBTC") return prices.BTC?.usd ?? 85000;
    return prices.ETH?.usd ?? 2400;
  })();
  const evmValueUsd      = evmAmtNum > 0 ? evmAmtNum * evmUsdRate : 0;
  const estimatedBsvOut  = bsvUsd > 0 && evmValueUsd > 0
    ? (evmValueUsd * (1 - SLIPPAGE)) / bsvUsd : 0;
  const tokenAddrOnChain = evmTokenMeta?.address[evmChainId] ?? null;
  const evmChainName     = CHAINS.find(c => c.id === evmChainId)?.name ?? "";

  // ── Poll BSV intent (BSV→EVM) ─────────────────────────────────────────────
  const { data: intentData, refetch: refetchIntent } = useQuery<BsvIntentData>({
    queryKey: ["cross-chain-bsv-intent", intentId],
    queryFn:  async () => {
      const r = await fetch(`${BASE}/api/swaps/${intentId}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Failed to fetch intent");
      return r.json();
    },
    enabled:         !!intentId && step === "tracking" && direction === "bsv-to-evm",
    refetchInterval: query => {
      const d = query.state.data as BsvIntentData | undefined;
      if (!d || BSV_TERMINAL.has(d.status)) return false;
      return 5000;
    },
    staleTime: 0,
  });

  // displayIntent: use polling data or the initial fundingData returned on creation
  const displayIntent: BsvIntentData | null = intentData ?? fundingData;

  // ── Overlay record (on-chain OP_RETURN verification) ──────────────────────
  const overlayOrderId = intentId ? intentId.replace(/-/g, "").slice(0, 16) : null;
  const { data: overlayData } = useQuery({
    queryKey:        ["overlay-record", overlayOrderId],
    queryFn:         async () => {
      if (!overlayOrderId) return null;
      const r = await fetch(`${BASE}/api/overlay/intents/${overlayOrderId}`);
      if (!r.ok) return null;
      return r.json() as Promise<{ found: boolean; record: { explorerUrl: string; txid: string } } | null>;
    },
    enabled:         !!overlayOrderId && step === "tracking" && isBsvToEvm,
    refetchInterval: 60_000,
    staleTime:       30_000,
  });
  const overlayRecord = (overlayData as any)?.found ? (overlayData as any).record : null;

  // Auto-advance to tracking after BSV tx or non-PENDING status
  useEffect(() => {
    if (step === "funding" && displayIntent) {
      if (displayIntent.status !== "PENDING_FUNDING" || bsvTxid) {
        setStep("tracking");
      }
    }
  }, [displayIntent, step, bsvTxid]);

  // ── Poll EVM→BSV swap status ───────────────────────────────────────────────
  const { data: evmSwapData, refetch: refetchEvmSwap } = useQuery<EvmBsvSwapData>({
    queryKey: ["cross-chain-evm-to-bsv", evmSwapId],
    queryFn:  async () => {
      const r = await fetch(
        `${BASE}/api/swaps/${evmSwapId}`,
        { cache: "no-store" }
      );
      if (!r.ok) throw new Error("Failed to fetch EVM→BSV swap");
      return r.json();
    },
    enabled:         !!evmSwapId && step === "tracking" && direction === "evm-to-bsv",
    refetchInterval: query => {
      const d = query.state.data as EvmBsvSwapData | undefined;
      if (!d || EVM_BSV_TERMINAL.has(d.status)) return false;
      return 5000;
    },
    staleTime: 0,
  });

  // ── Deadline clock (BSV→EVM) ─────────────────────────────────────────────
  const [timeLeft, setTimeLeft] = useState("");
  useEffect(() => {
    if (!displayIntent?.deadlineTs) return;
    const tick = () => {
      const s = Math.max(0, displayIntent.deadlineTs - Math.floor(Date.now() / 1000));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      setTimeLeft(`${h}h ${m.toString().padStart(2, "0")}m ${sec.toString().padStart(2, "0")}s`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [displayIntent?.deadlineTs]);

  const refundable = !!displayIntent &&
    (displayIntent.status === "EXPIRED" ||
      (Date.now() / 1000 > displayIntent.deadlineTs &&
        !BSV_TERMINAL.has(displayIntent.status)));

  // ── BSV→EVM: Create intent ─────────────────────────────────────────────────
  const handleCreateBsvIntent = useCallback(async () => {
    setFormErr(null);
    if (amtSat < MIN_BSV_SAT) {
      setFormErr(`Minimum is ${MIN_BSV_SAT} satoshis`); return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(destAddr.trim())) {
      setFormErr("Destination must be a valid EVM address (0x…)"); return;
    }
    setCreating(true);
    try {
      const r = await fetch(`${BASE}/api/swaps/bsv-evm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress:        address ?? destAddr.trim(),
          tokenOut,
          amountInSat:        amtSat,
          minAmountOut,
          destinationChain:   String(chainId),
          destinationAddress: destAddr.trim(),
        }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? "Failed to create swap");
      setIntentId(json.intentId ?? json.id ?? json.swapId);
      setFundingData(json as BsvIntentData);
      setStep("funding");
    } catch (err: any) {
      setFormErr(err.message ?? "Failed to initiate swap");
    } finally {
      setCreating(false);
    }
  }, [address, amtSat, tokenOut, chainId, destAddr, minAmountOut]);

  // ── BSV→EVM: Passkey send ─────────────────────────────────────────────────
  // CRITICAL: use displayIntent (fundingData ?? intentData) — intentData is only
  // populated when step==="tracking", so in step==="funding" we must use
  // fundingData (set synchronously on intent creation) to have htlcAddress.
  const handleSendWithPasskey = useCallback(async () => {
    const htlcAddress = displayIntent?.htlcAddress;
    const amountSat   = displayIntent?.amountInSat;
    if (!htlcAddress || !amountSat || !internalBsvAddress || !address) return;
    setSendErr(null);
    setSending(true);
    try {
      const { sendBsvWithPasskey } = await import("@/lib/passkeyWallet");
      const result = await sendBsvWithPasskey(
        address,
        internalBsvAddress,
        htlcAddress,
        amountSat / 1e8,
      );
      setBsvTxid(result.txid);
      setStep("tracking");
    } catch (err: any) {
      setSendErr(err.message ?? "Failed to send BSV");
    } finally {
      setSending(false);
    }
  }, [displayIntent, internalBsvAddress, address]);

  // ── BSV→EVM: Reclaim ──────────────────────────────────────────────────────
  const handleRefund = useCallback(async () => {
    if (!intentId) return;
    setRefunding(true); setActionMsg(null);
    try {
      const r = await fetch(`${BASE}/api/bsv-intent/${intentId}/refund`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const json = await r.json();
      setActionMsg(r.ok
        ? "Refund initiated — watcher will broadcast the CLTV tx shortly."
        : (json.error ?? "Refund failed"));
      if (r.ok) setTimeout(() => refetchIntent(), 3000);
    } catch { setActionMsg("Network error. Try again."); }
    finally  { setRefunding(false); }
  }, [intentId, refetchIntent]);

  // ── BSV→EVM: Cancel ──────────────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
    if (!intentId || !address) return;
    setCancelling(true); setActionMsg(null);
    try {
      const r = await fetch(`${BASE}/api/bsv-intent/${intentId}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress: address }),
      });
      const json = await r.json();
      if (!r.ok) setActionMsg(json.error ?? "Cancel failed");
      else { setStep("configure"); setIntentId(null); setFundingData(null); }
    } catch { setActionMsg("Network error."); }
    finally  { setCancelling(false); }
  }, [intentId, address]);

  // ── EVM→BSV: Lock + register ───────────────────────────────────────────────
  const handleEvmLock = useCallback(async () => {
    setFormErr(null);
    if (evmAmtNum <= 0) { setFormErr("Enter a valid EVM amount."); return; }
    if (bsvRecvAddr.trim().length < 20) {
      setFormErr("Enter a valid BSV receive address."); return;
    }
    if (!address) { setFormErr("Connect your EVM wallet first."); return; }
    if (!tokenAddrOnChain) {
      setFormErr(`${evmToken} is not supported on ${evmChainName}.`); return;
    }

    setLockingEvm(true); setLockErr(null);
    setStep("locking");

    try {
      // 1. Register intent with backend to get a stable swap ID
      const regResp = await fetch(`${BASE}/api/evm-to-bsv-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userEvmAddress:  address,
          bsvReceiveAddr:  bsvRecvAddr.trim(),
          tokenIn:         evmToken,
          tokenAddress:    tokenAddrOnChain === "native" ? "native" : tokenAddrOnChain,
          amountInRaw:     parseUnits(evmAmtStr, evmTokenMeta?.decimals ?? 18).toString(),
          amountInHuman:   evmAmtStr,
          chainId:         evmChainId,
          estimatedBsvOut: estimatedBsvOut > 0 ? estimatedBsvOut.toFixed(8) : undefined,
        }),
      });
      const regJson = await regResp.json();
      if (!regResp.ok) throw new Error(regJson.error ?? "Failed to register swap");

      const swapId: string = regJson.swapId;
      setEvmSwapId(swapId);

      // 2. Lock EVM tokens on-chain (use swapId as the escrow orderId)
      //    parseUnits (viem) avoids floating-point precision loss.
      const rawAmt = parseUnits(evmAmtStr, evmTokenMeta?.decimals ?? 18);
      let txHash: string;

      if (tokenAddrOnChain === "native") {
        const r = await lockEthUniversal(swapId, rawAmt, address, evmChainId);
        txHash = r.txHash;
      } else {
        const r = await lockErc20Universal(swapId, tokenAddrOnChain, rawAmt, address, evmChainId);
        txHash = r.txHash;
      }

      setLocalLockHash(txHash);

      // 3. Sign the lock authorisation (EIP-191 personal_sign) — proves wallet ownership.
      //    Message must match the format verified server-side in PUT /lock.
      const sigMessage = `OrahDEX: Authorize EVM lock\nSwap: ${swapId}\nTx: ${txHash}`;
      let signature: string;
      try {
        signature = await signMessageAsync({ message: sigMessage });
      } catch (sigErr: any) {
        throw new Error(
          `Wallet declined signing the lock authorisation: ${sigErr?.message ?? "user rejected"}. ` +
          `Your ${evmToken} is locked on-chain (tx: ${txHash}). Contact support with swap ID: ${swapId}.`
        );
      }

      // 4. Record the lock tx hash + signature in the backend → transitions status to LOCKED.
      //    This is mandatory: if it fails the solver cannot detect or fulfil the swap.
      const lockResp = await fetch(
        `${BASE}/api/evm-to-bsv-intent/${swapId}/lock`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ evmLockTxHash: txHash, userEvmAddress: address, signature }),
        }
      );
      if (!lockResp.ok) {
        const errBody = await lockResp.json().catch(() => ({ error: lockResp.statusText }));
        throw new Error(
          `Lock recorded on-chain (tx: ${txHash}) but the server rejected the record: ` +
          `${errBody.error ?? lockResp.status}. Contact support with swap ID: ${swapId}.`
        );
      }

      setStep("tracking");
    } catch (err: any) {
      setLockErr(err?.message ?? "Lock failed");
      setStep("locking"); // stay on locking step to show error
    } finally {
      setLockingEvm(false);
    }
  }, [
    address, evmAmtNum, evmAmtStr, evmToken, evmTokenMeta,
    evmChainId, bsvRecvAddr, tokenAddrOnChain, evmChainName, estimatedBsvOut,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────

  const bsvComplete  = displayIntent?.status === "CLAIMED";
  const bsvRefunded  = displayIntent?.status === "REFUNDED" || displayIntent?.status === "CANCELLED";
  const evmComplete  = evmSwapData?.status === "COMPLETE";
  const evmFailed    = evmSwapData?.status === "FAILED" || evmSwapData?.status === "REFUNDED";
  const evmIsExpired = !evmComplete && !evmFailed &&
    !!evmSwapData?.expiresAt && new Date(evmSwapData.expiresAt) < new Date();

  const activeEvmStatus: EvmBsvApiStatus =
    evmSwapData?.status ?? (evmSwapId ? "PENDING_LOCK" : "PENDING_LOCK");

  const evmStepIndex = {
    PENDING_LOCK: 0, LOCKED: 1, AWAITING_BSV: 2, BSV_SENT: 2, COMPLETE: 3, FAILED: 3, REFUNDED: 3,
  }[activeEvmStatus] ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-zinc-950 border-violet-500/20 text-zinc-50 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-zinc-800">
          <DialogTitle className="flex items-center gap-2 text-violet-300 text-base">
            <Shield size={16} /> BSV ↔ EVM Atomic Swap
          </DialogTitle>
          <DialogDescription className="text-zinc-400 text-xs leading-relaxed">
            Trustless cross-chain swap via HTLC. Non-custodial — only you can claim or refund.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-5 pt-4 flex flex-col gap-4 max-h-[80vh] overflow-y-auto">

          {/* Direction toggle — only shown in configure step */}
          {step === "configure" && (
            <div className="flex rounded-lg overflow-hidden border border-zinc-800">
              {(["bsv-to-evm", "evm-to-bsv"] as Direction[]).map(d => (
                <button
                  key={d}
                  onClick={() => { setDirection(d); setFormErr(null); }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-all",
                    direction === d
                      ? "bg-violet-600 text-white"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                  )}
                >
                  {d === "bsv-to-evm"
                    ? <><Zap size={12} /> BSV → EVM</>
                    : <><ArrowLeftRight size={12} /> EVM → BSV</>}
                </button>
              ))}
            </div>
          )}

          {/* ══ BSV → EVM: CONFIGURE ══════════════════════════════════════════ */}
          {step === "configure" && isBsvToEvm && (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  BSV amount to send
                </label>
                <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden focus-within:border-violet-500/50">
                  <input type="number" min="0" step="0.0001" placeholder="0.01"
                    value={amtBsv} onChange={e => setAmtBsv(e.target.value)}
                    className="flex-1 bg-transparent px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                  />
                  <span className="px-3 text-xs font-bold text-zinc-400">BSV</span>
                </div>
                {bsvValueUsd > 0 && (
                  <p className="text-[10px] text-zinc-500">
                    ≈ ${bsvValueUsd.toFixed(2)} · {amtSat.toLocaleString()} sat
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Receive token</label>
                  <select value={tokenOut} onChange={e => setTokenOut(e.target.value)}
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-violet-500/50">
                    {BSV_OUT_TOKENS.map(t => <option key={t.symbol}>{t.symbol}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">EVM chain</label>
                  <select value={chainId} onChange={e => setChainId(Number(e.target.value))}
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-violet-500/50">
                    {CHAINS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">EVM receive address</label>
                <input type="text"
                  placeholder={address?.startsWith("0x") ? address : "0x…"}
                  value={destAddr} onChange={e => setDestAddr(e.target.value)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-xs font-mono text-zinc-100 outline-none focus:border-violet-500/50 placeholder:text-zinc-600"
                />
                {address?.startsWith("0x") && !destAddr && (
                  <button onClick={() => setDestAddr(address)}
                    className="text-[10px] text-violet-400 hover:text-violet-300 self-start">
                    Use connected wallet address
                  </button>
                )}
              </div>

              {estimatedOut > 0 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-1.5">
                  <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Estimated swap</p>
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <span className="text-zinc-200">{parseFloat(amtBsv || "0").toFixed(4)} BSV</span>
                    <ArrowRight size={13} className="text-violet-400" />
                    <span className="text-violet-300">≥ {estimatedOut.toFixed(4)} {tokenOut}</span>
                  </div>
                  <p className="text-[9px] text-zinc-600">
                    {SLIPPAGE * 100}% slippage · 48h HTLC · Trustless on-chain script
                  </p>
                </div>
              )}

              {formErr && <ErrorBox msg={formErr} />}

              <button onClick={handleCreateBsvIntent}
                disabled={creating || amtSat < MIN_BSV_SAT || !destAddr.trim()}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold bg-violet-600 text-white hover:bg-violet-500 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                {creating
                  ? <><Loader2 size={14} className="animate-spin" /> Creating HTLC…</>
                  : <><Zap size={14} /> Initiate BSV→EVM Swap</>}
              </button>
            </>
          )}

          {/* ══ BSV → EVM: FUNDING ════════════════════════════════════════════ */}
          {step === "funding" && displayIntent && isBsvToEvm && (
            <>
              <div className="flex flex-col gap-1">
                <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Send exactly this amount:
                </p>
                <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2">
                  <span className="font-mono font-bold text-amber-300 text-base">
                    {(displayIntent.amountInSat / 1e8).toFixed(8)} BSV
                  </span>
                  <span className="text-xs text-amber-400/70 ml-1">
                    ({displayIntent.amountInSat.toLocaleString()} sat)
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  HTLC P2SH address (BSV)
                </p>
                <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5">
                  <span className="font-mono text-[11px] text-violet-300 flex-1 break-all select-all">
                    {displayIntent.htlcAddress}
                  </span>
                  <CopyButton text={displayIntent.htlcAddress} />
                </div>
                <p className="text-[9px] text-zinc-600 leading-relaxed">
                  Time-locked smart contract address. Send the exact amount. Excess is consumed by the refund tx fee.
                </p>
              </div>

              {isOrahWallet && internalBsvAddress && !bsvTxid && (
                <button onClick={handleSendWithPasskey} disabled={sending}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                  {sending
                    ? <><Loader2 size={14} className="animate-spin" /> Sending BSV…</>
                    : <><Zap size={14} /> Send with Passkey (Orah Wallet)</>}
                </button>
              )}

              {bsvTxid && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 space-y-1">
                  <p className="text-xs font-semibold text-emerald-400">BSV sent!</p>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-emerald-300 break-all">{bsvTxid}</span>
                    <a href={`https://whatsonchain.com/tx/${bsvTxid}`}
                      target="_blank" rel="noopener noreferrer"
                      className="shrink-0 text-emerald-400 hover:text-emerald-300">
                      <ExternalLink size={11} />
                    </a>
                  </div>
                </div>
              )}

              {sendErr && <ErrorBox msg={sendErr} />}
              {!bsvTxid && (
                <p className="text-[10px] text-zinc-500 text-center">
                  {isOrahWallet && internalBsvAddress
                    ? "Or send manually from any BSV wallet."
                    : "Send the exact amount from your BSV wallet to the address above."}
                </p>
              )}

              {displayIntent.deadlineTs && (
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <Clock size={11} /> HTLC expires in:
                  <span className="font-mono text-zinc-300">{timeLeft}</span>
                </div>
              )}

              <div className="flex gap-2">
                <button onClick={() => setStep("tracking")}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors">
                  <RotateCcw size={12} /> Track status
                </button>
                <button onClick={handleCancel} disabled={cancelling}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-red-500/30 text-xs text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50">
                  {cancelling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                  Cancel swap
                </button>
              </div>
              {actionMsg && (
                <p className="text-[10px] text-zinc-400 text-center">{actionMsg}</p>
              )}
            </>
          )}

          {/* ══ BSV → EVM: TRACKING ═══════════════════════════════════════════ */}
          {step === "tracking" && isBsvToEvm && (
            <>
              {displayIntent && !BSV_TERMINAL.has(displayIntent.status) && (
                <StatusStep
                  labels={["Deposit BSV", "Detecting", "Confirmed", "Solver fills", "Done"]}
                  currentIndex={bsvStepIndex(displayIntent.status)}
                />
              )}

              {displayIntent && (
                <StatusBadge
                  label={BSV_STATUS_LABELS[displayIntent.status]}
                  isComplete={displayIntent.status === "CLAIMED"}
                  isFailed={displayIntent.status === "REFUNDED" || displayIntent.status === "CANCELLED"}
                  isWarning={refundable}
                  sub={
                    displayIntent.status === "FUNDED" && displayIntent.confirmations != null
                      ? `${displayIntent.confirmations} of 3 confirmations`
                      : !BSV_TERMINAL.has(displayIntent.status) && !refundable
                      ? `HTLC expires in ${timeLeft}`
                      : undefined
                  }
                />
              )}

              {displayIntent && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
                  <Row label="HTLC address">
                    <span className="flex items-center gap-1">
                      {displayIntent.htlcAddress.slice(0, 10)}…{displayIntent.htlcAddress.slice(-6)}
                      <CopyButton text={displayIntent.htlcAddress} />
                      <a href={`https://whatsonchain.com/address/${displayIntent.htlcAddress}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-violet-400 hover:text-violet-300">
                        <ExternalLink size={9} />
                      </a>
                    </span>
                  </Row>
                  <Row label="Swap">
                    {(displayIntent.amountInSat / 1e8).toFixed(8)} BSV →
                    ≥{parseFloat(displayIntent.minAmountOut).toFixed(4)} {displayIntent.tokenOut}
                  </Row>
                  <Row label="Chain">{chainName} ({displayIntent.destinationChain})</Row>
                  <Row label="Receive">
                    {displayIntent.destinationAddress.slice(0, 10)}…{displayIntent.destinationAddress.slice(-4)}
                  </Row>
                  {displayIntent.fundingTxid && (
                    <Row label="Deposit tx">
                      <TxLink href={`https://whatsonchain.com/tx/${displayIntent.fundingTxid}`}
                        txid={displayIntent.fundingTxid} />
                    </Row>
                  )}
                  {overlayRecord && (
                    <Row label="On-chain record">
                      <a
                        href={overlayRecord.explorerUrl ?? `https://whatsonchain.com/tx/${overlayRecord.txid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 text-xs font-medium"
                      >
                        <CheckCircle2 size={10} />
                        Verified on-chain ✓
                      </a>
                    </Row>
                  )}
                  {displayIntent.claimTxid && (
                    <Row label="Claim tx">
                      <TxLink href={`https://whatsonchain.com/tx/${displayIntent.claimTxid}`}
                        txid={displayIntent.claimTxid} className="text-emerald-300" />
                    </Row>
                  )}
                  {displayIntent.solverPaymentTxid && (
                    <Row label="EVM payment">
                      <TxLink href={`https://etherscan.io/tx/${displayIntent.solverPaymentTxid}`}
                        txid={displayIntent.solverPaymentTxid} className="text-emerald-300" />
                    </Row>
                  )}
                  {displayIntent.refundTxid && (
                    <Row label="Refund tx">
                      <TxLink href={`https://whatsonchain.com/tx/${displayIntent.refundTxid}`}
                        txid={displayIntent.refundTxid} className="text-amber-300" />
                    </Row>
                  )}
                </div>
              )}

              {refundable && !BSV_TERMINAL.has(displayIntent?.status ?? "CANCELLED") && (
                <button onClick={handleRefund} disabled={refunding}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold bg-amber-600/80 text-white hover:bg-amber-500 disabled:opacity-50 transition-all">
                  {refunding
                    ? <><Loader2 size={14} className="animate-spin" /> Initiating…</>
                    : <><RotateCcw size={14} /> Reclaim funds (CLTV refund)</>}
                </button>
              )}

              {actionMsg && (
                <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">
                  {actionMsg}
                </div>
              )}

              {(bsvComplete || bsvRefunded) && (
                <button
                  onClick={() => {
                    setStep("configure"); setIntentId(null);
                    setFundingData(null); setBsvTxid(null);
                    setAmtBsv(""); setDestAddr(""); setActionMsg(null);
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors">
                  <ArrowLeftRight size={14} /> Start new swap
                </button>
              )}

              {!bsvComplete && !bsvRefunded && (
                <button onClick={() => refetchIntent()}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors">
                  <RotateCcw size={10} /> Refresh status
                </button>
              )}
            </>
          )}

          {/* ══ EVM → BSV: CONFIGURE ══════════════════════════════════════════ */}
          {step === "configure" && !isBsvToEvm && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                    EVM token to send
                  </label>
                  <select value={evmToken} onChange={e => setEvmToken(e.target.value)}
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-violet-500/50">
                    {EVM_IN_TOKENS.map(t => <option key={t.symbol}>{t.symbol}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                    EVM chain
                  </label>
                  <select value={evmChainId} onChange={e => setEvmChainId(Number(e.target.value))}
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-violet-500/50">
                    {CHAINS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Amount ({evmToken})
                </label>
                <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden focus-within:border-violet-500/50">
                  <input type="number" min="0" step="0.001" placeholder="0.1"
                    value={evmAmtStr} onChange={e => setEvmAmtStr(e.target.value)}
                    className="flex-1 bg-transparent px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600" />
                  <span className="px-3 text-xs font-bold text-zinc-400">{evmToken}</span>
                </div>
                {evmValueUsd > 0 && (
                  <p className="text-[10px] text-zinc-500">≈ ${evmValueUsd.toFixed(2)} USD</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  BSV receive address
                </label>
                <input type="text" placeholder="1YourBSVAddress…"
                  value={bsvRecvAddr} onChange={e => setBsvRecvAddr(e.target.value)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-xs font-mono text-zinc-100 outline-none focus:border-violet-500/50 placeholder:text-zinc-600"
                />
                {internalBsvAddress && !bsvRecvAddr && (
                  <button onClick={() => setBsvRecvAddr(internalBsvAddress)}
                    className="text-[10px] text-violet-400 hover:text-violet-300 self-start">
                    Use my OrahDEX BSV address
                  </button>
                )}
              </div>

              {!tokenAddrOnChain && evmToken !== "ETH" && (
                <div className="flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/8 px-3 py-2 text-xs text-yellow-300">
                  <AlertCircle size={12} className="shrink-0" />
                  {evmToken} is not supported on {evmChainName}. Switch chain.
                </div>
              )}

              {estimatedBsvOut > 0 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-1.5">
                  <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                    Estimated swap
                  </p>
                  <div className="flex items-center gap-2 text-sm font-bold">
                    <span className="text-zinc-200">{evmAmtNum.toFixed(4)} {evmToken}</span>
                    <ArrowRight size={13} className="text-violet-400" />
                    <span className="text-violet-300">≥ {estimatedBsvOut.toFixed(4)} BSV</span>
                  </div>
                  <p className="text-[9px] text-zinc-600">
                    {SLIPPAGE * 100}% slippage · Escrow lock on {evmChainName} · Solver delivers BSV
                  </p>
                </div>
              )}

              {formErr && <ErrorBox msg={formErr} />}

              <button onClick={handleEvmLock}
                disabled={
                  !evmAmtNum || evmAmtNum <= 0 ||
                  !bsvRecvAddr.trim() || !address ||
                  (!tokenAddrOnChain)
                }
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold bg-violet-600 text-white hover:bg-violet-500 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                <Lock size={14} /> Lock {evmToken} & Request BSV
              </button>
            </>
          )}

          {/* ══ EVM → BSV: LOCKING ════════════════════════════════════════════ */}
          {step === "locking" && !isBsvToEvm && (
            <div className="flex flex-col items-center py-6 gap-3">
              {lockingEvm && !lockErr ? (
                <>
                  <Loader2 size={32} className="animate-spin text-violet-400" />
                  <p className="text-sm font-semibold text-violet-300">
                    Locking {evmToken} on {evmChainName}…
                  </p>
                  <p className="text-xs text-zinc-500 text-center">
                    Approve the transaction in your wallet. Do not close this window.
                  </p>
                </>
              ) : lockErr ? (
                <>
                  <AlertCircle size={28} className="text-red-400" />
                  <p className="text-sm font-semibold text-red-300">Lock failed</p>
                  <p className="text-xs text-zinc-400 text-center">{lockErr}</p>
                  <button
                    onClick={() => { setStep("configure"); setEvmSwapId(null); setLockErr(null); }}
                    className="mt-2 px-4 py-2 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors">
                    Back to configure
                  </button>
                </>
              ) : null}
            </div>
          )}

          {/* ══ EVM → BSV: TRACKING ═══════════════════════════════════════════ */}
          {step === "tracking" && !isBsvToEvm && (
            <>
              <StatusStep
                labels={["Lock EVM", "Locked", "Solver delivers", "Done"]}
                currentIndex={evmStepIndex}
              />

              <StatusBadge
                label={EVM_STATUS_LABELS[activeEvmStatus]}
                isComplete={activeEvmStatus === "COMPLETE"}
                isFailed={activeEvmStatus === "FAILED" || activeEvmStatus === "REFUNDED"}
                isWarning={false}
                sub={
                  activeEvmStatus === "LOCKED"
                    ? "Lock confirmed. Solver detecting — BSV delivery takes 1–5 min."
                    : activeEvmStatus === "AWAITING_BSV" || activeEvmStatus === "BSV_SENT"
                    ? "BSV is on its way to your receive address."
                    : undefined
                }
              />

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
                {evmSwapData && (
                  <>
                    <Row label="Swap">
                      {evmSwapData.amountInHuman} {evmSwapData.tokenIn}
                      {evmSwapData.estimatedBsvOut
                        ? ` → ≥ ${parseFloat(evmSwapData.estimatedBsvOut).toFixed(4)} BSV`
                        : " → BSV"}
                    </Row>
                    <Row label="Chain">{evmChainName}</Row>
                    <Row label="BSV receive">
                      {evmSwapData.bsvReceiveAddr.slice(0, 12)}…{evmSwapData.bsvReceiveAddr.slice(-6)}
                    </Row>
                  </>
                )}
                {(evmSwapData?.evmLockTxHash ?? localLockHash) && (
                  <Row label="Lock tx">
                    <TxLink
                      href={explorerTx(evmChainId, (evmSwapData?.evmLockTxHash ?? localLockHash)!)}
                      txid={(evmSwapData?.evmLockTxHash ?? localLockHash)!}
                    />
                  </Row>
                )}
                {evmSwapData?.solverBsvTxid && (
                  <Row label="BSV delivery tx">
                    <TxLink
                      href={`https://whatsonchain.com/tx/${evmSwapData.solverBsvTxid}`}
                      txid={evmSwapData.solverBsvTxid}
                      className="text-emerald-300"
                    />
                  </Row>
                )}
                {evmSwapId && (
                  <Row label="Swap ID">
                    <span className="text-zinc-600 text-[10px]">{evmSwapId.slice(0, 18)}…</span>
                  </Row>
                )}
              </div>

              {!evmFailed && !evmIsExpired && (
                <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/30 px-3 py-2.5 text-[10px] text-zinc-400 leading-relaxed space-y-1">
                  <p className="font-semibold text-zinc-300">What happens next?</p>
                  <p>
                    A solver monitors the escrow contract and delivers BSV to your address once
                    your lock is confirmed. If BSV is not delivered within the escrow timeout,
                    you can reclaim via the escrow contract.
                  </p>
                </div>
              )}

              {/* ── EVM → BSV reclaim panel ───────────────────────────────────── */}
              {(evmFailed || evmIsExpired) && !evmComplete && (() => {
                const contractAddr = escrowAddress(evmSwapData?.chainId ?? null);
                const cid = evmSwapData?.chainId;
                const explorerBase: Record<number, string> = {
                  1:        "https://etherscan.io",
                  11155111: "https://sepolia.etherscan.io",
                  56:       "https://bscscan.com",
                  97:       "https://testnet.bscscan.com",
                };
                const explorerRoot = (cid && explorerBase[cid]) ?? "https://etherscan.io";
                const writeUrl = contractAddr
                  ? `${explorerRoot}/address/${contractAddr}#writeContract`
                  : null;
                return (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 space-y-2.5">
                    <div className="flex items-center gap-1.5">
                      <RotateCcw size={12} className="text-amber-400 shrink-0" />
                      <p className="text-xs font-semibold text-amber-300">Reclaim your EVM funds</p>
                    </div>
                    <p className="text-[10px] text-amber-200/70 leading-relaxed">
                      {evmFailed
                        ? "This swap failed before BSV was delivered."
                        : "The swap window has expired without BSV delivery."}{" "}
                      Call{" "}
                      <code className="bg-zinc-800 px-1 rounded text-amber-300">refund(orderId)</code>{" "}
                      on the escrow contract to recover your locked tokens.
                    </p>
                    {contractAddr && (
                      <div className="space-y-1">
                        <p className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold">Escrow contract</p>
                        <div className="flex items-center gap-2">
                          <code className="text-[10px] font-mono text-zinc-300 flex-1 break-all">{contractAddr}</code>
                          <CopyButton text={contractAddr} />
                        </div>
                      </div>
                    )}
                    {evmSwapId && (
                      <div className="space-y-1">
                        <p className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold">Order ID (refund argument)</p>
                        <div className="flex items-center gap-2">
                          <code className="text-[10px] font-mono text-zinc-300 flex-1 break-all">{evmSwapId}</code>
                          <CopyButton text={evmSwapId} />
                        </div>
                      </div>
                    )}
                    {writeUrl && (
                      <a href={writeUrl} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-amber-400 hover:text-amber-300 transition-colors">
                        <ExternalLink size={10} /> Open Write Contract on Explorer
                      </a>
                    )}
                  </div>
                );
              })()}

              {(evmComplete || evmFailed) ? (
                <button
                  onClick={() => {
                    setStep("configure"); setEvmSwapId(null);
                    setEvmAmtStr(""); setBsvRecvAddr(""); setLocalLockHash(null);
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors">
                  <ArrowLeftRight size={14} /> Start new swap
                </button>
              ) : (
                <button onClick={() => refetchEvmSwap()}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors">
                  <RotateCcw size={10} /> Refresh status
                </button>
              )}
            </>
          )}

          {/* Loading */}
          {step !== "configure" && step !== "locking" && !displayIntent && !evmSwapData && !evmSwapId && (
            <div className="flex items-center justify-center py-6 gap-2 text-zinc-500">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
