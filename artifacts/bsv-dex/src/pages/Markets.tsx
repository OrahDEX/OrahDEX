import { useState, useEffect, useRef, useMemo } from "react";
import { CoinLogo } from "@/components/CoinLogo";
import { useStagedMarkets as useGetMarkets, useMarketSearch } from "@/hooks/useStagedMarkets";
import { useSEO } from "@/hooks/useSEO";
import {
  USDT_MARKETS, USDC_MARKETS, TUSD_MARKETS, USDD_MARKETS,
  BSV_MARKETS, BTC_MARKETS, ETH_MARKETS, BCH_MARKETS, BNB_MARKETS,
  MATIC_MARKETS, AVAX_MARKETS, ARB_MARKETS, OP_MARKETS, FTM_MARKETS, CRO_MARKETS,
  BASE_MARKETS, LINEA_MARKETS, ZK_MARKETS, SCR_MARKETS, MNT_MARKETS,
  AI_MARKETS, SOL_MARKETS, MEME_MARKETS, DEFI_MARKETS, NEW_MARKETS,
  FUTURES_MARKETS,
  GAMING_MARKETS, COSMOS_MARKETS,
  RWA_MARKETS, EXCHANGE_MARKETS, DEPIN_MARKETS, BRC20_MARKETS,
  UNISWAP_MARKETS, PANCAKE_MARKETS,
} from "@/lib/mock-data";
import { formatPrice, formatVolume, cn } from "@/lib/utils";
import { hasCategory } from "@/lib/market-categories";
import { ContractAddressBadge } from "@/components/ContractAddressBadge";
import { Search, Star, ArrowRightLeft, Zap, TrendingUp, Wallet, X, ChevronLeft, ChevronRight, BarChart2, ExternalLink, Info, Globe } from "lucide-react";
import { useLocation } from "wouter";
import { useWalletStore } from "@/store/useWalletStore";
import { getWalletMarketTab } from "@/lib/walletMarket";
import { AiInsightsBar } from "@/components/AiInsightsBar";
import { useSettingsStore, convertFromUsd, getCurrencySymbol, FIAT_CURRENCIES } from "@/store/useSettingsStore";
import { useWalletPrices } from "@/hooks/useWalletPrices";
import { useLetsExchangePairs } from "@/hooks/useLetsExchangePairs";
import { getCoinInfo, getTagColor } from "@/lib/coinInfo";
import { useGeckoTerminalPools } from "@/hooks/useGeckoTerminalPools";
import { useBaseTokenList } from "@/hooks/useBaseTokenList";
import { useBaseTokenPrices } from "@/hooks/useBaseTokenPrices";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Normalised market row — all fields present after `normalise()` */
interface MarketRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  lastPrice: string | number;
  priceChangePercent24h: string | number;
  high24h?: string | number;
  low24h?: string | number;
  volume24h?: string | number;
  marketCap?: string | number;
  type?: string;
  name?: string;
  contractAddresses?: Record<string, string>;
  [key: string]: unknown;
}

type UsdSub = "USDT" | "USDC" | "TUSD" | "USDD";
type Tab = "favorites" | "new" | "usd" | "btc" | "eth" | "bnb" | "matic" | "avax" | "arb" | "op" | "ftm" | "cro" | "base" | "linea" | "zk" | "scr" | "mnt" | "bch" | "bsv" | "sol" | "ai" | "meme" | "defi" | "uniswap" | "pancake" | "futures" | "gaming" | "cosmos" | "rwa" | "exchange" | "depin" | "brc20";

const USD_SUBS: { id: UsdSub; label: string }[] = [
  { id: "USDT", label: "USDT" },
  { id: "USDC", label: "USDC" },
  { id: "TUSD", label: "TUSD" },
  { id: "USDD", label: "USDD" },
];


interface TabMeta { id: Tab; label: string; color: string; desc: string }
const TAB_META: TabMeta[] = [
  { id: "favorites", label: "★ Favorites", color: "text-green-400",   desc: "Your starred pairs" },
  { id: "new",       label: "NEW",          color: "text-green-400",   desc: "Recently listed" },
  { id: "usd",       label: "USD",          color: "text-blue-400",    desc: "Stablecoin markets" },
  { id: "btc",       label: "BTC",          color: "text-orange-400",  desc: "All pairs quoted in BTC" },
  { id: "bsv",       label: "BSV",          color: "text-green-400",   desc: "All pairs quoted in BSV · On-chain settlement" },
  { id: "eth",       label: "ETH",          color: "text-violet-400",  desc: "All pairs quoted in ETH" },
  { id: "bnb",       label: "BNB",          color: "text-green-400",  desc: "All pairs quoted in BNB · BSC" },
  { id: "matic",     label: "MATIC",        color: "text-purple-400",  desc: "All pairs quoted in MATIC · Polygon" },
  { id: "avax",      label: "AVAX",         color: "text-red-400",     desc: "All pairs quoted in AVAX · Avalanche" },
  { id: "arb",       label: "ARB",          color: "text-sky-400",     desc: "All pairs quoted in ARB · Arbitrum" },
  { id: "op",        label: "OP",           color: "text-red-400",     desc: "All pairs quoted in OP · Optimism" },
  { id: "ftm",       label: "FTM",          color: "text-blue-400",    desc: "All pairs quoted in FTM · Fantom" },
  { id: "cro",       label: "CRO",          color: "text-indigo-400",  desc: "All pairs quoted in CRO · Cronos" },
  { id: "base",      label: "BASE",         color: "text-blue-400",    desc: "Curated Base L2 pairs · Live prices via DexScreener" },
  { id: "linea",     label: "LINEA",        color: "text-violet-400",  desc: "All pairs quoted in LINEA · MetaMask L2" },
  { id: "zk",        label: "ZK",           color: "text-indigo-300",  desc: "All pairs quoted in ZK · zkSync Era" },
  { id: "scr",       label: "SCROLL",       color: "text-orange-300",  desc: "All pairs quoted in SCR · Scroll L2" },
  { id: "mnt",       label: "MNT",          color: "text-teal-400",    desc: "All pairs quoted in MNT · Mantle L2" },
  { id: "sol",       label: "SOL",          color: "text-purple-400",  desc: "All pairs quoted in SOL · Solana" },
  { id: "bch",       label: "BCH",          color: "text-green-400",   desc: "All pairs quoted in Bitcoin Cash" },
  { id: "ai",        label: "AI",           color: "text-cyan-400",    desc: "Artificial Intelligence tokens" },
  { id: "depin",     label: "DePIN",        color: "text-teal-400",    desc: "Decentralized Physical Infrastructure · compute, storage, wireless" },
  { id: "meme",      label: "MEME",         color: "text-pink-400",    desc: "Meme tokens" },
  { id: "defi",      label: "DEFI",         color: "text-emerald-400", desc: "DeFi protocols · DEXs, lending, yield" },
  { id: "uniswap",   label: "AMM V3",       color: "text-pink-400",    desc: "Concentrated liquidity AMM pools · Ethereum + multi-chain" },
  { id: "pancake",   label: "BNB DEX",      color: "text-yellow-400",  desc: "BNB Smart Chain DEX pools + multi-chain" },
  { id: "gaming",    label: "GAMING",       color: "text-violet-400",  desc: "Gaming & Metaverse · P2E, NFT games, virtual worlds" },
  { id: "cosmos",    label: "COSMOS",       color: "text-purple-400",  desc: "Cosmos IBC ecosystem · app-chains, DEXs, data availability" },
  { id: "rwa",       label: "RWA",          color: "text-yellow-400",  desc: "Real World Assets · tokenized gold, T-bills, real estate" },
  { id: "exchange",  label: "EXCHANGE",     color: "text-orange-400",  desc: "Exchange tokens · CEX utility & governance tokens" },
  { id: "brc20",     label: "BRC-20",       color: "text-orange-400",  desc: "BRC-20 tokens & Bitcoin Ordinals · on-chain Bitcoin assets" },
  { id: "futures",   label: "Futures",      color: "text-red-400",     desc: "Perpetual futures · Up to 100× leverage" },
];

function normalise(m: any): any {
  const base  = m.baseAsset  ?? m.base  ?? m.symbol?.split(/[-/]/)[0] ?? "";
  const quote = m.quoteAsset ?? m.quote ?? "USDT";
  const price = parseFloat(m.lastPrice ?? m.price) || 0;
  const chg   = parseFloat(m.priceChangePercent24h ?? m.priceChangePercent ?? m.change) || 0;
  const vol   = parseFloat(m.volume24h ?? m.volume) || 0;
  const type  = m.type ?? (m.symbol?.includes("PERP") ? "futures" : "spot");
  return { ...m, symbol: m.symbol ?? `${base}-${quote}`, baseAsset: base, quoteAsset: quote,
    lastPrice: price, priceChangePercent24h: chg, volume24h: vol, type };
}


const STABLE_MOCK: Record<UsdSub, any[]> = {
  USDT: USDT_MARKETS, USDC: USDC_MARKETS, TUSD: TUSD_MARKETS, USDD: USDD_MARKETS,
};

const ALL_MOCK = () => [
  ...USDT_MARKETS, ...USDC_MARKETS, ...TUSD_MARKETS, ...USDD_MARKETS,
  ...BSV_MARKETS, ...BTC_MARKETS, ...ETH_MARKETS, ...BCH_MARKETS,
  ...AI_MARKETS, ...DEPIN_MARKETS, ...MEME_MARKETS, ...DEFI_MARKETS,
  ...UNISWAP_MARKETS, ...PANCAKE_MARKETS,
  ...BASE_MARKETS,
  ...GAMING_MARKETS, ...COSMOS_MARKETS,
  ...RWA_MARKETS, ...EXCHANGE_MARKETS, ...BRC20_MARKETS,
].map(normalise);

export function Markets() {
  useSEO({
    title: "Crypto Markets — 500+ Trading Pairs · Every Coin",
    description: "Trade every cryptocurrency on OrahDEX — 500+ spot pairs across BTC, ETH, SOL, all Layer 1s, Layer 2s, DeFi, Gaming, Cosmos, AI/DePIN, Meme, RWA, BRC-20 & more. Live prices from CoinGecko.",
    keywords: "crypto markets, bitcoin price, ethereum price, BSV price, live crypto prices, spot trading pairs, OrahDEX markets",
    url: "/",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": "OrahDEX Cryptocurrency Markets",
      "description": "Live cryptocurrency trading pairs on OrahDEX",
      "url": "https://orahdex.org/"
    }
  });

  const { address, network, chainId } = useWalletStore();
  const [tab, setTab] = useState<Tab>("usd");
  const [usdSub, setUsdSub] = useState<UsdSub>("USDT");
  const [search, setSearch] = useState("");
  const [stars, setStars] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("market_favorites");
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const [walletBannerDismissed, setWalletBannerDismissed] = useState(false);
  const [selectedCoin, setSelectedCoin] = useState<MarketRow | null>(null);
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [tabCanScrollLeft, setTabCanScrollLeft] = useState(false);
  const [tabCanScrollRight, setTabCanScrollRight] = useState(true);

  function updateTabScrollState() {
    const el = tabScrollRef.current;
    if (!el) return;
    setTabCanScrollLeft(el.scrollLeft > 4);
    setTabCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }

  function scrollTabsBy(delta: number) {
    const el = tabScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: delta, behavior: "smooth" });
    setTimeout(updateTabScrollState, 350);
  }

  /* Initialize tab scroll state after mount */
  useEffect(() => {
    updateTabScrollState();
    const el = tabScrollRef.current;
    if (!el) return;
    const onResize = () => updateTabScrollState();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const showWalletBanner = false;
  const walletChainLabel = "";

  const [, navigate] = useLocation();

  const handleTrade = (href: string) => {
    navigate(href);
  };

  const { data: apiMarkets } = useGetMarkets({ query: { refetchInterval: 30_000, staleTime: 25_000 } as any });
  const raw = ((apiMarkets && (apiMarkets as any[]).length > 0 ? apiMarkets : []) as any[]).map(normalise);
  const { results: serverSearchResults } = useMarketSearch(search, { debounceMs: 300 });

  // LE "all" pairs — only needed for SOL tab, Favorites, or when searching
  const needAllPairs = tab === "sol" || tab === "eth" || tab === "favorites" || search.length > 0;
  const { pairs: rawLeAllPairs } = useLetsExchangePairs({ all: true, enabled: needAllPairs });
  const leAllPairs = useMemo(() => {
    const mapped = (rawLeAllPairs ?? []).map(p => ({
      ...normalise({
        symbol:               p.symbol,
        baseAsset:            p.baseAsset,
        quoteAsset:           p.quoteAsset,
        lastPrice:            p.lastPrice,
        priceChangePercent24h: p.priceChangePercent24h,
        volume24h:            p.volume,
        type:                 "spot",
      }),
      network: (p as any).network ?? null,
    })).filter(m => m.lastPrice > 0);
    // LE lists the same coin on multiple chains — keep one per base:quote (best price)
    const best = new Map<string, typeof mapped[0]>();
    for (const m of mapped) {
      const key = `${m.baseAsset}:${m.quoteAsset}`;
      const ex = best.get(key);
      if (!ex || m.lastPrice > ex.lastPrice) best.set(key, m);
    }
    return [...best.values()];
  }, [rawLeAllPairs]);

  // LE BSV-quoted pairs — only needed for BSV tab
  const { pairs: rawLePairs } = useLetsExchangePairs({ quote: "BSV", enabled: tab === "bsv" });
  const leBsvPairs = useMemo(() => {
    const all = (rawLePairs ?? []).map(p => normalise({
      symbol:               p.symbol,
      baseAsset:            p.baseAsset,
      quoteAsset:           p.quoteAsset,
      lastPrice:            p.lastPrice,
      priceChangePercent24h: p.priceChangePercent24h,
      volume24h:            p.volume,
      type:                 "spot",
    })).filter(m => m.lastPrice > 0);
    const best = new Map<string, typeof all[0]>();
    for (const m of all) { const ex = best.get(m.baseAsset); if (!ex || m.lastPrice > ex.lastPrice) best.set(m.baseAsset, m); }
    return [...best.values()];
  }, [rawLePairs]);

  // LE BTC-quoted pairs — only needed for BTC tab
  const { pairs: rawLeBtcPairs } = useLetsExchangePairs({ quote: "BTC", enabled: tab === "btc" });
  const leBtcPairs = useMemo(() => {
    const all = (rawLeBtcPairs ?? []).map(p => normalise({
      symbol:               p.symbol,
      baseAsset:            p.baseAsset,
      quoteAsset:           p.quoteAsset,
      lastPrice:            p.lastPrice,
      priceChangePercent24h: p.priceChangePercent24h,
      volume24h:            p.volume,
      type:                 "spot",
    })).filter(m => m.lastPrice > 0);
    const best = new Map<string, typeof all[0]>();
    for (const m of all) { const ex = best.get(m.baseAsset); if (!ex || m.lastPrice > ex.lastPrice) best.set(m.baseAsset, m); }
    return [...best.values()];
  }, [rawLeBtcPairs],
  );

  /**
   * Build a symbol → live-price map from the API response.
   * Mock data always provides the FULL pair list; API prices enrich it.
   */
  const livePrice = new Map<string, any>(raw.map((m: any) => [m.symbol, m]));

  // Live on-chain data from GeckoTerminal (chain/category tabs, cached 90s)
  const { data: geckoRows } = useGeckoTerminalPools(tab);
  // Full Base chain token catalog from CoinGecko (base tab only, cached 1h)
  const { data: baseTokenList } = useBaseTokenList(tab === "base");
  // DexScreener prices for catalog tokens not covered by GeckoTerminal (cached 60s)
  const basePrices = useBaseTokenPrices(baseTokenList, tab === "base" && baseTokenList.length > 0);

  /** Enrich a mock pair list with live prices from the API where available. */
  const enrich = (mock: any[]): any[] =>
    mock.map(m => {
      const live = livePrice.get(m.symbol);
      if (!live) return m;
      return { ...m, lastPrice: live.lastPrice, priceChangePercent24h: live.priceChangePercent24h, volume24h: live.volume24h, marketCap: live.marketCap ?? m.marketCap };
    });

  /** Live markets from API grouped by quote asset (for full pair display). */
  const liveByQuote = (quote: string) => {
    const live = raw.filter(m => m.quoteAsset === quote && m.type !== "futures");
    return live.length > 0 ? live : null;
  };
  const liveBsv   = liveByQuote("BSV");
  const liveBtc   = liveByQuote("BTC");
  const liveEth   = liveByQuote("ETH");
  const liveBnb   = liveByQuote("BNB");
  const liveBch   = liveByQuote("BCH");
  const liveMatic = liveByQuote("MATIC");
  const liveAvax  = liveByQuote("AVAX");
  const liveArb   = liveByQuote("ARB");
  const liveOp    = liveByQuote("OP");
  const liveFtm   = liveByQuote("FTM");
  const liveCro   = liveByQuote("CRO");

  /** Only show pairs that are in the DB and have a real price (tradeable) */
  const tradeable = (arr: any[]) =>
    arr.filter(m => parseFloat(m.lastPrice || "0") > 0);

  /** Get all live pairs for a quote asset — DB-only, no mock fallback */
  const dbByQuote = (quote: string) =>
    tradeable(raw.filter(m => m.quoteAsset === quote && m.type !== "futures"));

  /** For protocol tabs: cross-reference mock list with DB pairs so only real DB pairs show */
  const dbBySymbols = (mockList: any[]) => {
    const symbols = new Set(mockList.map((m: any) => m.symbol ?? `${m.baseAsset}/${m.quoteAsset}`));
    return tradeable(raw.filter(m => symbols.has(m.symbol)));
  };

  /**
   * For themed category tabs: use the live category map so every DB pair
   * whose base asset belongs to `tag` is shown automatically.
   * Prefer USDT pairs; if a base asset only has other quotes those show too.
   */
  const dbByCategory = (tag: string) => {
    const inCategory = raw.filter(m => m.type !== "futures" && hasCategory(m.baseAsset, tag));
    if (inCategory.length === 0) return [];
    // Group by base asset and pick the best quote in priority order
    const priority = ["USDT","USDC","TUSD","USDD","BTC","ETH","BSV","BNB"];
    const byBase = new Map<string, any>();
    for (const m of inCategory) {
      const existing = byBase.get(m.baseAsset);
      if (!existing) { byBase.set(m.baseAsset, m); continue; }
      const ePri = priority.indexOf(existing.quoteAsset);
      const mPri = priority.indexOf(m.quoteAsset);
      const eIdx = ePri === -1 ? 999 : ePri;
      const mIdx = mPri === -1 ? 999 : mPri;
      if (mIdx < eIdx) byBase.set(m.baseAsset, m);
    }
    return tradeable([...byBase.values()]);
  };

  function getMarkets(): any[] {
    switch (tab) {
      case "favorites":
        return tradeable(raw.filter(m => stars.has(m.symbol)));
      case "new":
        // NEW_MARKETS defines symbols; cross-reference with live DB data
        return dbBySymbols(NEW_MARKETS.map(normalise));
      case "usd":
        return dbByQuote(usdSub);
      case "bsv": {
        const dbBsv = dbByQuote("BSV");
        const dbSymbols = new Set(dbBsv.map((m: any) => m.symbol));
        const dbBases = new Set(dbBsv.map((m: any) => m.baseAsset));
        const leOnly = leBsvPairs.filter(m => !dbSymbols.has(m.symbol) && !dbBases.has(m.baseAsset));
        return [...dbBsv, ...leOnly];
      }
      case "btc": {
        const dbBtc = dbByQuote("BTC");
        const dbBtcSymbols = new Set(dbBtc.map((m: any) => m.symbol));
        const dbBtcBases = new Set(dbBtc.map((m: any) => m.baseAsset));
        const leOnlyBtc = leBtcPairs.filter(m => !dbBtcSymbols.has(m.symbol) && !dbBtcBases.has(m.baseAsset));
        return [...dbBtc, ...leOnlyBtc];
      }
      case "eth": {
        const dbEth = dbByQuote("ETH");
        const dbBases = new Set(dbEth.map((m: any) => m.baseAsset));
        const baseKw = ["base", "base-mainnet"];
        const baseLeByBase = new Map<string, any>();
        for (const m of leAllPairs) {
          const net = String((m as any).network ?? "").toLowerCase();
          if (!baseKw.some(kw => net.includes(kw))) continue;
          if (dbBases.has(m.baseAsset)) continue;
          const ex = baseLeByBase.get(m.baseAsset);
          if (!ex || m.lastPrice > ex.lastPrice) baseLeByBase.set(m.baseAsset, m);
        }
        return [...dbEth, ...baseLeByBase.values()];
      }
      case "bnb":     return dbByQuote("BNB");
      case "matic":   return dbByQuote("MATIC");
      case "avax":    return dbByQuote("AVAX");
      case "arb":     return dbByQuote("ARB");
      case "op":      return dbByQuote("OP");
      case "ftm":     return dbByQuote("FTM");
      case "cro":     return dbByQuote("CRO");
      case "base": {
        let all = enrich(BASE_MARKETS.map(normalise));
        // Gecko merge: update prices + append priced tokens not in the static list
        if (geckoRows.length) {
          const geckoByBase = new Map(geckoRows.map((g: any) => [g.base, g]));
          const updated = all.map((r: any) => { const g = geckoByBase.get(r.baseAsset); return g && g.price > 0 ? { ...r, lastPrice: g.price, priceChangePercent24h: g.chg } : r; });
          const existingBases = new Set(updated.map((r: any) => r.baseAsset));
          const extra = geckoRows.filter((g: any) => !existingBases.has(g.base) && g.price > 0).map((g: any) => normalise({ symbol: g.symbol, baseAsset: g.base, quoteAsset: g.quote, lastPrice: g.price, priceChangePercent24h: g.chg, volume24h: g.vol, type: "spot" }));
          all = [...updated, ...extra];
        }
        // Base token list: append all ~2300 Base chain catalog tokens not already shown
        if (baseTokenList.length) {
          const existingBases = new Set(all.map((r: any) => r.baseAsset));
          const listExtra = baseTokenList
            .filter(t => !existingBases.has(t.symbol))
            .map(t => {
              const dp = basePrices.get(t.symbol);
              return normalise({ symbol: `${t.symbol}/USDC`, baseAsset: t.symbol, quoteAsset: "USDC", lastPrice: dp?.price ?? 0, priceChangePercent24h: dp?.chg ?? 0, volume24h: dp?.vol ?? 0, type: "spot" });
            });
          all = [...all, ...listExtra];
        }
        return all;
      }
      case "linea":   return dbByQuote("LINEA");
      case "zk":      return dbByQuote("ZK");
      case "scr":     return dbByQuote("SCR");
      case "mnt":     return dbByQuote("MNT");
      case "bch":     return dbByQuote("BCH");
      case "sol": {
        const dbSol = dbByCategory("sol_eco");
        const leSolPairs = leAllPairs.filter(m => {
          const net = String((m as any).network ?? "").toLowerCase();
          return net.includes("sol");
        });
        const dbBases = new Set(dbSol.map((m: any) => m.baseAsset));
        // Dedup within leSolPairs too — same coin on multiple SOL-related networks
        const leSolByBase = new Map<string, typeof leSolPairs[0]>();
        for (const m of leSolPairs) {
          if (dbBases.has(m.baseAsset)) continue;
          const ex = leSolByBase.get(m.baseAsset);
          if (!ex || m.lastPrice > ex.lastPrice) leSolByBase.set(m.baseAsset, m);
        }
        return [...dbSol, ...leSolByBase.values()];
      }
      case "ai":      return dbByCategory("ai");
      case "depin":   return dbByCategory("depin");
      case "meme":    return dbByCategory("meme");
      case "defi":    return dbByCategory("defi");
      case "uniswap": return dbBySymbols(UNISWAP_MARKETS.map(normalise));
      case "pancake": return dbBySymbols(PANCAKE_MARKETS.map(normalise));
      case "gaming":  return dbByCategory("gaming");
      case "cosmos":  return dbByCategory("cosmos");
      case "rwa":     return dbByCategory("rwa");
      case "exchange":return dbByCategory("exchange");
      case "brc20":   return dbByCategory("brc20");
      case "futures": return tradeable(raw.filter(m => m.type === "futures"));
      default:        return [];
    }
  }

  function tabCount(t: Tab): number {
    const dbQ  = (q: string) => tradeable(raw.filter(m => m.quoteAsset === q && m.type !== "futures")).length;
    const dbS  = (list: any[]) => dbBySymbols(list.map(normalise)).length;
    switch (t) {
      case "favorites": return tradeable(raw.filter(m => stars.has(m.symbol))).length;
      case "new":       return dbBySymbols(NEW_MARKETS.map(normalise)).length;
      case "usd":       return dbQ(usdSub);
      case "bsv": {
        const c = dbQ("BSV");
        const dbBases = new Set(tradeable(raw.filter((m:any)=>m.quoteAsset==="BSV")).map((m:any)=>m.baseAsset));
        return c + leBsvPairs.filter(m => !dbBases.has(m.baseAsset)).length;
      }
      case "btc": {
        const c = dbQ("BTC");
        const dbBtcBases = new Set(tradeable(raw.filter((m:any)=>m.quoteAsset==="BTC")).map((m:any)=>m.baseAsset));
        return c + leBtcPairs.filter(m => !dbBtcBases.has(m.baseAsset)).length;
      }
      case "eth":       return dbQ("ETH");
      case "bnb":       return dbQ("BNB");
      case "matic":     return dbQ("MATIC");
      case "avax":      return dbQ("AVAX");
      case "arb":       return dbQ("ARB");
      case "op":        return dbQ("OP");
      case "ftm":       return dbQ("FTM");
      case "cro":       return dbQ("CRO");
      case "base":      return dbS(BASE_MARKETS);
      case "linea":     return dbQ("LINEA");
      case "zk":        return dbQ("ZK");
      case "scr":       return dbQ("SCR");
      case "mnt":       return dbQ("MNT");
      case "bch":       return dbQ("BCH");
      case "sol": {
        const dbSolC = dbByCategory("sol_eco");
        const leSolC = leAllPairs.filter(m => {
          const net = String((m as any).network ?? "").toLowerCase();
          return net.includes("sol");
        });
        const dbBasesC = new Set(dbSolC.map((m: any) => m.baseAsset));
        return dbSolC.length + leSolC.filter(m => !dbBasesC.has(m.baseAsset)).length;
      }
      case "ai":        return dbByCategory("ai").length;
      case "depin":     return dbByCategory("depin").length;
      case "meme":      return dbByCategory("meme").length;
      case "defi":      return dbByCategory("defi").length;
      case "uniswap":   return dbS(UNISWAP_MARKETS);
      case "pancake":   return dbS(PANCAKE_MARKETS);
      case "gaming":    return dbByCategory("gaming").length;
      case "cosmos":    return dbByCategory("cosmos").length;
      case "rwa":       return dbByCategory("rwa").length;
      case "exchange":  return dbByCategory("exchange").length;
      case "brc20":     return dbByCategory("brc20").length;
      case "futures":   return tradeable(raw.filter(m => m.type === "futures")).length;
      default:          return 0;
    }
  }

  const markets  = getMarkets();
  const searchPool = search
    ? [...tradeable(raw), ...leAllPairs.filter(m => !raw.some((r: any) => r.symbol === m.symbol))]
    : markets;
  const _localFiltered = searchPool.filter(m =>
    m.symbol.toLowerCase().includes(search.toLowerCase()) ||
    (m.baseAsset ?? "").toLowerCase().includes(search.toLowerCase())
  );
  const _localSymbols = new Set(_localFiltered.map((m: any) => m.symbol));
  const filtered = search
    ? [
        ..._localFiltered,
        ...serverSearchResults
          .filter((m: any) => !_localSymbols.has(m.symbol))
          .map((m: any) => normalise(m)),
      ]
    : _localFiltered;
  const toggleStar = (symbol: string) =>
    setStars(prev => {
      const n = new Set(prev);
      n.has(symbol) ? n.delete(symbol) : n.add(symbol);
      try { localStorage.setItem("market_favorites", JSON.stringify([...n])); } catch {}
      return n;
    });

  const { quoteCurrency } = useSettingsStore();
  const isFiatTarget = FIAT_CURRENCIES.some(c => c.code === quoteCurrency);
  const isCryptoQuoteCurrency = ["BTC","ETH","BNB","SOL","BSV"].includes(quoteCurrency);
  const qSym = getCurrencySymbol(quoteCurrency);

  /* ── Cross-rate: BTC price & BSV price for every row ── */
  const { prices: liveCrossRates } = useWalletPrices();
  const BTC_USD = liveCrossRates.BTC.usd || 83000;
  const BSV_USD = liveCrossRates.BSV.usd || 14;
  const ETH_USD = liveCrossRates.ETH.usd || 2400;

  const QUOTE_USD: Record<string, number> = {
    USDT: 1, USDC: 1, TUSD: 1, USDD: 1, FDUSD: 1,
    BTC: BTC_USD, ETH: ETH_USD, BSV: BSV_USD,
    BNB: 580, BCH: 320, SOL: 130, MATIC: 0.32,
    AVAX: 18, ARB: 0.42, OP: 0.70, FTM: 0.51,
    CRO: 0.085, TRX: 0.24, DOT: 6.8, ATOM: 4.2,
    NEAR: 2.4, SUI: 2.2, APT: 5.0, INJ: 16,
    XRP: 0.52, ADA: 0.44, DOGE: 0.12, LINK: 14.5,
    UNI: 6.2, SAND: 0.25, MANA: 0.25,
  };

  function toUSD(price: number, quoteAsset: string): number {
    return price * (QUOTE_USD[quoteAsset] ?? 1);
  }

  function fmtBTC(usd: number): string {
    if (!usd) return "—";
    const v = usd / BTC_USD;
    if (v >= 1)      return v.toFixed(4);
    if (v >= 0.001)  return v.toFixed(6);
    return v.toFixed(8);
  }

  function fmtBSV(usd: number): string {
    if (!usd) return "—";
    const v = usd / BSV_USD;
    if (v >= 1000)  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (v >= 1)     return v.toFixed(4);
    if (v >= 0.001) return v.toFixed(6);
    return v.toFixed(8);
  }

  const meta = TAB_META.find(t => t.id === tab)!;
  const isCrossQuote = ["bsv","btc","eth","bnb","matic","avax","arb","op","ftm","cro","bch"].includes(tab);
  // Apply fiat/crypto conversion only for USD-quoted tabs (not cross-rate tabs)
  const applyQConversion = !isCrossQuote && (isFiatTarget || isCryptoQuoteCurrency) && quoteCurrency !== "USDT" && quoteCurrency !== "USDC";

  function qPrice(p: number): string {
    if (!p) return "—";
    if (!applyQConversion) return formatPrice(p);
    const c = convertFromUsd(p, quoteCurrency);
    if (c >= 10000) return c.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (c >= 1)     return c.toFixed(2);
    if (c >= 0.01)  return c.toFixed(4);
    if (c >= 0.0001) return c.toFixed(6);
    return c.toFixed(8);
  }

  return (
    <div className="flex flex-col h-full">
      {/* AI Insights banner */}
      <AiInsightsBar />

      {/* Header */}
      <div className="px-3 md:px-5 pt-0 pb-3 border-b border-border bg-card/40">
          {/* Main tabs — slim Poloniex-style with desktop scroll arrows */}
          <div className="mt-2 relative flex items-center gap-0">
            {/* Left arrow — desktop only */}
            <button
              onClick={() => scrollTabsBy(-240)}
              className={cn(
                "hidden md:flex shrink-0 items-center justify-center w-6 h-6 rounded-md border border-border/60 bg-card/80 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/10 transition-all mr-1",
                !tabCanScrollLeft && "opacity-30 pointer-events-none"
              )}
              aria-label="Scroll tabs left"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>

            {/* Scrollable tab row */}
            <div
              ref={tabScrollRef}
              onScroll={updateTabScrollState}
              className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-hide flex-1"
            >
              {TAB_META.map(t => {
                const isBsv    = t.id === "bsv";
                const isFav    = t.id === "favorites";
                const isUsd    = t.id === "usd";
                const isActive = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => { setTab(t.id); setSearch(""); }}
                    style={isBsv && !isActive ? { animation: "bsv-glow 2.5s ease-in-out infinite" } : undefined}
                    className={cn(
                      "shrink-0 flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold transition-all border",
                      isActive && isFav
                        ? "bg-green-500 text-black border-green-400 shadow shadow-green-500/30"
                        : isActive && isBsv
                        ? "bg-green-500 text-black border-green-400 shadow shadow-green-500/30"
                        : isActive && isUsd
                        ? "bg-primary text-primary-foreground border-primary shadow shadow-primary/20"
                        : isActive
                        ? "bg-primary/90 text-primary-foreground border-primary shadow shadow-primary/20"
                        : isFav
                        ? "text-green-400 border-green-500/40 bg-green-500/8 hover:bg-green-500/15"
                        : isBsv
                        ? "text-green-400 border-green-500/40 bg-green-500/8 hover:bg-green-500/15"
                        : "text-muted-foreground border-border/50 hover:border-primary/30 hover:text-foreground hover:bg-white/5"
                    )}
                  >
                    {isBsv && <span className="text-[11px] leading-none">⚡</span>}
                    {isFav && <Star className="w-2.5 h-2.5" />}
                    <span>{isFav ? "Favorites" : t.label}</span>
                    <span className={cn(
                      "text-[9px] font-black px-1 py-px rounded min-w-[16px] text-center",
                      (isActive && (isFav || isBsv)) ? "bg-black/20 text-black"
                      : isActive ? "bg-white/20 text-white"
                      : isFav || isBsv ? "bg-green-500/20 text-green-300"
                      : "bg-white/8 text-muted-foreground"
                    )}>
                      {tabCount(t.id)}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Right arrow — desktop only */}
            <button
              onClick={() => scrollTabsBy(240)}
              className={cn(
                "hidden md:flex shrink-0 items-center justify-center w-6 h-6 rounded-md border border-border/60 bg-card/80 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/10 transition-all mx-1",
                !tabCanScrollRight && "opacity-30 pointer-events-none"
              )}
              aria-label="Scroll tabs right"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            {/* Search — inline with tab row on desktop */}
            <div className="relative hidden md:block shrink-0 ml-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder={`Search ${tab === "usd" ? usdSub : meta.label} pairs…`}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
                className="w-44 bg-background border border-border rounded-lg pl-8 pr-3 py-1 text-xs focus:outline-none focus:border-primary focus:w-56 transition-all"
              />
            </div>
          </div>

          {/* Sub-rows: USD sub-tabs and mobile search */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {tab === "usd" && (
              <>
                {USD_SUBS.map(s => (
                  <button
                    key={s.id}
                    onClick={() => setUsdSub(s.id)}
                    className={cn(
                      "px-3 py-1 rounded-md text-xs font-bold border transition-all",
                      usdSub === s.id
                        ? "bg-blue-500/20 text-blue-400 border-blue-500/40"
                        : "text-muted-foreground border-border hover:text-foreground hover:bg-white/5"
                    )}
                  >
                    {s.label}
                  </button>
                ))}
                <span className="text-xs text-muted-foreground">· {tabCount("usd")} pairs</span>
              </>
            )}
            {tab !== "usd" && (
              <span className="text-xs text-muted-foreground">
                <span className={meta.color}>{filtered.length}</span> {meta.desc.split("·")[0].trim()} pairs
              </span>
            )}
            {/* Mobile search */}
            <div className="relative md:hidden ml-auto">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && e.preventDefault()}
                className="w-36 bg-background border border-border rounded-lg pl-8 pr-3 py-1 text-xs focus:outline-none focus:border-primary transition-all"
              />
            </div>
          </div>

          {/* Conditional notice banners */}
          {showWalletBanner && (
            <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/30 rounded-xl">
              <Wallet className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="text-xs font-semibold text-primary flex-1 min-w-0">Showing {walletChainLabel} Markets</span>
              <button onClick={() => setWalletBannerDismissed(true)} className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {tab === "bsv" && (
            <div className="mt-2 flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/30 rounded-xl">
              <span className="text-base leading-none">⚡</span>
              <span className="text-xs font-bold text-green-400">BSV — World's Fastest Settlement</span>
              <span className="text-[11px] text-green-300/60 hidden sm:inline">· &lt;5s · ~$0.001 fee</span>
            </div>
          )}
          {tab === "base" && (
            <div className="mt-2 flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 border border-blue-500/30 rounded-xl">
              <span className="text-base leading-none">🔵</span>
              <span className="text-xs font-bold text-blue-400">Base L2 — 2300+ Tokens · Live Prices via DexScreener</span>
            </div>
          )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <div className="px-3 md:px-5 py-3">
          <div className="bg-card border border-border rounded-2xl shadow-lg overflow-x-auto">
            <table className="w-full min-w-[820px] text-left border-collapse">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                  <th className="px-3 py-2.5 w-8"></th>
                  <th className="px-3 py-2.5">#</th>
                  <th className="px-3 py-2.5">Pair</th>
                  <th className="px-3 py-2.5 text-right">Price</th>
                  <th className="px-3 py-2.5 text-right">24h %</th>
                  <th className="px-3 py-2.5 text-right hidden lg:table-cell">
                    <span className="flex items-center justify-end gap-1">
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{background:"#F97316"}} />
                      BTC Price
                    </span>
                  </th>
                  <th className="px-3 py-2.5 text-right hidden lg:table-cell">
                    <span className="flex items-center justify-end gap-1">
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{background:"#EAB308"}} />
                      BSV Price
                    </span>
                  </th>
                  <th className="px-3 py-2.5 text-right hidden xl:table-cell">24h High</th>
                  <th className="px-3 py-2.5 text-right hidden xl:table-cell">24h Low</th>
                  <th className="px-3 py-2.5 text-right hidden lg:table-cell">Volume 24h</th>
                  <th className="px-3 py-2.5 text-right hidden xl:table-cell">Market Cap</th>
                  <th className="px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m, idx) => {
                  const base  = m.baseAsset ?? m.symbol.split(/[-/]/)[0];
                  const quote = m.quoteAsset ?? m.symbol.split(/[-/]/)[1];
                  const price = parseFloat(m.lastPrice) || 0;
                  const chg   = parseFloat(m.priceChangePercent24h) || 0;
                  const isUp  = chg >= 0;
                  const tradeHref = tab === "futures"
                    ? `/futures/${m.symbol.replace(/\//g, "-")}`
                    : `/trade/${m.symbol.replace(/\//g, "-")}`;

                  const priceUSD = toUSD(price, quote);
                  const btcCellVal = base === "BTC" ? "1 BTC" : fmtBTC(priceUSD);
                  const bsvCellVal = base === "BSV" ? "1 BSV" : fmtBSV(priceUSD);

                  return (
                    <tr key={m.symbol} className="hover:bg-white/5 transition-colors group">
                      <td className="px-3 py-2.5">
                        <button onClick={() => toggleStar(m.symbol)} className="text-muted-foreground hover:text-green-400 transition-colors">
                          <Star className={cn("w-3.5 h-3.5", stars.has(m.symbol) && "fill-green-400 text-green-400")} />
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground/50 tabular-nums">{idx + 1}</td>
                      <td className="px-3 py-2.5">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedCoin(m)}
                          onKeyDown={e => e.key === "Enter" && setSelectedCoin(m)}
                          className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity cursor-pointer"
                        >
                          <CoinLogo symbol={base} size={32} />
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-sm text-foreground">{base}</span>
                              <span className="text-muted-foreground text-xs">/{quote}</span>
                              {tab === "futures" && (
                                <span className="text-[10px] font-bold bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded border border-green-500/30">PERP</span>
                              )}
                              {tab === "new" && (
                                <span className="text-[10px] font-bold bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded border border-green-500/30">NEW</span>
                              )}
                            </div>
                            {(() => {
                              const info = getCoinInfo(base);
                              return info ? (
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-[10px] text-muted-foreground/70 leading-tight max-w-[180px] truncate">{info.description}</span>
                                  {info.tags.slice(0, 2).map(tag => (
                                    <span key={tag} className={cn("text-[9px] font-semibold px-1 py-px rounded border leading-none", getTagColor(tag))}>
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <ContractAddressBadge
                                  baseAsset={base}
                                  dbAddresses={(m as MarketRow).contractAddresses}
                                  variant="full"
                                />
                              );
                            })()}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm font-semibold">
                        {applyQConversion && <span className="text-muted-foreground/60 text-[10px] mr-0.5">{qSym}</span>}
                        {qPrice(price)}
                        {isCrossQuote && !applyQConversion && (
                          <span className="text-[10px] text-muted-foreground ml-1">{quote}</span>
                        )}
                      </td>
                      <td className={cn("px-3 py-2.5 text-right font-mono text-sm font-semibold", isUp ? "text-green-400" : "text-red-400")}>
                        {isUp ? "+" : ""}{chg.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs hidden lg:table-cell">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-orange-400 font-semibold tabular-nums">{btcCellVal}</span>
                          <span className="text-muted-foreground/50 text-[10px]">BTC</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs hidden lg:table-cell">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-yellow-400 font-semibold tabular-nums">{bsvCellVal}</span>
                          <span className="text-muted-foreground/50 text-[10px]">BSV</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-muted-foreground hidden xl:table-cell">
                        {qPrice(parseFloat(m.high24h) || 0)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-muted-foreground hidden xl:table-cell">
                        {qPrice(parseFloat(m.low24h) || 0)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground hidden lg:table-cell">
                        {formatVolume(parseFloat(m.volume24h) || 0)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground hidden xl:table-cell">
                        {m.marketCap ? formatVolume(parseFloat(m.marketCap) || 0) : <span className="text-muted-foreground/30">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => setSelectedCoin(m)}
                            className="inline-flex items-center gap-1 border border-border text-muted-foreground px-2 py-1 rounded-md font-bold text-[11px] hover:border-primary/40 hover:text-foreground transition-all active:scale-95"
                            title="View coin details"
                          >
                            <Info className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleTrade(tradeHref)}
                            className="inline-flex items-center gap-1 bg-primary text-primary-foreground px-3 py-1 rounded-md font-bold text-[11px] hover:brightness-110 transition-all active:scale-95"
                          >
                            <TrendingUp className="w-3 h-3" /> Trade
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={12} className="py-16 text-center text-muted-foreground text-sm">
                      {search ? `No results for "${search}"` : tab === "favorites" ? "Star pairs to see them here" : "Loading markets…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground/50 mt-3 text-center">
            Live prices via CoinGecko · On-chain settlement via Bitcoin SV · 0.1% maker fee
          </p>
        </div>
      </div>

      {/* ── Coin detail panel (slide-over) ── */}
      {selectedCoin && (
        <CoinDetailPanel
          coin={selectedCoin}
          onClose={() => setSelectedCoin(null)}
          onTrade={(href) => { setSelectedCoin(null); handleTrade(href); }}
          toUSD={toUSD}
          fmtBTC={fmtBTC}
          fmtBSV={fmtBSV}
          qPrice={qPrice}
          qSym={qSym}
          applyQConversion={applyQConversion}
          isCrossQuote={isCrossQuote}
          tab={tab}
          isStarred={stars.has(selectedCoin.symbol)}
          onToggleStar={() => toggleStar(selectedCoin.symbol)}
        />
      )}

    </div>
  );
}

/* ── Coin detail slide-over panel ── */
function CoinDetailPanel({
  coin, onClose, onTrade, toUSD, fmtBTC, fmtBSV, qPrice, qSym,
  applyQConversion, isCrossQuote, tab, isStarred, onToggleStar,
}: {
  coin: MarketRow;
  onClose: () => void;
  onTrade: (href: string) => void;
  toUSD: (price: number, quote: string) => number;
  fmtBTC: (usd: number) => string;
  fmtBSV: (usd: number) => string;
  qPrice: (p: number) => string;
  qSym: string;
  applyQConversion: boolean;
  isCrossQuote: boolean;
  tab: string;
  isStarred: boolean;
  onToggleStar: () => void;
}) {
  const base  = coin.baseAsset ?? coin.symbol.split(/[-/]/)[0];
  const quote = coin.quoteAsset ?? coin.symbol.split(/[-/]/)[1];
  const price = parseFloat(String(coin.lastPrice)) || 0;
  const chg   = parseFloat(String(coin.priceChangePercent24h)) || 0;
  const isUp  = chg >= 0;
  const priceUSD = toUSD(price, quote);
  const isFutures = tab === "futures";
  const tradeHref = isFutures
    ? `/futures/${coin.symbol.replace(/\//g, "-")}`
    : `/trade/${coin.symbol.replace(/\//g, "-")}`;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-80 bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <CoinLogo symbol={base} size={36} />
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-base text-foreground">{base}</span>
                <span className="text-muted-foreground text-sm">/{quote}</span>
                {isFutures && (
                  <span className="text-[10px] font-bold bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded border border-green-500/30">PERP</span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{coin.name ?? base} · {isFutures ? "Perpetual" : "Spot"}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleStar}
              className={cn("p-1.5 rounded-lg transition-colors", isStarred ? "text-green-400" : "text-muted-foreground hover:text-green-400")}
              title={isStarred ? "Remove from favorites" : "Add to favorites"}
            >
              <Star className={cn("w-4 h-4", isStarred && "fill-green-400")} />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Price section */}
        <div className="px-4 py-4 border-b border-border shrink-0">
          <div className="flex items-end justify-between">
            <div>
              <div className="flex items-baseline gap-1.5">
                {applyQConversion && <span className="text-muted-foreground/60 text-xs">{qSym}</span>}
                <span className={cn("text-2xl font-bold font-mono", isUp ? "text-green-400" : "text-red-400")}>
                  {qPrice(price)}
                </span>
                {isCrossQuote && !applyQConversion && (
                  <span className="text-sm text-muted-foreground font-mono">{quote}</span>
                )}
              </div>
              {!isCrossQuote && <p className="text-xs text-muted-foreground font-mono mt-0.5">≈${formatPrice(priceUSD)} USD</p>}
              {isCrossQuote && priceUSD > 0 && (
                <p className="text-xs text-muted-foreground font-mono mt-0.5">≈${formatPrice(priceUSD)} USD</p>
              )}
            </div>
            <div className={cn(
              "flex items-center gap-1 px-2.5 py-1 rounded-lg font-bold text-sm",
              isUp ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
            )}>
              {isUp ? "▲" : "▼"} {isUp ? "+" : ""}{chg.toFixed(2)}%
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* About / description */}
          {(() => {
            const info = getCoinInfo(base);
            if (!info) return null;
            return (
              <div className="bg-secondary/40 rounded-xl p-3 space-y-2">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                  <Info className="w-3 h-3" /> About {info.name}
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">{info.description}</p>
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {info.tags.map(tag => (
                    <span key={tag} className={cn("text-[9px] font-semibold px-1.5 py-0.5 rounded border leading-none", getTagColor(tag))}>
                      {tag}
                    </span>
                  ))}
                </div>
                {info.website && (
                  <a
                    href={info.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-1"
                  >
                    <Globe className="w-3 h-3" /> {info.website.replace(/^https?:\/\//, "")}
                  </a>
                )}
              </div>
            );
          })()}

          {/* 24h stats */}
          <div className="bg-secondary/40 rounded-xl p-3 space-y-2">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
              <BarChart2 className="w-3 h-3" /> 24h Statistics
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "High", value: qPrice(parseFloat(String(coin.high24h ?? 0)) || 0), color: "text-green-400" },
                { label: "Low",  value: qPrice(parseFloat(String(coin.low24h ?? 0)) || 0),  color: "text-red-400" },
                { label: "Volume", value: formatVolume(parseFloat(String(coin.volume24h ?? 0)) || 0), color: "text-foreground" },
                { label: "Market Cap", value: coin.marketCap ? formatVolume(parseFloat(String(coin.marketCap)) || 0) : "—", color: "text-foreground" },
              ].map(s => (
                <div key={s.label} className="bg-background/50 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground">{s.label}</p>
                  <p className={cn("text-xs font-semibold font-mono mt-0.5", s.color)}>{s.value || "—"}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Cross-rate pricing */}
          {priceUSD > 0 && (
            <div className="bg-secondary/40 rounded-xl p-3 space-y-2">
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                <ArrowRightLeft className="w-3 h-3" /> Cross Rates
              </p>
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-orange-400 inline-block" /> BTC Price
                  </span>
                  <span className="text-xs font-mono font-semibold text-orange-400 tabular-nums">
                    {base === "BTC" ? "1 BTC" : fmtBTC(priceUSD)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> BSV Price
                  </span>
                  <span className="text-xs font-mono font-semibold text-yellow-400 tabular-nums">
                    {base === "BSV" ? "1 BSV" : fmtBSV(priceUSD)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Contract addresses */}
          <div className="bg-secondary/40 rounded-xl p-3">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5 mb-2">
              <Zap className="w-3 h-3" /> Contract / Chain Info
            </p>
            <ContractAddressBadge
              baseAsset={base}
              dbAddresses={coin.contractAddresses}
              variant="full"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t border-border space-y-2 shrink-0">
          <button
            onClick={() => onTrade(tradeHref)}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-2.5 rounded-xl font-bold text-sm hover:brightness-110 transition-all active:scale-95"
          >
            <TrendingUp className="w-4 h-4" />
            {isFutures ? "Trade Perpetual" : "Trade Spot"}
          </button>
          {!isFutures && (
            <a
              href={`https://www.coingecko.com/en/coins/${base.toLowerCase()}`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center justify-center gap-2 border border-border text-muted-foreground py-2 rounded-xl font-semibold text-xs hover:border-primary/40 hover:text-foreground transition-all"
            >
              <ExternalLink className="w-3.5 h-3.5" /> View on CoinGecko
            </a>
          )}
        </div>
      </div>
    </>
  );
}
