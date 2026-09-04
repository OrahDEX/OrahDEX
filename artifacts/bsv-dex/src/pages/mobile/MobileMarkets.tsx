import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X, Star, ChevronUp, ChevronDown, Wallet } from "lucide-react";
import { useLocation } from "wouter";
import { CoinLogo } from "@/components/CoinLogo";
import { useWalletStore } from "@/store/useWalletStore";
import { getWalletMarketTab } from "@/lib/walletMarket";
import { useSettingsStore, convertFromUsd, getCurrencySymbol, FIAT_CURRENCIES } from "@/store/useSettingsStore";
import { useWalletPrices } from "@/hooks/useWalletPrices";

import { MobileWalletSheet } from "@/components/mobile/MobileWalletSheet";
import { ContractAddressBadge } from "@/components/ContractAddressBadge";
import { MobileBaseMarket } from "@/components/mobile/MobileBaseMarket";
import { MobileCoinVote } from "@/components/mobile/MobileCoinVote";
import {
  USDT_MARKETS, USDC_MARKETS, TUSD_MARKETS, USDD_MARKETS,
  BSV_MARKETS, BTC_MARKETS, ETH_MARKETS, BCH_MARKETS, BNB_MARKETS,
  MATIC_MARKETS, AVAX_MARKETS, ARB_MARKETS, OP_MARKETS, FTM_MARKETS, CRO_MARKETS,
  LINEA_MARKETS, ZK_MARKETS, SCR_MARKETS, MNT_MARKETS,
  AI_MARKETS, SOL_MARKETS, MEME_MARKETS, DEFI_MARKETS, NEW_MARKETS,
  FUTURES_MARKETS,
  GAMING_MARKETS, COSMOS_MARKETS,
  RWA_MARKETS, EXCHANGE_MARKETS, DEPIN_MARKETS, BRC20_MARKETS,
  UNISWAP_MARKETS, PANCAKE_MARKETS,
} from "@/lib/mock-data";
import { useLetsExchangePairs } from "@/hooks/useLetsExchangePairs";
import { useGeckoTerminalPools } from "@/hooks/useGeckoTerminalPools";
import { useZoraCoins } from "@/hooks/useZoraCoins";
import { useBaseTokenList } from "@/hooks/useBaseTokenList";
import { useBaseTokenPrices } from "@/hooks/useBaseTokenPrices";
import { cn } from "@/lib/utils";
import { hasCategory } from "@/lib/market-categories";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function fmt(p: number): string {
  if (!p && p !== 0) return "—";
  if (p >= 10000)  return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (p >= 100)    return p.toFixed(2);
  if (p >= 1)      return p.toFixed(4);
  if (p >= 0.01)   return p.toFixed(4);
  if (p >= 0.0001) return p.toFixed(6);
  if (p >= 1e-8)   return p.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  const mag = -Math.floor(Math.log10(p));
  return p.toFixed(Math.min(mag + 3, 18)).replace(/\.?0+$/, "");
}

function fmtShort(n: number): string {
  if (!n) return "—";
  if (n >= 1_000_000_000_000) return `$${(n / 1_000_000_000_000).toFixed(2)}T`;
  if (n >= 1_000_000_000)     return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)         return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)             return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function normalise(m: any): MktRow {
  const base  = m.baseAsset  ?? m.base  ?? m.symbol?.split(/[-/]/)[0] ?? "";
  const quote = m.quoteAsset ?? m.quote ?? "USDT";
  const price = parseFloat(m.lastPrice ?? m.price) || 0;
  const chg   = parseFloat(m.priceChangePercent24h ?? m.priceChangePercent ?? m.change) || 0;
  const vol   = parseFloat(m.volume24h ?? m.volume) || 0;
  const cap   = parseFloat(m.marketCap ?? m.market_cap) || 0;
  const type  = m.type ?? (m.symbol?.includes("PERP") ? "futures" : "spot");
  return { symbol: m.symbol ?? `${base}-${quote}`, base, quote, price, chg, vol, cap, type };
}

interface MktRow { symbol: string; base: string; quote: string; price: number; chg: number; vol: number; cap: number; type: string; }

type SortKey = "base" | "price" | "chg";
type SortDir = "asc" | "desc";
type UsdSub  = "USDT" | "USDC" | "TUSD" | "USDD";

const USD_SUBS: UsdSub[] = ["USDT", "USDC", "TUSD", "USDD"];

const STABLE_MOCK: Record<UsdSub, any[]> = {
  USDT: USDT_MARKETS, USDC: USDC_MARKETS, TUSD: TUSD_MARKETS, USDD: USDD_MARKETS,
};

type Cat = "all" | "favorites" | "new" | "usd" | "btc" | "eth" | "bnb" | "matic" | "avax" | "arb" | "op" | "ftm" | "cro" | "base" | "zora" | "linea" | "zk" | "scr" | "mnt" | "bch" | "bsv" | "sol" | "ai" | "meme" | "defi" | "futures" | "vote" | "gaming" | "cosmos" | "rwa" | "exchange" | "depin" | "brc20" | "uniswap" | "pancake";

const CATS: { id: Cat; label: string }[] = [
  { id: "vote",      label: "🗳️ Vote" },
  { id: "favorites", label: "Favs" },
  { id: "all",       label: "All" },
  { id: "new",       label: "NEW" },
  { id: "usd",       label: "USD" },
  { id: "btc",       label: "BTC" },
  { id: "bsv",       label: "BSV" },
  { id: "eth",       label: "ETH" },
  { id: "bnb",       label: "BNB" },
  { id: "matic",     label: "MATIC" },
  { id: "avax",      label: "AVAX" },
  { id: "arb",       label: "ARB" },
  { id: "op",        label: "OP" },
  { id: "ftm",       label: "FTM" },
  { id: "cro",       label: "CRO" },
  { id: "base",      label: "BASE" },
  { id: "zora",      label: "ZORA" },
  { id: "linea",     label: "LINEA" },
  { id: "zk",        label: "ZK" },
  { id: "scr",       label: "SCROLL" },
  { id: "mnt",       label: "MNT" },
  { id: "sol",       label: "SOL" },
  { id: "bch",       label: "BCH" },
  { id: "ai",        label: "AI" },
  { id: "depin",     label: "DePIN" },
  { id: "meme",      label: "MEME" },
  { id: "defi",      label: "DEFI" },
  { id: "gaming",    label: "GAMING" },
  { id: "cosmos",    label: "COSMOS" },
  { id: "rwa",       label: "RWA" },
  { id: "exchange",  label: "EXCHANGE" },
  { id: "brc20",     label: "BRC-20" },
  { id: "uniswap",   label: "UNISWAP" },
  { id: "pancake",   label: "PANCAKE" },
  { id: "futures",   label: "FUTURES" },
];

/**
 * Always use mock data as the full pair list; enrich prices from API where available.
 * This ensures all pairs are visible even when the API DB only tracks a small subset.
 */
// Complete, deduplicated pool — used for Favorites and "All" tabs
const _ALL_POOL_RAW = [
  ...USDT_MARKETS, ...USDC_MARKETS, ...TUSD_MARKETS, ...USDD_MARKETS,
  ...BSV_MARKETS, ...BTC_MARKETS, ...ETH_MARKETS, ...BCH_MARKETS,
  ...BNB_MARKETS, ...MATIC_MARKETS, ...AVAX_MARKETS, ...ARB_MARKETS,
  ...OP_MARKETS, ...FTM_MARKETS, ...CRO_MARKETS,
  ...LINEA_MARKETS, ...ZK_MARKETS, ...SCR_MARKETS, ...MNT_MARKETS,
  ...AI_MARKETS, ...SOL_MARKETS, ...MEME_MARKETS, ...DEFI_MARKETS,
  ...GAMING_MARKETS, ...COSMOS_MARKETS,
  ...RWA_MARKETS, ...EXCHANGE_MARKETS, ...DEPIN_MARKETS, ...BRC20_MARKETS,
  ...UNISWAP_MARKETS, ...PANCAKE_MARKETS,
  ...NEW_MARKETS, ...FUTURES_MARKETS,
];
const MOBILE_ALL_POOL: any[] = Array.from(
  new Map(_ALL_POOL_RAW.map(m => [m.symbol ?? `${m.baseAsset}-${m.quoteAsset}`, m])).values()
);

function getCatRows(
  cat: Cat,
  usdSub: UsdSub,
  livePrice: Map<string, MktRow>,
  favorites: Set<string>,
  leAllPairs: MktRow[],
  lePairs: MktRow[],      // LetsExchange BSV-quoted pairs
  leBtcPairs: MktRow[],   // LetsExchange BTC-quoted pairs
  apiRows: MktRow[],      // All live DB pairs (normalised)
): MktRow[] {
  const enrich = (mock: any[]): MktRow[] =>
    mock.map(m => {
      const n = normalise(m);
      const live = livePrice.get(n.symbol);
      if (!live) return n;
      const chg = live.chg !== 0 ? live.chg : n.chg;
      return { ...n, price: live.price, chg, vol: live.vol };
    });

  /** All DB pairs for a given quote, priced > 0 */
  const dbByQuote = (quote: string): MktRow[] =>
    apiRows.filter(m => m.quote === quote && m.type !== "futures" && m.price > 0);

  /** All DB pairs matching a category tag, priced > 0 — same logic as desktop */
  const dbByCat = (tag: string): MktRow[] =>
    apiRows.filter(m => m.type !== "futures" && m.price > 0 && hasCategory(m.base, tag));

  switch (cat) {
    case "all":       return enrich(MOBILE_ALL_POOL).filter(m => m.type !== "futures" && m.price > 0);
    case "favorites": return [
      ...enrich(MOBILE_ALL_POOL).filter(m => favorites.has(m.symbol)),
      ...leAllPairs.filter(p => favorites.has(p.symbol)),
    ];
    case "new":       return NEW_MARKETS.map(normalise);
    case "usd": {
      const dbUsd = dbByQuote(usdSub);
      return dbUsd.length > 0 ? dbUsd : enrich(STABLE_MOCK[usdSub]);
    }
    case "btc": {
      const dbBtc = dbByQuote("BTC");
      if (dbBtc.length > 0) {
        const dbBtcBases = new Set(dbBtc.map(r => r.base));
        const leBtcExtra = leBtcPairs.filter(p => !dbBtcBases.has(p.base) && p.price > 0);
        return [...dbBtc, ...leBtcExtra];
      }
      const native = enrich(BTC_MARKETS);
      const seenBtcBases = new Set(native.map(r => r.base));
      const seenBtcSymbols = new Set(native.map(r => r.symbol));
      const extraBtc = leBtcPairs
        .filter(p => !seenBtcBases.has(p.base) && !seenBtcSymbols.has(p.symbol) && p.price > 0)
        .sort((a, b) => a.base.localeCompare(b.base));
      return [...native, ...extraBtc];
    }
    case "eth": {
      const dbEth = dbByQuote("ETH");
      const leEthPairs = leAllPairs.filter(p => p.quote === "ETH" && p.price > 0);
      if (dbEth.length > 0) {
        const seenBases = new Set(dbEth.map(r => r.base));
        const leExtra = leEthPairs.filter(p => !seenBases.has(p.base)).sort((a, b) => a.base.localeCompare(b.base));
        return [...dbEth, ...leExtra];
      }
      const native = enrich(ETH_MARKETS);
      const seenBases = new Set(native.map(r => r.base));
      const seenSymbols = new Set(native.map(r => r.symbol));
      const extra = leEthPairs
        .filter(p => !seenBases.has(p.base) && !seenSymbols.has(p.symbol))
        .sort((a, b) => a.base.localeCompare(b.base));
      return [...native, ...extra];
    }
    case "bnb":   return dbByQuote("BNB").length   > 0 ? dbByQuote("BNB")   : enrich(BNB_MARKETS);
    case "matic": return dbByQuote("MATIC").length > 0 ? dbByQuote("MATIC") : enrich(MATIC_MARKETS);
    case "avax":  return dbByQuote("AVAX").length  > 0 ? dbByQuote("AVAX")  : enrich(AVAX_MARKETS);
    case "arb":   return dbByQuote("ARB").length   > 0 ? dbByQuote("ARB")   : enrich(ARB_MARKETS);
    case "op":    return dbByQuote("OP").length    > 0 ? dbByQuote("OP")    : enrich(OP_MARKETS);
    case "ftm":   return dbByQuote("FTM").length   > 0 ? dbByQuote("FTM")   : enrich(FTM_MARKETS);
    case "cro":   return dbByQuote("CRO").length   > 0 ? dbByQuote("CRO")   : enrich(CRO_MARKETS);
    case "linea": return dbByQuote("LINEA").length > 0 ? dbByQuote("LINEA") : enrich(LINEA_MARKETS);
    case "zk":    return dbByQuote("ZK").length    > 0 ? dbByQuote("ZK")    : enrich(ZK_MARKETS);
    case "scr":   return dbByQuote("SCR").length   > 0 ? dbByQuote("SCR")   : enrich(SCR_MARKETS);
    case "mnt":   return dbByQuote("MNT").length   > 0 ? dbByQuote("MNT")   : enrich(MNT_MARKETS);
    case "bch":   return dbByQuote("BCH").length   > 0 ? dbByQuote("BCH")   : enrich(BCH_MARKETS);
    case "bsv": {
      const dbBsv = dbByQuote("BSV");
      const dbBsvBases  = new Set(dbBsv.map(r => r.base));
      const dbBsvSymbols = new Set(dbBsv.map(r => r.symbol));
      if (dbBsv.length > 0) {
        const leExtra = lePairs.filter(p => !dbBsvBases.has(p.base) && !dbBsvSymbols.has(p.symbol) && p.price > 0);
        return [...dbBsv, ...leExtra];
      }
      const native = enrich(BSV_MARKETS).filter(m => m.price > 0);
      const seenBases = new Set(native.map(r => r.base));
      const seenSymbols = new Set(native.map(r => r.symbol));
      const extra = lePairs
        .filter(p => !seenBases.has(p.base) && !seenSymbols.has(p.symbol) && p.price > 0)
        .sort((a, b) => a.base.localeCompare(b.base));
      return [...native, ...extra];
    }
    case "sol": {
      const dbSol = dbByCat("sol_eco");
      const leSolPairs = leAllPairs.filter(p => {
        const net = String((p as any).network ?? "").toLowerCase();
        return net.includes("sol");
      });
      const base = dbSol.length > 0 ? dbSol : enrich(SOL_MARKETS);
      const baseBases = new Set(base.map(r => r.base));
      const extraSol = leSolPairs.filter(p => !baseBases.has(p.base) && p.price > 0);
      return [...base, ...extraSol];
    }
    case "ai":       { const db = dbByCat("ai");       return db.length > 0 ? db : enrich(AI_MARKETS);       }
    case "depin":    { const db = dbByCat("depin");    return db.length > 0 ? db : enrich(DEPIN_MARKETS);    }
    case "meme":     { const db = dbByCat("meme");     return db.length > 0 ? db : enrich(MEME_MARKETS);     }
    case "defi":     { const db = dbByCat("defi");     return db.length > 0 ? db : enrich(DEFI_MARKETS);     }
    case "gaming":   { const db = dbByCat("gaming");   return db.length > 0 ? db : enrich(GAMING_MARKETS);   }
    case "cosmos":   { const db = dbByCat("cosmos");   return db.length > 0 ? db : enrich(COSMOS_MARKETS);   }
    case "rwa":      { const db = dbByCat("rwa");      return db.length > 0 ? db : enrich(RWA_MARKETS);      }
    case "exchange": { const db = dbByCat("exchange"); return db.length > 0 ? db : enrich(EXCHANGE_MARKETS); }
    case "brc20":    { const db = dbByCat("brc20");    return db.length > 0 ? db : enrich(BRC20_MARKETS);    }
    case "uniswap":  return enrich(UNISWAP_MARKETS);
    case "pancake":  return enrich(PANCAKE_MARKETS);
    case "futures":  return enrich(FUTURES_MARKETS);
    default:         return [];
  }
}

export function MobileMarkets() {
  const [, navigate] = useLocation();
  const [search, setSearch]       = useState("");
  const [cat, setCat]             = useState<Cat>("usd");
  const [usdSub, setUsdSub]       = useState<UsdSub>("USDT");
  const [sortKey, setSortKey]     = useState<SortKey>("base");
  const [sortDir, setSortDir]     = useState<SortDir>("asc");
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("market_favorites");
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const [walletBannerDismissed, setWalletBannerDismissed] = useState(false);
  const [walletSheetOpen, setWalletSheetOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  const { address, network, chainId } = useWalletStore();
  const { quoteCurrency } = useSettingsStore();
  const { prices: crossPrices } = useWalletPrices();
  const BTC_USD = crossPrices.BTC.usd || 83000;
  const BSV_USD = crossPrices.BSV.usd || 14;
  const ETH_USD = crossPrices.ETH.usd || 2400;
  const CROSS_QUOTE_USD: Record<string, number> = {
    USDT: 1, USDC: 1, TUSD: 1, USDD: 1, FDUSD: 1, BUSD: 1,
    BTC: BTC_USD, ETH: ETH_USD, BSV: BSV_USD,
    BNB:   crossPrices.BNB?.usd   || 580,
    BCH:   crossPrices.BCH?.usd   || 320,
    SOL:   crossPrices.SOL?.usd   || 130,
    MATIC: crossPrices.MATIC?.usd || 0.32,
    AVAX:  crossPrices.AVAX?.usd  || 18,
    ARB:   crossPrices.ARB?.usd   || 0.42,
    OP:    crossPrices.OP?.usd    || 0.70,
    FTM:   crossPrices.FTM?.usd   || 0.20,
    CRO:   crossPrices.CRO?.usd   || 0.09,
    BASE:  crossPrices.BASE?.usd  || 0.85,
    LINEA: crossPrices.LINEA?.usd || 0.05,
    ZK:    crossPrices.ZK?.usd    || 0.15,
    SCR:   crossPrices.SCR?.usd   || 0.52,
    MNT:   crossPrices.MNT?.usd   || 1.02,
  };

  const showWalletBanner = false;
  const walletChainLabel = "";

  const { data: apiData } = useQuery({
    queryKey: ["markets"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/markets`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  // LE "all" pairs — only needed for SOL tab, Favorites, or when searching
  const needAllPairs = cat === "eth" || cat === "sol" || cat === "favorites" || search.length > 0;
  const { pairs: rawLeAllPairs } = useLetsExchangePairs({ all: true, enabled: needAllPairs });
  const leAllPairs = useMemo<MktRow[]>(() =>
    (rawLeAllPairs ?? []).map(p => ({
      symbol:  p.symbol,
      base:    p.baseAsset,
      quote:   p.quoteAsset,
      price:   p.lastPrice ?? 0,
      chg:     p.priceChangePercent24h ?? 0,
      vol:     p.volume ?? 0,
      cap:     0,
      type:    "spot",
      network: (p as any).network ?? null,
    } as MktRow)),
  [rawLeAllPairs]);

  // LE BSV-quoted pairs — only needed for BSV tab
  const { pairs: rawLePairs } = useLetsExchangePairs({ quote: "BSV", enabled: cat === "bsv" });
  const lePairs = useMemo<MktRow[]>(() =>
    (rawLePairs ?? []).map(p => ({
      symbol: p.symbol,
      base:   p.baseAsset,
      quote:  p.quoteAsset,
      price:  p.lastPrice ?? 0,
      chg:    p.priceChangePercent24h ?? 0,
      vol:    p.volume ?? 0,
      cap:    0,
      type:   "spot",
    })),
  [rawLePairs]);

  // LE BTC-quoted pairs — only needed for BTC tab
  const { pairs: rawLeBtcPairs } = useLetsExchangePairs({ quote: "BTC", enabled: cat === "btc" });
  const leBtcPairs = useMemo<MktRow[]>(() =>
    (rawLeBtcPairs ?? []).map(p => ({
      symbol: p.symbol,
      base:   p.baseAsset,
      quote:  p.quoteAsset,
      price:  p.lastPrice ?? 0,
      chg:    p.priceChangePercent24h ?? 0,
      vol:    p.volume ?? 0,
      cap:    0,
      type:   "spot",
    })),
  [rawLeBtcPairs]);

  const apiRows = useMemo<MktRow[]>(
    () => (Array.isArray(apiData) ? apiData : []).map(normalise),
    [apiData]
  );

  const livePrice = useMemo(() => new Map<string, MktRow>(
    apiRows.map((m: MktRow) => [m.symbol, m])
  ), [apiRows]);

  // Live on-chain data from GeckoTerminal (chain/category tabs, cached 90s)
  const { data: geckoRows } = useGeckoTerminalPools(cat);
  // Live Zora Coins API data (zora tab only)
  const { data: zoraRows } = useZoraCoins(cat === "zora");
  // Full Base chain token catalog from CoinGecko (base tab only, cached 1h)
  const { data: baseTokenList } = useBaseTokenList(cat === "base");
  // DexScreener prices for catalog tokens not covered by GeckoTerminal (cached 60s)
  const basePrices = useBaseTokenPrices(baseTokenList, cat === "base" && baseTokenList.length > 0);

  const globalRows = useMemo(() => Array.from(new Map(
    [
      ...apiRows,
      ...CATS.flatMap(c => getCatRows(c.id, usdSub, livePrice, favorites, leAllPairs, lePairs, leBtcPairs, apiRows)),
    ].map((m: MktRow) => [m.symbol, m])
  ).values()), [apiRows, usdSub, livePrice, favorites, leAllPairs, lePairs, leBtcPairs]);

  let rows = getCatRows(cat, usdSub, livePrice, favorites, leAllPairs, lePairs, leBtcPairs, apiRows);

  const applyLiveMerge = (rows: MktRow[], src: any[]): MktRow[] => {
    const byBase = new Map(src.map((s: any) => [s.base, s]));
    const updated = rows.map(r => { const s = byBase.get(r.base); return s && s.price > 0 ? { ...r, price: s.price, chg: s.chg } : r; });
    const existing = new Set(updated.map(r => r.base));
    const extra: MktRow[] = src.filter((s: any) => !existing.has(s.base) && s.price > 0).map((s: any) => ({ symbol: s.symbol, base: s.base, quote: s.quote, price: s.price, chg: s.chg, vol: s.vol, cap: s.fdv ?? 0, type: "spot" as const }));
    return [...updated, ...extra];
  };

  // Merge live GeckoTerminal data for chain/category tabs
  if (!search && geckoRows.length > 0) rows = applyLiveMerge(rows, geckoRows);
  // Merge Zora Coins API data for zora tab
  if (!search && cat === "zora" && zoraRows.length > 0) rows = applyLiveMerge(rows, zoraRows);
  // Merge Base token list: append all ~2300 Base chain catalog tokens for base tab
  if (!search && cat === "base" && baseTokenList.length > 0) {
    const existingBases = new Set(rows.map(r => r.base));
    const listExtra: MktRow[] = baseTokenList
      .filter(t => !existingBases.has(t.symbol))
      .map(t => { const dp = basePrices.get(t.symbol); return { symbol: `${t.symbol}/USDC`, base: t.symbol, quote: "USDC", price: dp?.price ?? 0, chg: dp?.chg ?? 0, vol: dp?.vol ?? 0, cap: 0, type: "spot" as const }; });
    rows = [...rows, ...listExtra];
  }

  if (search) {
    const q = search.toUpperCase();
    rows = globalRows.filter(m => m.base.includes(q) || m.symbol.includes(q));
  }

  rows = [...rows].sort((a, b) => {
    let v = 0;
    if (sortKey === "base")  v = a.base.localeCompare(b.base);
    if (sortKey === "price") v = a.price - b.price;
    if (sortKey === "chg")   v = a.chg - b.chg;
    return sortDir === "asc" ? v : -v;
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const toggleFav = (sym: string) =>
    setFavorites(prev => {
      const n = new Set(prev);
      n.has(sym) ? n.delete(sym) : n.add(sym);
      try { localStorage.setItem("market_favorites", JSON.stringify([...n])); } catch {}
      return n;
    });

  const goTrade = (m: MktRow) => {
    const slug = m.symbol.replace(/\//g, "-");
    if (m.type === "futures") { navigate(`/futures/${slug}`); return; }
    navigate(`/trade/${slug}`);
  };

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span className="inline-flex flex-col ml-0.5 opacity-30 text-[8px]"><ChevronUp className="w-2.5 h-2.5" /><ChevronDown className="w-2.5 h-2.5 -mt-1" /></span>;
    return sortDir === "asc"
      ? <ChevronUp className="inline w-3 h-3 ml-0.5 text-primary" />
      : <ChevronDown className="inline w-3 h-3 ml-0.5 text-primary" />;
  }

  return (
    <>
    <div className={cn("flex flex-col bg-background", (cat === "base" || cat === "vote") ? "h-full" : "h-full overflow-y-auto pb-24")}>
      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-20 bg-background border-b border-border/30">
        {/* Spot label + Search bar */}
        <div className="flex items-center gap-2 px-4 pt-1 pb-1">
          <span className="text-base font-bold shrink-0">Spot</span>
          <div className="flex-1 flex items-center gap-2 bg-secondary/60 border border-border/60 rounded-xl px-3 h-9">
            <Search size={13} className="text-muted-foreground shrink-0" />
            <input
              className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/60 outline-none"
              placeholder="Search coins…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
            />
            {search && <button onClick={() => setSearch("")}><X size={13} className="text-muted-foreground" /></button>}
          </div>
        </div>

        {/* Main category tabs */}
        <div ref={tabsRef} className="flex overflow-x-auto no-scrollbar px-4 pb-0 gap-0">
          {CATS.map(c => {
            const isBsv = c.id === "bsv";
            const isActive = cat === c.id;
            return (
              <button
                key={c.id}
                onClick={() => { setCat(c.id); setSearch(""); }}
                className={cn(
                  "shrink-0 px-3.5 py-2.5 text-[13px] font-medium whitespace-nowrap relative transition-colors",
                  isActive && isBsv ? "text-green-400 font-bold"
                  : isActive ? "text-foreground font-bold"
                  : isBsv ? "text-green-500/80 hover:text-green-400"
                  : "text-muted-foreground hover:text-foreground/80"
                )}
              >
                {isBsv ? "⚡ BSV" : c.label}
                {isActive && !isBsv && (
                  <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-primary rounded-full" />
                )}
                {isActive && isBsv && (
                  <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-green-500 rounded-full" />
                )}
              </button>
            );
          })}
        </div>

        {/* Wallet-aware market banner */}
        {showWalletBanner && (
          <div className="mx-4 mt-2 mb-0 flex items-center gap-2 px-3 py-2.5 bg-primary/10 border border-primary/25 rounded-xl">
            <Wallet className="w-4 h-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-bold text-primary leading-tight">Showing {walletChainLabel} Markets</p>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">Auto-filtered for your wallet · tap any tab to browse all</p>
            </div>
            <button
              onClick={() => setWalletBannerDismissed(true)}
              className="text-muted-foreground p-1 shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* BSV fastest settlement banner — mobile */}
        {cat === "bsv" && (
          <div className="mx-4 mt-2 mb-0 flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/25 rounded-xl">
            <span className="text-base leading-none">⚡</span>
            <div className="min-w-0">
              <p className="text-[11px] font-bold text-green-400 leading-tight">World's Fastest Settlement — BSV</p>
              <p className="text-[10px] text-green-300/60 leading-tight mt-0.5">On-chain in &lt;5s · ~$0.001 fee · No bridges</p>
            </div>
          </div>
        )}

        {/* USD sub-tabs — only visible when USD tab is active */}
        {cat === "usd" && (
          <div className="flex items-center gap-2 px-4 py-2 border-t border-border/20 bg-secondary/20">
            {USD_SUBS.map(s => (
              <button
                key={s}
                onClick={() => setUsdSub(s)}
                className={cn(
                  "px-3.5 py-1 rounded-lg text-[12px] font-semibold border transition-all",
                  usdSub === s
                    ? "bg-primary/20 text-primary border-primary/40"
                    : "text-muted-foreground border-border/40 hover:text-foreground"
                )}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Special full-screen views ── */}
      {cat === "base" ? (
        <MobileBaseMarket />
      ) : cat === "vote" ? (
        <MobileCoinVote />
      ) : (
        <>
          {/* ── Column headers ── */}
          <div className="flex items-center px-4 py-2 border-b border-border/30 bg-background/80">
            <div className="w-[23px] mr-2.5 shrink-0" />
            <button
              onClick={() => toggleSort("base")}
              className="flex items-center text-[11px] text-muted-foreground font-semibold flex-1"
            >
              Pair <SortIcon k="base" />
            </button>
            <button
              onClick={() => toggleSort("price")}
              className="flex flex-col items-end text-[11px] text-muted-foreground font-semibold w-36 pr-3"
            >
              <span className="flex items-center gap-0.5">
                Price {quoteCurrency !== "USDT" && quoteCurrency !== "USDC" && (
                  <span className="text-primary/70">{getCurrencySymbol(quoteCurrency)}</span>
                )} <SortIcon k="price" />
              </span>
              <span className="flex items-center gap-2 text-[9px] font-normal mt-0.5">
                <span className="text-orange-400/70">₿ BTC</span>
                <span className="text-yellow-400/70">⚡ BSV</span>
              </span>
            </button>
            <button
              onClick={() => toggleSort("chg")}
              className="flex items-center justify-center text-[11px] text-muted-foreground font-semibold w-[68px]"
            >
              Change <SortIcon k="chg" />
            </button>
          </div>

          {/* ── Market list ── */}
          {rows.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-20 text-muted-foreground text-sm">
              {cat === "favorites" ? "Star coins to add favorites" : search ? `No results for "${search}"` : "Loading…"}
            </div>
          ) : (
            <div>
              {rows.map((m) => (
                <MexcRow
                  key={m.symbol}
                  m={m}
                  quoteCurrency={quoteCurrency}
                  btcUSD={BTC_USD}
                  bsvUSD={BSV_USD}
                  quoteUSD={CROSS_QUOTE_USD[m.quote] ?? 1}
                  isFav={favorites.has(m.symbol)}
                  onFav={() => toggleFav(m.symbol)}
                  onTrade={() => goTrade(m)}
                  onBuy={() => goTrade(m)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>

    {walletSheetOpen && <MobileWalletSheet onClose={() => setWalletSheetOpen(false)} />}
    </>
  );
}

const STABLE_QUOTE_SET = new Set(["USDT", "USDC", "TUSD", "USDD", "USD", "BUSD"]);

function fmtCross(v: number, decimals: number): string {
  if (!v || v <= 0) return "—";
  if (v >= 1000)  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1)     return v.toFixed(decimals <= 4 ? 4 : decimals);
  if (v >= 0.001) return v.toFixed(6);
  if (v >= 1e-8)  return v.toFixed(8);
  // Sub-satoshi prices: extend decimal places to show 4 significant figures
  const mag = -Math.floor(Math.log10(v));
  return v.toFixed(Math.min(mag + 3, 18)).replace(/\.?0+$/, "");
}

function MexcRow({
  m, quoteCurrency, btcUSD, bsvUSD, quoteUSD, isFav, onFav, onTrade, onBuy
}: {
  m: MktRow; quoteCurrency: string;
  btcUSD: number; bsvUSD: number; quoteUSD: number;
  isFav: boolean; onFav: () => void; onTrade: () => void; onBuy: () => void;
}) {
  const isUp = m.chg >= 0;

  // Apply currency conversion only when the pair's quote is a stablecoin (price is in USD)
  const isStableQuote = STABLE_QUOTE_SET.has(m.quote);
  const isFiatTarget  = FIAT_CURRENCIES.some(c => c.code === quoteCurrency);
  const showConverted = isStableQuote && (isFiatTarget || ["BTC","ETH","BNB","SOL","BSV"].includes(quoteCurrency));

  const displayPrice = showConverted ? convertFromUsd(m.price, quoteCurrency) : m.price;
  const currSym      = showConverted ? getCurrencySymbol(quoteCurrency) : "";

  // Cross-rate computation: convert price → USD → BTC / BSV
  const priceUSD = m.price * quoteUSD;
  const isBTCBase = m.base === "BTC";
  const isBSVBase = m.base === "BSV";
  const priceBTC  = isBTCBase ? 1 : (priceUSD > 0 ? priceUSD / btcUSD : 0);
  const priceBSV  = isBSVBase ? 1 : (priceUSD > 0 ? priceUSD / bsvUSD : 0);

  return (
    <div className="flex items-center px-4 py-[9px] active:bg-secondary/30 transition-colors">
      <button onClick={onFav} className="mr-2.5 shrink-0 self-start mt-1">
        <Star size={13} className={isFav ? "fill-green-400 text-green-400" : "text-muted-foreground/30"} />
      </button>

      <button onClick={onTrade} className="mr-3 shrink-0">
        <CoinLogo symbol={m.base} size={32} />
      </button>

      <div className="flex-1 text-left min-w-0 flex flex-col gap-[2px]">
        <button onClick={onTrade} className="text-left">
          <div className="flex items-center gap-1">
            <span className="text-[14px] font-semibold text-foreground leading-tight">{m.base}</span>
            <span className="text-[12px] text-muted-foreground font-normal">/{m.quote}</span>
            {m.type === "futures" && (
              <span className="ml-1 text-[9px] font-bold text-green-400 bg-green-500/15 px-1 py-0.5 rounded border border-green-500/25">PERP</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 font-medium leading-none">
            <span>Vol {fmtShort(m.vol)}</span>
            {m.cap > 0 && (
              <>
                <span className="opacity-30">·</span>
                <span>Cap {fmtShort(m.cap)}</span>
              </>
            )}
          </div>
        </button>
        <ContractAddressBadge baseAsset={m.base} variant="inline" className="mt-[1px]" />
      </div>

      <button onClick={onTrade} className="text-right pr-3 w-36 shrink-0">
        <span className="text-[14px] font-semibold text-foreground tabular-nums leading-tight block">
          {currSym}{fmt(displayPrice)}
        </span>
        <span className="flex flex-col items-end gap-0 mt-[2px]">
          <span className="text-[9px] text-orange-400 tabular-nums leading-none font-medium">
            {isBTCBase ? "1 BTC" : `₿ ${fmtCross(priceBTC, 8)}`}
          </span>
          <span className="text-[9px] text-yellow-400 tabular-nums leading-none font-medium mt-[1px]">
            {isBSVBase ? "1 BSV" : `⚡ ${fmtCross(priceBSV, 4)}`}
          </span>
        </span>
      </button>

      <button
        onClick={onBuy}
        className={cn(
          "px-2 py-[3px] rounded-md flex items-center justify-center shrink-0 tabular-nums",
          isUp
            ? "bg-green-500/15 text-green-400 border border-green-500/30"
            : "bg-red-500/15 text-red-400 border border-red-500/30"
        )}
      >
        <span className="text-[11px] font-bold leading-none">
          {isUp ? "+" : ""}{m.chg.toFixed(2)}%
        </span>
      </button>
    </div>
  );
}
