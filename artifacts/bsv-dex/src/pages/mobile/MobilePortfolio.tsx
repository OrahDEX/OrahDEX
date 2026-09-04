import {
  TrendingUp, TrendingDown,
  ArrowDownToLine,
  Copy, Check, RefreshCw, Info,
  LogOut, Zap, Droplets, ExternalLink, ArrowLeftRight,
  ArrowDownLeft, ArrowUpRight, History, Upload, ChevronDown, X, Search, Loader2, Trash2,
} from "lucide-react";

import { useOnChainTxHistory } from "@/hooks/useOnChainTxHistory";
import type { OnChainTx } from "@/hooks/useOnChainTxHistory";
import { useWalletStore } from "@/store/useWalletStore";
import { useWalletModalStore } from "@/store/useWalletModalStore";
import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ReceiveModal } from "@/components/ReceiveModal";
import { WithdrawSheet } from "@/components/WithdrawSheet";
import { cn, getProviderLabel } from "@/lib/utils";
import { useSettingsStore, formatQuoteAmount } from "@/store/useSettingsStore";
import { useEvmBalances } from "@/hooks/useEvmBalances";
import { useTronBalances } from "@/hooks/useTronBalances";
import { useLiquidityStore } from "@/store/useLiquidityStore";
import { useEscrow } from "@/hooks/useEscrow";
import { checkEscrowDeposit } from "@/lib/escrow";

import { EXPLORER_TX, CHAIN_NAMES } from "@/lib/onChainLiquidity";
import { ChainSwitcherDropdown } from "@/components/ChainSwitcherDropdown";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Per-asset canonical withdrawal network (independent of connected wallet)
const EVM_ERC20 = { network: "evm",  networkLabel: "Ethereum (ERC-20)",  placeholder: "0x... (ERC-20 address)" };
const EVM_BEP20 = { network: "evm",  networkLabel: "BNB Chain (BEP-20)", placeholder: "0x... (BEP-20 address)" };
const EVM_ARB   = { network: "evm",  networkLabel: "Arbitrum One",       placeholder: "0x... (Arbitrum address)" };
const EVM_OP    = { network: "evm",  networkLabel: "Optimism",           placeholder: "0x... (Optimism address)" };
const SOL_NET   = { network: "sol",  networkLabel: "Solana",             placeholder: "Solana wallet address" };
const SOL_SPL   = { network: "sol",  networkLabel: "Solana (SPL token)", placeholder: "Solana wallet address" };
const TRON_TRC20= { network: "tron", networkLabel: "TRON (TRC-20)",      placeholder: "T... (TRON address)" };
const COSMOS_NET= { network: "cosmos",networkLabel: "Cosmos Hub",        placeholder: "cosmos1... (Bech32 address)" };

const ASSET_NETWORK_MAP: Record<string, { network: string; networkLabel: string; placeholder: string }> = {
  // ── Bitcoin family ──────────────────────────────────────────────────────────
  BTC:    { network: "btc",    networkLabel: "Bitcoin",              placeholder: "bc1... or 1... or 3..." },
  BSV:    { network: "bsv",    networkLabel: "Bitcoin SV",          placeholder: "1... (BSV P2PKH)" },
  BCH:    { network: "bch",    networkLabel: "Bitcoin Cash",        placeholder: "1... (P2PKH address)" },
  LTC:    { network: "ltc",    networkLabel: "Litecoin",            placeholder: "L... or ltc1..." },
  DASH:   { network: "dash",   networkLabel: "Dash",                placeholder: "X... (Dash address)" },
  ZEC:    { network: "zec",    networkLabel: "Zcash",               placeholder: "t1... (Zcash address)" },
  XMR:    { network: "xmr",    networkLabel: "Monero",              placeholder: "4... (Monero address)" },
  DOGE:   { network: "doge",   networkLabel: "Dogecoin",            placeholder: "D... (Dogecoin address)" },
  ORDI:   { network: "btc",    networkLabel: "Bitcoin (Ordinals)",  placeholder: "bc1p... (Taproot address)" },
  // ── EVM — Ethereum mainnet ──────────────────────────────────────────────────
  ETH:    { network: "evm",    networkLabel: "Ethereum Mainnet",    placeholder: "0x... (Ethereum address)" },
  USDT:   EVM_ERC20, USDC: EVM_ERC20, DAI: EVM_ERC20, TUSD: EVM_ERC20,
  AAVE:   EVM_ERC20, LINK: EVM_ERC20, UNI:  EVM_ERC20, MKR: EVM_ERC20,
  CRV:    EVM_ERC20, SUSHI:EVM_ERC20, COMP: EVM_ERC20, GRT: EVM_ERC20,
  SNX:    EVM_ERC20, YFI:  EVM_ERC20, LDO:  EVM_ERC20, ENS: EVM_ERC20,
  RUNE:   EVM_ERC20, RNDR: EVM_ERC20, FET:  EVM_ERC20, IMX: EVM_ERC20,
  MANA:   EVM_ERC20, SAND: EVM_ERC20, AXS:  EVM_ERC20, GALA:EVM_ERC20,
  SHIB:   EVM_ERC20, PEPE: EVM_ERC20, FLOKI:EVM_ERC20, TURBO:EVM_ERC20,
  THETA:  EVM_ERC20, GNS:  EVM_ERC20, PENDLE:EVM_ERC20, EIGEN:EVM_ERC20,
  WLD:    EVM_ERC20, TAO:  EVM_ERC20,
  // ── EVM — BNB Chain ─────────────────────────────────────────────────────────
  BNB:    EVM_BEP20, BUSD: EVM_BEP20, FDUSD: EVM_BEP20,
  CAKE:   EVM_BEP20, BAKE: EVM_BEP20, ALPACA:EVM_BEP20,
  // ── EVM — Polygon ───────────────────────────────────────────────────────────
  MATIC:  { network: "evm",    networkLabel: "Polygon",             placeholder: "0x... (Polygon address)" },
  // ── EVM — Avalanche ─────────────────────────────────────────────────────────
  AVAX:   { network: "evm",    networkLabel: "Avalanche C-Chain",   placeholder: "0x... (Avalanche address)" },
  // ── EVM — Fantom ────────────────────────────────────────────────────────────
  FTM:    { network: "evm",    networkLabel: "Fantom Opera",        placeholder: "0x... (Fantom address)" },
  // ── EVM — Arbitrum ──────────────────────────────────────────────────────────
  ARB:    EVM_ARB, GMX: EVM_ARB, RDNT: EVM_ARB,
  // ── EVM — Optimism ──────────────────────────────────────────────────────────
  OP:     EVM_OP, SNX_OP: EVM_OP,
  // ── EVM — other L2s ─────────────────────────────────────────────────────────
  SUI:    { network: "sui",    networkLabel: "Sui Network",         placeholder: "0x... (Sui address)" },
  APT:    { network: "apt",    networkLabel: "Aptos",               placeholder: "0x... (Aptos address)" },
  METIS:  { network: "evm",    networkLabel: "Metis Andromeda",     placeholder: "0x... (Metis address)" },
  STRK:   { network: "evm",    networkLabel: "Starknet (L2)",       placeholder: "0x... (StarkNet address)" },
  ZK:     { network: "evm",    networkLabel: "zkSync Era",          placeholder: "0x... (zkSync address)" },
  // ── Solana ecosystem ────────────────────────────────────────────────────────
  SOL:    SOL_NET, BONK: SOL_SPL, WIF: SOL_SPL, RNDR_SOL: SOL_SPL,
  // ── TRON ecosystem ──────────────────────────────────────────────────────────
  TRX:    { network: "tron",   networkLabel: "TRON Network",        placeholder: "T... (TRON address)" },
  BTT:    TRON_TRC20, WIN: TRON_TRC20, JST: TRON_TRC20, USDD: TRON_TRC20,
  // ── XRP Ledger ──────────────────────────────────────────────────────────────
  XRP:    { network: "xrp",    networkLabel: "XRP Ledger",          placeholder: "r... (XRP address)" },
  // ── Cardano ─────────────────────────────────────────────────────────────────
  ADA:    { network: "ada",    networkLabel: "Cardano",             placeholder: "addr1... (Cardano address)" },
  // ── Polkadot ────────────────────────────────────────────────────────────────
  DOT:    { network: "dot",    networkLabel: "Polkadot",            placeholder: "1... (Polkadot address)" },
  // ── Cosmos ecosystem ────────────────────────────────────────────────────────
  ATOM:   COSMOS_NET,
  OSMO:   { network: "cosmos", networkLabel: "Osmosis",             placeholder: "osmo1... (Bech32 address)" },
  INJ:    { network: "cosmos", networkLabel: "Injective",           placeholder: "inj1... (Bech32 address)" },
  SEI:    { network: "cosmos", networkLabel: "Sei Network",         placeholder: "sei1... (Bech32 address)" },
  TIA:    { network: "cosmos", networkLabel: "Celestia",            placeholder: "celestia1... (Bech32 address)" },
  DYDX:   { network: "cosmos", networkLabel: "dYdX Chain",          placeholder: "dydx1... (Bech32 address)" },
  // ── Stellar ─────────────────────────────────────────────────────────────────
  XLM:    { network: "xlm",    networkLabel: "Stellar",             placeholder: "G... (Stellar address)" },
  // ── TON ─────────────────────────────────────────────────────────────────────
  TON:    { network: "ton",    networkLabel: "The Open Network",    placeholder: "UQ... or EQ... (TON address)" },
  NOT:    { network: "ton",    networkLabel: "TON (Jetton)",        placeholder: "UQ... or EQ... (TON address)" },
  // ── Hedera ──────────────────────────────────────────────────────────────────
  HBAR:   { network: "hbar",   networkLabel: "Hedera Hashgraph",    placeholder: "0.0.xxxxx (Hedera account)" },
  // ── NEAR ────────────────────────────────────────────────────────────────────
  NEAR:   { network: "near",   networkLabel: "NEAR Protocol",       placeholder: "yourname.near or 0x..." },
  // ── Algorand ────────────────────────────────────────────────────────────────
  ALGO:   { network: "algo",   networkLabel: "Algorand",            placeholder: "A... (Algorand address)" },
  // ── Filecoin ────────────────────────────────────────────────────────────────
  FIL:    { network: "fil",    networkLabel: "Filecoin",            placeholder: "f1... or f3... (Filecoin)" },
  // ── Other L1s ───────────────────────────────────────────────────────────────
  ICP:    { network: "icp",    networkLabel: "Internet Computer",   placeholder: "xxxxx-xxxxx (ICP principal)" },
  VET:    { network: "vet",    networkLabel: "VeChain",             placeholder: "0x... (VeChain address)" },
  ETC:    { network: "evm",    networkLabel: "Ethereum Classic",    placeholder: "0x... (ETC address)" },
  EOS:    { network: "eos",    networkLabel: "EOS Network",         placeholder: "account.name (EOS account)" },
  EGLD:   { network: "egld",   networkLabel: "MultiversX",          placeholder: "erd1... (MultiversX address)" },
  KAS:    { network: "kas",    networkLabel: "Kaspa",               placeholder: "kaspa:... (Kaspa address)" },
  STX:    { network: "stx",    networkLabel: "Stacks",              placeholder: "SP... or SM... (Stacks address)" },
  ROSE:   { network: "cosmos", networkLabel: "Oasis Network",       placeholder: "oasis1... (Oasis address)" },
  ONE:    { network: "evm",    networkLabel: "Harmony ONE",         placeholder: "one1... (Harmony address)" },
  RUNE_N: { network: "native", networkLabel: "THORChain",           placeholder: "thor1... (THORChain address)" },
};

function getAssetNetworkInfo(asset: string, connectedNetwork: string | null):
  { network: string; networkLabel: string; placeholder: string } {
  if (ASSET_NETWORK_MAP[asset]) return ASSET_NETWORK_MAP[asset];
  const net = connectedNetwork ?? "evm";
  return { network: net, networkLabel: net.toUpperCase(), placeholder: "Destination address" };
}

// Map EVM chainId → portfolio native symbol
const EVM_NATIVE: Record<number, string> = {
  1: "ETH", 10: "ETH", 42161: "ETH", 8453: "ETH",
  59144: "ETH", 324: "ETH", 534352: "ETH", 5000: "MNT",
  56: "BNB", 137: "MATIC", 43114: "AVAX", 250: "FTM", 25: "CRO",
};

function getNativeAsset(network: string | null, chainId: number | null): string {
  if (network === "bsv")  return "BSV";
  if (network === "sol")  return "SOL";
  if (network === "btc")  return "BTC";
  if (network === "tron") return "TRX";
  if (network === "evm" && chainId) return EVM_NATIVE[chainId] ?? "ETH";
  return "ETH";
}

const ASSET_COLORS: Record<string, string> = {
  // Stablecoins
  USDT:  "#22C55E", USDC:  "#3B82F6", DAI:   "#EAB308", TUSD:  "#1D4ED8",
  BUSD:  "#F59E0B", FDUSD: "#64748B", USDD:  "#1B7D3A",
  // Bitcoin family
  BTC:   "#F97316", BSV:   "#22C55E", BCH:   "#8DC351", LTC:   "#A0A0A0",
  DOGE:  "#C8A300", DASH:  "#008DE4", ZEC:   "#F4B728", XMR:   "#FF6600",
  ORDI:  "#FF8C00",
  // Major L1s
  ETH:   "#8B5CF6", BNB:   "#EAB308", SOL:   "#9945FF", XRP:   "#00A9E0",
  ADA:   "#0033AD", TRX:   "#EF4444", TON:   "#0088CC", MATIC: "#7C3AED",
  POL:   "#7C3AED", AVAX:  "#E84142", DOT:   "#E6007A", ATOM:  "#2E3148",
  NEAR:  "#00C08B", FTM:   "#1969FF", ALGO:  "#00B4D8", XLM:   "#7D00FF",
  HBAR:  "#222C6E", ETC:   "#669073", XMR2:  "#FF6600", EGLD:  "#23F7DD",
  ZEC2:  "#F4B728", DASH2: "#008DE4", EOS:   "#443F54", THETA: "#2AB8E6",
  VET:   "#15BDFF", ICP:   "#F15A24", SEI:   "#9B5DE5", KAS:   "#70C7BA",
  STX:   "#5546FF", ROSE:  "#E75F88", ONE:   "#00AEE9",
  // L2s
  ARB:   "#2D374B", OP:    "#FF0420", SUI:   "#4DA2FF", APT:   "#00B4D8",
  IMX:   "#17EEE0", STRK:  "#EC796B", ZK:    "#8B5CF6", METIS: "#00D2FF",
  MNT:   "#6B7280",
  // DeFi
  LINK:  "#2563EB", UNI:   "#FF007A", AAVE:  "#B6509E", MKR:   "#1AAB9B",
  CRV:   "#3466A5", SUSHI: "#FA52A0", COMP:  "#00D395", GRT:   "#5A3DFF",
  SNX:   "#00D1FF", YFI:   "#006AE3", LDO:   "#F9A825", GMX:   "#2D42FC",
  DYDX:  "#6966FF", RUNE:  "#00CCFF", INJ:   "#00F2FE", RNDR:  "#FF004F",
  FET:   "#1D5A8E", TAO:   "#8B5CF6", WLD:   "#374151", EIGEN: "#6366F1",
  TIA:   "#7C3AED", PENDLE:"#3BACE2", ENS:   "#5284FF",
  // Gaming / NFT / Metaverse
  AXS:   "#0055D5", SAND:  "#00ADE8", MANA:  "#FF2D55", GALA:  "#0080FF",
  ILV:   "#1F2937", FIL:   "#0090FF",
  // Meme coins
  PEPE:  "#00A86B", SHIB:  "#FFA409", BONK:  "#FF9900", FLOKI: "#F5A623",
  WIF:   "#D97706", POPCAT:"#FF6B6B", NOT:   "#36B6F0", DOGS:  "#4B5563",
  NEIRO: "#EC4899", TURBO: "#F59E0B", CATI:  "#8B5CF6", HMSTR: "#6B7280",
  // Tron ecosystem
  BTT:   "#CC0000", WIN:   "#A428F5", JST:   "#06B6D4",
  // Wrapped / bridged
  WBTC:  "#F97316", WETH:  "#8B5CF6", CBETH: "#6366F1", WSTETH:"#00A3FF",
  CBBTC: "#F97316",
  // Other
  CAKE:  "#D1884F", ORDI2: "#FF8C00",
};

const TRON_POOL_IDS = new Set(["trx-usdt","btt-usdt","btt-trx","win-trx","jst-usdt","trx-btc"]);

const POOL_LABELS_MOBILE: Record<string, string> = {
  "btc-usdt":  "BTC / USDT",  "eth-usdt":  "ETH / USDT",
  "sol-usdt":  "SOL / USDT",  "bsv-usdt":  "BSV / USDT",
  "bnb-usdt":  "BNB / USDT",  "xrp-usdt":  "XRP / USDT",
  "ada-usdt":  "ADA / USDT",  "doge-usdt": "DOGE / USDT",
  "dot-usdt":  "DOT / USDT",  "link-usdt": "LINK / USDT",
  "bsv-btc":   "BSV / BTC",   "eth-btc":   "ETH / BTC",
  "trx-usdt":  "TRX / USDT",  "btt-usdt":  "BTT / USDT",
  "btt-trx":   "BTT / TRX",   "win-trx":   "WIN / TRX",
  "jst-usdt":  "JST / USDT",  "trx-btc":   "TRX / BTC",
};

interface MarketRow { symbol: string; baseAsset: string; quoteAsset: string; lastPrice: number; priceChangePercent24h: number; }

function useLivePrices() {
  return useQuery<Record<string, MarketRow>>({
    queryKey: ["portfolio-mobile-prices"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/markets`);
      if (!res.ok) throw new Error("price fetch failed");
      const rows: MarketRow[] = await res.json();
      // Only use USDT-quoted pairs so non-USDT cross rates don't corrupt prices
      const usdtRows = rows.filter(r => r.quoteAsset === "USDT");
      return Object.fromEntries(usdtRows.map(r => [r.baseAsset, r]));
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

const STATUS_COLOR: Record<string, string> = { open: "#4ade80", filled: "#22c55e", cancelled: "#6b7280" };

type Tab = "assets" | "defi" | "orders" | "history";

export function MobilePortfolio({ visibleTabs, hidePreContent }: { visibleTabs?: Tab[]; hidePreContent?: boolean } = {}) {
  const { address, network, provider, chainId, balance, disconnect, internalEvmAddress } = useWalletStore();
  // For orah-wallet, always query the ledger using the EVM address (primary account key)
  // so switching to BSV/BTC network doesn't fetch a different (empty) ledger account
  const ledgerAddress = (provider === "orah-wallet" && internalEvmAddress) ? internalEvmAddress : address;
  const { quoteCurrency } = useSettingsStore();
  const { getUserPositions, removePosition, clearWalletPositions } = useLiquidityStore();
  const lpPositions = address ? Object.entries(getUserPositions(address)) : [];
  const { cancelOrder: cancelOrderOnChain, escrowAvailable } = useEscrow();
  const { open: openWallet } = useWalletModalStore();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab | null>(() => hidePreContent ? null : (visibleTabs?.[0] ?? "assets"));
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [dismissedOrders, setDismissedOrders] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("orah_dismissed_orders") ?? "[]")); }
    catch { return new Set(); }
  });
  const [chainSheetOpen, setChainSheetOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<string | null>(null);
  const [historySubTab, setHistorySubTab] = useState<"onchain" | "trades" | "bridge" | "swaps" | "buys">(
    hidePreContent ? "onchain" : "trades"
  );
  const [onchainChainFilter, setOnchainChainFilter] = useState<number | null>(null);
  const { data: onchainTxs = [], isLoading: onchainLoading, refetch: refetchOnchain } = useOnChainTxHistory(
    historySubTab === "onchain" ? (ledgerAddress ?? address) : null
  );
  const [bridgeHistory, setBridgeHistory] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem("le_swap_history") ?? "[]"); } catch { return []; }
  });
  const [swapHistory] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem("orah_swap_history") ?? "[]"); } catch { return []; }
  });
  const [liveLeStatuses, setLiveLeStatuses] = useState<Record<string, any>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const removeBridgeEntry = useCallback((id: string) => {
    setBridgeHistory(prev => {
      const next = prev.filter((e: any) => e.transaction_id !== id);
      try { localStorage.setItem("le_swap_history", JSON.stringify(next.slice(0, 50))); } catch {}
      return next;
    });
    setLiveLeStatuses(prev => { const n = { ...prev }; delete n[id]; return n; });
    setConfirmDeleteId(null);
  }, []);

  // ── Transaction lookup tool ──────────────────────────────────────────────
  const [lookupId,     setLookupId]     = useState("");
  const [lookupResult, setLookupResult] = useState<any | null>(null);
  const [lookupError,  setLookupError]  = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const doLookup = useCallback(async () => {
    const id = lookupId.trim();
    if (!id) return;
    setLookupLoading(true);
    setLookupResult(null);
    setLookupError(null);
    try {
      const r = await fetch(`${BASE}/api/letsexchange/status/${encodeURIComponent(id)}`);
      const d = await r.json();
      if (r.ok && d.transaction_id) {
        setLookupResult(d);
      } else {
        setLookupError(d.error ?? "Exchange not found. Check the ID and try again.");
      }
    } catch {
      setLookupError("Network error — please try again.");
    } finally {
      setLookupLoading(false);
    }
  }, [lookupId]);

  // ── Venue-aware polling for pending bridge entries ───────────────────────
  const bridgeHistoryRef   = useRef(bridgeHistory);
  const liveLeStatusesRef  = useRef(liveLeStatuses);
  bridgeHistoryRef.current  = bridgeHistory;
  liveLeStatusesRef.current = liveLeStatuses;

  const BRIDGE_DONE = new Set(["finished", "failed", "refunded", "overdue"]);

  useEffect(() => {
    if (historySubTab !== "bridge") return;

    const fetchAll = async () => {
      const pending = bridgeHistoryRef.current.filter(
        e => !BRIDGE_DONE.has((liveLeStatusesRef.current[e.transaction_id]?.status ?? e.status ?? "wait").toLowerCase())
      );
      if (pending.length === 0) return;

      await Promise.all(pending.map(async (e: any) => {
        try {
          // Use stored venue so we hit the correct provider directly
          const venueSuffix = e.venue && e.venue !== "letsexchange"
            ? `?venue=${encodeURIComponent(e.venue)}`
            : "";
          const r = await fetch(`${BASE}/api/letsexchange/status/${encodeURIComponent(e.transaction_id)}${venueSuffix}`);
          if (!r.ok) return;
          const d = await r.json();
          if (!d.transaction_id) return;
          setLiveLeStatuses(prev => ({ ...prev, [e.transaction_id]: d }));
          // Persist updated status + rescued venue back to localStorage
          setBridgeHistory(prev => {
            let changed = false;
            const updated = prev.map((x: any) => {
              if (x.transaction_id !== e.transaction_id) return x;
              let next = x;
              if (d.status && d.status !== x.status)                           { next = { ...next, status: d.status };        changed = true; }
              if (d.venue_rescued && d.best_venue && d.best_venue !== x.venue) { next = { ...next, venue: d.best_venue };     changed = true; }
              return next;
            });
            if (changed) try { localStorage.setItem("le_swap_history", JSON.stringify(updated)); } catch {}
            return changed ? updated : prev;
          });
        } catch {}
      }));
    };

    fetchAll();
    const hasPending = bridgeHistory.some(
      (e: any) => !BRIDGE_DONE.has((liveLeStatuses[e.transaction_id]?.status ?? e.status ?? "wait").toLowerCase())
    );
    if (!hasPending) return;
    const iv = setInterval(fetchAll, 15_000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySubTab, bridgeHistory.length]);
  const [coinHistoryOpen, setCoinHistoryOpen] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAsset, setWithdrawAsset] = useState<{ asset: string; available: number; network: string; networkLabel: string; color: string } | null>(null);
  const [withdrawInitialTab, setWithdrawInitialTab] = useState<"deposit" | "withdraw" | "history">("withdraw");
  const [withdrawVisibleTabs, setWithdrawVisibleTabs] = useState<("deposit" | "withdraw" | "history")[] | undefined>(undefined);
  const queryClient = useQueryClient();

  const { data: prices, isLoading: pricesLoading, refetch } = useLivePrices();
  const { balances: evmBalances, refresh: evmRefresh } = useEvmBalances(
    network === "evm" ? address : null,
    network === "evm" ? (chainId ?? 1) : null,
  );
  const { balances: tronBalances, refresh: tronRefresh } = useTronBalances(
    network === "tron" ? address : null,
  );

  const bsvUnconfirmed = useWalletStore(s => s.bsvUnconfirmed);
  const nativeAsset = getNativeAsset(network, chainId);
  const walletStoreNativeBalance = Number.isFinite(Number(balance)) ? Number(balance) : 0;
  const liveNativeBalance =
    network === "evm"
      ? (evmBalances.find((b) => b.isNative)?.amount ?? null)
      : network === "tron"
        ? (tronBalances.find((b) => b.isNative)?.amount ?? null)
        : null;
  const nativeBalance = liveNativeBalance ?? walletStoreNativeBalance;

  const { data: ordersData } = useQuery({
    queryKey: ["portfolio-orders", ledgerAddress],
    queryFn: () => fetch(`${BASE}/api/orders?walletAddress=${encodeURIComponent(ledgerAddress || "")}`).then(r => r.json()),
    enabled: !!ledgerAddress,
    refetchInterval: 5_000,
    staleTime:       4_000,
  });
  const myOrders: any[] = Array.isArray(ordersData) ? ordersData : [];

  // ── OrahDEX internal exchange balance (user_balances) ────────────────────────
  const { data: exchangePortfolio, refetch: refetchExchange } = useQuery<{ balances: any[] }>({
    queryKey: ["orah-exchange-balance", ledgerAddress],
    queryFn:  async () => {
      if (!ledgerAddress) return { balances: [] };
      const r = await fetch(`${BASE}/api/portfolio?walletAddress=${encodeURIComponent(ledgerAddress)}`);
      if (!r.ok) return { balances: [] };
      const d = await r.json();
      return { balances: Array.isArray(d?.balances) ? d.balances : Array.isArray(d) ? d : [] };
    },
    enabled: !!ledgerAddress,
    refetchInterval: 30_000,
    staleTime:       15_000,
  });
  const exchangeBalances: any[] = exchangePortfolio?.balances ?? [];
  const nonZeroExchange = exchangeBalances.filter(b => parseFloat(b.available ?? b.total ?? "0") > 0);

  const { data: historyData = [], isLoading: historyLoading } = useQuery<any[]>({
    queryKey: ["trade-history", ledgerAddress],
    queryFn: () => fetch(`${BASE}/api/trades/history?walletAddress=${encodeURIComponent(ledgerAddress || "")}&limit=100`).then(r => r.json()),
    enabled: !!ledgerAddress,
    staleTime: 30_000,
  });

  // All coins that appear in history (for filter chips)
  const historyCoins: string[] = (() => {
    const seen = new Set<string>();
    for (const t of historyData) {
      const base = (t.symbol ?? "BSV/USDT").split("/")[0] ?? "BSV";
      seen.add(base);
    }
    return Array.from(seen);
  })();

  // Group history by date label (filtered by selected coin)
  const historyByDate: { label: string; trades: any[] }[] = (() => {
    const today = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const groups: Record<string, any[]> = {};
    const filtered = historyFilter
      ? historyData.filter(t => {
          const base = (t.symbol ?? "BSV/USDT").split("/")[0];
          return base === historyFilter;
        })
      : historyData;
    for (const t of filtered) {
      const d = new Date(t.timestamp ?? t.createdAt ?? Date.now());
      d.setHours(0,0,0,0);
      const label = d.getTime() === today.getTime() ? "Today"
        : d.getTime() === yesterday.getTime() ? "Yesterday"
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
      if (!groups[label]) groups[label] = [];
      groups[label].push(t);
    }
    return Object.entries(groups).map(([label, trades]) => ({ label, trades }));
  })();

  function dismissOrder(id: string) {
    setDismissedOrders(prev => {
      const next = new Set(prev);
      next.add(id);
      try { localStorage.setItem("orah_dismissed_orders", JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  const cancelMutation = useMutation({
    mutationFn: async ({ orderId, walletAddress: orderWalletAddress }: { orderId: string; walletAddress: string }) => {
      // Step 1: If the order has an active on-chain escrow deposit, cancel it
      // first so funds are returned to the user's wallet. Without this, clicking
      // Cancel in the portfolio only removes the order from the DB but leaves the
      // funds locked in the OrahDEXEscrow contract indefinitely.
      if (escrowAvailable && chainId) {
        let hasDeposit = false;
        try {
          const dep = await Promise.race([
            checkEscrowDeposit(orderId, chainId),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
          ]);
          hasDeposit = !!dep && !dep.released;
        } catch { /* RPC failure — skip on-chain cancel, let user retry */ }

        if (hasDeposit) {
          try {
            await cancelOrderOnChain(orderId);
          } catch (e: any) {
            const msg = String(e?.message ?? "").toLowerCase();
            const isMissingDeposit =
              msg.includes("no deposit") ||
              msg.includes("already settled") ||
              msg.includes("already released");
            if (!isMissingDeposit) throw e;
          }
        }
      }
      // Step 2: Tell the server to remove the order from the orderbook.
      const res = await fetch(`${BASE}/api/orders/${orderId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: orderWalletAddress }),
      });
      // 404 = already cancelled — treat as success.
      if (res.status === 404) return { id: orderId, status: "cancelled" };
      if (!res.ok) throw new Error("Failed to cancel");
      return res.json();
    },
    onMutate: async ({ orderId }) => {
      setCancellingId(orderId);
      await queryClient.cancelQueries({ queryKey: ["portfolio-orders", ledgerAddress] });
      const prev = queryClient.getQueryData(["portfolio-orders", ledgerAddress]);
      queryClient.setQueryData(["portfolio-orders", ledgerAddress], (old: any) =>
        Array.isArray(old)
          ? old.map((o: any) => String(o.id) === orderId ? { ...o, status: "cancelled", updatedAt: new Date().toISOString() } : o)
          : old
      );
      return { prev };
    },
    onError: (_err, _vars, context: any) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(["portfolio-orders", ledgerAddress], context.prev);
      }
    },
    onSettled: () => {
      setCancellingId(null);
      queryClient.invalidateQueries({ queryKey: ["portfolio-orders", ledgerAddress] });
      queryClient.invalidateQueries({ queryKey: ["orders", ledgerAddress] });
    },
  });

  // Build rows from real on-chain data where available
  const rows = (() => {
    // EVM: use all tokens returned by useEvmBalances (includes native + ERC-20)
    if (network === "evm" && evmBalances.length > 0) {
      return evmBalances.map(b => {
        const stableSymbols = ["USDT", "USDC", "DAI", "BUSD", "TUSD"];
        const isStable = stableSymbols.includes(b.symbol.toUpperCase());
        const mkt = prices?.[b.symbol];
        const price = b.price > 0 ? b.price : isStable ? 1 : (mkt?.lastPrice ?? 0);
        const change = b.change24h !== 0 ? b.change24h : isStable ? 0 : (mkt?.priceChangePercent24h ?? 0);
        const usdValue = b.usdValue > 0 ? b.usdValue : b.amount * price;
        const color = ASSET_COLORS[b.symbol] ?? "#6B7280";
        return { asset: b.symbol, color, amount: b.amount, price, change, value: usdValue, isNative: b.isNative };
      });
    }
    // TRON: use real balances from useTronBalances hook
    if (network === "tron" && tronBalances.length > 0) {
      return tronBalances.map(b => {
        const isStable = ["USDT","USDC"].includes(b.symbol);
        const mkt = prices?.[b.symbol];
        const price = b.price ?? (isStable ? 1 : (mkt?.lastPrice ?? 0));
        const change = isStable ? 0 : (mkt?.priceChangePercent24h ?? 0);
        const usdValue = b.usdValue ?? (b.amount * price);
        const color = ASSET_COLORS[b.symbol] ?? "#EF4444";
        return { asset: b.symbol, color, amount: b.amount, price, change, value: usdValue, isNative: b.isNative };
      });
    }
    // Non-EVM wallets: show native asset with stored balance + live price
    const nativeColor = ASSET_COLORS[nativeAsset] ?? "#6B7280";
    const mkt = prices?.[nativeAsset];
    const nativePrice  = mkt?.lastPrice ?? 0;
    const nativeChange = mkt?.priceChangePercent24h ?? 0;
    return [{ asset: nativeAsset, color: nativeColor, amount: nativeBalance, price: nativePrice, change: nativeChange, value: nativeBalance * nativePrice, isNative: true }];
  })();

  // eslint-disable-next-line prefer-const
  let tokensTotal = rows.reduce((s, r) => s + r.value, 0);
  const lpTotalValue = lpPositions.reduce((s, [, pos]) => s + (pos.depositedValueUsd ?? 0), 0);

  // Non-custodial: wallet rows are shown as-is — no OrahDEX ledger adjustments.
  // Trades settle directly wallet-to-wallet; no internal balance tracking needed.

  // ── BUCKET 2: Busy in Trade — assets locked in open limit/stop orders ─────
  // For SELL orders: base asset is reserved (e.g. 0.003 ETH locked for a sell)
  // For BUY  orders: quote asset is reserved (price × qty USDT)
  const STABLES = new Set(["USDT","USDC","DAI","BUSD","TUSD","FDUSD","USDD","oUSD"]);
  const openOrders = myOrders.filter(o => o.status === "open" || o.status === "pending");
  const lockedByAsset: Record<string, { amount: number; orders: { id: string; symbol: string; side: string; qty: number; price: number; type: string }[] }> = {};
  for (const order of openOrders) {
    const parts = (order.symbol ?? "").split("/");
    const base  = parts[0] ?? "";
    const quote = parts[1] ?? "USDT";
    if (order.side === "sell") {
      const qty = parseFloat(order.quantity) || parseFloat(order.qty) || 0;
      if (qty > 0 && base) {
        if (!lockedByAsset[base]) lockedByAsset[base] = { amount: 0, orders: [] };
        lockedByAsset[base].amount += qty;
        lockedByAsset[base].orders.push({ id: order.id, symbol: order.symbol, side: "sell", qty, price: parseFloat(order.price) || 0, type: order.type ?? "limit" });
      }
    } else {
      const qty   = parseFloat(order.quantity) || parseFloat(order.qty) || 0;
      const price = parseFloat(order.price) || 0;
      // For market buy orders price is null/0 — estimate cost via USDT cross-rate
      let cost = price > 0 ? price * qty : 0;
      let estimatedPrice = price;
      if (cost === 0 && qty > 0) {
        const basePriceUsdt  = prices?.[base]?.lastPrice  ?? 0;
        const quotePriceUsdt = STABLES.has(quote) ? 1 : (prices?.[quote]?.lastPrice ?? 0);
        estimatedPrice = quotePriceUsdt > 0 ? basePriceUsdt / quotePriceUsdt : 0;
        cost = estimatedPrice > 0 ? estimatedPrice * qty : 0;
      }
      if (qty > 0 && quote) {
        if (!lockedByAsset[quote]) lockedByAsset[quote] = { amount: 0, orders: [] };
        lockedByAsset[quote].amount += cost;
        lockedByAsset[quote].orders.push({ id: order.id, symbol: order.symbol, side: "buy", qty, price: estimatedPrice, type: order.type ?? "market" });
      }
    }
  }
  // Self-custody EVM: open orders are signed intents, NOT on-chain locks.
  // Funds remain fully available in the user's wallet (Rabby/MetaMask) until
  // the order fills. Showing a "Busy in Trade" reservation here is misleading
  // because the on-chain balance is unchanged. Hide the bucket entirely for
  // self-custody EVM users.
  const isSelfCustodyEvm = network === "evm";
  const rawLockedEntries = Object.entries(lockedByAsset).filter(([, v]) => v.amount > 0);
  const lockedEntries = isSelfCustodyEvm ? [] : rawLockedEntries;
  const lockedTotalUsd = lockedEntries.reduce((s, [token, v]) => {
    const p = STABLES.has(token) ? 1 : (prices?.[token]?.lastPrice ?? 0);
    return s + v.amount * p;
  }, 0);
  const hasOpenIntents = isSelfCustodyEvm && rawLockedEntries.length > 0;

  // ── BUCKET 1: Wallet balance (real on-chain, minus OrahDEX-consumed amounts) ──
  const total = tokensTotal;
  const nonZero = rows.filter(r => r.amount > 0);
  const totalChange = tokensTotal > 0 && nonZero.length > 0
    ? nonZero.reduce((s, r) => s + (r.value * r.change) / 100, 0) / tokensTotal * 100
    : 0;

  const handleCopy = () => {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!address && !hidePreContent) {
    return (
      <div className="flex flex-col h-full bg-background overflow-y-auto pb-24">
        <div className="px-4 pt-6 pb-4">
          <h1 className="text-xl font-bold text-foreground">Portfolio</h1>
        </div>

        {/* Hero card */}
        <div className="mx-4 mt-2 rounded-3xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 p-6 text-center space-y-2">
          <div className="w-16 h-16 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center mx-auto mb-3">
            <Zap size={28} className="text-primary" />
          </div>
          <h2 className="text-2xl font-black text-foreground tracking-tight">Login to Trade</h2>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">
            Connect your wallet to view live balances, track P&amp;L, receive funds, and start trading instantly.
          </p>
        </div>

        {/* Wallet options */}
        <div className="mx-4 mt-5 space-y-3">
          <p className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground px-1">Choose your wallet type</p>

          {/* EVM */}
          <button
            onClick={() => openWallet()}
            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-card border border-border hover:border-blue-500/40 hover:bg-blue-500/5 active:opacity-80 transition-all text-left group"
          >
            <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0 text-xl group-hover:scale-105 transition-transform">
              🦊
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground">EVM Wallets</p>
              <p className="text-xs text-muted-foreground mt-0.5">MetaMask · Coinbase · Trust · Ledger + all L2s</p>
              <div className="flex gap-1 mt-1.5">
                {["ETH","BNB","MATIC","ARB","BASE","AVAX","MNT"].map(s => (
                  <span key={s} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">{s}</span>
                ))}
              </div>
            </div>
            <span className="text-blue-400 text-xs font-semibold shrink-0 group-hover:translate-x-0.5 transition-transform">→</span>
          </button>

          {/* TRON */}
          <button
            onClick={() => openWallet()}
            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-card border border-border hover:border-red-500/40 hover:bg-red-500/5 active:opacity-80 transition-all text-left group"
          >
            <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0 text-xl group-hover:scale-105 transition-transform">
              🔴
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground">TRON Wallet</p>
              <p className="text-xs text-muted-foreground mt-0.5">TronLink · imToken · Trust · TokenPocket · OKX</p>
              <div className="flex gap-1 mt-1.5">
                {["TRX","USDT","BTT","WIN","JST"].map(s => (
                  <span key={s} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">{s}</span>
                ))}
              </div>
            </div>
            <span className="text-red-400 text-xs font-semibold shrink-0 group-hover:translate-x-0.5 transition-transform">→</span>
          </button>

          {/* BSV */}
          <button
            onClick={() => openWallet()}
            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-card border border-border hover:border-primary/40 hover:bg-primary/5 active:opacity-80 transition-all text-left group"
          >
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 text-xl group-hover:scale-105 transition-transform">
              ⚡
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground">Bitcoin SV Wallet</p>
              <p className="text-xs text-muted-foreground mt-0.5">HandCash · RelayX · Panda · Sensilet · manual</p>
              <div className="flex gap-1 mt-1.5">
                {["BSV","FAST","LOW FEE"].map(s => (
                  <span key={s} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">{s}</span>
                ))}
              </div>
            </div>
            <span className="text-primary text-xs font-semibold shrink-0 group-hover:translate-x-0.5 transition-transform">→</span>
          </button>

          {/* SOL / BTC */}
          <button
            onClick={() => openWallet()}
            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-card border border-border hover:border-violet-500/40 hover:bg-violet-500/5 active:opacity-80 transition-all text-left group"
          >
            <div className="w-12 h-12 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0 text-xl group-hover:scale-105 transition-transform">
              🌐
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground">Other Wallets</p>
              <p className="text-xs text-muted-foreground mt-0.5">Phantom (SOL) · UniSat · Xverse (BTC) · more</p>
              <div className="flex gap-1 mt-1.5">
                {["SOL","BTC","ORDINALS"].map(s => (
                  <span key={s} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20">{s}</span>
                ))}
              </div>
            </div>
            <span className="text-violet-400 text-xs font-semibold shrink-0 group-hover:translate-x-0.5 transition-transform">→</span>
          </button>
        </div>

        {/* Features list */}
        <div className="mx-4 mt-5 p-4 rounded-2xl bg-secondary/40 border border-border">
          <p className="text-xs font-semibold text-muted-foreground mb-3">After connecting you can:</p>
          <div className="space-y-2">
            {[
              { icon: "📊", text: "View live portfolio balance & P&L" },
              { icon: "💳", text: "Buy crypto with fiat (Apple Pay, Card, Bank)" },
              { icon: "💸", text: "Receive funds directly to your wallet" },
              { icon: "⚡", text: "Trade spot & futures markets" },
              { icon: "🔗", text: "Cross-chain BSV settlements via HTLC" },
            ].map(f => (
              <div key={f.text} className="flex items-center gap-2.5 text-xs text-muted-foreground">
                <span className="text-base leading-none">{f.icon}</span>
                {f.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <ReceiveModal isOpen={receiveOpen} onClose={() => setReceiveOpen(false)} />
      {withdrawAsset && (() => {
        const assetNet = getAssetNetworkInfo(withdrawAsset.asset, network);
        const sameNetwork = assetNet.network === (network ?? "evm");
        return (
          <WithdrawSheet
            open={withdrawOpen}
            onClose={() => { setWithdrawOpen(false); setWithdrawAsset(null); }}
            walletAddress={ledgerAddress ?? ""}
            defaultRecipient={sameNetwork ? (address ?? "") : ""}
            asset={withdrawAsset.asset}
            available={withdrawAsset.available}
            network={assetNet.network}
            networkLabel={assetNet.networkLabel}
            addressPlaceholder={assetNet.placeholder}
            color={withdrawAsset.color}
            initialTab={withdrawInitialTab}
            visibleTabs={withdrawVisibleTabs}
            isOrahWallet={provider === "orah-wallet"}
            passkeyEvmAddress={internalEvmAddress ?? undefined}
          />
        );
      })()}

      <div className={hidePreContent ? "flex flex-col" : "flex flex-col h-full overflow-y-auto pb-24 bg-background"}>
        {!hidePreContent && (
        <div className="px-4 pt-safe-top pb-3 pt-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground">Chain Balance</h1>
            {network && (
              <button
                onClick={() => setChainSheetOpen(true)}
                className="flex items-center gap-1 mt-0.5 group active:opacity-60 transition-opacity"
              >
                <p className="text-[10px] text-muted-foreground">
                  {provider ? getProviderLabel(provider) : network.toUpperCase()} · {network.toUpperCase()}
                </p>
                <ChevronDown size={10} className="text-muted-foreground/60 group-hover:text-muted-foreground transition-colors" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => { refetch(); if (network === "evm") evmRefresh?.(); if (network === "tron") tronRefresh?.(); }}
              className="p-2 rounded-full border border-border text-muted-foreground hover:text-foreground transition-all"
              title="Refresh"
            >
              <RefreshCw size={13} className={pricesLoading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={async () => {
                if (provider === "reown") {
                  import("@/lib/reown-appkit").then(({ disconnectReown }) => disconnectReown()).catch(() => {});
                }
                disconnect();
              }}
              className="p-2 rounded-full border border-border text-muted-foreground hover:text-red-400 hover:border-red-400/30 transition-all"
              title="Disconnect wallet"
            >
              <LogOut size={13} />
            </button>
          </div>
        </div>
        )}

        {/* ── Chain picker bottom sheet ─────────────────────────────────── */}
        {chainSheetOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
            onClick={() => setChainSheetOpen(false)}
          >
            <div
              className="w-full rounded-t-3xl overflow-hidden"
              style={{ background: "var(--color-bg, hsl(var(--card)))", maxHeight: "80vh", display: "flex", flexDirection: "column" }}
              onClick={e => e.stopPropagation()}
            >
              {/* Handle + header */}
              <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
                <div className="w-10 h-1 rounded-full bg-border mx-auto absolute left-1/2 -translate-x-1/2 top-2" />
                <p className="font-bold text-sm text-foreground">Select Network</p>
                <button onClick={() => setChainSheetOpen(false)} className="p-1 rounded-full hover:bg-white/10 transition-colors">
                  <X size={16} className="text-muted-foreground" />
                </button>
              </div>
              {/* Chain list via inline accordion — starts expanded, closes sheet on selection */}
              <div className="overflow-y-auto flex-1 px-3 pb-6">
                <ChainSwitcherDropdown
                  inline
                  startOpen
                  onChainSelected={() => setChainSheetOpen(false)}
                />
              </div>
            </div>
          </div>
        )}

        <div className={`px-4 ${hidePreContent && tab === null ? "space-y-0" : "space-y-4"}`}>
          {!hidePreContent && <>
          {/* ── BUCKET 1: Balance card ───────────────────────────────────────────── */}
          {/* On-chain balance card */}
          <div className="bg-card border border-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground font-medium">Wallet Balance</p>
              <span className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded-full border",
                network === "bsv" ? "bg-green-500/10 text-green-400 border-green-500/25"
                  : network === "evm" ? "bg-blue-500/10 text-blue-400 border-blue-500/25"
                  : network === "sol" ? "bg-violet-500/10 text-violet-400 border-violet-500/25"
                  : "bg-secondary text-muted-foreground border-border"
              )}>
                {provider ? getProviderLabel(provider) : (network ?? "").toUpperCase()}
              </span>
            </div>
            {pricesLoading && total === 0 ? (
              <div className="h-9 w-44 bg-muted/40 rounded-lg animate-pulse mb-2" />
            ) : (
              <p className="text-3xl font-bold text-foreground tracking-tight">
                {formatQuoteAmount(total, quoteCurrency)}
              </p>
            )}

            {total > 0 && (() => {
              const pnlUsd = total * totalChange / 100;
              return (
                <div className="flex items-center gap-3 mt-1.5">
                  <div className={cn("flex items-center gap-1.5", totalChange >= 0 ? "text-green-500" : "text-red-500")}>
                    {totalChange >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                    <span className="text-sm font-bold">{totalChange >= 0 ? "+" : ""}{totalChange.toFixed(2)}%</span>
                  </div>
                  <span className="text-muted-foreground/40 text-xs">·</span>
                  <span className={cn("text-sm font-semibold", totalChange >= 0 ? "text-green-400/80" : "text-red-400/80")}>
                    {pnlUsd >= 0 ? "+" : "−"}{formatQuoteAmount(Math.abs(pnlUsd), quoteCurrency)} today
                  </span>
                </div>
              );
            })()}

            {/* Available vs Locked breakdown */}
            {lockedTotalUsd > 0 && (
              <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] text-muted-foreground mb-0.5">Available</p>
                  <p className="text-sm font-bold text-green-400">{formatQuoteAmount(Math.max(0, total - lockedTotalUsd), quoteCurrency)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-0.5">Busy in Trade</p>
                  <p className="text-sm font-bold text-orange-400">{formatQuoteAmount(lockedTotalUsd, quoteCurrency)}</p>
                </div>
              </div>
            )}

            {/* Allocation bar */}
            {total > 0 && nonZero.length > 0 && (
              <>
                <div className="flex h-1.5 rounded-full overflow-hidden mt-4 gap-0.5">
                  {nonZero.map(r => (
                    <div key={r.asset} className="h-full rounded-full" style={{ flex: r.value / total, backgroundColor: r.color }} />
                  ))}
                </div>
                <div className="flex gap-3 mt-2 flex-wrap">
                  {nonZero.map(r => (
                    <div key={r.asset} className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: r.color }} />
                      <span className="text-[10px] text-muted-foreground">{r.asset}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Self-custody info banner: open orders are signed intents only */}
          {hasOpenIntents && (
            <div className="bg-blue-500/5 border border-blue-500/25 rounded-2xl p-3 flex items-start gap-2">
              <svg className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-blue-300">Self-custody — your keys, your funds</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                  {rawLockedEntries.length} open order{rawLockedEntries.length === 1 ? "" : "s"}. Funds for unlocked orders stay in your wallet; locked orders are held in the on-chain escrow contract until the trade settles or you cancel.
                </p>
              </div>
            </div>
          )}

          {/* ── BUCKET 2: Busy in Trade (locked in open limit/stop orders) ───── */}
          {lockedEntries.length > 0 && (
            <div className="bg-orange-500/5 border border-orange-500/25 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-orange-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  <span className="text-sm font-bold text-orange-300">Busy in Trade</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30 uppercase tracking-wide">Reserved</span>
                </div>
                <span className="text-base font-bold text-orange-300">{formatQuoteAmount(lockedTotalUsd, quoteCurrency)}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mb-3">
                Reserved for your open limit/stop orders. Released back when orders are filled or cancelled.
              </p>
              <div className="space-y-2">
                {lockedEntries.map(([token, v]) => {
                  const isStable = ["USDT","USDC","DAI","BUSD"].includes(token);
                  const p = isStable ? 1 : (prices?.[token]?.lastPrice ?? 0);
                  const usdVal = v.amount * p;
                  return (
                    <div key={token} className="flex items-start justify-between">
                      <div>
                        <span className="text-xs font-bold text-foreground">{token}</span>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {v.orders.map(o => (
                            <span key={o.id} className="mr-2">
                              {o.type.toUpperCase()} {o.side.toUpperCase()} {o.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} {o.symbol?.split("/")[0]}
                              {o.price > 0 ? ` @ $${o.price.toLocaleString()}` : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <div className="text-xs font-mono text-foreground">{v.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</div>
                        {usdVal > 0 && <div className="text-[10px] text-muted-foreground">≈ {formatQuoteAmount(usdVal, quoteCurrency)}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── BUCKET 3: OrahDEX Exchange Balance ──────────────────────────────── */}
          {nonZeroExchange.length > 0 && (
            <div className="bg-emerald-500/5 border border-emerald-500/25 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Zap size={14} className="text-emerald-400" />
                  <span className="text-sm font-bold text-foreground">OrahDEX Balance</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase tracking-wide">Trading</span>
                </div>
                <button onClick={() => refetchExchange()} className="text-emerald-400/60 hover:text-emerald-400 transition-colors">
                  <RefreshCw size={12} />
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground mb-3">
                Funds in your OrahDEX trading account — ready to trade or withdraw to your wallet.
              </p>
              <div className="space-y-2.5">
                {nonZeroExchange.map((b: any) => {
                  const avail  = parseFloat(b.available ?? "0");
                  const locked = parseFloat(b.locked ?? "0");
                  const usdVal = parseFloat(b.value ?? "0") || avail * (parseFloat(b.price ?? "0") || 0);
                  const net    = ASSET_NETWORK_MAP[b.asset] ?? { network: "evm", networkLabel: b.asset, placeholder: "" };
                  const color  = ASSET_COLORS[b.asset] ?? "#6B7280";
                  return (
                    <div key={b.asset} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0" style={{ backgroundColor: color }}>
                          {b.asset.slice(0, 2)}
                        </div>
                        <div>
                          <span className="text-xs font-semibold text-foreground">{b.asset}</span>
                          {locked > 0 && (
                            <div className="text-[9px] text-orange-400">{locked.toLocaleString(undefined, { maximumFractionDigits: 6 })} in orders</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <div className="text-xs font-mono text-foreground">{avail.toLocaleString(undefined, { maximumFractionDigits: 8 })}</div>
                          {usdVal > 0 && <div className="text-[10px] text-muted-foreground">{formatQuoteAmount(usdVal, quoteCurrency)}</div>}
                        </div>
                        <button
                          onClick={() => {
                            setWithdrawAsset({ asset: b.asset, available: avail, network: net.network, networkLabel: net.networkLabel, color });
                            setWithdrawInitialTab("withdraw");
                            setWithdrawVisibleTabs(["withdraw", "deposit", "history"]);
                            setWithdrawOpen(true);
                          }}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 active:scale-95 transition-all text-[11px] font-semibold"
                        >
                          <ArrowUpRight size={12} />
                          Withdraw
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Receive / Bridge */}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setReceiveOpen(true)} className="flex flex-col items-center justify-center gap-1 py-3 rounded-2xl bg-primary text-primary-foreground font-bold text-xs shadow-lg shadow-primary/20 active:opacity-90">
              <ArrowDownToLine size={15} />
              Receive
            </button>
            <button onClick={() => navigate("/deposit-bsv")} className="flex flex-col items-center justify-center gap-1 py-3 rounded-2xl bg-secondary border border-border text-muted-foreground font-bold text-xs active:opacity-80 transition-colors">
              <ArrowLeftRight size={15} />
              Bridge
            </button>
          </div>


          {/* ── BUCKET 4: DeFi / Liquidity (LP tokens, Uniswap, AMM) ─────────── */}
          {lpTotalValue > 0 && (
            <div className="bg-primary/5 border border-primary/20 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Droplets size={14} className="text-primary" />
                  <span className="text-sm font-bold text-foreground">DeFi / Liquidity</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-primary/20 text-primary border border-primary/30 uppercase tracking-wide">LP</span>
                </div>
                <span className="text-base font-bold text-primary">{formatQuoteAmount(lpTotalValue, quoteCurrency)}</span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Liquidity deposited into AMM pools. Underlying tokens stay in your wallet — value shown here is your LP position.
              </p>
            </div>
          )}
          </>}

          {/* Tabs — filtered by visibleTabs prop */}
          {(!visibleTabs || visibleTabs.length > 1) && (
          <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
            {(["assets", "defi", "orders", "history"] as Tab[]).filter(t => !visibleTabs || visibleTabs.includes(t)).map(t => (
              <button
                key={t}
                onClick={() => setTab(prev => prev === t ? null : t)}
                className={`shrink-0 px-3.5 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                  tab === t
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-card border-border text-muted-foreground"
                }`}
              >
                {t === "assets" ? "Token"
                  : t === "defi" ? "DeFi"
                  : t === "orders" ? "Orders"
                  : <><History size={11} className="shrink-0" />History</>}
                {t === "defi" && (lpPositions.length + openOrders.length) > 0 && (
                  <span className="w-4 h-4 rounded-full bg-primary text-[9px] font-bold text-primary-foreground flex items-center justify-center">
                    {lpPositions.length + openOrders.length}
                  </span>
                )}
              </button>
            ))}
          </div>
          )}

          {/* Assets tab */}
          {tab === "assets" && (
            <>
              {/* Note about single-chain view for EVM wallets */}
              {network === "evm" && (
                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-primary/5 border border-primary/15">
                  <Info size={14} className="text-primary shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Showing on-chain balances for your connected network. Switch chains in your wallet to view other assets.
                  </p>
                </div>
              )}

              <div className="bg-card border border-border rounded-2xl overflow-hidden mb-4">
                {rows.map((r, i) => (
                  <div
                    key={r.asset}
                    onClick={() => setCoinHistoryOpen(r.asset)}
                    className={`flex items-center gap-3 px-4 py-3.5 active:bg-muted/40 cursor-pointer transition-colors ${i < rows.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 border"
                      style={{ backgroundColor: r.color + "22", borderColor: r.color + "44", color: r.color }}
                    >
                      {r.asset[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-semibold text-foreground">{r.asset}</p>
                        {r.isNative && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-green-500/15 text-green-400 border border-green-500/25">
                            NATIVE
                          </span>
                        )}
                        {r.isNative && network === "bsv" && bsvUnconfirmed > 0 && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/25 animate-pulse">
                            +{bsvUnconfirmed.toFixed(8)} PENDING
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                        {r.amount > 0
                          ? r.amount.toLocaleString(undefined, { maximumFractionDigits: r.amount < 0.0001 ? 8 : 6 })
                          : "0.000000"}
                      </p>
                      {r.price > 0 && !["USDT","USDC","DAI"].includes(r.asset) && (
                        <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                          @ ${(() => {
                            const p = r.price;
                            if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
                            if (p >= 1)    return p.toFixed(2);
                            if (p >= 0.01) return p.toFixed(4);
                            if (p >= 0.001) return p.toFixed(6);
                            if (p >= 1e-8)  return p.toFixed(8);
                            const mag = -Math.floor(Math.log10(p));
                            return p.toFixed(Math.min(mag + 3, 18)).replace(/\.?0+$/, "");
                          })()}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-foreground">
                        {formatQuoteAmount(r.value, quoteCurrency)}
                      </p>
                      {r.change !== 0 && (
                        <p className={`text-xs font-medium mt-0.5 ${r.change >= 0 ? "text-green-500" : "text-red-500"}`}>
                          {r.change >= 0 ? "+" : ""}{r.change.toFixed(2)}%
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* DeFi tab */}
          {tab === "defi" && (
            lpPositions.length === 0 && openOrders.length === 0 ? (
              <div className="bg-card border border-border rounded-2xl p-8 mb-4 flex flex-col items-center gap-2 text-muted-foreground">
                <Droplets className="w-8 h-8 opacity-30 mb-1" />
                <p className="text-sm font-medium">No DeFi positions yet</p>
                <p className="text-xs opacity-60 text-center">Place orders or add liquidity to get started</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3 mb-4">

                {/* ── Open Orders — for self-custody EVM these are signed intents,
                       for everyone else they reserve internal-ledger funds ─────── */}
                {openOrders.length > 0 && (() => {
                  const isSelfCustodyEvm = !!address?.startsWith("0x");
                  return (
                  <div className={cn(
                    "border rounded-2xl p-4",
                    isSelfCustodyEvm
                      ? "bg-blue-500/5 border-blue-500/25"
                      : "bg-orange-500/5 border-orange-500/25",
                  )}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <svg className={cn("w-3.5 h-3.5", isSelfCustodyEvm ? "text-blue-400" : "text-orange-400")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        <span className={cn("text-sm font-bold", isSelfCustodyEvm ? "text-blue-300" : "text-orange-300")}>
                          {isSelfCustodyEvm ? "Open Orders" : "In Exchange"}
                        </span>
                        <span className={cn(
                          "text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wide",
                          isSelfCustodyEvm
                            ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                            : "bg-orange-500/20 text-orange-400 border-orange-500/30",
                        )}>Open</span>
                      </div>
                      {!isSelfCustodyEvm && lockedTotalUsd > 0 && (
                        <span className="text-base font-bold text-orange-300">{formatQuoteAmount(lockedTotalUsd, quoteCurrency)}</span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground mb-3">
                      {isSelfCustodyEvm
                        ? "Signed intents — funds stay in your wallet until the order fills."
                        : "Coins reserved for your open orders. Released when orders fill or are cancelled."}
                    </p>
                    <div className="space-y-2">
                      {openOrders.map((o: any) => {
                        const parts = (o.symbol ?? "").split("/");
                        const orderBase  = parts[0] ?? "";
                        const orderQuote = parts[1] ?? "USDT";
                        const qty   = parseFloat(o.quantity ?? o.qty ?? "0") || 0;
                        const price = parseFloat(o.price ?? "0") || 0;
                        const isMarket = !o.price || o.type === "market";
                        const isBuy  = o.side === "buy";
                        const lockedAsset  = isBuy ? orderQuote : orderBase;
                        const ordInLocked = lockedByAsset[lockedAsset]?.orders.find((x: any) => String(x.id) === String(o.id));
                        const lockedAmount = isBuy
                          ? (ordInLocked ? ordInLocked.price * ordInLocked.qty : 0)
                          : qty;
                        const assetColor = ASSET_COLORS[lockedAsset] ?? "#6B7280";
                        return (
                          <div key={o.id} className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border">
                            <div
                              className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold shrink-0 border"
                              style={{ backgroundColor: assetColor + "22", borderColor: assetColor + "44", color: assetColor }}
                            >
                              {lockedAsset[0]}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-xs font-bold text-foreground">{o.symbol}</span>
                                <span
                                  className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                                  style={{
                                    backgroundColor: isBuy ? "#22c55e18" : "#ef444418",
                                    color: isBuy ? "#22c55e" : "#ef4444",
                                  }}
                                >
                                  {o.side?.toUpperCase()}
                                </span>
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                                  {(o.type ?? "limit").toUpperCase()}
                                </span>
                              </div>
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                <span className="font-mono">{qty.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                                <span className="ml-1">{orderBase}</span>
                                {!isMarket && price > 0 && (
                                  <span className="ml-1 text-muted-foreground/70">@ {price < 1 ? price.toFixed(6) : price.toLocaleString(undefined, { maximumFractionDigits: 4 })} {orderQuote}</span>
                                )}
                                {isMarket && <span className="ml-1 text-muted-foreground/70">at market</span>}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              {lockedAmount > 0 && (
                                <div className="text-xs font-mono font-bold text-orange-300">
                                  {lockedAmount.toLocaleString(undefined, { maximumFractionDigits: lockedAmount < 0.001 ? 8 : 6 })}
                                  <span className="text-[9px] font-normal text-muted-foreground ml-0.5">{lockedAsset}</span>
                                </div>
                              )}
                              <button
                                onClick={() => cancelMutation.mutate({ orderId: String(o.id), walletAddress: String(o.walletAddress || ledgerAddress || "") })}
                                disabled={cancellingId === String(o.id)}
                                className="mt-1 text-[10px] px-2 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 font-semibold disabled:opacity-40 transition-all"
                              >
                                {cancellingId === String(o.id) ? "…" : "Cancel"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  );
                })()}


                {/* DeFi summary row — only when LP positions exist */}
                {lpPositions.length > 0 && (
                <div className="bg-primary/5 border border-primary/20 rounded-2xl px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Droplets size={14} className="text-primary" />
                    <span className="text-xs font-semibold text-muted-foreground">Total LP Value</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-primary">
                      ${lpTotalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    {address && (
                      <button
                        onClick={() => { if (window.confirm("Remove all LP positions? This only clears the local record — no on-chain change.")) clearWalletPositions(address); }}
                        className="text-[10px] px-2 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 font-semibold"
                      >
                        Clear All
                      </button>
                    )}
                  </div>
                </div>
                )}

                {lpPositions.map(([poolId, pos]) => {
                  const display = POOL_LABELS_MOBILE[poolId] ?? poolId.toUpperCase().replace("-", " / ");
                  const explorerBase = pos.chainId ? EXPLORER_TX[pos.chainId] : null;
                  const txUrl   = explorerBase && pos.txHash ? `${explorerBase}${pos.txHash}` : null;
                  const dateStr = new Date(pos.depositedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
                  const isTronPool = TRON_POOL_IDS.has(poolId);
                  const chainName = pos.chainId ? (CHAIN_NAMES[pos.chainId] ?? `Chain ${pos.chainId}`) : isTronPool ? "TRON" : null;
                  const chainColor = pos.chainId === 1 ? { bg: "bg-violet-500/15", text: "text-violet-400", border: "border-violet-500/25" }
                    : pos.chainId === 8453 ? { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/25" }
                    : isTronPool ? { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/25" }
                    : { bg: "bg-secondary/50", text: "text-muted-foreground", border: "border-border" };
                  return (
                    <div key={poolId} className="bg-card border border-border rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-bold text-sm">{display}</div>
                          <div className="flex items-center gap-1 mt-0.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                            <span className="text-[10px] text-green-400 font-semibold">ACTIVE · EARNING FEES</span>
                          </div>
                        </div>
                        {chainName && (
                          <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold border ${chainColor.bg} ${chainColor.text} ${chainColor.border}`}>
                            {chainName}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="bg-secondary/30 rounded-xl p-3">
                          <div className="text-[10px] text-muted-foreground mb-0.5">LP Tokens</div>
                          <div className="font-mono font-bold text-sm">{pos.lpTokens.toFixed(4)}</div>
                        </div>
                        <div className="bg-secondary/30 rounded-xl p-3">
                          <div className="text-[10px] text-muted-foreground mb-0.5">Est. Value</div>
                          <div className="font-mono font-bold text-sm">{formatQuoteAmount(pos.depositedValueUsd, quoteCurrency)}</div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{dateStr}</span>
                        <div className="flex items-center gap-2">
                          {txUrl ? (
                            <a
                              href={txUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary/10 border border-primary/20 text-primary text-xs font-semibold"
                            >
                              View Tx <ExternalLink className="w-3 h-3" />
                            </a>
                          ) : pos.txHash ? (
                            <span className="font-mono text-[10px]">{pos.txHash.slice(0, 8)}…</span>
                          ) : null}
                          {address && (
                            <button
                              onClick={() => removePosition(address, poolId)}
                              className="text-[10px] px-2 py-1.5 rounded-xl border border-red-500/30 text-red-400 hover:bg-red-500/10 font-semibold"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}

          {/* Orders tab */}
          {tab === "orders" && (() => {
            const visibleOrders = myOrders.filter(o => !dismissedOrders.has(String(o.id)));
            return visibleOrders.length === 0 ? (
              <div className="bg-card border border-border rounded-2xl p-8 mb-4 flex flex-col items-center gap-2 text-muted-foreground">
                <p className="text-sm font-medium">No orders yet</p>
                <p className="text-xs opacity-60 text-center">Your open and past orders will appear here</p>
              </div>
            ) : (
              <div className="bg-card border border-border rounded-2xl overflow-hidden mb-4">
                {visibleOrders.map((o: any, i: number) => (
                  <div
                    key={o.id}
                    className={`flex items-center gap-3 px-4 py-3.5 ${i < visibleOrders.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold text-foreground">{o.symbol}</span>
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                          style={{
                            backgroundColor: o.side === "buy" ? "#22c55e18" : "#ef444418",
                            color: o.side === "buy" ? "#22c55e" : "#ef4444",
                          }}
                        >
                          {o.side.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {o.type ?? "limit"} · {Number(o.quantity).toFixed(4)} @ ${Number(o.price).toLocaleString()}
                      </p>
                    </div>
                    {o.status === "open" || o.status === "pending" ? (
                      <button
                        onClick={() => cancelMutation.mutate({ orderId: String(o.id), walletAddress: String(o.walletAddress || ledgerAddress || "") })}
                        disabled={cancellingId === String(o.id)}
                        className="shrink-0 px-3 py-1.5 rounded-xl border border-red-500/40 text-red-400 text-[11px] font-bold active:bg-red-500/10 disabled:opacity-40 transition-all"
                      >
                        {cancellingId === String(o.id) ? "…" : "Cancel"}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="text-right">
                          <p className="text-xs font-semibold capitalize" style={{ color: STATUS_COLOR[o.status] ?? "#6b7280" }}>
                            {o.status}
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {new Date(o.updatedAt ?? o.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </div>
                        <button
                          onClick={() => dismissOrder(String(o.id))}
                          className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 active:bg-red-500/20 transition-all"
                          aria-label="Remove"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* History tab */}
          {tab === "history" && (
            <>
              {/* Sub-tab chips: On-Chain / Trades / Bridge / Coin Travel / Buys */}
              <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar">
                {([
                  { key: "onchain", label: "Txn History" },
                  { key: "trades",  label: "Trades"      },
                  { key: "bridge",  label: "Bridge"      },
                  { key: "swaps",   label: "Coin Travel" },
                  { key: "buys",    label: "Buys"        },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setHistorySubTab(key)}
                    className={cn(
                      "flex-1 min-w-[72px] py-2 rounded-xl text-xs font-bold border transition-all",
                      historySubTab === key
                        ? "bg-primary/15 border-primary/40 text-primary"
                        : "bg-card border-border text-muted-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* ── ON-CHAIN wallet transactions ────────────────────────── */}
              {historySubTab === "onchain" && (() => {
                const chains = Array.from(new Set(onchainTxs.map(t => t.chainId)));
                const filtered = onchainChainFilter
                  ? onchainTxs.filter(t => t.chainId === onchainChainFilter)
                  : onchainTxs;

                const timeAgo = (ts: number) => {
                  const s = Math.floor(Date.now() / 1000) - ts;
                  if (s < 60)   return `${s}s ago`;
                  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
                  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
                  return `${Math.floor(s / 86400)}d ago`;
                };

                const fmt = (n: number, decimals = 4) =>
                  n === 0 ? "0" : n < 0.0001 ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: decimals });

                return (
                  <>
                    {/* Chain filter pills */}
                    {chains.length > 1 && (
                      <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar mb-3">
                        <button
                          onClick={() => setOnchainChainFilter(null)}
                          className={`shrink-0 px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                            !onchainChainFilter ? "bg-primary/15 border-primary/40 text-primary" : "bg-card border-border text-muted-foreground"
                          }`}
                        >All</button>
                        {chains.map(cid => {
                          const sample = onchainTxs.find(t => t.chainId === cid)!;
                          return (
                            <button key={cid}
                              onClick={() => setOnchainChainFilter(onchainChainFilter === cid ? null : cid)}
                              className={`shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                                onchainChainFilter === cid ? "bg-primary/15 border-primary/40 text-primary" : "bg-card border-border text-muted-foreground"
                              }`}
                            >
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: sample.chainColor }} />
                              {sample.chainName}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Refresh button */}
                    <div className="flex justify-end mb-2">
                      <button
                        onClick={() => refetchOnchain()}
                        disabled={onchainLoading}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <RefreshCw size={11} className={onchainLoading ? "animate-spin" : ""} />
                        {onchainLoading ? "Loading…" : "Refresh"}
                      </button>
                    </div>

                    {onchainLoading && filtered.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                        <RefreshCw size={20} className="animate-spin opacity-40" />
                        <p className="text-xs">Fetching on-chain history…</p>
                      </div>
                    ) : !address ? (
                      <div className="bg-card border border-border rounded-2xl p-8 mb-4 flex flex-col items-center gap-2 text-muted-foreground">
                        <History size={28} className="opacity-20 mb-1" />
                        <p className="text-sm font-medium">Connect your wallet</p>
                        <p className="text-xs opacity-60 text-center">Connect to view on-chain transaction history</p>
                      </div>
                    ) : filtered.length === 0 ? (
                      <div className="bg-card border border-border rounded-2xl p-8 mb-4 flex flex-col items-center gap-2 text-muted-foreground">
                        <History size={28} className="opacity-20 mb-1" />
                        <p className="text-sm font-medium">No transactions found</p>
                        <p className="text-xs opacity-60 text-center">On-chain transactions will appear here</p>
                      </div>
                    ) : (
                      <div className="bg-card border border-border rounded-2xl overflow-hidden mb-4 divide-y divide-border">
                        {filtered.map((tx: OnChainTx, i: number) => {
                          const label = tx.isTokenTransfer
                            ? (tx.isIncoming ? `Receive ${tx.tokenSymbol ?? "Token"}` : `Send ${tx.tokenSymbol ?? "Token"}`)
                            : tx.functionName
                              ? tx.functionName.split("(")[0].replace(/([A-Z])/g, " $1").trim()
                              : (tx.isIncoming ? `Receive ${tx.nativeSymbol}` : `Send ${tx.nativeSymbol}`);

                          const amount = tx.isTokenTransfer
                            ? `${tx.isIncoming ? "+" : "-"}${fmt(tx.tokenValue ?? 0)} ${tx.tokenSymbol}`
                            : tx.valueEth > 0
                              ? `${tx.isIncoming ? "+" : "-"}${fmt(tx.valueEth, 6)} ${tx.nativeSymbol}`
                              : "Contract call";

                          return (
                            <a
                              key={`${tx.hash}-${i}`}
                              href={tx.explorerUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-3 px-4 py-3.5 hover:bg-muted/30 transition-colors active:bg-muted/50"
                            >
                              {/* Direction icon */}
                              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                                tx.isError
                                  ? "bg-red-500/10 text-red-400"
                                  : tx.isIncoming
                                    ? "bg-green-500/10 text-green-400"
                                    : "bg-muted text-muted-foreground"
                              }`}>
                                {tx.isError
                                  ? <span className="text-xs font-bold">!</span>
                                  : tx.isIncoming
                                    ? <ArrowDownLeft size={15} />
                                    : <ArrowUpRight size={15} />}
                              </div>

                              {/* Info */}
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-semibold text-foreground truncate capitalize">{label}</p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: tx.chainColor }} />
                                  <p className="text-[11px] text-muted-foreground">{tx.chainName} · {timeAgo(tx.timeStamp)}</p>
                                  {tx.isError && (
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">FAILED</span>
                                  )}
                                </div>
                              </div>

                              {/* Amount + link */}
                              <div className="text-right shrink-0 flex items-center gap-2">
                                <p className={`text-xs font-semibold font-mono ${
                                  tx.isError ? "text-muted-foreground line-through" :
                                  tx.isIncoming ? "text-green-400" : "text-foreground"
                                }`}>{amount}</p>
                                <ExternalLink size={11} className="text-muted-foreground/40 shrink-0" />
                              </div>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}

              {/* ── TRADES ─────────────────────────────────────────────── */}
              {historySubTab === "trades" && (
                historyLoading ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                    <RefreshCw size={20} className="animate-spin opacity-40" />
                    <p className="text-xs">Loading trades…</p>
                  </div>
                ) : historyData.length === 0 ? (
                  <div className="bg-card border border-border rounded-2xl p-8 mb-4 flex flex-col items-center gap-2 text-muted-foreground">
                    <History size={28} className="opacity-20 mb-1" />
                    <p className="text-sm font-medium">No trade history yet</p>
                    <p className="text-xs opacity-60 text-center">Your filled orders will appear here</p>
                  </div>
                ) : (
                  <>
                    {historyCoins.length > 1 && (
                      <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar mb-2">
                        <button
                          onClick={() => setHistoryFilter(null)}
                          className={`shrink-0 px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                            !historyFilter ? "bg-primary/15 border-primary/40 text-primary" : "bg-card border-border text-muted-foreground"
                          }`}
                        >All</button>
                        {historyCoins.map(coin => (
                          <button
                            key={coin}
                            onClick={() => setHistoryFilter(historyFilter === coin ? null : coin)}
                            className={`shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                              historyFilter === coin ? "bg-primary/15 border-primary/40 text-primary" : "bg-card border-border text-muted-foreground"
                            }`}
                          >
                            <span className="w-4 h-4 rounded-md flex items-center justify-center text-[9px] font-bold"
                              style={{ backgroundColor: (ASSET_COLORS[coin] ?? "#6B7280") + "33", color: ASSET_COLORS[coin] ?? "#6B7280" }}>
                              {coin[0]}
                            </span>
                            {coin}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="space-y-4 mb-4">
                      {historyByDate.map(({ label, trades }) => (
                        <div key={label}>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 px-1 mb-1.5">{label}</p>
                          <div className="bg-card border border-border rounded-2xl overflow-hidden">
                            {trades.map((t: any, i: number) => {
                              const isBuy   = (t.side ?? "buy") === "buy";
                              const sym     = (t.symbol ?? "BSV/USDT").split("/");
                              const base    = sym[0] ?? "BSV";
                              const quote   = sym[1] ?? "USDT";
                              const coinIn  = isBuy ? base  : quote;
                              const coinOut = isBuy ? quote : base;
                              const amtIn   = isBuy ? Number(t.quantity ?? t.fillQty ?? 0) : Number(t.total ?? (Number(t.quantity) * Number(t.price)));
                              const amtOut  = isBuy ? Number(t.total ?? (Number(t.quantity) * Number(t.price))) : Number(t.quantity ?? t.fillQty ?? 0);
                              const time    = new Date(t.timestamp ?? t.createdAt ?? Date.now());
                              const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                              const fee     = Number(t.fee ?? 0);
                              const color   = ASSET_COLORS[base] ?? "#6B7280";
                              return (
                                <div key={t.id ?? i} className={`flex items-center gap-3 px-4 py-3.5 ${i < trades.length - 1 ? "border-b border-border" : ""}`}>
                                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 border"
                                    style={{ backgroundColor: color + "22", borderColor: color + "44", color }}>
                                    {base[0]}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-sm font-semibold text-foreground">{base}/{quote}</span>
                                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${isBuy ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                                        {isBuy ? "BUY" : "SELL"}
                                      </span>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground mt-0.5">
                                      @ ${Number(t.price ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} · {timeStr}
                                      {fee > 0 && <span className="text-muted-foreground/50"> · fee {fee.toFixed(4)}</span>}
                                    </p>
                                  </div>
                                  <div className="text-right shrink-0 space-y-0.5">
                                    <div className="flex items-center justify-end gap-1 text-green-400">
                                      <ArrowDownLeft size={10} strokeWidth={2.5} />
                                      <span className="text-xs font-bold font-mono">+{amtIn.toLocaleString(undefined, { maximumFractionDigits: amtIn < 0.01 ? 6 : 4 })} {coinIn}</span>
                                    </div>
                                    <div className="flex items-center justify-end gap-1 text-muted-foreground/70">
                                      <ArrowUpRight size={10} strokeWidth={2.5} />
                                      <span className="text-[11px] font-mono">-{amtOut.toLocaleString(undefined, { maximumFractionDigits: amtOut < 0.01 ? 6 : 4 })} {coinOut}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )
              )}

              {/* ── BRIDGE (LetsExchange cross-chain) ──────────────────── */}
              {historySubTab === "bridge" && (
                <>
                {/* ── Transaction lookup ──────────────────────────────── */}
                <div className="bg-card border border-border rounded-2xl p-3.5 mb-3">
                  <p className="text-[11px] font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Search size={11} /> Look up any exchange by ID
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={lookupId}
                      onChange={e => { setLookupId(e.target.value); setLookupResult(null); setLookupError(null); }}
                      onKeyDown={e => e.key === "Enter" && doLookup()}
                      placeholder="Paste exchange ID…"
                      className="flex-1 min-w-0 bg-background border border-border rounded-xl px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
                    />
                    <button
                      onClick={doLookup}
                      disabled={!lookupId.trim() || lookupLoading}
                      className="shrink-0 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-bold disabled:opacity-40 flex items-center gap-1.5"
                    >
                      {lookupLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                      Check
                    </button>
                  </div>

                  {/* Lookup result */}
                  {lookupResult && (() => {
                    const s = lookupResult.status ?? "wait";
                    const isOk  = s === "finished";
                    const isBad = s === "failed" || s === "refunded" || s === "overdue";
                    const label = s === "wait" ? "Awaiting deposit"
                      : s === "confirming" || s === "confirmation" ? "Confirming"
                      : s === "exchanging" ? "Exchanging"
                      : s === "sending"    ? "Sending"
                      : s === "finished"   ? "Completed"
                      : s === "refunded"   ? "Refunded"
                      : s === "overdue"    ? "Overdue"
                      : s === "failed"     ? "Failed"
                      : s;
                    const color = isOk ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                      : isBad ? "text-red-400 bg-red-500/10 border-red-500/20"
                      : "text-amber-400 bg-amber-500/10 border-amber-500/20";
                    return (
                      <div className="mt-3 rounded-xl border border-border bg-background/50 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground font-mono truncate">{lookupResult.transaction_id}</span>
                          <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full border", color)}>{label}</span>
                        </div>
                        {lookupResult.hash_out && (
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="text-muted-foreground/60 shrink-0">Outbound TX</span>
                            <span className="font-mono text-foreground/70 truncate flex-1">{lookupResult.hash_out}</span>
                          </div>
                        )}
                        {isOk && (
                          <p className="text-[11px] text-emerald-400">Exchange completed — funds were sent to your destination address.</p>
                        )}
                        {s === "wait" && (
                          <p className="text-[11px] text-amber-400/80">Waiting for your deposit to arrive. BSV confirmations can take a few minutes.</p>
                        )}
                        {(s === "confirming" || s === "confirmation") && (
                          <p className="text-[11px] text-amber-400/80">Deposit received and confirming on-chain. Exchange will begin shortly.</p>
                        )}
                        {s === "exchanging" && (
                          <p className="text-[11px] text-amber-400/80">Deposit confirmed. Exchange is in progress.</p>
                        )}
                        {s === "sending" && (
                          <p className="text-[11px] text-amber-400/80">Exchange done — sending funds to your address now.</p>
                        )}
                        {isBad && (
                          <p className="text-[11px] text-red-400">Exchange {label.toLowerCase()}. Contact OrahDEX support at support@orahdex.org with this ID.</p>
                        )}
                      </div>
                    );
                  })()}

                  {lookupError && (
                    <p className="mt-2.5 text-[11px] text-red-400">{lookupError}</p>
                  )}
                </div>

                {bridgeHistory.length === 0 ? (
                  <div className="bg-card border border-border rounded-2xl p-8 mb-4 flex flex-col items-center gap-2 text-muted-foreground">
                    <ArrowLeftRight size={28} className="opacity-20 mb-1" />
                    <p className="text-sm font-medium">No bridge history yet</p>
                    <p className="text-xs opacity-60 text-center">Cross-chain swaps will appear here</p>
                  </div>
                ) : (
                  <div className="space-y-2 mb-4">
                    {bridgeHistory.map((e: any, i: number) => {
                      const fmtAmt = (n: any, maxDec = 8) => {
                        const v = parseFloat(String(n ?? ""));
                        if (!isFinite(v) || isNaN(v) || v === 0) return String(n ?? "–");
                        const abs = Math.abs(v);
                        const dec = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : Math.min(maxDec, 8);
                        return v.toFixed(dec).replace(/\.?0+$/, "");
                      };
                      const live = liveLeStatuses[e.transaction_id];
                      const status = live?.status ?? e.status ?? "wait";
                      const rawTs = e.createdAt ?? e.created_at;
                      const ts = rawTs ? new Date(rawTs) : null;
                      const dateStr = ts
                        ? ts.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                        : "";
                      const isFinished = status === "finished";
                      const isFailed   = status === "failed" || status === "refunded";
                      const isPending  = !isFinished && !isFailed;
                      const statusColor = isFinished ? "text-green-400 bg-green-500/15"
                        : isFailed ? "text-red-400 bg-red-500/15"
                        : "text-yellow-400 bg-yellow-500/15";
                      const statusLabel = status === "wait" ? "awaiting deposit"
                        : status === "confirming" ? "confirming"
                        : status === "exchanging" ? "exchanging"
                        : status === "sending" ? "sending"
                        : status;
                      const hashIn  = live?.hash_in  ?? null;
                      const hashOut = live?.hash_out ?? null;
                      const depositAddr = e.deposit ?? null;
                      const withdrawalAmt = e.withdrawal_amount && Number(e.withdrawal_amount) > 0
                        ? fmtAmt(e.withdrawal_amount)
                        : null;

                      const copyText = async (text: string) => {
                        try { await navigator.clipboard.writeText(text); } catch {}
                      };

                      return (
                        <div key={e.transaction_id ?? i} className="bg-card border border-border rounded-2xl overflow-hidden">
                          {/* Header row */}
                          <div className="flex items-center gap-3 px-4 pt-3.5 pb-2.5">
                            <div className={cn(
                              "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border",
                              isFinished ? "bg-green-500/10 border-green-500/25" : isFailed ? "bg-red-500/10 border-red-500/25" : "bg-primary/10 border-primary/20"
                            )}>
                              <ArrowLeftRight size={16} className={isFinished ? "text-green-400" : isFailed ? "text-red-400" : "text-primary"} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-bold text-foreground">{e.coin_from} → {e.coin_to}</span>
                                <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-md capitalize", statusColor)}>
                                  {statusLabel}
                                </span>
                                {isPending && (
                                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
                                )}
                              </div>
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                {fmtAmt(e.deposit_amount)} {e.coin_from}
                                {withdrawalAmt
                                  ? <> → <span className="text-green-400 font-semibold">{withdrawalAmt} {e.coin_to}</span></>
                                  : <span className="text-muted-foreground/50"> → pending</span>}
                                {dateStr && <span className="text-muted-foreground/40"> · {dateStr}</span>}
                              </p>
                            </div>
                            {isPending && (
                              <button
                                onClick={() => setConfirmDeleteId(prev => prev === e.transaction_id ? null : e.transaction_id)}
                                className="shrink-0 p-2 -mr-1 rounded-xl hover:bg-red-500/10 active:bg-red-500/20 transition-colors"
                                aria-label="Remove transaction"
                              >
                                <Trash2 size={15} className={confirmDeleteId === e.transaction_id ? "text-red-400" : "text-muted-foreground/35"} />
                              </button>
                            )}
                          </div>

                          {/* Deposit address — shown for pending swaps */}
                          {isPending && depositAddr && (
                            <div className="mx-4 mb-2.5 rounded-xl border border-yellow-500/25 bg-yellow-500/8 px-3 py-2">
                              <p className="text-[10px] text-yellow-400/80 font-semibold mb-0.5">Send {fmtAmt(e.deposit_amount)} {e.coin_from} to:</p>
                              <div className="flex items-center gap-2">
                                <p className="text-[11px] font-mono text-foreground/80 truncate flex-1">{depositAddr}</p>
                                <button
                                  onClick={() => copyText(depositAddr)}
                                  className="shrink-0 text-yellow-400/70 hover:text-yellow-400 active:opacity-60 transition-colors"
                                >
                                  <Copy size={12} />
                                </button>
                              </div>
                              {e.deposit_extra_id && (
                                <p className="text-[10px] text-muted-foreground/60 mt-0.5">Memo: <span className="font-mono">{e.deposit_extra_id}</span></p>
                              )}
                            </div>
                          )}

                          {/* TX hashes */}
                          {(hashIn || hashOut) && (
                            <div className="mx-4 mb-2.5 space-y-1">
                              {hashIn && (
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-muted-foreground/50 shrink-0 w-16">Deposit TX</span>
                                  <span className="text-[10px] font-mono text-muted-foreground/70 truncate flex-1">{hashIn}</span>
                                  <button onClick={() => copyText(hashIn)} className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground active:opacity-60">
                                    <Copy size={10} />
                                  </button>
                                </div>
                              )}
                              {hashOut && (
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-muted-foreground/50 shrink-0 w-16">Receive TX</span>
                                  <span className="text-[10px] font-mono text-muted-foreground/70 truncate flex-1">{hashOut}</span>
                                  <button onClick={() => copyText(hashOut)} className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground active:opacity-60">
                                    <Copy size={10} />
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Order ID */}
                          <div className="flex items-center gap-2 px-4 pb-2.5">
                            <span className="text-[10px] text-muted-foreground/30 shrink-0">ID</span>
                            <span className="text-[10px] font-mono text-muted-foreground/35 truncate">{e.transaction_id}</span>
                            <button onClick={() => copyText(e.transaction_id)} className="shrink-0 text-muted-foreground/25 hover:text-muted-foreground/60 active:opacity-60">
                              <Copy size={10} />
                            </button>
                          </div>

                          {/* Delete confirmation — shown when trash icon is tapped */}
                          {isPending && confirmDeleteId === e.transaction_id && (
                            <div className="flex items-center gap-2 px-4 pb-3 pt-2 border-t border-red-500/15 bg-red-500/5">
                              <span className="flex-1 text-[11px] text-muted-foreground">Remove this entry?</span>
                              <button
                                onClick={() => setConfirmDeleteId(null)}
                                className="text-[11px] px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-white/5 active:opacity-60 transition"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => removeBridgeEntry(e.transaction_id)}
                                className="text-[11px] px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 active:opacity-60 transition font-semibold"
                              >
                                Remove
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                </>
              )}

              {/* ── COIN TRAVEL (on-chain DEX swaps) ───────────────────── */}
              {historySubTab === "swaps" && (
                swapHistory.length === 0 ? (
                  <div className="bg-card border border-border rounded-2xl p-8 mb-4 flex flex-col items-center gap-2 text-muted-foreground">
                    <Zap size={28} className="opacity-20 mb-1" />
                    <p className="text-sm font-medium">No on-chain swaps yet</p>
                    <p className="text-xs opacity-60 text-center">On-chain DEX swaps will appear here</p>
                  </div>
                ) : (
                  <div className="bg-card border border-border rounded-2xl overflow-hidden mb-4">
                    {swapHistory.map((s: any, i: number) => {
                      const ts = s.ts ? new Date(s.ts) : null;
                      const dateStr = ts
                        ? ts.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                        : "";
                      return (
                        <div key={s.id ?? i} className={`flex items-center gap-3 px-4 py-3.5 ${i < swapHistory.length - 1 ? "border-b border-border" : ""}`}>
                          <div className="w-9 h-9 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center shrink-0">
                            <Zap size={16} className="text-green-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-foreground">BSV → {s.coinSymbol}</span>
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-green-500/15 text-green-400">SWAP</span>
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {s.bsvAmount} BSV → {Number(s.receiveAmt).toFixed(6)} {s.coinSymbol}
                              {s.chainLabel && <span className="text-muted-foreground/50"> · {s.chainLabel}</span>}
                              {dateStr && <span className="text-muted-foreground/50"> · {dateStr}</span>}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </>
          )}
        </div>

      </div>

      {/* Coin History Bottom Sheet */}
      {coinHistoryOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setCoinHistoryOpen(null)}
          />
          {/* Sheet */}
          <div className="relative bg-background border-t border-border rounded-t-2xl max-h-[80vh] flex flex-col shadow-2xl">
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1 shrink-0">
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold border"
                style={{
                  backgroundColor: (ASSET_COLORS[coinHistoryOpen] ?? "#6B7280") + "22",
                  borderColor:     (ASSET_COLORS[coinHistoryOpen] ?? "#6B7280") + "44",
                  color:            ASSET_COLORS[coinHistoryOpen] ?? "#6B7280",
                }}
              >
                {coinHistoryOpen[0]}
              </div>
              <div className="flex-1">
                <p className="text-sm font-bold text-foreground">{coinHistoryOpen}</p>
                <p className="text-[11px] text-muted-foreground">Trade history</p>
              </div>
              <button
                onClick={() => setCoinHistoryOpen(null)}
                className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground"
              >
                ✕
              </button>
            </div>

            {/* Trade list */}
            <div className="overflow-y-auto flex-1 px-4 py-3 space-y-1">
              {(() => {
                const coinTrades = historyData.filter(t => {
                  const base = (t.symbol ?? "BSV/USDT").split("/")[0];
                  return base === coinHistoryOpen;
                });
                if (historyLoading) return (
                  <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
                    <RefreshCw size={16} className="animate-spin opacity-40" />
                    <span className="text-xs">Loading…</span>
                  </div>
                );
                if (coinTrades.length === 0) return (
                  <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                    <History size={24} className="opacity-20" />
                    <p className="text-sm">No {coinHistoryOpen} trades yet</p>
                    <p className="text-xs opacity-60 text-center">Buy or sell {coinHistoryOpen} to see your history here</p>
                  </div>
                );
                return coinTrades.map((t: any, i: number) => {
                  const isBuy   = (t.side ?? "buy") === "buy";
                  const sym     = (t.symbol ?? `${coinHistoryOpen}/USDT`).split("/");
                  const base    = sym[0] ?? coinHistoryOpen;
                  const quote   = sym[1] ?? "USDT";
                  const coinIn  = isBuy ? base  : quote;
                  const coinOut = isBuy ? quote : base;
                  const amtIn   = isBuy
                    ? Number(t.quantity ?? t.fillQty ?? 0)
                    : Number(t.total ?? (Number(t.quantity) * Number(t.price)));
                  const amtOut  = isBuy
                    ? Number(t.total ?? (Number(t.quantity) * Number(t.price)))
                    : Number(t.quantity ?? t.fillQty ?? 0);
                  const time    = new Date(t.timestamp ?? t.createdAt ?? Date.now());
                  const dateStr = time.toLocaleDateString(undefined, { month: "short", day: "numeric" });
                  const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  return (
                    <div
                      key={t.id ?? i}
                      className="flex items-center gap-3 py-3 border-b border-border last:border-0"
                    >
                      {/* Direction icon */}
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${isBuy ? "bg-green-500/15" : "bg-red-500/15"}`}>
                        {isBuy
                          ? <ArrowDownLeft size={14} className="text-green-400" strokeWidth={2.5} />
                          : <ArrowUpRight  size={14} className="text-red-400"   strokeWidth={2.5} />
                        }
                      </div>
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${isBuy ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                            {isBuy ? "BUY" : "SELL"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            @ ${Number(t.price ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground/70 mt-0.5">{dateStr} · {timeStr}</p>
                      </div>
                      {/* Amounts */}
                      <div className="text-right shrink-0 space-y-0.5">
                        <div className="flex items-center justify-end gap-1 text-green-400">
                          <span className="text-xs font-bold font-mono">
                            +{amtIn.toLocaleString(undefined, { maximumFractionDigits: amtIn < 0.01 ? 6 : 4 })} {coinIn}
                          </span>
                        </div>
                        <div className="flex items-center justify-end gap-1 text-muted-foreground/60">
                          <span className="text-[11px] font-mono">
                            -{amtOut.toLocaleString(undefined, { maximumFractionDigits: amtOut < 0.01 ? 6 : 4 })} {coinOut}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
