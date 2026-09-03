// Updated Markets.tsx to remove auto from BSV/USDT
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
  return { ...m, symbol: m.symbol ?? `${base}-${quote}` };
}
