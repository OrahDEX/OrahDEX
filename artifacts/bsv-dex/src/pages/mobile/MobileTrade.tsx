import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { CoinLogo } from "@/components/CoinLogo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSignMessage, useAccount } from "wagmi";
import { Bell, Star, Share2, AlignJustify, X, TrendingUp, CheckCircle2, AlertCircle, Info, Zap, Check, Wallet, Clock, ListOrdered, ChevronDown, ChevronRight, Plus, Minus, ArrowLeftRight, Download, Users2, CreditCard, ShoppingCart, Link2, XCircle, ShieldCheck } from "lucide-react";
import { Chart } from "@/components/trading/Chart";
import { MobileMarketSelector } from "@/components/mobile/MobileMarketSelector";
import { ContractAddressBadge } from "@/components/ContractAddressBadge";
import { cn } from "@/lib/utils";
import { useWalletStore } from "@/store/useWalletStore";
import { useWalletModalStore } from "@/store/useWalletModalStore";
import { useEvmBalances } from "@/hooks/useEvmBalances";
import { useNotificationStore } from "@/store/useNotificationStore";
import { useToast } from "@/hooks/use-toast";
import { useWalletPrices } from "@/hooks/useWalletPrices";
import { useSettingsStore, convertFromUsd, getCurrencySymbol, FIAT_CURRENCIES } from "@/store/useSettingsStore";
import { CHAIN_DISPLAY, ADDRESS_PLACEHOLDERS, getAssetNativeChain, walletCanReceive } from "@/lib/crossChain";
import { MIN_QUICK_FILL_QTY } from "@/lib/tradeConstants";
import { VENUE_LABELS, VENUE_COLORS } from "@/lib/venues";
import { generateMockCandles, generateMockOrderBook, MOCK_TICKER } from "@/lib/mock-data";
import { useEscrow } from "@/hooks/useEscrow";
import { useLetsExchangePairs } from "@/hooks/useLetsExchangePairs";
import { usePairPrices } from "@/hooks/usePairPrices";
import { LockFundsDialog } from "@/components/trading/LockFundsDialog";
import { HtlcLockRecovery } from "@/components/trading/HtlcLockRecovery";
import { CrossChainSwapPanel } from "@/components/trading/CrossChainSwapPanel";
import { hasEscrow, chainLabel, checkEscrowDeposit, resolveEscrowAsset } from "@/lib/escrow";
import { getViemAccountForAddress } from "@/lib/walletSigner";
import { CoinInfoSheet } from "@/components/mobile/CoinInfoSheet";

/* ── Notifications drawer — backed by the real notification store ── */
const TYPE_ICON: Record<string, React.ReactNode> = {
  order_placed:    <ShoppingCart size={15} className="text-blue-400" />,
  order_filled:    <CheckCircle2 size={15} className="text-green-400" />,
  order_cancelled: <AlertCircle  size={15} className="text-amber-400" />,
  trade:           <Zap          size={15} className="text-violet-400" />,
  bridge:          <Link2        size={15} className="text-cyan-400" />,
  price_alert:     <TrendingUp   size={15} className="text-orange-400" />,
  info:            <Info         size={15} className="text-blue-400" />,
  warning:         <AlertCircle  size={15} className="text-amber-400" />,
  success:         <CheckCircle2 size={15} className="text-green-400" />,
  error:           <AlertCircle  size={15} className="text-red-400" />,
};

function relTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000)     return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDateTime(value: string | Date | number) {
  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const EVM_EXPLORERS: Record<number, string> = {
  1:      "https://etherscan.io/tx/",
  10:     "https://optimistic.etherscan.io/tx/",
  56:     "https://bscscan.com/tx/",
  130:    "https://explorer.unichain.org/tx/",
  137:    "https://polygonscan.com/tx/",
  324:    "https://explorer.zksync.io/tx/",
  1329:   "https://seitrace.com/tx/",
  8453:   "https://basescan.org/tx/",
  42161:  "https://arbiscan.io/tx/",
  43114:  "https://snowtrace.io/tx/",
  59144:  "https://lineascan.build/tx/",
  534352: "https://scrollscan.com/tx/",
};

function getOrderExplorerUrl(order: any): string | null {
  if (order?.explorerUrl) return String(order.explorerUrl);
  const txid = String(order?.txid ?? "");
  if (!txid) return null;
  if (txid.startsWith("htlc-pending-")) return null;
  if (txid.startsWith("local:")) return null;
  if (txid.startsWith("0x")) {
    const chainId = order?.chainId ?? order?.evmChainId;
    const base = (chainId && EVM_EXPLORERS[Number(chainId)]) ?? "https://etherscan.io/tx/";
    return base + txid;
  }
  return `https://whatsonchain.com/tx/${txid}`;
}

function getNotifPath(n: { type: string; pair?: string; href?: string }): string | null {
  if (n.href) return n.href;
  const { type, pair } = n;
  if (pair) {
    const urlPair = pair.replace("/", "-");
    const isFutures = urlPair.includes("PERP");
    if (["order_placed", "order_filled", "order_cancelled", "order_partial", "trade", "price_alert", "error"].includes(type)) {
      return isFutures ? `/futures/${urlPair}` : `/trade/${urlPair}`;
    }
  }
  if (type === "bridge") return "/swap";
  if (type === "wallet_connected" || type === "wallet_disconnected") return "/portfolio";
  if (type === "withdrawal" || type === "deposit") return "/portfolio";
  if (type === "liquidity") return "/liquidity";
  if (type === "support") return "/admin/support/inbox";
  if (type === "order_placed" || type === "order_cancelled" || type === "order_filled" || type === "order_partial") return "/portfolio";
  return null;
}

function NotificationsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { notifications, markAllRead, clearAll, markRead } = useNotificationStore();
  const [, navigate] = useLocation();
  const unread = notifications.filter(n => !n.read).length;

  const handleMarkAll = () => markAllRead();
  const dismiss = (id: string) => {
    markRead(id);
  };

  const handleNotifClick = (n: { id: string; type: string; pair?: string; href?: string }) => {
    markRead(n.id);
    const dest = getNotifPath(n);
    if (!dest) return;
    onClose();
    if (dest.startsWith("http")) {
      window.open(dest, "_blank", "noopener,noreferrer");
      return;
    }
    navigate(dest);
  };

  return (
    <>
      <div
        className={cn("fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none")}
        onClick={onClose}
      />
      <div className={cn(
        "fixed top-0 right-0 bottom-0 z-50 w-[85vw] max-w-xs bg-background flex flex-col shadow-2xl transition-transform duration-250 ease-out border-l border-border",
        open ? "translate-x-0" : "translate-x-full"
      )}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-12 pb-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Bell size={16} className="text-foreground" />
            <span className="font-bold text-base">Notifications</span>
            {unread > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 bg-primary text-primary-foreground rounded-full">{unread}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unread > 0 && (
              <button onClick={handleMarkAll} className="text-xs text-primary font-semibold">Mark all read</button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Notif list */}
        <div className="flex-1 overflow-y-auto overscroll-contain divide-y divide-border/50">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
              <Bell size={32} className="opacity-30" />
              <p className="text-sm">No notifications yet</p>
              <p className="text-xs text-center px-6 opacity-70">Place an order to see trade updates here</p>
            </div>
          ) : notifications.map(n => {
            const dest = getNotifPath(n);
            return (
            <div
              key={n.id}
              onClick={() => handleNotifClick(n)}
              className={cn(
                "flex gap-3 px-4 py-3.5 relative transition-colors",
                !n.read && "bg-primary/4",
                dest ? "cursor-pointer hover:bg-secondary/50 active:bg-secondary/70" : "cursor-default",
              )}
            >
              {!n.read && <span className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-primary rounded-full" />}
              <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                {TYPE_ICON[n.type] ?? <Info size={15} className="text-blue-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-1">
                  <p className={cn("text-[13px] font-semibold leading-snug", !n.read ? "text-foreground" : "text-muted-foreground")}>{n.title}</p>
                  <button onClick={(e) => { e.stopPropagation(); dismiss(n.id); }} className="shrink-0 p-0.5 text-muted-foreground/50 hover:text-muted-foreground">
                    <X size={11} />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{n.body}</p>
                {n.txid && (
                  <a
                    href={n.href ?? (n.txid.startsWith("0x") ? `https://etherscan.io/tx/${n.txid}` : `https://whatsonchain.com/tx/${n.txid}`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-primary font-mono mt-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {n.txid.slice(0, 10)}… <Link2 size={10} />
                  </a>
                )}
                <p className="text-[10px] text-muted-foreground/50 mt-1">{relTime(n.timestamp)}</p>
              </div>
            </div>
          )})}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border px-4 py-3">
          <button onClick={clearAll} className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors">
            Clear all notifications
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Share toast ── */
function ShareToast({ visible, copied }: { visible: boolean; copied: boolean }) {
  return (
    <div className={cn(
      "fixed bottom-28 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-foreground text-background text-sm font-semibold shadow-xl transition-all duration-300",
      visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none"
    )}>
      {copied ? <><Check size={14} /> Link copied!</> : <><Share2 size={14} /> Shared!</>}
    </div>
  );
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");


function fmt(p: number) {
  if (!p || !isFinite(p) || p <= 0) return "—";
  if (p >= 1000)  return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(2);
  if (p >= 0.01)  return p.toFixed(4);
  if (p >= 0.001) return p.toFixed(6);
  if (p >= 1e-8)  return p.toFixed(8);
  // Sub-satoshi prices (e.g. BTT/BTC): extend decimal places to show 4 sig figs
  const mag = -Math.floor(Math.log10(p));
  return p.toFixed(Math.min(mag + 3, 18)).replace(/\.?0+$/, "");
}
function fmtVol(v: number) {
  if (!v) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return v.toFixed(2);
}

const INDICATORS = ["MA", "EMA", "BOLL"] as const;
type IndicatorName = typeof INDICATORS[number];

// Maps tab name → Chart sub-panel indicator (null = overlay only, no sub-chart change)
const INDICATOR_TO_SUB: Record<IndicatorName, "macd" | "rsi" | "stoch" | "cci" | "williams" | "none" | null> = {
  MA:   null,    // main-chart overlay
  EMA:  null,    // main-chart overlay
  BOLL: null,    // main-chart overlay
};
const PERIODS = [
  { label: "Today", key: "today" },
  { label: "7D",    key: "7d" },
  { label: "30D",   key: "30d" },
  { label: "90D",   key: "90d" },
  { label: "180D",  key: "180d" },
  { label: "1Y",    key: "1y" },
] as const;

type BottomTab = "orderbook" | "trades" | "orders";
type Side = "buy" | "sell";
type OrderType = "limit" | "market" | "stop-limit" | "stop-market" | "trailing-stop" | "post-only";

const ORDER_TYPES: OrderType[] = ["limit", "market", "stop-limit", "stop-market", "trailing-stop", "post-only"];
const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  "limit":         "Limit",
  "market":        "Market",
  "stop-limit":    "Stop-Limit",
  "stop-market":   "Stop-Market",
  "trailing-stop": "Trailing Stop",
  "post-only":     "Post Only",
};
const ORDER_TYPE_DESCS: Record<OrderType, string> = {
  "limit":         "Set a specific price. Order fills only at that price or better.",
  "market":        "Fills immediately at the best available price.",
  "stop-limit":    "Triggers a limit order when the stop price is reached.",
  "stop-market":   "Triggers a market order when the stop price is reached.",
  "trailing-stop": "Stop price trails the market by a callback rate %.",
  "post-only":     "Always placed as maker. Rejected if it would immediately fill.",
};


export function MobileTrade({ symbol: rawSymbol }: { symbol: string }) {
  // Only replace the first hyphen (base-quote separator); keep -PERP suffix intact
  const symbol = rawSymbol.replace(/^([^-]+)-/, "$1/");
  const base = symbol.split("/")[0];
  const quote = symbol.split("/")[1]?.replace("-PERP", "") ?? "USDT";
  const isFutures = rawSymbol.toUpperCase().includes("PERP");

  const { address, balance: walletBalance, chainId: walletChainId, network, provider, internalEvmAddress, internalBsvAddress, internalBchAddress, internalBtcAddress, internalSolAddress, internalXrpAddress, internalLtcAddress, internalDogeAddress, switchChain } = useWalletStore();
  const { signMessageAsync } = useSignMessage();
  const { isConnected: evmConnected } = useAccount();
  const isEvm = network === "evm" || (!network && !!walletChainId);
  const isOrahWallet = provider === "orah-wallet";
  const isExternalEvm = isEvm && !isOrahWallet;
  // Non-custodial mode: any EVM wallet (including Orah self-custody) trades
  // directly from its on-chain balance — no exchange deposit required.
  // Only non-EVM Orah chains (BSV/BTC/SOL) still use the internal ledger.
  const isSelfCustodyEvm = isEvm && !!address;
  // Default to chainId 1 (Ethereum mainnet) when wallet hasn't reported a chain yet,
  // matching Portfolio behavior — otherwise the balance fetch never starts and Trade
  // shows 0 even though the wallet holds funds.
  const { balances: evmTokenBalances, loading: evmBalancesLoading, refresh: refreshEvmBalances } = useEvmBalances(isEvm ? address : null, isEvm ? (walletChainId ?? 1) : null);
  const { open: openWallet } = useWalletModalStore();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { addNotification } = useNotificationStore();
  const [apiBalances, setApiBalances] = useState<Record<string, number>>({});
  // Start as true so EVM users see "—" immediately rather than a flash of on-chain balance
  const [apiBalancesLoading, setApiBalancesLoading] = useState(true);
  const fetchApiBalances = useCallback(async (b: string, q: string, addr: string) => {
    const fetchOne = async (asset: string) => {
      try {
        const r = await fetch(`${BASE}/api/balances/${asset}?walletAddress=${addr}`, { cache: "no-store" });
        if (!r.ok) return { available: 0 };
        const j = await r.json();
        return { available: parseFloat(j.available ?? "0") || 0 };
      } catch { return { available: 0 }; }
    };
    setApiBalancesLoading(true);
    const [bRes, qRes] = await Promise.all([fetchOne(b), fetchOne(q)]);
    setApiBalances({ [b]: bRes.available, [q]: qRes.available });
    setApiBalancesLoading(false);
  }, []);
  // Fetch internal exchange balance for ALL connected wallets — not just Orah.
  // External EVM wallets accumulate internal balance after exchange trades or
  // on-chain swap settlements. Without this, sell orders on cross-chain pairs
  // (e.g. EVM wallet selling BSV) are incorrectly blocked by the sell guard.
  useEffect(() => {
    if (!address) { setApiBalances({}); return; }
    fetchApiBalances(base, quote, address);
  }, [address, symbol, fetchApiBalances, base, quote]);
  // Only Orah Wallet uses internal exchange ledger as the primary available balance source.
  // External wallets (EVM/BSV/BTC/SOL) use on-chain wallet balances, optionally merged with
  // internal exchange balances for assets accumulated via exchange trades.
  const usesApiBalance = isOrahWallet && !isEvm;
  // Show pending state only when the current mode depends on ledger balances.
  const balancesPending = usesApiBalance && apiBalancesLoading;

  const { quoteCurrency } = useSettingsStore();
  const { prices: crossPrices } = useWalletPrices();
  const BTC_USD_RATE = crossPrices.BTC.usd || 83000;
  const BSV_USD_RATE = crossPrices.BSV.usd || 16;
  const ETH_USD_RATE = crossPrices.ETH.usd || 2400;
  const QUOTE_TO_USD: Record<string, number> = {
    USDT: 1, USDC: 1, TUSD: 1, USDD: 1, FDUSD: 1,
    BTC: BTC_USD_RATE, ETH: ETH_USD_RATE, BSV: BSV_USD_RATE,
    BNB: crossPrices.BNB?.usd || 580,
    BCH: crossPrices.BCH?.usd || 320,
    SOL: crossPrices.SOL?.usd || 130,
    MATIC: crossPrices.MATIC?.usd || 0.32,
    AVAX: crossPrices.AVAX?.usd || 18,
    ARB: crossPrices.ARB?.usd || 0.42,
    OP: crossPrices.OP?.usd || 0.70,
    FTM: crossPrices.FTM?.usd || 0.51,
    MNT: crossPrices.MNT?.usd || 0.70,
  };

  const { data: myOrdersData } = useQuery({
    queryKey: ["orders", address],
    queryFn: () => fetch(`${BASE}/api/orders?walletAddress=${encodeURIComponent(address || "")}`).then(r => r.json()),
    enabled: !!address,
    refetchInterval: 5_000,
    staleTime:       4_000,
  });

  // Also fetch orders placed under the alternate address (BSV ↔ EVM cross-network)
  const altAddress = (internalEvmAddress && internalEvmAddress !== address)
    ? internalEvmAddress
    : (internalBsvAddress && internalBsvAddress !== address)
      ? internalBsvAddress
      : null;

  const { data: altOrdersData } = useQuery({
    queryKey: ["orders", altAddress],
    queryFn: () => fetch(`${BASE}/api/orders?walletAddress=${encodeURIComponent(altAddress || "")}`).then(r => r.json()),
    enabled: !!altAddress,
    refetchInterval: 5_000,
    staleTime:       4_000,
  });

  const withOwnerWallet = (rows: any, fallbackWallet: string | null | undefined) => (
    Array.isArray(rows)
      ? rows.map((o: any) => ({ ...o, ownerWalletAddress: o.walletAddress || fallbackWallet || "" }))
      : []
  );

  const myOrders: any[] = useMemo(() => {
    const primary = withOwnerWallet(myOrdersData, address);
    const alt = withOwnerWallet(altOrdersData, altAddress);
    const seen    = new Set<string>();
    return [...primary, ...alt].filter(o => {
      const key = String(o.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [myOrdersData, altOrdersData, address, altAddress]);
  const openOrders   = myOrders.filter(o => o.status === "open"  && o.symbol === symbol);
  const historyOrders = myOrders.filter(o => o.status !== "open" && o.symbol === symbol);

  // ── Compute amounts locked in open orders ACROSS ALL markets ──────────────
  // External wallets hold funds on-chain; the exchange cannot debit them until
  // an order fills. We must subtract every open order that locks the same
  // asset, not just orders on the current pair — e.g. an open BUY on APE/ETH
  // locks ETH, and that same ETH can't be used to BUY 0G on 0G/ETH.
  // For sells the base of each order locks; for buys the quote of each order locks.
  const allOpenOrders = myOrders.filter((o: any) => o.status === "open");
  const lockedSellQty = allOpenOrders
    .filter((o: any) => o.side === "sell" && (String(o.symbol).split("/")[0] || "").toUpperCase() === base.toUpperCase())
    .reduce((sum: number, o: any) => sum + parseFloat(o.quantity ?? "0"), 0);
  // lockedBuySpend is computed AFTER lastPrice (below) because market orders have
  // price: null and need lastPrice as a fallback to compute the correct spend amount.

  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const getOrderWalletAddress = (order: any) => (
    String(order?.walletAddress || order?.ownerWalletAddress || "")
  );

  const cancelMutation = useMutation({
    mutationFn: async ({ orderId, walletAddress: orderWalletAddress }: { orderId: string; walletAddress: string }) => {
      // Step 1 (best-effort): release any on-chain escrow lock so the user
      // gets their coins back. Only send the on-chain cancel tx if there is
      // actually a deposit in escrow — calling cancel() on an order that was
      // never locked causes "OrahDEXEscrow: no deposit" to revert, which
      // triggers a confusing "Gas fee estimation failed" prompt in the wallet.
      if (escrowAvailable && walletChainId) {
        let hasDeposit = false;
        try {
          // 4-second timeout: a slow RPC shouldn't stall the cancel button.
          const dep = await Promise.race([
            checkEscrowDeposit(orderId, walletChainId),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
          ]);
          hasDeposit = !!dep && !dep.released;
        } catch { /* RPC failure — err on the side of not sending a bad tx */ }

        if (hasDeposit) {
          try {
            await cancelOrderOnChain(orderId);
          } catch (e: any) {
            const msg = String(e?.message ?? "").toLowerCase();
            // Swallow "nothing to refund" errors (race: deposit released between
            // our check and the tx) — surface real failures (user rejection, etc).
            const isMissingDeposit =
              msg.includes("no deposit") ||
              msg.includes("already settled") ||
              msg.includes("already released");
            if (!isMissingDeposit) throw e;
          }
        }
      }
      // Step 2: tell the server to remove the order from the orderbook.
      const res = await fetch(`${BASE}/api/orders/${orderId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: orderWalletAddress }),
      });
      // 404 means the order is already cancelled (desired state) — treat as success.
      // This handles double-tap, stale cache, and races gracefully.
      if (res.status === 404) return { id: orderId, status: "cancelled" };
      if (!res.ok) throw new Error("Failed to cancel");
      return res.json();
    },
    onMutate: async ({ orderId }) => {
      setCancellingId(orderId);
      await queryClient.cancelQueries({ queryKey: ["orders", address] });
      if (altAddress) await queryClient.cancelQueries({ queryKey: ["orders", altAddress] });
      const prev = queryClient.getQueryData(["orders", address]);
      const prevAlt = altAddress ? queryClient.getQueryData(["orders", altAddress]) : undefined;
      queryClient.setQueryData(["orders", address], (old: any) =>
        Array.isArray(old)
          ? old.map((o: any) => String(o.id) === orderId ? { ...o, status: "cancelled", updatedAt: new Date().toISOString() } : o)
          : old
      );
      if (altAddress) {
        queryClient.setQueryData(["orders", altAddress], (old: any) =>
          Array.isArray(old)
            ? old.map((o: any) => String(o.id) === orderId ? { ...o, status: "cancelled", updatedAt: new Date().toISOString() } : o)
            : old
        );
      }
      return { prev, prevAlt };
    },
    onError: (err: any, _vars, context: any) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(["orders", address], context.prev);
      }
      if (altAddress && context?.prevAlt !== undefined) {
        queryClient.setQueryData(["orders", altAddress], context.prevAlt);
      }
      toast({
        title: "Cancel failed",
        description: String(err?.message ?? "Could not cancel order"),
        variant: "destructive",
      });
    },
    onSettled: () => {
      setCancellingId(null);
      queryClient.invalidateQueries({ queryKey: ["orders", address] });
      if (altAddress) queryClient.invalidateQueries({ queryKey: ["orders", altAddress] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-orders"] });
      if (usesApiBalance && address) {
        void fetchApiBalances(base, quote, address);
        queryClient.invalidateQueries({ queryKey: ["mobile-exchange-balances", address] });
      }
    },
  });
  const handleCancelOrder = useCallback((order: any) => {
    const walletAddress = getOrderWalletAddress(order);
    if (!walletAddress) {
      toast({
        title: "Cancel failed",
        description: "Order owner wallet is missing. Refresh and try again.",
        variant: "destructive",
      });
      return;
    }
    cancelMutation.mutate({ orderId: String(order.id), walletAddress });
  }, [cancelMutation, toast]);

  // ── Submission lock — prevents any multi-submit path ─────────────────────────
  // useRef is synchronous (unlike useState) so it blocks double-taps that happen
  // within the same React render cycle before isPending propagates.
  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Content fingerprint: same symbol+side+amount within 2 seconds = duplicate
  const lastOrderFingerprintRef = useRef<string | null>(null);

  // Dedup guard — prevents double banner/toast when the same fill event fires twice
  const lastProcessedTradeIdRef = useRef<string | null>(null);

  // Pre-read sessionStorage once so initial state can hydrate from it.
  const _bootLockFlow: any = (() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem("orahdex:lockFlow:v1");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })();
  const [orderResult, setOrderResult] = useState<{
    tradeId: string | null;
    matched: boolean;
    txid?: string;
    explorerUrl?: string | null;
    side: string;
    base: string;
    quoteSymbol: string;
    avgFillPrice: number;
    filledQty: number;
    fee: number;
    quantity: number;
    price: number;
  } | null>(_bootLockFlow?.order ?? null);
  const [escrowTx, setEscrowTx] = useState<{ txHash: string; explorerUrl: string } | null>(_bootLockFlow?.tx ?? null);
  const { escrowAvailable, status: escrowStatus, lockOrder, cancelOrder: cancelOrderOnChain, isLoading: escrowLoading, errorMsg: escrowErrorMsg, txResult: escrowTxResult, reset: resetEscrow } = useEscrow();
  // Lock-funds confirmation dialog (opens when user taps "Lock funds on X")
  // ── Persistence: mobile Safari kills the tab when the user opens imToken
  // to sign, so we save the in-flight lock state to sessionStorage and
  // re-hydrate it when the tab reloads. After hydration we also poll the
  // escrow contract once to detect locks that *did* complete while we were away.
  const LOCK_FLOW_KEY = "orahdex:lockFlow:v1";
  type LockFlowSnapshot = {
    open:    boolean;
    params:  { orderId: string; side: "buy" | "sell"; base: string; quote: string; quantity: number; price: number; } | null;
    tx:      { txHash: string; explorerUrl: string } | null;
    order:   any | null;  // orderResult, so the open-order card stays visible
  };
  const initialLockFlow: LockFlowSnapshot | null = (() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(LOCK_FLOW_KEY);
      return raw ? (JSON.parse(raw) as LockFlowSnapshot) : null;
    } catch { return null; }
  })();
  const [lockDialogOpen, setLockDialogOpen]   = useState<boolean>(initialLockFlow?.open ?? false);
  const [pendingLockParams, setPendingLockParams] = useState<{
    orderId: string; side: "buy" | "sell"; base: string; quote: string;
    quantity: number; price: number;
  } | null>(initialLockFlow?.params ?? null);

  // ── Persist lock-flow snapshot to sessionStorage on every change ──────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const snap: LockFlowSnapshot = {
      open:   lockDialogOpen,
      params: pendingLockParams,
      tx:     escrowTx,
      order:  orderResult,
    };
    // Only persist while a lock flow is "live" — otherwise clear it so we
    // don't re-open the dialog on the next visit.
    const isLive = lockDialogOpen || !!escrowTx || (!!pendingLockParams && !!orderResult && !orderResult.matched);
    if (isLive) {
      try { window.sessionStorage.setItem(LOCK_FLOW_KEY, JSON.stringify(snap)); } catch {}
    } else {
      try { window.sessionStorage.removeItem(LOCK_FLOW_KEY); } catch {}
    }
  }, [lockDialogOpen, pendingLockParams, escrowTx, orderResult]);

  // ── On mount: if we restored a pending lock, check on-chain whether the
  // tx already completed while the tab was backgrounded. If so, jump straight
  // to "success" so the user sees their funds locked instead of the confirm
  // screen offering to re-lock (which would revert with "already locked").
  useEffect(() => {
    if (!pendingLockParams || escrowTx || !walletChainId) return;
    let cancelled = false;
    (async () => {
      const dep = await checkEscrowDeposit(pendingLockParams.orderId, walletChainId);
      if (cancelled || !dep || dep.released) return;
      setEscrowTx({
        txHash: "",  // unknown — but the contract confirms funds are sitting in escrow
        explorerUrl: `https://etherscan.io/address/0xeE234cEb85697b64800E696699b7841e00413B4f`,
      });
      // Refresh on-chain balances so the deduction shows immediately
      setTimeout(() => { refreshEvmBalances(); }, 500);
    })();
    return () => { cancelled = true; };
  // intentionally only on mount + when chainId resolves
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletChainId]);

  const [orderError, setOrderError] = useState<{ message: string; code?: string } | null>(null);


  const orderMutation = useMutation({
    mutationFn: async (body: object) => {
      const res = await fetch(`${BASE}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let errMsg = "Order failed";
        let errCode: string | undefined;
        try {
          const errData = await res.json();
          errMsg  = errData?.error ?? errMsg;
          errCode = errData?.code;
        } catch { /* ignore parse error */ }
        const err: any = new Error(errMsg);
        err.code = errCode;
        throw err;
      }
      return res.json();
    },
    onSuccess: (data, variables: any) => {
      setOrderError(null);
      const matched  = data?.matched ?? false;
      const txid     = data?.settlementTxid ?? data?.txid;
      const explorerUrl = data?.explorerUrl ?? null;
      const tradeId  = data?.id ?? null;
      const ordSide  = variables?.side ?? side;
      const ordBase  = data?.symbol?.split("/")[0] ?? base;
      const ordQuote = data?.quoteSymbol ?? quote;

      // ── Dedup guard: must run BEFORE any state update or toast ───────────────
      if (matched && tradeId && tradeId === lastProcessedTradeIdRef.current) return;
      if (matched && tradeId) lastProcessedTradeIdRef.current = tradeId;

      // ── Fill data: all sourced from API response, never from user inputs ──────
      // data.filledQuantity — actual qty filled (base asset, set by matcher)
      // data.price          — avgFillPrice (always set for matched orders)
      // data.total          — filledQty × price (gross quote, set by matcher)
      // data.fee            — 0.1% of gross in quote currency
      const filledQty    = data?.filledQuantity ?? 0;
      const avgFillPrice = data?.price ?? (data?.total && filledQty > 0 ? data.total / filledQty : 0);
      const fee          = data?.fee ?? 0;

      // Limit/stop order display fields for unmatched orders
      const ordQtyDisplay   = data?.quantity ?? variables?.quantity ?? "";
      const ordPriceDisplay = data?.price && !matched ? String(data.price) : (variables?.price ?? "");

      // ── Release submission lock so next order can be placed ──────────────────
      isSubmittingRef.current = false;
      setIsSubmitting(false);

      setEscrowTx(null);
      setOrderResult({
        tradeId, matched, txid, explorerUrl,
        side: ordSide, base: ordBase, quoteSymbol: ordQuote, avgFillPrice, filledQty, fee,
        quantity: Number(ordQtyDisplay) || 0,
        price:    Number(ordPriceDisplay) || 0,
      });
      setAmount("");

      // ── Auto-open the lock-funds confirmation popup the moment the order
      // is placed — so the user sees the popup directly after tapping
      // Buy/Sell instead of having to find a separate "Lock funds on ETH"
      // button. Only open for unmatched (open) orders on a chain where
      // escrow is deployed, and only when self-custody escrow is available.
      if (!matched && tradeId && escrowAvailable && hasEscrow(walletChainId ?? 0)) {
        const usePrice = Number(ordPriceDisplay) > 0 ? Number(ordPriceDisplay) : lastPrice;
        const useQty   = Number(ordQtyDisplay) || 0;
        // For a buy order the lock amount = quantity × price. If price is still
        // 0 (market order placed before the price feed loads) we can't compute
        // a valid lock amount. Skip the auto-popup — the manual "Lock funds"
        // button will remain available once the price feed arrives.
        const lockAmountKnown = ordSide === "sell" ? useQty > 0 : (useQty > 0 && usePrice > 0);
        // Also verify the token is resolvable to an on-chain address before
        // opening the dialog — tokens not in CHAIN_TOKEN_ADDRESSES would show
        // Amount "—" with the button permanently disabled. The order was already
        // accepted server-side with sig-only proof, so skip the lock dialog
        // gracefully for unlisted tokens instead of showing a broken popup.
        const lockAssetResolvable = lockAmountKnown && !!resolveEscrowAsset(
          walletChainId ?? 0,
          ordSide as "buy" | "sell",
          ordBase, ordQuote, useQty, usePrice,
        );
        // Always reset stale escrow state when a new order is placed so the
        // previous cancel/lock error doesn't bleed through to the new order card.
        resetEscrow();
        if (lockAssetResolvable) {
          setPendingLockParams({
            orderId:  tradeId,
            side:     ordSide as "buy" | "sell",
            base:     ordBase,
            quote:    ordQuote,
            quantity: useQty,
            price:    usePrice,
          });
          setLockDialogOpen(true);
        }
      }

      queryClient.invalidateQueries({ queryKey: ["orders", address] });
      if (altAddress) queryClient.invalidateQueries({ queryKey: ["orders", altAddress] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-orders"] });
      if (usesApiBalance && address) {
        void fetchApiBalances(base, quote, address);
        queryClient.invalidateQueries({ queryKey: ["mobile-exchange-balances", address] });
      }
      setTimeout(() => setOrderResult(null), 10000);

      if (matched && address) {
        // Compute credited amount from fill payload — never from wallet diff
        let receivedQty: string;
        let receivedTok: string;
        if (ordSide === "sell") {
          const gross = filledQty * avgFillPrice;
          const net   = gross - fee;
          receivedQty = net > 0 ? net.toFixed(2) : gross.toFixed(2);
          receivedTok = ordQuote;
        } else {
          receivedQty = filledQty > 0 ? filledQty.toFixed(6) : "0";
          receivedTok = ordBase;
        }

        toast({
          title: `✅ ${ordSide === "sell" ? "Sell" : "Buy"} Order Filled!`,
          description: isEvm
            ? `+${receivedQty} ${receivedTok} settled on-chain to your wallet`
            : `+${receivedQty} ${receivedTok} credited to your OrahDEX balance`,
        });
        addNotification({
          type: "order_filled",
          title: `${ordSide === "sell" ? "SELL" : "BUY"} Order Filled ✓`,
          body: isEvm
            ? `+${receivedQty} ${receivedTok} settled on-chain to your wallet`
            : `+${receivedQty} ${receivedTok} credited to your OrahDEX balance · withdraw anytime`,
          pair: symbol,
          side: ordSide as "buy" | "sell",
          txid: txid ?? undefined,
          href: explorerUrl ?? undefined,
        });
      } else {
        // Unmatched: use quantity and price from the API-confirmed order record
        const qtyStr = ordQtyDisplay ? String(ordQtyDisplay) : amount;
        toast({
          title: `📋 ${ordSide === "sell" ? "Sell" : "Buy"} Order Placed`,
          description: ordPriceDisplay
            ? `${qtyStr} ${ordBase} @ $${parseFloat(ordPriceDisplay).toLocaleString()} · open in order book, waiting for match`
            : `${qtyStr} ${ordBase} open — waiting for a matching ${ordSide === "sell" ? "buyer" : "seller"}`,
        });
        addNotification({
          type: "order_placed",
          title: `${ordSide === "sell" ? "SELL" : "BUY"} Order Open`,
          body: ordPriceDisplay
            ? `${qtyStr} ${ordBase} @ $${parseFloat(ordPriceDisplay).toLocaleString()} · waiting for match`
            : `${qtyStr} ${ordBase} in order book`,
          pair: symbol,
          side: ordSide as "buy" | "sell",
        });
      }
    },
    onError: (err: any) => {
      // Release lock on error so the user can try again
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      lastOrderFingerprintRef.current = null;
      const msg  = err?.message ?? "Could not place order";
      const code = err?.code;
      setOrderError({ message: msg, code });
      toast({
        title:       code === "NO_LIQUIDITY" ? "No Liquidity" : "Order Failed",
        description: code === "NO_LIQUIDITY"
          ? "No matching sellers found. Place a limit order to set your price instead."
          : code === "DEPOSIT_REQUIRED"
          ? (usesApiBalance
            ? "Deposit funds to your OrahDEX trading balance before trading."
            : isSelfCustodyEvm
              ? "Insufficient on-chain balance. Add funds to your wallet before trading."
              : "Deposit funds to your wallet before trading.")
          : code === "INSUFFICIENT_FUNDS"
          ? (usesApiBalance
            ? "Insufficient balance. Check your trading balance."
            : "Insufficient wallet balance. Check your on-chain funds.")
          : msg,
        variant: "destructive",
      });
    },
  });

  const [interval, setInterval] = useState<string>(() => {
    const saved = localStorage.getItem('orahdex-mobile-interval');
    const valid = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d','3d','1w','1M','1Y','2Y','5Y','10Y','All'];
    return saved && valid.includes(saved) ? saved : "1h";
  });
  const [activeIndicator, setActiveIndicator] = useState<IndicatorName | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>("orderbook");
  const [starred, setStarred] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [coinInfoOpen, setCoinInfoOpen] = useState(false);
  const headerUnread = useNotificationStore((s) => s.notifications.filter(n => !n.read).length);
  const [shareToastVisible, setShareToastVisible] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [side, setSide] = useState<Side>("buy");

  const handleShare = async () => {
    const url = `${window.location.origin}${import.meta.env.BASE_URL}trade/${rawSymbol}`;
    const text = `Trade ${symbol} on OrahDEX — Trade means DEX`;
    if (navigator.share) {
      try { await navigator.share({ title: `OrahDEX — ${symbol}`, text, url }); } catch {}
      setShareCopied(false);
    } else {
      try { await navigator.clipboard.writeText(url); } catch {}
      setShareCopied(true);
    }
    setShareToastVisible(true);
    setTimeout(() => setShareToastVisible(false), 2200);
  };
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [orderTypeOpen, setOrderTypeOpen] = useState(false);
  const [fundingSheetOpen, setFundingSheetOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [trailingRate, setTrailingRate] = useState("");
  const [amount, setAmount] = useState("");

  // Clear order form fields whenever the trading pair changes.
  // MobileTrade is a keep-alive tab component (no key prop) — the same instance
  // is reused across all pair navigations, so state does NOT reset automatically.
  // Without this, a price like "4421" from ETH/USDT persists on the next pair
  // and produces a wildly out-of-market limit order that confuses users.
  useEffect(() => {
    setPrice("");
    setAmount("");
    setStopPrice("");
    setTrailingRate("");
  }, [rawSymbol]);
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [atomicSwapOpen, setAtomicSwapOpen] = useState(false);
  const scrollBodyRef  = useRef<HTMLDivElement>(null);
  const orderFormRef   = useRef<HTMLDivElement>(null);
  const [receiveAddress, setReceiveAddress] = useState("");
  const baseChain = getAssetNativeChain(base);
  const canReceiveBase = walletCanReceive(network, baseChain);
  const isBaseEvmChain = baseChain === "evm";
  const hasMobileInternalEvm = !!internalEvmAddress && network === "bsv";
  const mobileEvmHandled = isBaseEvmChain && hasMobileInternalEvm;
  const isMobileBsvChain = baseChain === "bsv";
  const hasMobileInternalBsv = !!internalBsvAddress && network === "evm";
  const mobileBsvHandled = isMobileBsvChain && hasMobileInternalBsv;
  const isMobileBtcChain = baseChain === "bitcoin";
  const hasMobileInternalBtc = !!internalBtcAddress && network === "evm";
  const mobileBtcHandled = isMobileBtcChain && hasMobileInternalBtc;
  const isMobileSolChain  = baseChain === "solana";
  const hasMobileInternalSol  = !!internalSolAddress  && network === "evm";
  const mobileSolHandled  = isMobileSolChain  && hasMobileInternalSol;
  const isMobileXrpChain  = baseChain === "ripple";
  const hasMobileInternalXrp  = !!internalXrpAddress  && network === "evm";
  const mobileXrpHandled  = isMobileXrpChain  && hasMobileInternalXrp;
  const isMobileLtcChain  = baseChain === "litecoin";
  const hasMobileInternalLtc  = !!internalLtcAddress  && network === "evm";
  const mobileLtcHandled  = isMobileLtcChain  && hasMobileInternalLtc;
  const isMobileDogeChain = baseChain === "dogecoin";
  const hasMobileInternalDoge = !!internalDogeAddress && network === "evm";
  const mobileDogeHandled = isMobileDogeChain && hasMobileInternalDoge;
  const hasMobileSeparateBtcAddr = !!internalBtcAddress && internalBtcAddress !== internalBsvAddress;
  const showCrossChainNotice = side === "buy" && !!address && !canReceiveBase && !mobileEvmHandled && !mobileBsvHandled && !mobileBtcHandled && !mobileSolHandled && !mobileXrpHandled && !mobileLtcHandled && !mobileDogeHandled;
  const showMobileEvmInfo  = side === "buy" && !!address && network === "bsv" && isBaseEvmChain    && hasMobileInternalEvm;
  const showMobileBsvInfo  = side === "buy" && !!address && network === "evm" && isMobileBsvChain  && hasMobileInternalBsv;
  const showMobileBtcInfo  = side === "buy" && !!address && network === "evm" && isMobileBtcChain  && hasMobileInternalBtc;
  const showMobileSolInfo  = side === "buy" && !!address && network === "evm" && isMobileSolChain  && hasMobileInternalSol;
  const showMobileXrpInfo  = side === "buy" && !!address && network === "evm" && isMobileXrpChain  && hasMobileInternalXrp;
  const showMobileLtcInfo  = side === "buy" && !!address && network === "evm" && isMobileLtcChain  && hasMobileInternalLtc;
  const showMobileDogeInfo = side === "buy" && !!address && network === "evm" && isMobileDogeChain && hasMobileInternalDoge;
  const crossChainName = CHAIN_DISPLAY[baseChain] ?? baseChain;
  const crossChainPlaceholder = ADDRESS_PLACEHOLDERS[baseChain] ?? `${base} address…`;

  const encodedSymbol = encodeURIComponent(symbol);

  const { data: ticker } = useQuery({
    queryKey: ["ticker", symbol],
    queryFn: () => fetch(`${BASE}/api/markets/${encodedSymbol}/ticker`).then(r => r.json()),
    refetchInterval: 5000,
  });

  const { pairs: rawLePairs } = useLetsExchangePairs({ all: true });
  const lePair = useMemo(() => {
    if (!Array.isArray(rawLePairs)) return null;
    const key = symbol.toUpperCase();
    return rawLePairs.find((p) => String(p.symbol).toUpperCase() === key) ?? null;
  }, [rawLePairs, symbol]);

  const lePairPrice = Number(lePair?.lastPrice ?? 0) || 0;
  const lePairChange = Number(lePair?.priceChangePercent24h ?? 0) || 0;

  // Live LE/SS rate for this pair — works for any of the 1.8M bridge pairs even with no stored price
  const { letsexchange: leVenuePrice } = usePairPrices(
    { symbol: base, network: base },
    { symbol: quote, network: quote },
  );
  const liveBridgeRate = leVenuePrice?.rate ?? 0;

  const MOBILE_RANGE_PRESET_MAP: Record<string, { apiInterval: string; limit: number }> = {
    '1Y':  { apiInterval: '1d', limit: 365 },
    '2Y':  { apiInterval: '1w', limit: 104 },
    '5Y':  { apiInterval: '1w', limit: 261 },
    '10Y': { apiInterval: '1M', limit: 120 },
    'All': { apiInterval: '1M', limit: 1500 },
  };
  const mobilePreset = MOBILE_RANGE_PRESET_MAP[interval];
  const mobileApiInterval = mobilePreset ? mobilePreset.apiInterval : interval;
  const mobileCandleLimit = mobilePreset ? mobilePreset.limit : 150;

  const { data: candles = [] } = useQuery({
    queryKey: ["candles", symbol, interval],
    queryFn: () => fetch(`${BASE}/api/markets/${encodedSymbol}/candles?interval=${mobileApiInterval}&limit=${mobileCandleLimit}`).then(r => r.json()),
    refetchInterval: 30000,
    staleTime: 20000,
  });

  const { data: perfCandles = [] } = useQuery({
    queryKey: ["perf-candles", symbol],
    queryFn: () => fetch(`${BASE}/api/markets/${encodedSymbol}/candles?interval=1d&limit=400`).then(r => r.json()),
    refetchInterval: 300_000,
    staleTime: 240_000,
  });

  const { data: orderBook } = useQuery({
    queryKey: ["orderbook", symbol],
    queryFn: () => fetch(`${BASE}/api/markets/${encodedSymbol}/orderbook`).then(r => r.json()),
    refetchInterval: 5000,
  });

  const { data: recentTrades = [] } = useQuery({
    queryKey: ["trades", symbol],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/markets/${encodedSymbol}/trades`);
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    },
    refetchInterval: 5000,
  });

  // ── LetsExchange min/max for the current pair & direction ─────────────────
  const { data: leMinData } = useQuery({
    queryKey: ["le-min", base, quote, side],
    queryFn: async () => {
      const coin_from = side === "sell" ? base : quote;
      const coin_to   = side === "sell" ? quote : base;
      const r = await fetch(`${BASE}/api/letsexchange/estimate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from:         coin_from,
          to:           coin_to,
          network_from: coin_from,
          network_to:   coin_to,
          amount:       1,
        }),
      });
      if (!r.ok) return null;
      return r.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  const lastPrice = parseFloat(ticker?.lastPrice) || lePairPrice || liveBridgeRate || 0;



  // ── lockedBuySpend: quote asset spent in open buy orders ───────────────────
  // Market orders have price: null in the DB, so we fall back to lastPrice to
  // estimate how much quote is tied up. Without this, market buy orders would
  // show the full on-chain balance as "available" even with an open order.
  // Sum quote spend across ALL open buy orders whose quote asset matches the
  // current quote — e.g. on 0G/ETH, an open BUY on APE/ETH also locks ETH.
  const lockedBuySpend = allOpenOrders
    .filter((o: any) => o.side === "buy" && (String(o.symbol).split("/")[1] || "").toUpperCase() === quote.toUpperCase())
    .reduce((sum: number, o: any) => {
      const qty = parseFloat(o.quantity ?? "0") || 0;
      // For cross-pair locks we cannot reuse the current market's lastPrice as
      // a fallback. Limit orders carry an explicit price; market orders have
      // already debited at fill time, so price=null orders are very rare here.
      const px  = parseFloat(o.price ?? "0") || 0;
      return sum + qty * px;
    }, 0);

  const change = parseFloat(ticker?.priceChangePercent) || lePairChange || 0;
  const high24 = parseFloat(ticker?.highPrice) || 0;
  const low24  = parseFloat(ticker?.lowPrice)  || 0;
  const vol24  = parseFloat(ticker?.volume)    || 0;
  const volQuote = lastPrice * vol24;

  // Fallback price for candles/orderbook when ticker hasn't loaded yet
  const fallbackPrice = lastPrice > 0 ? lastPrice : (MOCK_TICKER[rawSymbol]?.lastPrice || liveBridgeRate || 14.35);
  // Ensure the chart always has candle data to render
  const chartCandles = (Array.isArray(candles) && candles.length > 0)
    ? candles
    : generateMockCandles(fallbackPrice);
  // Ensure order book always shows data
  const rawOB = orderBook as any;
  const isBridgePair = rawOB?.isBridgePair === true || (ticker as any)?.isBridgePair === true;
  const hasRealOB = !isBridgePair && (rawOB?.bids?.length > 0 || rawOB?.asks?.length > 0);
  // Memoized so the mock order book (which uses Math.random) doesn't regenerate on every render
  const effectiveOrderBook = useMemo(
    () => hasRealOB ? orderBook : generateMockOrderBook(fallbackPrice),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasRealOB, orderBook, fallbackPrice],
  );


  /* ── Live browser-tab price title ────────────────────────────────────── */
  useEffect(() => {
    if (!lastPrice) return;
    const sign = change >= 0 ? "▲" : "▼";
    document.title = `${sign} ${fmt(lastPrice)} | ${base}/${quote} | OrahDEX`;
    return () => { document.title = "OrahDEX"; };
  }, [lastPrice, change, base, quote]);

  // Persist interval across page refreshes
  useEffect(() => { localStorage.setItem('orahdex-mobile-interval', interval); }, [interval]);

  // Quote-currency and cross-rate computations
  const quoteToUSD    = QUOTE_TO_USD[quote] ?? 1;
  const priceUSD      = lastPrice * quoteToUSD;
  const isFiatTarget  = FIAT_CURRENCIES.some(c => c.code === quoteCurrency);
  const isStableQuote = ["USDT","USDC","TUSD","USDD","FDUSD"].includes(quote);
  const showConverted = isStableQuote && (isFiatTarget || ["BTC","ETH","BNB","SOL","BSV"].includes(quoteCurrency));
  const convertedPrice = showConverted ? convertFromUsd(priceUSD, quoteCurrency) : null;
  const quoteSym       = showConverted ? getCurrencySymbol(quoteCurrency) : null;
  const isBTCBase = base === "BTC";
  const isBSVBase = base === "BSV";
  const crossBTC  = isBTCBase ? 1 : priceUSD > 0 ? priceUSD / BTC_USD_RATE : 0;
  const crossBSV  = isBSVBase ? 1 : priceUSD > 0 ? priceUSD / BSV_USD_RATE : 0;

  const asks = (effectiveOrderBook?.asks ?? []).slice(0, 8).reverse();
  const bids = (effectiveOrderBook?.bids ?? []).slice(0, 8);

  const handleIntervalChange = useCallback((iv: string) => setInterval(iv), []);

  const needsLimitPrice = orderType === "limit" || orderType === "stop-limit" || orderType === "post-only";
  const effectivePrice  = needsLimitPrice
    ? (parseFloat(price || "0") || lastPrice)
    : lastPrice;
  const amtNum  = parseFloat(amount || "0");
  const totalNum = effectivePrice * amtNum;
  const total = totalNum > 0 ? fmt(totalNum) : "";

  // LE min/max converted to base-asset units
  const leMinRaw: number = parseFloat(leMinData?.min_amount ?? 0) || 0;
  const leMaxRaw: number = parseFloat(leMinData?.max_amount ?? 0) || 0;
  // For SELL: LE min is already in base. For BUY: LE min is in quote → divide by price.
  const leMinBase = side === "sell"
    ? leMinRaw
    : (leMinRaw > 0 && effectivePrice > 0 ? leMinRaw / effectivePrice : 0);
  const leMaxBase = side === "sell"
    ? leMaxRaw
    : (leMaxRaw > 0 && effectivePrice > 0 ? leMaxRaw / effectivePrice : 0);
  const belowLeMin = leMinBase > 0 && amtNum > 0 && amtNum < leMinBase;
  const aboveLeMax = leMaxBase > 0 && amtNum > leMaxBase;
  const FEE_RATE = 0.001;
  const estFee  = amtNum > 0 && totalNum > 0 ? fmt(totalNum * FEE_RATE) + " " + quote : "--";

  // ── Canonical L2 chain awareness ──────────────────────────────────────────
  // Each L2 chain carries a canonical native asset that's 1:1 with its L1.
  // e.g. ETH on Base (BaseETH) = ETH. ETH on Arb (ArbETH) = ETH. All tradeable in ETH markets.
  const CHAIN_INFO: Record<number, { name: string; nativeSymbol: string; l2Label: string | null }> = {
    1:      { name: "Ethereum",  nativeSymbol: "ETH",  l2Label: null },
    8453:   { name: "Base",      nativeSymbol: "ETH",  l2Label: "Base" },     // BaseETH = canonical ETH
    42161:  { name: "Arbitrum",  nativeSymbol: "ETH",  l2Label: "Arb"  },     // ArbETH = canonical ETH
    10:     { name: "Optimism",  nativeSymbol: "ETH",  l2Label: "OP"   },     // OPETH = canonical ETH
    137:    { name: "Polygon",   nativeSymbol: "ETH",  l2Label: "Polygon" },   // bridged ETH
    56:     { name: "BSC",       nativeSymbol: "BNB",  l2Label: null },
    43114:  { name: "Avalanche", nativeSymbol: "AVAX", l2Label: null },
    59144:  { name: "Linea",     nativeSymbol: "ETH",  l2Label: "Linea" },
    534352: { name: "Scroll",    nativeSymbol: "ETH",  l2Label: "Scroll" },
    5000:   { name: "Mantle",    nativeSymbol: "MNT",  l2Label: null },
  };
  const chainInfo = walletChainId ? CHAIN_INFO[walletChainId] : null;
  // Native symbol for non-EVM networks (BSV, BTC, SOL)
  const nativeSymbol: string = network === "bsv" ? "BSV"
    : network === "btc" ? "BTC"
    : network === "sol" ? "SOL"
    : chainInfo?.nativeSymbol ?? "ETH";
  // For EVM external wallets: never use the persisted wallet store balance as a fallback.
  // It may hold a stale internal-ledger value (e.g. 1,472 ETH). Use 0 until useEvmBalances
  // completes its first RPC fetch. For non-EVM (BSV/BTC/SOL) the store is set by on-chain
  // polling hooks so it is safe to use.
  const walletBal = address && walletBalance && !isEvm ? parseFloat(walletBalance) : 0;

  // Resolve ERC-20 balances for base and quote tokens
  const erc20BaseBalance  = evmTokenBalances.find(t => t.symbol.toUpperCase() === base.toUpperCase())?.amount  ?? 0;
  const erc20QuoteBalance = evmTokenBalances.find(t => t.symbol.toUpperCase() === quote.toUpperCase())?.amount ?? 0;

  // Native token is usable as base (e.g. ETH on Base selling in ETH/USDT)
  const isNativeBase  = nativeSymbol === base;
  // Native token is usable as quote spend (e.g. ETH on Arbitrum buying in TOKEN/ETH)
  const isNativeQuote = nativeSymbol === quote;

  // useEvmBalances always includes the native token in its results alongside ERC-20s.
  // Prefer the hook value so we never show the stale wallet-store ledger balance.
  // Fall back to walletBal only before the hook's first fetch (evmTokenBalances empty).
  const walletBaseBalance  = evmTokenBalances.length > 0 ? erc20BaseBalance  : (isNativeBase  ? walletBal : 0);
  const walletQuoteBalance = evmTokenBalances.length > 0 ? erc20QuoteBalance : (isNativeQuote ? walletBal  : 0);

  // Orah Wallet users use the API ledger balance.
  // External wallets are on-chain-first: availability comes from wallet balances,
  // then open-order locks are subtracted client-side for accurate remaining size.
  const internalBaseBalance  = apiBalances[base]  ?? 0;
  const internalQuoteBalance = apiBalances[quote] ?? 0;
  // For OrahWallet (non-EVM) users: use the internal exchange ledger as the primary
  // source, but merge in the on-chain native balance so BSV shows correctly even
  // when no funds have been deposited to the internal ledger yet.
  const grossSellBalance = usesApiBalance
    ? Math.max(internalBaseBalance,  isNativeBase  ? walletBal : 0)
    : walletBaseBalance;
  const grossBuyBalance  = usesApiBalance
    ? Math.max(internalQuoteBalance, isNativeQuote ? walletBal : 0)
    : walletQuoteBalance;
  // Self-custody EVM (Orah Wallet on EVM, or external wallet): open orders are
  // signed intents — funds remain on-chain in the wallet until fill. We DO NOT
  // subtract UI-side locks from displayed balance because nothing is actually
  // locked on-chain. (For internal-ledger mode, gross already excludes locks.)
  const sellBalance = grossSellBalance;
  const buyBalance  = grossBuyBalance;

  const available    = side === "sell" ? sellBalance : buyBalance;
  const availableSym = side === "sell" ? base        : quote;
  const fundingAsset = (side === "sell" ? base : quote).toUpperCase();
  const coinWalletHref = `/portfolio/${encodeURIComponent(fundingAsset)}`;

  const maxBuyNum = effectivePrice > 0 ? (buyBalance / effectivePrice) : 0;
  const maxBuy  = maxBuyNum   > 0 ? maxBuyNum.toFixed(6)   : "0";
  const maxSell = sellBalance > 0 ? sellBalance.toFixed(6) : "0";

  // Click available → fill max amount, fee-adjusted so the order never exceeds balance.
  // BUY : fee is charged on the quote spend, so max base = balance / (price × (1 + fee))
  // SELL: fee is deducted from the quote received, so max base = full base balance (no adjustment)
  const handleFillMax = () => {
    if (!address || available <= 0) return;
    if (side === "buy") {
      if (effectivePrice <= 0) return;
      const maxQty = buyBalance / (effectivePrice * (1 + FEE_RATE));
      setAmount(maxQty.toFixed(6));
    } else {
      setAmount(sellBalance.toFixed(6));
    }
  };
  const handleFillMin = () => {
    if (!address || available <= 0) return;
    if (side === "buy") {
      if (effectivePrice <= 0) return;
      const maxQty = buyBalance / (effectivePrice * (1 + FEE_RATE));
      const minQty = Math.min(maxQty, MIN_QUICK_FILL_QTY);
      setAmount(minQty > 0 ? minQty.toFixed(6) : "");
    } else {
      const minQty = Math.min(sellBalance, MIN_QUICK_FILL_QTY);
      setAmount(minQty > 0 ? minQty.toFixed(6) : "");
    }
  };

  function stepPrice(delta: number) {
    const cur = parseFloat(price || String(lastPrice)) || lastPrice;
    const ref = lastPrice > 0 ? lastPrice : Math.abs(cur) || 1;
    // Step = 0.1% of the price magnitude (handles sub-satoshi like 1e-11)
    const mag   = Math.pow(10, Math.floor(Math.log10(ref)));
    const step  = mag * 0.001;
    const dps   = Math.max(0, Math.min(18, -Math.floor(Math.log10(step)) + 1));
    setPrice((cur + delta * step).toFixed(dps));
  }
  function stepStopPrice(delta: number) {
    const cur = parseFloat(stopPrice || String(lastPrice)) || lastPrice;
    const ref = lastPrice > 0 ? lastPrice : Math.abs(cur) || 1;
    const mag   = Math.pow(10, Math.floor(Math.log10(ref)));
    const step  = mag * 0.001;
    const dps   = Math.max(0, Math.min(18, -Math.floor(Math.log10(step)) + 1));
    setStopPrice((cur + delta * step).toFixed(dps));
  }
  function stepAmount(delta: number) {
    const cur = parseFloat(amount || "0");
    const step = 0.001;
    setAmount(Math.max(0, cur + delta * step).toFixed(3));
  }

  async function handlePlaceOrder() {
    if (!address || !amount || amtNum <= 0) return;

    // ── LetsExchange max guard ────────────────────────────────────────────────
    // belowLeMin is intentionally not a hard block here — the multi-venue router
    // may find a provider (SimpleSwap, ChangeNOW) that accepts the amount even
    // when it is below LetsExchange's minimum.  The API will reject with a clear
    // error if truly no venue can fill the order.
    if (aboveLeMax) {
      toast({
        title: "Amount too high",
        description: `Maximum trade via exchange is ${leMaxBase < 1 ? leMaxBase.toFixed(4) : leMaxBase.toFixed(2)} ${base}`,
        variant: "destructive",
      });
      return;
    }

    // ── ATOMIC SUBMISSION LOCK ────────────────────────────────────────────────
    // isSubmittingRef is a ref (synchronous) — it blocks double-taps that arrive
    // in the same render cycle before isPending propagates.  isSubmitting state
    // mirrors it for button disabled/label rendering.
    if (isSubmittingRef.current) return;

    // ── CONTENT FINGERPRINT DEDUP (2-second window) ───────────────────────────
    // Prevents identical orders fired from multiple code paths (form button +
    // sticky bar button) within the same user interaction.
    const fingerprint = `${symbol}:${side}:${amtNum.toFixed(8)}:${Math.floor(Date.now() / 2000)}`;
    if (lastOrderFingerprintRef.current === fingerprint) return;
    lastOrderFingerprintRef.current = fingerprint;

    // ── Lock acquired ─────────────────────────────────────────────────────────
    isSubmittingRef.current = true;
    setIsSubmitting(true);

    // ── Stop-limit / stop-market: require a valid stop price before submitting ──
    if ((orderType === "stop-limit" || orderType === "stop-market") && !(parseFloat(stopPrice || "0") > 0)) {
      toast({
        title: "Stop price required",
        description: "Enter a stop price before placing a stop order.",
        variant: "destructive",
      });
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      lastOrderFingerprintRef.current = null;
      return;
    }

    // ── SELL guard: block impossible sell orders before the network round-trip ──
    // 1e-9 tolerance covers toFixed(6) rounding so a legitimate 100% fill is
    // never falsely blocked by floating-point arithmetic.
    if (side === "sell" && amtNum > sellBalance + 1e-9) {
      toast({
        title:       "Insufficient balance",
        description: `You only have ${maxSell} ${base} available to sell`,
        variant:     "destructive",
      });
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      lastOrderFingerprintRef.current = null;
      return;
    }

    const apiType = (orderType === "stop-limit" || orderType === "stop-market")
      ? "stop"
      : orderType === "post-only"
      ? "limit"
      : orderType === "trailing-stop"
      ? "stop"
      : orderType; // "limit" | "market"
    const usePrice = needsLimitPrice ? (parseFloat(price || "0") || lastPrice || undefined) : undefined;

    // Trailing stop: derive initial stop price from callback rate % off the current market price
    const trailingStopPrice = orderType === "trailing-stop" && lastPrice > 0
      ? side === "sell"
        ? lastPrice * (1 - (parseFloat(trailingRate || "1") / 100))
        : lastPrice * (1 + (parseFloat(trailingRate || "1") / 100))
      : undefined;

    const useStop  = orderType === "trailing-stop"
      ? trailingStopPrice
      : (orderType === "stop-limit" || orderType === "stop-market")
      ? (parseFloat(stopPrice || "0") || undefined)
      : undefined;

    let evmSignature: string | undefined;
    let orderNonce:   string | undefined;
    let orderExpiry:  string | undefined;
    if (isSelfCustodyEvm) {
      const nonceBytes = new Uint8Array(16);
      crypto.getRandomValues(nonceBytes);
      orderNonce  = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      orderExpiry = String(Math.floor(Date.now() / 1000) + 5 * 60);

      // Canonical message — must mirror buildOrderAuthMessage() in walletAuth.ts
      const orderMsg = [
        "Authorize OrahDEX order",
        `Wallet: ${address}`,
        `Symbol: ${symbol}`,
        `Side: ${side}`,
        `Quantity: ${amtNum.toString()}`,
        `Nonce: ${orderNonce}`,
        `Expiry: ${orderExpiry}`,
      ].join("\n");

      try {
        if (isOrahWallet) {
          // Self-custody Orah wallet: sign with the in-app key (PIN/passkey unlock)
          const account = await getViemAccountForAddress(address!, {
            title:    "Authorize trade",
            subtitle: `${side.toUpperCase()} ${amtNum} ${base} on ${symbol}`,
          });
          evmSignature = await account.signMessage!({ message: orderMsg });
        } else {
          // External wallet: tier-1 = wagmi/Reown, tier-2 = direct window.ethereum
          const isUserRejection = (e: any) => {
            const code = e?.code;
            const msg  = (e?.message ?? "").toLowerCase();
            return code === 4001 || code === "ACTION_REJECTED" ||
              msg.includes("rejected") || msg.includes("denied") || msg.includes("cancel");
          };

          if (evmConnected) {
            try {
              evmSignature = await signMessageAsync({ message: orderMsg });
            } catch (wagmiErr: any) {
              if (isUserRejection(wagmiErr)) throw wagmiErr;
              // Fall through to direct provider
            }
          }

          if (!evmSignature) {
            const hexMsg = "0x" + Array.from(new TextEncoder().encode(orderMsg))
              .map(b => b.toString(16).padStart(2, "0")).join("");

            if (provider === "reown") {
              // Reown/WalletConnect: window.ethereum is never injected — must call
              // personal_sign directly on the connector's raw EIP-1193 provider.
              const { wagmiAdapter } = await import("@/lib/reown-appkit");
              const connector = wagmiAdapter.wagmiConfig.connectors.find(
                (c: any) => c.id === "walletConnect" || c.type === "walletConnect"
              );
              const eip1193 = await (connector as any)?.getProvider?.();
              if (!eip1193) throw new Error("WalletConnect provider unavailable. Please reconnect your wallet.");
              evmSignature = await eip1193.request({ method: "personal_sign", params: [hexMsg, address] });
            } else {
              const eth = (window as any).ethereum;
              if (!eth) {
                throw new Error("No wallet provider found. Please connect MetaMask or use WalletConnect.");
              }
              evmSignature = await eth.request({ method: "personal_sign", params: [hexMsg, address] });
            }
          }
        }
      } catch (signErr: any) {
        const code = signErr?.code;
        const msg: string = signErr?.message ?? "";
        const isRejection = code === 4001 || code === "ACTION_REJECTED" ||
          msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("denied") ||
          msg.toLowerCase().includes("user cancelled") || msg.toLowerCase().includes("user canceled");
        toast({
          title: isRejection ? "Wallet signature declined" : "Wallet signing failed",
          description: isRejection
            ? `Tap ${side === "buy" ? "Buy" : "Sell"} again and approve the signing request in your wallet to place the order.`
            : (msg || "Could not sign order. Please reconnect your wallet and try again."),
          variant: "destructive",
        });
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        lastOrderFingerprintRef.current = null;
        return;
      }
    }

    orderMutation.mutate({
      symbol,
      walletAddress: address,
      side,
      type:      apiType,
      price:     usePrice,
      stopPrice: useStop,
      quantity:  amtNum,
      networkType:    address.startsWith("0x") ? "evm" : "bsv",
      walletSource:   (isOrahWallet && !isEvm) ? "orah" : "external",
      receiveAddress: receiveAddress.trim() || undefined,
      reportedBalance: !usesApiBalance ? (side === "sell" ? grossSellBalance : grossBuyBalance).toString() : undefined,
      evmSignature,
      nonce:  orderNonce,
      expiry: orderExpiry,
      chainId: walletChainId ?? undefined,
    } as any);
  }

  return (
    <div className="flex flex-col bg-background overflow-x-hidden" style={{ height: "100%" }}>

      {/* ── HEADER ── */}
      <div className="shrink-0 flex items-center px-3 pt-3 pb-2 border-b border-border gap-2">
        {/* ≡ Three-lines market selector button */}
        <button
          onClick={() => setSelectorOpen(true)}
          className="p-1.5 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Select market"
        >
          <AlignJustify size={19} />
        </button>

        {/* Pair name — tapping also opens selector */}
        <button
          onClick={() => setSelectorOpen(true)}
          className="flex items-center gap-1.5 flex-1 min-w-0"
        >
          <CoinLogo symbol={base} size={20} />
          <span className="text-base font-bold truncate">
            {base}<span className="text-muted-foreground font-normal text-sm">/{quote}</span>
          </span>
          {isFutures && (
            <span className="shrink-0 text-[9px] font-bold bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded border border-green-500/30">PERP</span>
          )}
        </button>

        {/* Right icons */}
        <div className="flex items-center gap-2.5 text-muted-foreground shrink-0">
          {/* Bell with unread badge */}
          <button onClick={() => setNotifOpen(true)} className="relative p-0.5">
            <Bell size={17} />
            {headerUnread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-500 rounded-full border border-background" />
            )}
          </button>
          <button onClick={() => setStarred(s => !s)}>
            <Star size={17} className={starred ? "fill-green-400 text-green-400" : ""} />
          </button>
          <button onClick={() => setCoinInfoOpen(true)}>
            <Info size={17} />
          </button>
          <button onClick={handleShare}>
            <Share2 size={17} />
          </button>
        </div>
      </div>

      {/* ── SCROLLABLE BODY ── */}
      <div
        ref={scrollBodyRef}
        className="flex-1 overflow-y-auto pb-20"
        style={{ WebkitOverflowScrolling: "touch", overscrollBehaviorY: "none" }}
      >

        {/* ── PRICE BLOCK ── */}
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-baseline gap-3">
            <span className={cn("text-3xl font-bold tabular-nums", change >= 0 ? "text-green-500" : "text-red-500")}>
              {fmt(lastPrice)}
            </span>
            <span className={cn("text-sm font-semibold", change >= 0 ? "text-green-500" : "text-red-500")}>
              {change >= 0 ? "+" : ""}{change.toFixed(2)}%
            </span>
          </div>
          {/* Quote currency + cross rates — spot only */}
          {!isFutures && (
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              <p className="text-xs text-muted-foreground">
                {convertedPrice !== null
                  ? `≈${quoteSym}${fmt(convertedPrice)}`
                  : `≈$${fmt(priceUSD)}`}
              </p>
              {crossBTC > 0 && !isBTCBase && (
                <span className="text-[11px] text-orange-400 tabular-nums font-medium">
                  ₿ {fmt(crossBTC)}
                </span>
              )}
              {crossBSV > 0 && !isBSVBase && (
                <span className="text-[11px] text-yellow-400 tabular-nums font-medium">
                  ⚡ {crossBSV < 0.001 ? crossBSV.toFixed(6) : crossBSV < 1 ? crossBSV.toFixed(4) : crossBSV.toFixed(2)}
                </span>
              )}
            </div>
          )}
          {!isFutures && <ContractAddressBadge baseAsset={base} variant="inline" className="mt-1" />}

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-2">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">24h High</span>
              <span className="font-medium text-foreground">{fmt(high24)}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">24h Low</span>
              <span className="font-medium text-foreground">{fmt(low24)}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Vol({base})</span>
              <span className="font-medium text-foreground">{fmtVol(vol24)}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Vol({quote})</span>
              <span className="font-medium text-foreground">{fmtVol(volQuote)}</span>
            </div>
          </div>
        </div>

        {/* ── TIMEFRAME + INDICATOR ROW ── */}
        <div className="flex items-center gap-0 border-b border-border bg-card overflow-x-auto no-scrollbar px-2 py-1.5">
          {/* Timeframe pills */}
          {(["1m","3m","5m","15m","30m","1h","2h","4h","1d","1w","1M","1Y","2Y","5Y","10Y","All"]).map(iv => (
            <button
              key={iv}
              onClick={() => handleIntervalChange(iv)}
              className={cn(
                "shrink-0 px-2.5 py-1 rounded-md text-[12px] font-semibold transition-all mr-0.5",
                interval === iv
                  ? "bg-green-500/20 text-green-400 border border-green-500/40"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >{iv}</button>
          ))}

          {/* Divider */}
          <div className="w-px h-5 mx-2 bg-border shrink-0" />

          {/* Indicator pills */}
          {INDICATORS.map(ind => (
            <button
              key={ind}
              onClick={() => setActiveIndicator(ind === activeIndicator ? null : ind)}
              className={cn(
                "shrink-0 px-2.5 py-1 rounded-md text-[12px] font-semibold transition-all mr-0.5",
                activeIndicator === ind
                  ? "bg-primary/20 text-primary border border-primary/40"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              {ind}
            </button>
          ))}
        </div>

        {/* ── CHART ── */}
        <div className="h-[340px] overflow-hidden">
          <Chart
            symbol={symbol}
            interval={interval}
            onIntervalChange={handleIntervalChange}
            hideIntervalBar={true}
            subIndicator={activeIndicator ? (INDICATOR_TO_SUB[activeIndicator] ?? undefined) : undefined}
            data={chartCandles}
          />
        </div>

        {/* ── PERFORMANCE ROW — spot only ── */}
        {!isFutures && (() => {
          const hasPerfData = Array.isArray(perfCandles) && perfCandles.length > 0 && lastPrice > 0;
          const PERIOD_DAYS: Record<string, number> = {
            today: 1, "7d": 7, "30d": 30, "90d": 90, "180d": 180, "1y": 365,
          };
          function calcPerfPct(daysAgo: number): number | null {
            if (!hasPerfData) return null;
            if (daysAgo === 1) return change;
            const targetSec = Date.now() / 1000 - daysAgo * 86400;
            let closest = (perfCandles as any[])[0];
            let minDiff  = Math.abs((closest?.time ?? 0) - targetSec);
            for (const c of (perfCandles as any[])) {
              const d = Math.abs((c.time ?? 0) - targetSec);
              if (d < minDiff) { minDiff = d; closest = c; }
            }
            const base = parseFloat(closest?.close ?? closest?.open ?? "0");
            if (!base) return null;
            return ((lastPrice - base) / base) * 100;
          }
          return (
            <div className="flex overflow-x-auto no-scrollbar px-4 py-2 gap-5 border-b border-border">
              {PERIODS.map(({ label, key }) => {
                const pct = calcPerfPct(PERIOD_DAYS[key] ?? 1);
                if (pct === null) {
                  return (
                    <div key={label} className="shrink-0 text-center">
                      <p className="text-[10px] text-muted-foreground">{label}</p>
                      <p className="text-[11px] font-semibold mt-0.5 text-muted-foreground/40">—</p>
                    </div>
                  );
                }
                return (
                  <div key={label} className="shrink-0 text-center">
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                    <p className={cn("text-[11px] font-semibold mt-0.5", pct >= 0 ? "text-green-500" : "text-red-500")}>
                      {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                    </p>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* ── BOTTOM TABS: ORDER BOOK / MARKET TRADES / MY ORDERS ── */}
        <div className="flex border-b border-border">
          {([
            { key: "orderbook" as BottomTab, label: "Order Book",    Icon: ListOrdered },
            { key: "trades"    as BottomTab, label: "Market Trades", Icon: Clock },
            { key: "orders"    as BottomTab, label: "My Orders",     Icon: Wallet },
          ]).map(t => (
            <button
              key={t.key}
              onClick={() => setBottomTab(t.key)}
              className={cn(
                "flex-1 py-2.5 text-xs font-semibold transition-colors border-b-2",
                bottomTab === t.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── ORDER BOOK — SPLIT FACE-TO-FACE ── */}
        {bottomTab === "orderbook" && (() => {
          const ROWS = 10;
          // Always sort before slicing — guarantees consistent direction regardless of data source.
          // Bids: highest price first (best bid at top)
          const bidRows = [...(effectiveOrderBook?.bids ?? [])]
            .sort((a: any, b: any) => parseFloat(b.price ?? b[0]) - parseFloat(a.price ?? a[0]))
            .slice(0, ROWS);
          // Asks: lowest price first (best ask at top) — they face the bids
          const askRows = [...(effectiveOrderBook?.asks ?? [])]
            .sort((a: any, b: any) => parseFloat(a.price ?? a[0]) - parseFloat(b.price ?? b[0]))
            .slice(0, ROWS);
          const allQ = [
            ...bidRows.map((b: any) => parseFloat(b.quantity ?? b[1])),
            ...askRows.map((a: any) => parseFloat(a.quantity ?? a[1])),
          ];
          const maxQ = Math.max(...allQ, 1);

          return (
            <div className="pb-2">
              {/* Headers */}
              <div className="flex text-[9px] uppercase tracking-wider text-muted-foreground font-semibold px-3 py-1.5 border-b border-border/40">
                <div className="flex-1 flex justify-between">
                  <span>Amount</span>
                  <span className="text-green-500">Bid</span>
                </div>
                <div className="w-px bg-border mx-2" />
                <div className="flex-1 flex justify-between">
                  <span className="text-red-400">Ask</span>
                  <span>Amount</span>
                </div>
              </div>

              {/* Rows — bid on left, ask on right, same row index */}
              {Array.from({ length: ROWS }).map((_, i) => {
                const bid = bidRows[i];
                const ask = askRows[i];
                const bP = bid ? parseFloat(bid.price ?? bid[0]) : null;
                const bQ = bid ? parseFloat(bid.quantity ?? bid[1]) : null;
                const aP = ask ? parseFloat(ask.price ?? ask[0]) : null;
                const aQ = ask ? parseFloat(ask.quantity ?? ask[1]) : null;
                const bidPct = bQ != null ? (bQ / maxQ) * 100 : 0;
                const askPct = aQ != null ? (aQ / maxQ) * 100 : 0;

                return (
                  <div key={i} className="flex items-center text-[11px] h-[22px]">
                    {/* BID row — tap to fill buy form */}
                    <button
                      className="flex-1 relative flex items-center px-3 h-full overflow-hidden text-left active:bg-green-500/10 transition-colors"
                      onClick={() => {
                        if (bP == null) return;
                        setPrice(String(bP));
                        if (bQ != null) setAmount(bQ.toFixed(3));
                        setSide("buy");
                        setOrderError(null);
                        setShowOrderForm(true);
                      }}
                    >
                      <div
                        className="absolute inset-y-0 right-0 bg-green-500/12"
                        style={{ width: `${bidPct}%` }}
                      />
                      {bP != null ? (
                        <>
                          <span className="relative z-10 text-muted-foreground/60 flex-1 tabular-nums text-[10.5px]">
                            {bQ!.toFixed(3)}
                          </span>
                          <span className="relative z-10 text-green-400 font-semibold tabular-nums">
                            {fmt(bP)}
                          </span>
                        </>
                      ) : <span className="flex-1" />}
                    </button>

                    {/* Center vertical divider */}
                    <div className="w-px self-stretch bg-border/60 shrink-0" />

                    {/* ASK row — tap to fill sell form */}
                    <button
                      className="flex-1 relative flex items-center px-3 h-full overflow-hidden text-left active:bg-red-500/10 transition-colors"
                      onClick={() => {
                        if (aP == null) return;
                        setPrice(String(aP));
                        if (aQ != null) setAmount(aQ.toFixed(3));
                        setSide("sell");
                        setOrderError(null);
                        setShowOrderForm(true);
                      }}
                    >
                      <div
                        className="absolute inset-y-0 left-0 bg-red-500/12"
                        style={{ width: `${askPct}%` }}
                      />
                      {aP != null ? (
                        <>
                          <span className="relative z-10 text-red-400 font-semibold tabular-nums">
                            {fmt(aP)}
                          </span>
                          <span className="relative z-10 text-muted-foreground/60 flex-1 text-right tabular-nums text-[10.5px]">
                            {aQ!.toFixed(3)}
                          </span>
                        </>
                      ) : <span className="flex-1" />}
                    </button>
                  </div>
                );
              })}

              {/* Mid price bar */}
              <div className="flex items-center justify-center gap-2 py-2 border-y border-border/50 mx-0 my-0.5 bg-secondary/30 flex-wrap">
                <span className={cn(
                  "text-sm font-bold tabular-nums",
                  change >= 0 ? "text-green-400" : "text-red-400"
                )}>
                  {change >= 0 ? "▲" : "▼"} {fmt(lastPrice)}
                </span>
                <span className="text-[11px] text-muted-foreground">≈</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {convertedPrice !== null ? `${quoteSym}${fmt(convertedPrice)}` : `$${fmt(priceUSD)}`}
                </span>
                {!isBTCBase && crossBTC > 0 && (
                  <span className="text-[10px] text-orange-400 tabular-nums font-medium">
                    ₿{fmt(crossBTC)}
                  </span>
                )}
                {!isBSVBase && crossBSV > 0 && (
                  <span className="text-[10px] text-yellow-400 tabular-nums font-medium">
                    ⚡{crossBSV < 0.001 ? crossBSV.toFixed(6) : crossBSV < 1 ? crossBSV.toFixed(4) : crossBSV.toFixed(2)}
                  </span>
                )}
                <span className={cn(
                  "text-[10px] font-semibold px-1.5 py-0.5 rounded",
                  change >= 0 ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                )}>
                  {change >= 0 ? "+" : ""}{change.toFixed(2)}%
                </span>
              </div>
            </div>
          );
        })()}

        {/* ── MARKET TRADES — POLONIEX STYLE ── */}
        {bottomTab === "trades" && (
          <div className="pt-1 pb-2">
            {/* Column headers */}
            <div className="flex text-[9px] uppercase tracking-wider text-muted-foreground font-semibold px-4 py-1.5 border-b border-border/50">
              <span className="flex-1">Price ({quote})</span>
              <span className="w-24 text-right">Amount ({base})</span>
              <span className="w-20 text-right">Time</span>
            </div>
            {((recentTrades as any[]) ?? []).slice(0, 25).map((t: any, i: number) => {
              const isBuy = t.side === "buy";
              return (
                <div key={i} className="flex items-center px-4 py-[4px]">
                  <span className={cn(
                    "flex-1 text-[12px] font-semibold tabular-nums",
                    isBuy ? "text-green-400" : "text-red-400"
                  )}>
                    {fmt(parseFloat(t.price))}
                  </span>
                  <span className="w-24 text-right text-[11px] text-muted-foreground tabular-nums">
                    {parseFloat(t.quantity).toFixed(4)}
                  </span>
                  <span className="w-20 text-right text-[10px] text-muted-foreground/60">
                    {new Date(t.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── MY ORDERS ── */}
        {bottomTab === "orders" && (
          <div className="pb-2">
            {!address ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 px-6 text-center">
                <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                  <Wallet size={22} className="text-primary" />
                </div>
                <p className="text-sm font-semibold text-foreground">Connect to view orders</p>
                <p className="text-xs text-muted-foreground">Connect your wallet to see open and filled orders.</p>
                <button
                  onClick={() => openWallet()}
                  className="mt-1 px-5 py-2.5 rounded-xl bg-gradient-to-r from-red-500 to-primary text-white text-sm font-bold active:opacity-80"
                >
                  Connect Wallet
                </button>
              </div>
            ) : openOrders.length === 0 && historyOrders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
                <ListOrdered size={28} className="opacity-30" />
                <p className="text-sm">No orders for {symbol}</p>
                <p className="text-xs opacity-60">Orders on other pairs are in your Portfolio</p>
              </div>
            ) : (
              <>
                {/* Open Orders section */}
                {openOrders.length > 0 && (
                  <>
                    <div className="px-4 pt-3 pb-1 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Open Orders ({openOrders.length})</span>
                      <button
                        onClick={() => openOrders.forEach(handleCancelOrder)}
                        className="text-[10px] font-semibold text-red-400 hover:text-red-300"
                      >
                        Cancel All
                      </button>
                    </div>
                    <div className="border-b border-border/50" />
                    {openOrders.map((o: any) => (
                      <div key={o.id} className="flex items-center px-4 py-3 border-b border-border/20 gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={cn("text-[10px] font-bold uppercase", o.side === "buy" ? "text-green-400" : "text-red-400")}>
                              {o.side}
                            </span>
                            <span className="text-xs text-foreground font-semibold">{o.symbol}</span>
                            <span className="text-[9px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{o.type ?? "limit"}</span>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                            <span>Price: <span className="text-foreground font-mono">{o.price ? fmt(Number(o.price)) : "—"}</span></span>
                            <span>Qty: <span className="text-foreground font-mono">{Number(o.quantity).toFixed(4)}</span></span>
                            {o.stopPrice && (
                              <span>Stop: <span className="text-amber-400 font-mono">{fmt(Number(o.stopPrice))}</span></span>
                            )}
                            {o.trailingRate && (
                              <span>Trail: <span className="text-amber-400 font-mono">{(Number(o.trailingRate) * 100).toFixed(2)}%</span></span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => handleCancelOrder(o)}
                          disabled={cancellingId === String(o.id)}
                          className="shrink-0 px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400 text-[11px] font-bold active:bg-red-500/10 disabled:opacity-40 transition-all"
                        >
                          {cancellingId === String(o.id) ? "…" : "Cancel"}
                        </button>
                      </div>
                    ))}
                  </>
                )}

                {/* History section */}
                {historyOrders.length > 0 && (
                  <>
                    <div className="px-4 pt-3 pb-1">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">History ({historyOrders.length})</span>
                    </div>
                    <div className="border-b border-border/50" />
                    <div className="flex text-[9px] uppercase tracking-wider text-muted-foreground font-semibold px-4 py-1.5 border-b border-border/30">
                      <span className="flex-1">Pair</span>
                      <span className="w-16 text-right">Price</span>
                      <span className="w-14 text-right">Qty</span>
                      <span className="w-16 text-right">Status</span>
                    </div>
                    {historyOrders.map((o: any) => (
                      <div key={o.id} className="px-4 py-2 border-b border-border/20">
                        <div className="flex items-center">
                          <div className="flex-1 min-w-0 flex items-center gap-1">
                            <span className={cn("text-[10px] font-bold uppercase", o.side === "buy" ? "text-green-400" : "text-red-400")}>{o.side}</span>
                            <span className="text-[11px] text-foreground font-medium truncate">{o.symbol}</span>
                            {o.type && o.type !== "limit" && (
                              <span className="text-[9px] bg-secondary text-muted-foreground px-1 py-0.5 rounded shrink-0">{o.type}</span>
                            )}
                          </div>
                          <span className="w-16 text-right text-[11px] font-mono text-foreground">{o.price ? fmt(Number(o.price)) : "mkt"}</span>
                          <div className="w-14 text-right">
                            <span className="text-[11px] font-mono text-muted-foreground">{Number(o.filledQuantity ?? o.quantity).toFixed(3)}</span>
                            {o.filledQuantity && Number(o.filledQuantity) < Number(o.quantity) && (
                              <span className="block text-[9px] text-muted-foreground/50">/{Number(o.quantity).toFixed(3)}</span>
                            )}
                          </div>
                          {String(o.txid ?? "").startsWith("htlc-pending-") ? (
                            <span className="w-16 text-right text-[10px] font-semibold text-amber-400 flex items-center justify-end gap-0.5">
                              <Clock size={9} className="shrink-0" />
                              Settling
                            </span>
                          ) : (
                            <span className={cn(
                              "w-16 text-right text-[10px] font-semibold",
                              o.status === "filled" ? "text-primary" : "text-muted-foreground/60"
                            )}>
                              {o.status.charAt(0).toUpperCase() + o.status.slice(1)}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                          <span className="font-mono">#{String(o.id).slice(0, 10)}</span>
                          <span>{formatDateTime(o.updatedAt ?? o.createdAt)}</span>
                          {(() => {
                            const fillQty = Number(o.filledQuantity ?? o.quantity);
                            const fillPrice = Number(o.price ?? 0);
                            const fee = fillQty * fillPrice * 0.001;
                            if (fee > 0) return <span>Fee: {fee < 0.00001 ? fee.toExponential(2) : fee.toFixed(6)} {quote}</span>;
                            return null;
                          })()}
                          {o.stopPrice && (
                            <span>Stop: <span className="text-amber-400 font-mono">{fmt(Number(o.stopPrice))}</span></span>
                          )}
                          {getOrderExplorerUrl(o) && (
                            <a
                              href={getOrderExplorerUrl(o)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-primary font-mono"
                            >
                              {String(o.txid).slice(0, 12)}… <Link2 size={10} />
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}

            {/* Recover stuck on-chain HTLC funds — only for EVM wallets */}
            {isSelfCustodyEvm && address && (
              <div className="px-3 pb-3">
                <HtlcLockRecovery chainId={walletChainId ?? 1} />
              </div>
            )}
          </div>
        )}

        {/* ── ORDER FORM (slide-up panel) ── */}
        {showOrderForm && (
          <div ref={orderFormRef} className="px-3 pt-3 pb-2 border-t border-border mt-2 space-y-2.5">

            {/* ── ORDER FORM ── */}
            {(<>

            {/* Non-custodial mode disclosure */}
            {isSelfCustodyEvm && (
              <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl text-[11px] bg-primary/8 border border-primary/20">
                <ShieldCheck size={12} className="text-primary shrink-0" />
                <span className="text-primary/80 font-medium">Non-custodial — your wallet settles on-chain. No deposit required.</span>
              </div>
            )}

            {/* Order type dropdown row */}
            <div className="flex items-center gap-2">
              <button className="w-7 h-7 rounded-full border border-border flex items-center justify-center text-muted-foreground shrink-0">
                <Info size={13} />
              </button>
              <button
                onClick={() => setOrderTypeOpen(true)}
                className="flex-1 h-9 bg-card border border-border rounded-xl px-3 flex items-center justify-between text-sm font-semibold text-foreground"
              >
                <span>{ORDER_TYPE_LABELS[orderType]}</span>
                <ChevronDown size={14} className="text-muted-foreground" />
              </button>
            </div>

            {/* Stop Price — for stop-limit & stop-market */}
            {(orderType === "stop-limit" || orderType === "stop-market") && (
              <div className="flex items-center gap-1.5 h-11 bg-card border border-border rounded-xl overflow-hidden">
                <button onClick={() => stepStopPrice(-1)} className="w-10 h-full flex items-center justify-center text-muted-foreground border-r border-border shrink-0 active:bg-border/40">
                  <Minus size={14} />
                </button>
                <div className="flex-1 flex items-center px-1">
                  <input
                    className="flex-1 bg-transparent text-sm text-center outline-none tabular-nums"
                    placeholder={`Stop (${quote})`}
                    value={stopPrice}
                    onChange={e => setStopPrice(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <button onClick={() => stepStopPrice(1)} className="w-10 h-full flex items-center justify-center text-muted-foreground border-l border-border shrink-0 active:bg-border/40">
                  <Plus size={14} />
                </button>
              </div>
            )}

            {/* Trailing rate — for trailing-stop */}
            {orderType === "trailing-stop" && (
              <div className="flex items-center gap-1.5 h-11 bg-card border border-border rounded-xl overflow-hidden">
                <button onClick={() => setTrailingRate(r => String(Math.max(0, parseFloat(r||"0") - 0.1).toFixed(1)) as string)} className="w-10 h-full flex items-center justify-center text-muted-foreground border-r border-border shrink-0 active:bg-border/40">
                  <Minus size={14} />
                </button>
                <div className="flex-1 flex items-center px-1">
                  <input
                    className="flex-1 bg-transparent text-sm text-center outline-none tabular-nums"
                    placeholder="Callback Rate (%)"
                    value={trailingRate}
                    onChange={e => setTrailingRate(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <button onClick={() => setTrailingRate(r => String((parseFloat(r||"0") + 0.1).toFixed(1)) as string)} className="w-10 h-full flex items-center justify-center text-muted-foreground border-l border-border shrink-0 active:bg-border/40">
                  <Plus size={14} />
                </button>
              </div>
            )}

            {/* Limit Price — for limit, stop-limit, post-only */}
            {needsLimitPrice && (
              <div className="flex items-center gap-1.5 h-11 bg-card border border-border rounded-xl overflow-hidden">
                <button onClick={() => stepPrice(-1)} className="w-10 h-full flex items-center justify-center text-muted-foreground border-r border-border shrink-0 active:bg-border/40">
                  <Minus size={14} />
                </button>
                <div className="flex-1 flex items-center px-1">
                  <input
                    className="flex-1 bg-transparent text-sm text-center outline-none tabular-nums"
                    placeholder={fmt(lastPrice)}
                    value={price}
                    onChange={e => setPrice(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <button onClick={() => stepPrice(1)} className="w-10 h-full flex items-center justify-center text-muted-foreground border-l border-border shrink-0 active:bg-border/40">
                  <Plus size={14} />
                </button>
              </div>
            )}

            {/* Amount */}
            <div className="flex items-center gap-1.5 h-11 bg-card border border-border rounded-xl overflow-hidden">
              <button onClick={() => stepAmount(-1)} className="w-10 h-full flex items-center justify-center text-muted-foreground border-r border-border shrink-0 active:bg-border/40">
                <Minus size={14} />
              </button>
              <div className="flex-1 flex items-center px-1">
                <input
                  className="flex-1 bg-transparent text-sm text-center outline-none tabular-nums"
                  placeholder={`Amount (${base})`}
                  value={amount}
                  onChange={e => { setAmount(e.target.value); setOrderError(null); }}
                  inputMode="decimal"
                />
              </div>
              <button onClick={() => stepAmount(1)} className="w-10 h-full flex items-center justify-center text-muted-foreground border-l border-border shrink-0 active:bg-border/40">
                <Plus size={14} />
              </button>
            </div>

            {/* LE min/max + winning venue hint */}
            {leMinBase > 0 && (
              <div className="flex items-center justify-between text-[10px] px-1 -mt-0.5">
                <span className={cn("font-semibold", belowLeMin ? "text-red-400" : "text-muted-foreground/55")}>
                  Min: {leMinBase < 0.0001
                    ? leMinBase.toFixed(8)
                    : leMinBase < 1
                      ? leMinBase.toFixed(6)
                      : leMinBase.toFixed(4)
                  } {base}
                </span>
                <div className="flex items-center gap-1.5">
                  {leMaxBase > 0 && (
                    <span className={cn("font-semibold", aboveLeMax ? "text-red-400" : "text-muted-foreground/40")}>
                      Max: {leMaxBase < 1 ? leMaxBase.toFixed(4) : leMaxBase.toFixed(2)} {base}
                    </span>
                  )}
                  {leMinData?.best_venue && (
                    <span className={cn(
                      "px-1 py-0.5 rounded text-[9px] font-bold border",
                      VENUE_COLORS[leMinData.best_venue] ?? "text-muted-foreground",
                      leMinData.best_venue === "changenow"  ? "bg-sky-500/10 border-sky-500/25" :
                      leMinData.best_venue === "simpleswap" ? "bg-emerald-500/10 border-emerald-500/25" :
                      leMinData.best_venue === "stealthex"  ? "bg-orange-500/10 border-orange-500/25" :
                      "bg-violet-500/10 border-violet-500/25"
                    )}>
                      {VENUE_LABELS[leMinData.best_venue] ?? leMinData.best_venue}
                    </span>
                  )}
                </div>
              </div>
            )}
            {(belowLeMin || aboveLeMax) && (
              <p className="text-[10px] text-red-400 px-1 -mt-0.5">
                {belowLeMin
                  ? `Amount is below the minimum required for this trade`
                  : `Amount exceeds the maximum allowed for this trade`}
              </p>
            )}

            {/* % quick-fill bar */}
            <div className="relative pt-1 pb-1">
              <div className="flex justify-between px-1 mb-1">
                {[25, 50, 75, 100].map(p => (
                  <button
                    key={p}
                    disabled={balancesPending}
                    onClick={() => {
                      if (balancesPending) return;
                      if (side === "buy" && buyBalance > 0 && effectivePrice > 0) {
                        setAmount(((buyBalance / effectivePrice) * p / 100).toFixed(6));
                      } else if (side === "sell" && sellBalance > 0) {
                        setAmount((sellBalance * p / 100).toFixed(6));
                      }
                    }}
                    className="text-[10px] text-muted-foreground font-semibold disabled:opacity-40"
                  >{p}%</button>
                ))}
              </div>
              <div className="h-[2px] bg-border rounded-full mx-1">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{
                    width: (() => {
                      const barMax = side === "sell"
                        ? (sellBalance > 0 ? sellBalance : grossSellBalance > 0 ? grossSellBalance : 1)
                        : (maxBuyNum  > 0 ? maxBuyNum   : grossBuyBalance  > 0 ? grossBuyBalance  : 1);
                      return `${Math.min(100, (amtNum / barMax) * 100)}%`;
                    })(),
                  }}
                />
              </div>
            </div>

            {/* Total */}
            <div className="flex items-center h-10 bg-card/50 border border-border rounded-xl px-3">
              <span className="text-sm text-muted-foreground flex-1">Total ({quote})</span>
              <span className="text-sm font-semibold tabular-nums">{amtNum > 0 ? total : ""}</span>
            </div>

            {/* ── EVM Sub-wallet info (BSV users buying EVM assets) ── */}
            {showMobileEvmInfo && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/8 px-3 py-2.5 space-y-1.5">
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-emerald-300 font-semibold">Sent to your OrahDEX EVM wallet</p>
                    <p className="text-[10px] text-emerald-200/70 leading-relaxed mt-0.5">
                      One address works on <span className="text-emerald-300 font-medium">all EVM networks</span> — ETH, BSC, Polygon, Arbitrum, Base, Avalanche, Linea, Scroll, Mantle and more.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black/20 border border-emerald-500/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-emerald-400/70 text-[10px] font-medium shrink-0">All EVM</span>
                  <span className="text-[10px] font-mono text-emerald-300 truncate flex-1">{internalEvmAddress}</span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(internalEvmAddress ?? "")}
                    className="shrink-0 text-emerald-400/50"
                    title="Copy"
                  >
                    <Link2 size={11} />
                  </button>
                </div>
              </div>
            )}

            {/* ── BSV Sub-wallet info (EVM users buying BSV assets) ── */}
            {showMobileBsvInfo && (
              <div className="rounded-xl border border-teal-500/30 bg-teal-500/8 px-3 py-2.5 space-y-1.5">
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="text-teal-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-teal-300 font-semibold">Sent to your OrahDEX BSV wallet</p>
                    <p className="text-[10px] text-teal-200/70 leading-relaxed mt-0.5">
                      {hasMobileSeparateBtcAddr
                        ? <>Your <span className="text-teal-300 font-medium">HD wallet</span> gives each chain its own BIP44 address — BSV, BTC, BCH &amp; SOL all separate.</>
                        : <>One key covers <span className="text-teal-300 font-medium">BSV, BTC &amp; BCH</span> — same address for BSV &amp; BTC, separate CashAddr for BCH.</>
                      }
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black/20 border border-teal-500/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-teal-400/70 text-[10px] font-medium shrink-0">{hasMobileSeparateBtcAddr ? "BSV" : "BSV·BTC"}</span>
                  <span className="text-[10px] font-mono text-teal-300 truncate flex-1">{internalBsvAddress}</span>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(internalBsvAddress ?? "")}
                    className="shrink-0 text-teal-400/50" title="Copy BSV">
                    <Link2 size={11} />
                  </button>
                </div>
                {internalBchAddress && (
                  <div className="flex items-center gap-2 bg-black/20 border border-teal-500/20 rounded-lg px-2.5 py-1.5">
                    <span className="text-teal-400/70 text-[10px] font-medium shrink-0">BCH</span>
                    <span className="text-[10px] font-mono text-teal-300 truncate flex-1">{internalBchAddress}</span>
                    <button type="button" onClick={() => navigator.clipboard?.writeText(internalBchAddress)}
                      className="shrink-0 text-teal-400/50" title="Copy BCH">
                      <Link2 size={11} />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── BTC Sub-wallet info (EVM users buying BTC — HD wallet only) ── */}
            {showMobileBtcInfo && (
              <div className="rounded-xl border border-orange-500/30 bg-orange-500/8 px-3 py-2.5 space-y-1.5">
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="text-orange-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-orange-300 font-semibold">Sent to your OrahDEX BTC wallet</p>
                    <p className="text-[10px] text-orange-200/70 leading-relaxed mt-0.5">
                      Derived at <span className="text-orange-300 font-medium">m/44'/0'/0'/0/0</span> — compatible with any BIP44 wallet.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black/20 border border-orange-500/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-orange-400/70 text-[10px] font-medium shrink-0">BTC</span>
                  <span className="text-[10px] font-mono text-orange-300 truncate flex-1">{internalBtcAddress}</span>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(internalBtcAddress ?? "")}
                    className="shrink-0 text-orange-400/50" title="Copy BTC">
                    <Link2 size={11} />
                  </button>
                </div>
              </div>
            )}

            {/* ── SOL Sub-wallet info (EVM users buying SOL — HD wallet only) ── */}
            {showMobileSolInfo && (
              <div className="rounded-xl border border-violet-500/30 bg-violet-500/8 px-3 py-2.5 space-y-1.5">
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="text-violet-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-violet-300 font-semibold">Sent to your OrahDEX Solana wallet</p>
                    <p className="text-[10px] text-violet-200/70 leading-relaxed mt-0.5">
                      Derived via <span className="text-violet-300 font-medium">SLIP-0010 m/44'/501'/0'/0'</span> — Phantom-compatible.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black/20 border border-violet-500/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-violet-400/70 text-[10px] font-medium shrink-0">SOL</span>
                  <span className="text-[10px] font-mono text-violet-300 truncate flex-1">{internalSolAddress}</span>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(internalSolAddress ?? "")}
                    className="shrink-0 text-violet-400/50" title="Copy SOL">
                    <Link2 size={11} />
                  </button>
                </div>
              </div>
            )}

            {/* ── XRP Sub-wallet info (EVM users buying XRP — HD wallet only) ── */}
            {showMobileXrpInfo && (
              <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/8 px-3 py-2.5 space-y-1.5">
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="text-cyan-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-cyan-300 font-semibold">Sent to your OrahDEX XRP wallet</p>
                    <p className="text-[10px] text-cyan-200/70 leading-relaxed mt-0.5">
                      Derived at <span className="text-cyan-300 font-medium">m/44'/144'/0'/0/0</span> — compatible with Ledger, Trust Wallet, and all BIP44 wallets.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black/20 border border-cyan-500/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-cyan-400/70 text-[10px] font-medium shrink-0">XRP</span>
                  <span className="text-[10px] font-mono text-cyan-300 truncate flex-1">{internalXrpAddress}</span>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(internalXrpAddress ?? "")}
                    className="shrink-0 text-cyan-400/50" title="Copy XRP">
                    <Link2 size={11} />
                  </button>
                </div>
              </div>
            )}

            {/* ── LTC Sub-wallet info (EVM users buying LTC — HD wallet only) ── */}
            {showMobileLtcInfo && (
              <div className="rounded-xl border border-slate-400/30 bg-slate-400/8 px-3 py-2.5 space-y-1.5">
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="text-slate-300 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-slate-200 font-semibold">Sent to your OrahDEX Litecoin wallet</p>
                    <p className="text-[10px] text-slate-300/70 leading-relaxed mt-0.5">
                      Derived at <span className="text-slate-200 font-medium">m/44'/2'/0'/0/0</span> — compatible with Ledger, Trust Wallet, and all BIP44 wallets.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black/20 border border-slate-400/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-slate-400/70 text-[10px] font-medium shrink-0">LTC</span>
                  <span className="text-[10px] font-mono text-slate-200 truncate flex-1">{internalLtcAddress}</span>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(internalLtcAddress ?? "")}
                    className="shrink-0 text-slate-400/50" title="Copy LTC">
                    <Link2 size={11} />
                  </button>
                </div>
              </div>
            )}

            {/* ── DOGE Sub-wallet info (EVM users buying DOGE — HD wallet only) ── */}
            {showMobileDogeInfo && (
              <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/8 px-3 py-2.5 space-y-1.5">
                <div className="flex items-start gap-2">
                  <CheckCircle2 size={13} className="text-yellow-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-yellow-300 font-semibold">Sent to your OrahDEX Dogecoin wallet</p>
                    <p className="text-[10px] text-yellow-200/70 leading-relaxed mt-0.5">
                      Derived at <span className="text-yellow-300 font-medium">m/44'/3'/0'/0/0</span> — compatible with Ledger, Trust Wallet, and all BIP44 wallets.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black/20 border border-yellow-500/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-yellow-400/70 text-[10px] font-medium shrink-0">DOGE</span>
                  <span className="text-[10px] font-mono text-yellow-300 truncate flex-1">{internalDogeAddress}</span>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(internalDogeAddress ?? "")}
                    className="shrink-0 text-yellow-400/50" title="Copy DOGE">
                    <Link2 size={11} />
                  </button>
                </div>
              </div>
            )}

            {/* ── Cross-chain receive notice ── */}
            {showCrossChainNotice && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 space-y-2">
                <div className="flex items-start gap-2">
                  <Info size={13} className="text-amber-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-amber-300 font-semibold">{base} lives on {crossChainName}</p>
                    <p className="text-[10px] text-amber-200/70 leading-relaxed mt-0.5">
                      Bought {base} lives on {crossChainName}. Provide your {crossChainName} address below to receive funds after settlement.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black/20 border border-amber-500/20 rounded-lg px-2.5 py-1.5">
                  <span className="text-amber-400/80 text-[10px] font-medium shrink-0">{base}</span>
                  <input
                    type="text"
                    value={receiveAddress}
                    onChange={e => setReceiveAddress(e.target.value)}
                    placeholder={crossChainPlaceholder}
                    className="flex-1 bg-transparent text-[10px] font-mono text-foreground focus:outline-none placeholder:text-muted-foreground/40 min-w-0"
                  />
                  {receiveAddress && (
                    <button type="button" onClick={() => setReceiveAddress("")} className="shrink-0 text-muted-foreground/40">
                      <XCircle size={13} />
                    </button>
                  )}
                </div>
                {receiveAddress && (
                  <div className="flex items-center gap-1.5 text-[10px] text-green-400">
                    <CheckCircle2 size={11} className="shrink-0" />
                    Address confirmed — funds will be sent to this address after settlement.
                  </div>
                )}
              </div>
            )}

            {/* Non-custodial mode banner: explain that orders don't lock funds */}
            {isEvm && (
              <div className="bg-blue-500/5 border border-blue-500/25 rounded-xl px-3 py-2 flex items-start gap-2">
                <svg className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                <div className="text-[10px] leading-relaxed text-blue-300/90">
                  <span className="font-bold text-blue-300">Non-custodial.</span> Available reflects your real on-chain wallet balance. Orders are signed intents — funds stay in your wallet (Rabby/MetaMask) until fill.
                  {hasEscrow(walletChainId ?? 0) && <span className="text-emerald-400"> On-chain escrow available on this chain.</span>}
                </div>
              </div>
            )}

            {/* Available / Max Buy / Est. Fee */}
            <div className="space-y-1.5 px-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground border-b border-dashed border-muted-foreground/40">Available</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleFillMin}
                    disabled={!address || available <= 0 || balancesPending}
                    className="text-[10px] font-bold px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
                  >
                    MIN
                  </button>
                  <button
                    onClick={handleFillMax}
                    disabled={!address || available <= 0 || balancesPending}
                    className="text-[10px] font-bold px-2 py-1 rounded border border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-50"
                  >
                    MAX
                  </button>
                  <span className="text-xs font-semibold tabular-nums text-primary flex items-center gap-1">
                    {balancesPending
                      ? "—"
                      : available > 0
                        ? available.toLocaleString("en-US", { maximumFractionDigits: 6, useGrouping: false })
                        : "0.0000"}&nbsp;{availableSym}
                    {isEvm && (
                      <span className="text-[9px] font-bold px-1 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary leading-none">
                        On-chain
                      </span>
                    )}
                    {!isEvm && side === "sell" && isNativeBase && chainInfo?.l2Label && (
                      <span className="text-[9px] font-bold px-1 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary leading-none">
                        {chainInfo.l2Label}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => setFundingSheetOpen(true)}
                    className="rounded-full border-2 border-primary text-primary shrink-0 inline-flex items-center justify-center active:bg-primary/20 transition-colors"
                    style={{ width: 22, height: 22, minWidth: 22, minHeight: 22 }}
                  >
                    <Plus size={10} strokeWidth={3} />
                  </button>
                </div>
              </div>
              {/* Low balance hint — shown when no balance available on any source */}
              {address && available === 0 && !apiBalancesLoading && (
                <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80 leading-tight px-0.5">
                  <span>
                    No {side === "buy" ? quote : base} in wallet —{" "}
                    get it via{" "}
                    <a
                      href="/swap"
                      className="text-cyan-400 underline underline-offset-2 font-semibold"
                    >
                      Bridge
                    </a>
                    {" "}or deposit on-chain.
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground border-b border-dashed border-muted-foreground/40">Max {side === "buy" ? "Buy" : "Sell"}</span>
                <span className="text-xs font-semibold text-foreground tabular-nums">
                  {balancesPending ? "—" : side === "buy" ? maxBuy : maxSell}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground border-b border-dashed border-muted-foreground/40">Est. Trading Fee</span>
                <span className="text-xs text-foreground tabular-nums">{estFee}</span>
              </div>
            </div>

            {/* Order result banner */}
            {orderResult && (
              <div className={cn(
                "rounded-xl border p-3 space-y-1",
                orderResult.matched
                  ? "bg-green-500/10 border-green-500/25"
                  : "bg-blue-500/10 border-blue-500/25"
              )}>
                <div className={cn(
                  "flex items-center gap-2 text-sm font-bold",
                  orderResult.matched ? "text-green-400" : "text-blue-300"
                )}>
                  <CheckCircle2 size={15} className="shrink-0" />
                  {orderResult.matched
                    ? `${orderResult.side === "sell" ? "Sell" : "Buy"} Order Filled!`
                    : `${orderResult.side === "sell" ? "Sell" : "Buy"} Order Open`}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {orderResult.matched
                    ? (() => {
                        // All values from API fill payload — no wallet diff, no user-input price
                        const gross = orderResult.filledQty * orderResult.avgFillPrice;
                        const net   = gross - orderResult.fee;
                        if (orderResult.side === "sell") {
                          const creditedQty = net > 0 ? net.toFixed(2) : gross.toFixed(2);
                          return isEvm
                            ? `+${creditedQty} ${orderResult.quoteSymbol} settled on-chain to your wallet`
                            : `+${creditedQty} ${orderResult.quoteSymbol} credited to your OrahDEX balance`;
                        } else {
                          const creditedQty = orderResult.filledQty > 0 ? orderResult.filledQty.toFixed(6) : "0";
                          return isEvm
                            ? `+${creditedQty} ${orderResult.base} settled on-chain to your wallet`
                            : `+${creditedQty} ${orderResult.base} credited to your OrahDEX balance`;
                        }
                      })()
                    : `${orderResult.filledQty > 0 ? String(orderResult.filledQty) : ""} ${orderResult.base} in order book — waiting for a matching ${orderResult.side === "sell" ? "buyer" : "seller"}.`
                  }
                </p>
                {orderResult.matched && orderResult.txid && orderResult.explorerUrl && (
                  <a
                    href={orderResult.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium"
                  >
                    View on chain <Link2 size={12} />
                  </a>
                )}

                {/* On-chain escrow lock — only for open orders on chains where escrow is deployed,
                    and only when the token address is known (unlisted tokens use sig-only proof). */}
                {!orderResult.matched && escrowAvailable && hasEscrow(walletChainId ?? 0) && orderResult.tradeId && !escrowTx && !!resolveEscrowAsset(
                  walletChainId ?? 0,
                  orderResult.side as "buy" | "sell",
                  orderResult.base,
                  orderResult.quoteSymbol,
                  orderResult.quantity || orderResult.filledQty || 0,
                  orderResult.price > 0 ? orderResult.price : lastPrice,
                ) && (
                  <div className="pt-1.5 border-t border-blue-500/20 space-y-1.5">
                    <p className="text-[11px] text-blue-300/80">
                      Lock funds on-chain so your balance shows in Rabby, imToken &amp; other DeFi wallets.
                    </p>
                    <button
                      disabled={escrowLoading}
                      onClick={() => {
                        if (!orderResult.tradeId) return;
                        const usePrice = orderResult.price > 0 ? orderResult.price : lastPrice;
                        // Open the confirmation dialog instead of locking
                        // immediately. The dialog calls lockOrder() only when
                        // the user clicks "Confirm & Lock".
                        setPendingLockParams({
                          orderId:  orderResult.tradeId,
                          side:     orderResult.side as "buy" | "sell",
                          base:     orderResult.base,
                          quote:    orderResult.quoteSymbol,
                          quantity: orderResult.quantity || orderResult.filledQty || 0,
                          price:    usePrice,
                        });
                        resetEscrow();
                        setLockDialogOpen(true);
                      }}
                      className={cn(
                        "flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg transition-all",
                        "bg-violet-600/20 text-violet-300 border border-violet-500/30",
                        "hover:bg-violet-600/30 active:opacity-70",
                        escrowLoading && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      {escrowLoading ? (
                        <>
                          <span className="animate-spin inline-block w-3 h-3 border-2 border-violet-300/30 border-t-violet-300 rounded-full" />
                          {escrowStatus === "approving" ? "Approving token…" : "Locking on-chain…"}
                        </>
                      ) : (
                        <>
                          <Link2 size={11} />
                          Lock funds on {chainLabel(walletChainId)}
                        </>
                      )}
                    </button>
                  </div>
                )}

                {/* Wrong chain — offer one-tap switch to Ethereum mainnet (where escrow is deployed) */}
                {!orderResult.matched && orderResult.tradeId && !escrowTx && isEvm && !escrowAvailable && (
                  <div className="pt-1.5 border-t border-blue-500/20 space-y-1.5">
                    <p className="text-[11px] text-amber-300/80">
                      On-chain locking isn't available on {chainLabel(walletChainId)}. Switch to
                      Ethereum mainnet (or Sepolia testnet) to lock these funds on-chain.
                    </p>
                    <button
                      onClick={async () => {
                        if (provider === "orah-wallet") {
                          switchChain(1);
                        } else {
                          const eth = (window as any).ethereum;
                          if (eth) {
                            try {
                              await eth.request({
                                method: "wallet_switchEthereumChain",
                                params: [{ chainId: "0x1" }],
                              });
                              switchChain(1);
                            } catch (e) {
                              toast({
                                title: "Switch failed",
                                description: "Open your wallet and switch to Ethereum, then try again.",
                                variant: "destructive",
                              });
                            }
                          }
                        }
                      }}
                      className={cn(
                        "flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg transition-all",
                        "bg-amber-600/20 text-amber-300 border border-amber-500/30",
                        "hover:bg-amber-600/30 active:opacity-70",
                      )}
                    >
                      <Link2 size={11} />
                      Switch to Ethereum to lock
                    </button>
                  </div>
                )}

                {/* Escrow lock error */}
                {!orderResult.matched && !escrowTx && escrowStatus === "error" && escrowErrorMsg && (
                  <div className="pt-1.5 border-t border-red-500/20">
                    <p className="text-[11px] text-red-400 font-medium">
                      Lock failed: {escrowErrorMsg}
                    </p>
                  </div>
                )}

                {/* Escrow lock success */}
                {!orderResult.matched && escrowTx && (
                  <div className="pt-1.5 border-t border-violet-500/20 space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] text-violet-300 font-bold">
                      <CheckCircle2 size={11} />
                      Funds locked on {chainLabel(walletChainId)}
                    </div>
                    <a
                      href={escrowTx.explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-violet-400 hover:text-violet-300 font-medium"
                    >
                      View escrow on Etherscan <Link2 size={10} />
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Error banner */}
            {orderError && (
              <div className="flex flex-col gap-2">
                <div className={cn(
                  "flex flex-col gap-1.5 px-3 py-2.5 rounded-xl border text-sm",
                  orderError.code === "NO_LIQUIDITY"
                    ? "bg-amber-500/10 border-amber-500/25 text-amber-400"
                    : "bg-red-500/10 border-red-500/25 text-red-400",
                )}>
                  <div className="flex items-start gap-2">
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <span className="font-semibold leading-snug">
                      {orderError.code === "NO_LIQUIDITY"
                        ? "No matching sellers"
                        : orderError.code === "DEPOSIT_REQUIRED"
                        ? (isSelfCustodyEvm ? "Insufficient on-chain balance" : "Deposit required to trade")
                        : orderError.code === "INSUFFICIENT_FUNDS"
                        ? (usesApiBalance ? "Insufficient trading balance" : "Insufficient wallet balance")
                        : "Order failed"}
                    </span>
                  </div>
                  <p className={cn(
                    "text-xs leading-relaxed pl-6",
                    orderError.code === "NO_LIQUIDITY" ? "text-amber-400/80" : "text-red-400/80",
                  )}>
                    {orderError.code === "NO_LIQUIDITY"
                      ? "No sellers at this price in the order book. Place a limit order to set your price, or use OrahBridge for an instant cross-chain swap below."
                      : orderError.code === "DEPOSIT_REQUIRED"
                      ? (usesApiBalance
                        ? `Your ${side === "sell" ? base : quote} trading balance is empty. Use Bridge to fund it, or deposit on-chain.`
                        : isSelfCustodyEvm
                          ? `Not enough ${side === "sell" ? base : quote} in your connected wallet. Use Bridge to swap for more.`
                          : `No ${side === "sell" ? base : quote} on-chain. Get it via Bridge or deposit from another wallet.`)
                      : orderError.code === "INSUFFICIENT_FUNDS"
                      ? (usesApiBalance
                        ? `Not enough ${side === "sell" ? base : quote} in your trading balance. Top up via Bridge or check Portfolio.`
                        : `Not enough ${side === "sell" ? base : quote} on-chain. Use Bridge to swap for more, or deposit.`)
                      : orderError.message}
                  </p>
                  {orderError.code === "DEPOSIT_REQUIRED" && (
                    <div className="ml-6 mt-0.5 flex gap-3">
                      <a href="/swap" className="text-xs font-bold text-cyan-400 underline underline-offset-2">
                        Open Bridge →
                      </a>
                      {!isSelfCustodyEvm && (
                        <a href={coinWalletHref} className="text-xs font-bold text-primary underline underline-offset-2">
                          Open Wallet →
                        </a>
                      )}
                    </div>
                  )}
                </div>

                {/* OrahBridge instant-swap quote — shown when no native liquidity */}
                {orderError.code === "NO_LIQUIDITY" && (
                  swapQuoteLoading ? (
                    <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border/40 bg-card text-xs text-muted-foreground">
                      <span className="animate-spin w-3.5 h-3.5 border-2 border-primary/30 border-t-primary rounded-full shrink-0" />
                      Checking OrahBridge rates…
                    </div>
                  ) : swapQuote ? (
                    <div className="flex flex-col gap-2.5 px-3 py-3 rounded-xl border border-primary/25 bg-primary/5">
                      <div className="flex items-center justify-between">
                        <span className={cn("text-xs font-bold", VENUE_COLORS[swapQuote.venue] ?? "text-primary")}>
                          {VENUE_LABELS[swapQuote.venue] ?? swapQuote.venue}
                        </span>
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Instant Swap</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                        <span className="text-muted-foreground">Send</span>
                        <span className="font-mono font-semibold text-foreground">
                          {swapQuote.amountIn % 1 === 0
                            ? swapQuote.amountIn.toFixed(0)
                            : parseFloat(swapQuote.amountIn.toFixed(8)).toString()}
                        </span>
                        <span className="font-semibold text-foreground">{swapQuote.assetIn}</span>
                        <span className="text-muted-foreground px-0.5">→</span>
                        <span className="text-muted-foreground">Receive</span>
                        <span className="font-mono font-semibold text-primary">
                          ≈ {parseFloat(swapQuote.expectedOutput.toFixed(8)).toString()}
                        </span>
                        <span className="font-semibold text-primary">{swapQuote.assetOut}</span>
                      </div>
                      {!swapQuote.canExecute && (
                        <p className="text-[10px] text-amber-400/80">Amount may be below this provider's minimum — try a larger size.</p>
                      )}
                      <a
                        href={`${BASE}/swap`}
                        className="w-full py-2.5 rounded-lg text-xs font-bold text-center text-white bg-primary hover:bg-primary/90 transition-colors"
                      >
                        Swap via {VENUE_LABELS[swapQuote.venue] ?? "OrahBridge"} →
                      </a>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 px-3 py-2.5 rounded-xl border border-border/40 bg-card">
                      <p className="text-xs text-muted-foreground">No instant-swap quote available for this pair right now.</p>
                      <a
                        href={`${BASE}/swap`}
                        className="text-xs font-bold text-primary underline underline-offset-2"
                      >
                        Browse OrahBridge →
                      </a>
                    </div>
                  )
                )}
              </div>
            )}

            {/* Confirm / Place Order button */}
            {!address ? (
              <button
                onClick={() => openWallet()}
                className="w-full py-3.5 rounded-xl text-sm font-bold text-white transition-all active:opacity-80 flex items-center justify-center gap-2 bg-gradient-to-r from-red-500 to-primary shadow-lg"
              >
                <Wallet size={16} />
                Connect Wallet to Trade
              </button>
            ) : (
              <button
                onClick={handlePlaceOrder}
                disabled={!amount || amtNum <= 0 || isSubmitting || aboveLeMax}
                className={cn(
                  "w-full py-3.5 rounded-xl text-sm font-bold text-white transition-all active:opacity-80 flex items-center justify-center gap-2",
                  side === "sell"
                    ? "bg-red-600 shadow-lg shadow-red-500/20"
                    : "bg-green-600 shadow-lg shadow-green-500/20",
                  (!amount || amtNum <= 0 || isSubmitting || aboveLeMax) && "opacity-50 cursor-not-allowed"
                )}
              >
                {isSubmitting ? (
                  <><span className="animate-spin inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> Placing…</>
                ) : (
                  `${side === "sell" ? "Sell" : "Buy"} ${base}`
                )}
              </button>
            )}

            </>)}
          </div>
        )}

      </div>

      {/* ── NON-CUSTODIAL STRIP (EVM wallets only) ── */}
      {isSelfCustodyEvm && (
        <div className="shrink-0 flex items-center justify-center gap-1.5 px-4 py-1 border-t border-blue-500/20 bg-blue-500/5 text-[10px] text-blue-300/80 font-medium leading-none">
          <svg className="w-3 h-3 shrink-0 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          Non-custodial — funds stay in your wallet until on-chain settlement
        </div>
      )}

      {/* ── STICKY BOTTOM BAR ── */}
      <div
        className="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-border bg-background/95 backdrop-blur"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 20px)" }}
      >
        {!address ? (
          /* Connect Wallet CTA */
          <button
            onClick={() => openWallet()}
            className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-red-500 to-primary active:opacity-80 transition-opacity flex items-center justify-center gap-2"
          >
            <Wallet size={16} />
            Connect Wallet
          </button>
        ) : (
          <>
            {/* Buy button */}
            <button
              onClick={() => {
                if (side === "buy" && showOrderForm && amtNum > 0) {
                  handlePlaceOrder();
                } else {
                  setSide("buy");
                  setOrderError(null);
                  setShowOrderForm(true);
                }
              }}
              disabled={isSubmitting}
              className={cn(
                "flex-1 py-3 rounded-xl text-sm font-bold text-white transition-all active:opacity-80",
                isSubmitting ? "opacity-50 cursor-not-allowed"
                  : side === "buy" && showOrderForm && amtNum > 0
                  ? "opacity-100 scale-[1.01]"
                  : "opacity-85"
              )}
              style={{ backgroundColor: "#16a34a" }}
            >
              {isSubmitting && side === "buy"
                ? "Placing…"
                : side === "buy" && showOrderForm && amtNum > 0
                ? `Buy ${amtNum.toFixed(4)} ${base}`
                : `Buy ${base}`}
            </button>

            {/* Sell button */}
            <button
              onClick={() => {
                if (side === "sell" && showOrderForm && amtNum > 0) {
                  handlePlaceOrder();
                } else {
                  setSide("sell");
                  setOrderError(null);
                  setShowOrderForm(true);
                }
              }}
              disabled={isSubmitting}
              className={cn(
                "flex-1 py-3 rounded-xl text-sm font-bold text-white transition-all active:opacity-80",
                isSubmitting ? "opacity-50 cursor-not-allowed"
                  : side === "sell" && showOrderForm && amtNum > 0
                  ? "opacity-100 scale-[1.01]"
                  : "opacity-85"
              )}
              style={{ backgroundColor: "#dc2626" }}
            >
              {isSubmitting && side === "sell"
                ? "Placing…"
                : side === "sell" && showOrderForm && amtNum > 0
                ? `Sell ${amtNum.toFixed(4)} ${base}`
                : `Sell ${base}`}
            </button>

          </>
        )}
      </div>

      {/* ── FUNDING METHOD SHEET ── */}
      {fundingSheetOpen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={() => setFundingSheetOpen(false)}
          />
          <div
            className="fixed bottom-0 left-0 right-0 z-50 bg-card rounded-t-2xl shadow-2xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
          >
            {/* Handle */}
            <div className="w-10 h-1 bg-border rounded-full mx-auto mt-3 mb-4" />

            {/* Header */}
            <div className="flex items-center justify-between px-5 mb-4">
              <h2 className="text-base font-bold text-foreground">Select a Method</h2>
              <button
                onClick={() => setFundingSheetOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-secondary text-muted-foreground"
              >
                <X size={15} />
              </button>
            </div>

            {/* Options */}
            {([
              {
                icon: <ArrowLeftRight size={20} />,
                label: "Transfer",
                desc: "Wallet-to-wallet transfer using your coin wallet",
                href: coinWalletHref,
              },
              {
                icon: <Download size={20} />,
                label: "Deposit",
                desc: "Receive funds directly to your wallet address",
                href: coinWalletHref,
              },
              {
                icon: <CreditCard size={20} />,
                label: "Withdraw",
                desc: "Send funds directly from your wallet to another wallet",
                href: coinWalletHref,
              },
              {
                icon: <Users2 size={20} />,
                label: "P2P",
                desc: "Multiple fiats, zero fees, and the best prices",
                href: "/p2p",
              },
            ] as const).map(({ icon, label, desc, href }) => (
              <button
                key={label}
                onClick={() => {
                  setFundingSheetOpen(false);
                  window.location.hash = "";
                  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
                  window.location.href = base + href;
                }}
                className="w-full flex items-center gap-4 px-5 py-4 border-t border-border/50 hover:bg-white/5 active:bg-white/8 transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
                  {icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-semibold text-foreground leading-snug">{label}</p>
                  <p className="text-[12px] text-muted-foreground mt-0.5 leading-snug">{desc}</p>
                </div>
                <ChevronRight size={16} className="text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </>
      )}

      {/* ── ORDER TYPE SHEET ── */}
      {orderTypeOpen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={() => setOrderTypeOpen(false)}
          />
          <div className="fixed bottom-0 left-0 right-0 z-50 bg-card rounded-t-2xl shadow-2xl overflow-hidden"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)" }}
          >
            <div className="w-10 h-1 bg-border rounded-full mx-auto mt-3 mb-1" />
            <p className="text-center text-xs text-muted-foreground pb-2 px-6">Order Type</p>
            {ORDER_TYPES.map((t, i) => (
              <button
                key={t}
                onClick={() => { setOrderType(t); setOrderTypeOpen(false); }}
                className={cn(
                  "w-full px-6 py-3.5 text-left transition-colors flex items-center justify-between gap-3",
                  i < ORDER_TYPES.length - 1 && "border-b border-border/50",
                  orderType === t ? "bg-primary/5" : "hover:bg-white/5"
                )}
              >
                <div className="flex-1 min-w-0">
                  <p className={cn("text-[15px] font-semibold leading-snug", orderType === t ? "text-primary" : "text-foreground")}>
                    {ORDER_TYPE_LABELS[t]}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                    {ORDER_TYPE_DESCS[t]}
                  </p>
                </div>
                {orderType === t && <div className="w-2 h-2 rounded-full bg-primary shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}

      {/* ── MARKET SELECTOR DRAWER ── */}
      <MobileMarketSelector
        open={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        currentSymbol={symbol}
        defaultCat={isFutures ? "futures" : "usd"}
        mode={isFutures ? "futures" : "spot"}
      />

      {/* ── NOTIFICATIONS DRAWER ── */}
      <NotificationsDrawer open={notifOpen} onClose={() => setNotifOpen(false)} />

      {/* ── COIN INFO SHEET ── */}
      {coinInfoOpen && (
        <CoinInfoSheet symbol={base} onClose={() => setCoinInfoOpen(false)} />
      )}

      {/* ── SHARE TOAST ── */}
      <ShareToast visible={shareToastVisible} copied={shareCopied} />

      {/* ── LOCK FUNDS DIALOG (confirmation + live status) ── */}
      <CrossChainSwapPanel open={atomicSwapOpen} onOpenChange={setAtomicSwapOpen} />

      <LockFundsDialog
        open={lockDialogOpen}
        onOpenChange={setLockDialogOpen}
        order={pendingLockParams}
        chainId={walletChainId ?? null}
        status={escrowStatus}
        errorMsg={escrowErrorMsg}
        txResult={escrowTxResult}
        onConfirm={async () => {
          if (!pendingLockParams) return null;
          const result = await lockOrder(pendingLockParams);
          if (result) {
            setEscrowTx(result);
            // Refresh on-chain balances so the deduction shows immediately
            // (Rabby/MetaMask refresh on their own next poll).
            setTimeout(() => { refreshEvmBalances(); }, 1500);
          }
          return result;
        }}
      />

    </div>
  );
}
