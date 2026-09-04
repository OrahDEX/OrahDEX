import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPrice(price: number, decimals?: number): string {
  if (!isFinite(price) || price === 0) return "0.00";
  const abs = Math.abs(price);
  let d = decimals ?? (
    abs >= 1000  ? 2 :
    abs >= 1     ? 2 :
    abs >= 0.1   ? 4 :
    abs >= 0.01  ? 4 :
    abs >= 0.001 ? 6 :
    8
  );
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(price);
}

export function formatVolume(volume: number): string {
  if (volume >= 1e9) return (volume / 1e9).toFixed(2) + "B";
  if (volume >= 1e6) return (volume / 1e6).toFixed(2) + "M";
  if (volume >= 1e3) return (volume / 1e3).toFixed(2) + "K";
  return volume.toFixed(2);
}

export function formatPercent(percent: number): string {
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent.toFixed(2)}%`;
}

export function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const PROVIDER_LABELS: Record<string, string> = {
  "relayx":         "RelayX",
  "panda":          "Panda Wallet",
  "sensilet":       "Sensilet",
  "twetch":         "Twetch",
  "yours":          "Yours Wallet",
  "metamask":       "MetaMask",
  "rabby":          "Rabby",
  "coinbase":       "Coinbase Wallet",
  "trust":          "Trust Wallet",
  "okx":            "OKX Wallet",
  "bybit":          "Bybit Wallet",
  "rainbow":        "Rainbow",
  "phantom":        "Phantom",
  "imtoken":        "imToken",
  "guarda":         "Guarda Wallet",
  "atomic":         "Atomic Wallet",
  "ledger":         "Ledger",
  "trezor":         "Trezor",
  "keystone":       "Keystone",
  "gridplus":       "GridPlus Lattice1",
  "walletconnect":  "WalletConnect",
  "tronlink":       "TronLink",
  "trust-tron":     "Trust Wallet",
  "okx-tron":       "OKX Wallet",
  "bitget-tron":    "Bitget Wallet",
  "tokenpocket":    "TokenPocket",
  "phantom-btc":    "Phantom (BTC)",
  "phantom-sol":    "Phantom (SOL)",
  "unisat":         "UniSat",
  "xverse":         "Xverse",
  "leather":        "Leather",
  "oyl":            "OYL Wallet",
  "solflare":       "Solflare",
  "backpack":       "Backpack",
  "glow":           "Glow",
  "slope":          "Slope",
  "mobile-qr":      "Mobile QR",
  "manual":         "Manual Entry",
  "reown":          "EVM Wallet",
  "orah-wallet":    "OrahDEX Wallet",
  "passkey":        "Passkey",
  "handcash":       "HandCash",
  "thirdweb":       "ThirdWeb",
};

export function getProviderLabel(provider: string | null | undefined): string {
  if (!provider) return "";
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
}

// Coin name → symbol lookup for natural-language search ("bitcoin" → BTC, etc.)
export const COIN_NAMES: Record<string, string> = {
  BTC:   "bitcoin",        ETH:   "ethereum",        SOL:   "solana",
  XRP:   "ripple xrp",     BNB:   "binance bnb",      ADA:   "cardano",
  DOGE:  "dogecoin",       DOT:   "polkadot",          AVAX:  "avalanche",
  MATIC: "polygon matic",  LINK:  "chainlink",         UNI:   "uniswap",
  ATOM:  "cosmos",         LTC:   "litecoin",           BCH:   "bitcoin cash",
  TRX:   "tron",           NEAR:  "near protocol",     ICP:   "internet computer",
  APT:   "aptos",          ARB:   "arbitrum",           OP:    "optimism",
  SUI:   "sui",            INJ:   "injective",          PEPE:  "pepe",
  SHIB:  "shiba inu shib", MKR:   "maker",              AAVE:  "aave",
  CRV:   "curve",          ENS:   "ethereum name service", LDO: "lido",
  SUSHI: "sushiswap",      COMP:  "compound",           GRT:   "the graph",
  SNX:   "synthetix",      YFI:   "yearn finance",     RUNE:  "thorchain",
  FTM:   "fantom",         ALGO:  "algorand",           XLM:   "stellar",
  HBAR:  "hedera",         THETA: "theta",              ZEC:   "zcash",
  DASH:  "dash",           CRO:   "cronos crypto",      KCS:   "kucoin",
  OKB:   "okx okb",        BONK:  "bonk",               WIF:   "dogwifhat",
  JUP:   "jupiter",        PYTH:  "pyth network",       JTO:   "jito",
  FET:   "fetch ai",       RNDR:  "render",              TAO:   "bittensor",
  WLD:   "worldcoin",      GLM:   "golem",               STORJ: "storj",
  AXS:   "axie infinity",  ENJ:   "enjin",               GALA:  "gala",
  SAND:  "the sandbox",    MANA:  "decentraland",        IMX:   "immutable",
  APE:   "apecoin ape",    RON:   "ronin",               ILV:   "illuvium",
  OSMO:  "osmosis",        LUNA:  "terra luna",          BAND:  "band protocol",
  ONDO:  "ondo finance",   STX:   "stacks bitcoin",      ORDI:  "ordinals",
  BSV:   "bitcoin sv",     USDT:  "tether usd",          USDC:  "usd coin",
  TUSD:  "trueusd",        USDD:  "usdd stablecoin",     TON:   "toncoin telegram",
  SEI:   "sei network",    TIA:   "celestia",             KAS:   "kaspa",
  FLOKI: "floki inu",      TRUMP: "trump meme",           STRK:  "starknet",
  EIGEN: "eigenlayer",     ZRO:   "layerzero",            MNT:   "mantle",
  BEAM:  "beam",           PRIME: "echelon prime",        PIXEL: "pixels game",
  BASE:  "base chain",      ZK:    "zksync",
  SCR:   "scroll",         LINEA: "linea",                GBP:   "british pound sterling",
  EUR:   "euro",           AUD:   "australian dollar",    JPY:   "japanese yen",
};

/**
 * Returns true if a market row matches the given search query.
 * Searches base symbol, quote symbol, full pair symbol, and coin names.
 */
export function marketMatchesQuery(
  base: string,
  quote: string,
  symbol: string,
  query: string
): boolean {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const b = base.toLowerCase();
  const qt = quote.toLowerCase();
  const sym = symbol.toLowerCase().replace(/[/-]/g, "");
  const symSlash = symbol.toLowerCase();
  const baseName = (COIN_NAMES[base] ?? "").toLowerCase();
  const quoteName = (COIN_NAMES[quote] ?? "").toLowerCase();
  return (
    b.includes(q) ||
    qt.includes(q) ||
    sym.includes(q.replace(/[/-]/g, "")) ||
    symSlash.includes(q) ||
    baseName.includes(q) ||
    quoteName.includes(q)
  );
}
