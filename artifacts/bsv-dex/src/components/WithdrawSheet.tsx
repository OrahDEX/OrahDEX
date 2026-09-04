/**
 * WithdrawSheet.tsx
 *
 * Three-tab dialog: Deposit · Withdraw · History
 *
 * Deposit tab  — unique per-user deposit address + QR, network selector,
 *                and TX-hash verifier.
 * Withdraw tab — amount + recipient form, instant on-chain settlement.
 * History tab  — past withdrawals with status badges, gas-shortage banner.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  CheckCircle2,
  Loader2,
  Zap,
  History,
  Copy,
  Check,
  AlertCircle,
  ExternalLink,
  Download,
  RefreshCw,
  Wallet,
  ArrowRight,
  Clock,
} from "lucide-react";
import { API_BASE } from "@/lib/api";
import { validateAltChainAddress } from "@/lib/addressValidation";
import { isAddress as isEvmAddress } from "viem";
import { CHAIN_RPC_URLS, CHAIN_RPC_FALLBACKS, fetchEvmBalance } from "@/lib/reown";
import {
  getViemAccountForAddress,
  sendBsvFromAddress,
  sendBtcFromAddress,
  sendLtcFromAddress,
  sendDogeFromAddress,
  sendXrpFromAddress,
  sendTrxFromAddress,
  sendBchFromAddress,
  sendSolFromAddress,
  signBsvChallengeFromAddress,
} from "@/lib/walletSigner";
import {
  listPasskeyWallets,
  loginWithPasskey,
} from "@/lib/passkeyWallet";
import { getDerivedAddresses, listImportedWallets } from "@/lib/walletPin";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNotificationStore } from "@/store/useNotificationStore";
import { useAddressBookStore, WALLET_TYPE_META } from "@/store/useAddressBookStore";
import { useWalletStore } from "@/store/useWalletStore";
import { useHandCashStore } from "@/store/useHandCashStore";
import { useCustomTokenStore } from "@/store/useCustomTokenStore";
import { QRCodeCanvas } from "qrcode.react";

// ── constants ────────────────────────────────────────────────────────────────
const SUPPORTED_CHAINS: { id: number; label: string; short: string; color: string }[] = [
  { id: 1,        label: "Ethereum Mainnet", short: "Ethereum", color: "#627EEA" },
  { id: 8453,     label: "Base",             short: "Base",     color: "#0052FF" },
  { id: 56,       label: "BNB Smart Chain",  short: "BSC",      color: "#F3BA2F" },
  { id: 11155111, label: "Sepolia Testnet",  short: "Sepolia",  color: "#9B59B6" },
];

/** Returns true if `s` is a HandCash $handle or @handcash.io paymail */
function isHandCashHandle(s: string): boolean {
  const t = s.trim().replace(/^\$/, "");
  if (/^[a-zA-Z][a-zA-Z0-9_]{2,24}$/.test(t)) return true;
  if (t.toLowerCase().endsWith("@handcash.io")) return true;
  return false;
}

// ── non-EVM chains available in the withdraw chain selector ──────────────────
const NON_EVM_WITHDRAW_CHAINS = [
  { id: "evm",  label: "EVM",  color: "#627EEA" },
  { id: "bsv",  label: "BSV",  color: "#22C55E" },
  { id: "btc",  label: "BTC",  color: "#F97316" },
  { id: "sol",  label: "SOL",  color: "#9945FF" },
  { id: "xrp",  label: "XRP",  color: "#00A9E0" },
  { id: "ltc",  label: "LTC",  color: "#A0A0A0" },
  { id: "doge", label: "DOGE", color: "#C8A300" },
  { id: "trx",  label: "TRX",  color: "#EF4444" },
  { id: "bch",  label: "BCH",  color: "#8DC351" },
];

// ── wallet-send chain & token registry ───────────────────────────────────────
interface WalletChain  { id: number; name: string; symbol: string; color: string; explorer: string }
interface WalletToken  { symbol: string; decimals: number; isNative: boolean; address: string | null; color: string }

const WALLET_CHAINS: WalletChain[] = [
  { id: 8453,     name: "Base",      symbol: "ETH",  color: "#0052FF", explorer: "https://basescan.org/tx/" },
  { id: 1,        name: "Ethereum",  symbol: "ETH",  color: "#627EEA", explorer: "https://etherscan.io/tx/" },
  { id: 56,       name: "BSC",       symbol: "BNB",  color: "#F0B90B", explorer: "https://bscscan.com/tx/" },
  { id: 42161,    name: "Arbitrum",  symbol: "ETH",  color: "#28A0F0", explorer: "https://arbiscan.io/tx/" },
  { id: 10,       name: "Optimism",  symbol: "ETH",  color: "#FF0420", explorer: "https://optimistic.etherscan.io/tx/" },
  { id: 137,      name: "Polygon",   symbol: "POL",  color: "#8247E5", explorer: "https://polygonscan.com/tx/" },
  { id: 43114,    name: "Avalanche", symbol: "AVAX", color: "#E84142", explorer: "https://snowtrace.io/tx/" },
  { id: 11155111, name: "Sepolia",   symbol: "ETH",  color: "#9B59B6", explorer: "https://sepolia.etherscan.io/tx/" },
];

const WALLET_TOKENS: Record<number, WalletToken[]> = {
  // ── Base ───────────────────────────────────────────────────────────────────
  8453: [
    { symbol: "ETH",   decimals: 18, isNative: true,  address: null,                                       color: "#627EEA" },
    { symbol: "USDC",  decimals: 6,  isNative: false, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", color: "#3B82F6" },
    { symbol: "USDT",  decimals: 6,  isNative: false, address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", color: "#22C55E" },
    { symbol: "WETH",  decimals: 18, isNative: false, address: "0x4200000000000000000000000000000000000006", color: "#8B5CF6" },
    { symbol: "WBTC",  decimals: 8,  isNative: false, address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", color: "#F97316" },
    { symbol: "DAI",   decimals: 18, isNative: false, address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", color: "#F5A623" },
    { symbol: "cbETH", decimals: 18, isNative: false, address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", color: "#0052FF" },
    { symbol: "AERO",  decimals: 18, isNative: false, address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", color: "#FF6B35" },
  ],
  // ── Ethereum Mainnet ───────────────────────────────────────────────────────
  1: [
    { symbol: "ETH",   decimals: 18, isNative: true,  address: null,                                       color: "#627EEA" },
    { symbol: "USDT",  decimals: 6,  isNative: false, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", color: "#22C55E" },
    { symbol: "USDC",  decimals: 6,  isNative: false, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", color: "#3B82F6" },
    { symbol: "WBTC",  decimals: 8,  isNative: false, address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", color: "#F97316" },
    { symbol: "DAI",   decimals: 18, isNative: false, address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", color: "#F5A623" },
    { symbol: "LINK",  decimals: 18, isNative: false, address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", color: "#2A5ADA" },
    { symbol: "UNI",   decimals: 18, isNative: false, address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", color: "#FF007A" },
    { symbol: "AAVE",  decimals: 18, isNative: false, address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", color: "#B6509E" },
    { symbol: "SHIB",  decimals: 18, isNative: false, address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", color: "#E05C12" },
    { symbol: "PEPE",  decimals: 18, isNative: false, address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", color: "#4CAF50" },
    { symbol: "MKR",   decimals: 18, isNative: false, address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", color: "#1AAB9B" },
    { symbol: "CRV",   decimals: 18, isNative: false, address: "0xD533a949740bb3306d119CC777fa900bA034cd52", color: "#FF0000" },
    { symbol: "LDO",   decimals: 18, isNative: false, address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", color: "#F57A25" },
    { symbol: "ARB",   decimals: 18, isNative: false, address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1", color: "#28A0F0" },
    { symbol: "ORAH",  decimals: 18, isNative: false, address: "0x0000000000000000000000000000000000000000", color: "#00D4AA" },
  ],
  // ── BNB Smart Chain ────────────────────────────────────────────────────────
  56: [
    { symbol: "BNB",   decimals: 18, isNative: true,  address: null,                                       color: "#F0B90B" },
    { symbol: "USDT",  decimals: 18, isNative: false, address: "0x55d398326f99059fF775485246999027B3197955", color: "#22C55E" },
    { symbol: "USDC",  decimals: 18, isNative: false, address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", color: "#3B82F6" },
    { symbol: "BUSD",  decimals: 18, isNative: false, address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", color: "#F5A623" },
    { symbol: "CAKE",  decimals: 18, isNative: false, address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", color: "#FF6B81" },
    { symbol: "WBTC",  decimals: 18, isNative: false, address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", color: "#F97316" },
    { symbol: "ETH",   decimals: 18, isNative: false, address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", color: "#627EEA" },
    { symbol: "FLOKI", decimals: 9,  isNative: false, address: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37", color: "#FF8C00" },
    { symbol: "PEPE",  decimals: 18, isNative: false, address: "0x25d887Ce7a35172C62FeBFD67a1856F20Faebb00", color: "#4CAF50" },
    { symbol: "XRP",   decimals: 18, isNative: false, address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", color: "#00AAE4" },
  ],
  // ── Arbitrum ───────────────────────────────────────────────────────────────
  42161: [
    { symbol: "ETH",   decimals: 18, isNative: true,  address: null,                                       color: "#627EEA" },
    { symbol: "USDC",  decimals: 6,  isNative: false, address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", color: "#3B82F6" },
    { symbol: "USDT",  decimals: 6,  isNative: false, address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", color: "#22C55E" },
    { symbol: "ARB",   decimals: 18, isNative: false, address: "0x912CE59144191C1204E64559FE8253a0e49E6548", color: "#28A0F0" },
    { symbol: "WBTC",  decimals: 8,  isNative: false, address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", color: "#F97316" },
    { symbol: "LINK",  decimals: 18, isNative: false, address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", color: "#2A5ADA" },
    { symbol: "UNI",   decimals: 18, isNative: false, address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0", color: "#FF007A" },
    { symbol: "GMX",   decimals: 18, isNative: false, address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", color: "#04D1A5" },
    { symbol: "DAI",   decimals: 18, isNative: false, address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", color: "#F5A623" },
    { symbol: "AAVE",  decimals: 18, isNative: false, address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196", color: "#B6509E" },
  ],
  // ── Optimism ───────────────────────────────────────────────────────────────
  10: [
    { symbol: "ETH",   decimals: 18, isNative: true,  address: null,                                       color: "#627EEA" },
    { symbol: "USDC",  decimals: 6,  isNative: false, address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", color: "#3B82F6" },
    { symbol: "USDT",  decimals: 6,  isNative: false, address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", color: "#22C55E" },
    { symbol: "OP",    decimals: 18, isNative: false, address: "0x4200000000000000000000000000000000000042", color: "#FF0420" },
    { symbol: "WBTC",  decimals: 8,  isNative: false, address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", color: "#F97316" },
    { symbol: "LINK",  decimals: 18, isNative: false, address: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6", color: "#2A5ADA" },
    { symbol: "SNX",   decimals: 18, isNative: false, address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4", color: "#1E1A31" },
    { symbol: "DAI",   decimals: 18, isNative: false, address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", color: "#F5A623" },
    { symbol: "AAVE",  decimals: 18, isNative: false, address: "0x76FB31fb4af56892A25e32cFC43De717950c9278", color: "#B6509E" },
  ],
  // ── Polygon ────────────────────────────────────────────────────────────────
  137: [
    { symbol: "POL",   decimals: 18, isNative: true,  address: null,                                       color: "#8247E5" },
    { symbol: "USDT",  decimals: 6,  isNative: false, address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", color: "#22C55E" },
    { symbol: "USDC",  decimals: 6,  isNative: false, address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", color: "#3B82F6" },
    { symbol: "WETH",  decimals: 18, isNative: false, address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", color: "#627EEA" },
    { symbol: "WBTC",  decimals: 8,  isNative: false, address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", color: "#F97316" },
    { symbol: "DAI",   decimals: 18, isNative: false, address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", color: "#F5A623" },
    { symbol: "LINK",  decimals: 18, isNative: false, address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", color: "#2A5ADA" },
    { symbol: "AAVE",  decimals: 18, isNative: false, address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", color: "#B6509E" },
    { symbol: "UNI",   decimals: 18, isNative: false, address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", color: "#FF007A" },
    { symbol: "SHIB",  decimals: 18, isNative: false, address: "0x6f8a06447Ff6FcF75d803135a7de15CE88C1d4ec", color: "#E05C12" },
  ],
  // ── Avalanche ──────────────────────────────────────────────────────────────
  43114: [
    { symbol: "AVAX",  decimals: 18, isNative: true,  address: null,                                       color: "#E84142" },
    { symbol: "USDC",  decimals: 6,  isNative: false, address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", color: "#3B82F6" },
    { symbol: "USDT",  decimals: 6,  isNative: false, address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", color: "#22C55E" },
    { symbol: "WBTC",  decimals: 8,  isNative: false, address: "0x50b7545627a5162F82A992c33b87aDc75187B218", color: "#F97316" },
    { symbol: "WETH",  decimals: 18, isNative: false, address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", color: "#627EEA" },
    { symbol: "DAI",   decimals: 18, isNative: false, address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", color: "#F5A623" },
    { symbol: "LINK",  decimals: 18, isNative: false, address: "0x5947BB275c521040051D82396192181b413227A3", color: "#2A5ADA" },
    { symbol: "AAVE",  decimals: 18, isNative: false, address: "0x63a72806098Bd3D9520cC43356dD78afe5D386D9", color: "#B6509E" },
  ],
  // ── Sepolia Testnet ────────────────────────────────────────────────────────
  11155111: [
    { symbol: "ETH",   decimals: 18, isNative: true,  address: null,                                       color: "#627EEA" },
    { symbol: "USDC",  decimals: 6,  isNative: false, address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", color: "#3B82F6" },
    { symbol: "USDT",  decimals: 6,  isNative: false, address: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0", color: "#22C55E" },
    { symbol: "WBTC",  decimals: 8,  isNative: false, address: "0x29f2D40B0605204364af54EC677bD022dA425d03", color: "#F97316" },
    { symbol: "DAI",   decimals: 18, isNative: false, address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", color: "#F5A623" },
    { symbol: "ORAH",  decimals: 18, isNative: false, address: "0x0000000000000000000000000000000000000000", color: "#00D4AA" },
  ],
};

// minimal ERC-20 transfer ABI
const ERC20_TRANSFER_ABI = [{
  name: "transfer", type: "function", stateMutability: "nonpayable",
  inputs:  [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

// ── types ────────────────────────────────────────────────────────────────────
interface WithdrawHistoryItem {
  id:           string;
  asset:        string;
  amount:       number;
  recipient:    string;
  network:      string;
  networkLabel: string;
  status:       "pending" | "processing" | "completed" | "failed" | "cancelled";
  txid?:        string | null;
  note?:        string | null;
  createdAt:    string;
}

interface DepositAddressResponse {
  depositAddress: string;
  chainId:        number;
  chainName:      string;
  nativeSymbol:   string;
  blockExplorer:  string;
  ledgerBalances: Record<string, string>;
}

interface BitcoinDepositResponse {
  network:          string;
  supported:        boolean;
  symbol:           string;
  label:            string;
  address?:         string;
  minDeposit?:      string;
  explorerTx?:      string;
  explorerAddress?: string;
  message?:         string;
}

interface SolanaDepositResponse {
  network:          string;
  supported:        boolean;
  symbol:           string;
  label?:           string;
  address?:         string;
  minDeposit?:      string;
  explorerTx?:      string;
  explorerAddress?: string;
  message?:         string;
}

interface AltChainDepositResponse {
  network:          string;
  supported:        boolean;
  symbol:           string;
  label?:           string;
  address?:         string;
  minDeposit?:      string;
  explorerAddress?: string;
  message?:         string;
}

interface PendingBsvDeposit {
  txid:          string;
  bsvAddress:    string;
  amountSat:     number;
  amountBsv:     string;
  status:        "mempool" | "confirmed" | "stale";
  blockHeight:   number | null;
  chainHeight:   number | null;
  confirmations: number | null;
  detectedAt:    string;
  confirmedAt:   string | null;
  explorerUrl:   string;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function summariseNote(raw: string): string {
  if (!raw) return raw;
  if (raw.includes("total cost") && raw.includes("gas fee"))
    return "Your withdrawal is queued and will be processed automatically.";
  if (/insufficient funds/i.test(raw)) return "Insufficient funds to complete the transaction.";
  if (/nonce/i.test(raw)) return "Transaction nonce conflict — please retry.";
  if (/execution reverted/i.test(raw)) return "Transaction reverted by the contract.";
  const firstSentence = raw.split(/\.\s/)[0];
  return firstSentence.length <= 120 ? firstSentence : firstSentence.slice(0, 117) + "…";
}

function isGasError(note: string | null | undefined): boolean {
  if (!note) return false;
  return (note.includes("total cost") && note.includes("gas fee")) ||
    /insufficient funds for transfer/i.test(note);
}

function shortAddr(a: string) {
  return a ? `${a.slice(0, 8)}…${a.slice(-6)}` : "";
}

// ── auto-select chain + token for a given asset symbol ───────────────────────
function resolveWalletChainToken(asset: string): { chain: WalletChain; token: WalletToken } {
  const sym = asset.toUpperCase();
  // 1. Check if the asset is a native token of any chain (e.g. ETH, BNB, AVAX, POL)
  const nativeChain = WALLET_CHAINS.find(c => c.symbol.toUpperCase() === sym);
  if (nativeChain) {
    const token = (WALLET_TOKENS[nativeChain.id] ?? []).find(t => t.isNative) ?? WALLET_TOKENS[nativeChain.id][0];
    return { chain: nativeChain, token };
  }
  // 2. Check if the asset appears as an ERC-20 token on any chain (prefer chain with most liquidity)
  const CHAIN_PRIORITY = [1, 8453, 56, 42161, 10, 137, 43114, 11155111];
  for (const chainId of CHAIN_PRIORITY) {
    const tok = (WALLET_TOKENS[chainId] ?? []).find(t => t.symbol.toUpperCase() === sym);
    if (tok) {
      const chain = WALLET_CHAINS.find(c => c.id === chainId) ?? WALLET_CHAINS[0];
      return { chain, token: tok };
    }
  }
  // 3. Fallback to Base / ETH
  return { chain: WALLET_CHAINS[0], token: WALLET_TOKENS[WALLET_CHAINS[0].id][0] };
}

// ── props ────────────────────────────────────────────────────────────────────
export interface WithdrawSheetProps {
  open:                boolean;
  onClose:             () => void;
  walletAddress:       string;
  defaultRecipient?:   string;
  asset:               string;
  available:           number;
  network:             string;
  networkLabel:        string;
  addressPlaceholder?: string;
  color?:              string;
  /** Open directly on a specific tab */
  initialTab?:         "deposit" | "withdraw" | "history";
  /** Restrict which tabs are visible in the tab bar. Defaults to all three. */
  visibleTabs?:        ("deposit" | "withdraw" | "history")[];
  /** Whether this is a passkey / orah-wallet — enables "Send from Wallet" mode */
  isOrahWallet?:       boolean;
  /** EVM address of the OrahWallet passkey — required for BSV/non-EVM wallet signing. */
  passkeyEvmAddress?:  string;
  /** Per-chain wallet addresses for the chain selector (bsv, btc, ltc, xrp, sol, trx, doge, bch) */
  nonEvmAddresses?:    Record<string, string | undefined>;
  /** Pre-select a specific EVM chain when opened from a token row */
  initialChainId?:     number;
  /** Pre-select a specific token symbol when opened from a token row */
  initialTokenSymbol?: string;
  /** Pre-select a non-EVM chain when opened from a chain row (e.g. "btc", "bch", "sol") */
  initialNonEvmChain?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
export function WithdrawSheet({
  open,
  onClose,
  walletAddress,
  defaultRecipient,
  asset,
  available,
  network,
  networkLabel,
  addressPlaceholder = "Destination wallet address",
  color = "#6B7280",
  initialTab = "withdraw",
  visibleTabs,
  isOrahWallet = false,
  passkeyEvmAddress,
  nonEvmAddresses,
  initialChainId,
  initialTokenSymbol,
  initialNonEvmChain,
}: WithdrawSheetProps) {
  const { toast } = useToast();
  const { addNotification } = useNotificationStore();
  const { isHardwareWallet, hardwareWalletType } = useWalletStore();

  const isBitcoinFork = ["bsv", "btc", "bch"].includes(network.toLowerCase());
  const isSolana      = network.toLowerCase() === "sol";
  const isEvmNetwork  = !isBitcoinFork && !isSolana && (network.toLowerCase() === "evm" || network === "");
  const isAltChain    = !isBitcoinFork && !isSolana && !isEvmNetwork; // LTC, DOGE, XRP, ADA, TRON, TON, etc.
  const isNonEvm      = isBitcoinFork || isSolana || isAltChain;

  // ── Resolve the correct OrahDEX signing address for non-EVM chains ────────
  // When an external EVM wallet is the primary connection passkeyEvmAddress is
  // undefined. We auto-detect the OrahDEX passkey wallet that owns the non-EVM
  // addresses, falling back to the first passkey wallet on the device.
  const resolvedSigningEvmAddress = useMemo((): string => {
    if (passkeyEvmAddress) return passkeyEvmAddress;
    const passkeys = listPasskeyWallets();
    if (passkeys.length === 0) return walletAddress;
    if (nonEvmAddresses) {
      for (const pk of passkeys) {
        const d = getDerivedAddresses(pk.address);
        if (!d) continue;
        if (
          (nonEvmAddresses.bsv && d.bsv?.toLowerCase()  === nonEvmAddresses.bsv.toLowerCase())  ||
          (nonEvmAddresses.btc && d.btc?.toLowerCase()  === nonEvmAddresses.btc.toLowerCase())  ||
          (nonEvmAddresses.sol && d.sol?.toLowerCase()  === nonEvmAddresses.sol.toLowerCase())  ||
          (nonEvmAddresses.trx && d.tron?.toLowerCase() === nonEvmAddresses.trx.toLowerCase())  ||
          (nonEvmAddresses.xrp && d.xrp?.toLowerCase()  === nonEvmAddresses.xrp.toLowerCase())
        ) return pk.address;
      }
      for (const imp of listImportedWallets()) {
        const d = getDerivedAddresses(imp.address);
        if (!d) continue;
        if (
          (nonEvmAddresses.bsv && d.bsv?.toLowerCase() === nonEvmAddresses.bsv.toLowerCase()) ||
          (nonEvmAddresses.btc && d.btc?.toLowerCase() === nonEvmAddresses.btc.toLowerCase()) ||
          (nonEvmAddresses.sol && d.sol?.toLowerCase() === nonEvmAddresses.sol.toLowerCase())
        ) return imp.address;
      }
    }
    return passkeys[0].address;
  }, [passkeyEvmAddress, walletAddress, nonEvmAddresses]);

  // Merge auto-loaded derived addresses with any passed nonEvmAddresses.
  // Auto-loading lets Portfolio/MobilePortfolio work without passing nonEvmAddresses.
  const effectiveNonEvmAddresses = useMemo((): Record<string, string | undefined> => {
    const d = getDerivedAddresses(resolvedSigningEvmAddress);
    const auto: Record<string, string | undefined> = d ? {
      bsv:  d.bsv  ?? undefined,
      btc:  d.btc  ?? undefined,
      bch:  d.bch  ?? undefined,
      sol:  d.sol  ?? undefined,
      trx:  d.tron ?? undefined,
      xrp:  d.xrp  ?? undefined,
      ltc:  d.ltc  ?? undefined,
      doge: d.doge ?? undefined,
    } : {};
    return { ...auto, ...nonEvmAddresses };
  }, [resolvedSigningEvmAddress, nonEvmAddresses]);

  // True when we have an OrahDEX wallet (passkey or imported) that can sign
  const canSignNonEvm = useMemo(() => {
    const addr = resolvedSigningEvmAddress.toLowerCase();
    return listPasskeyWallets().some(w => w.address.toLowerCase() === addr) ||
      listImportedWallets().some(w => w.address.toLowerCase() === addr);
  }, [resolvedSigningEvmAddress]);
  const [tab,          setTab]          = useState<"deposit" | "withdraw" | "history">(initialTab);
  const [copiedId,     setCopiedId]     = useState<string | null>(null);
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const [depositChain, setDepositChain] = useState(SUPPORTED_CHAINS[1]); // Base default
  const [depositMode,  setDepositMode]  = useState<"exchange" | "wallet">("exchange");
  const [txHash,       setTxHash]       = useState("");   // EVM deposit TX verification
  const [verifying,    setVerifying]    = useState(false);
  const [bsvTxHash,    setBsvTxHash]    = useState("");
  const [bsvVerifying, setBsvVerifying] = useState(false);
  const [solTxHash,    setSolTxHash]    = useState("");
  const [solVerifying, setSolVerifying] = useState(false);

  // ── deposit-from-wallet state ────────────────────────────────────────────
  const [depFromWalletBalance,  setDepFromWalletBalance]  = useState<number | null>(null);
  const [depFromWalletBalFetch, setDepFromWalletBalFetch] = useState(false);
  const [depFromWalletAmount,   setDepFromWalletAmount]   = useState("");
  const [depFromWalletSending,  setDepFromWalletSending]  = useState(false);
  const [depFromWalletTxHash,   setDepFromWalletTxHash]   = useState<string | null>(null);
  const [depFromWalletError,    setDepFromWalletError]    = useState<string | null>(null);

  // ── wallet send state (EVM) ──────────────────────────────────────────────
  const [walletSendChain,     setWalletSendChain]     = useState<WalletChain>(() => resolveWalletChainToken(asset).chain);
  const [walletSendToken,     setWalletSendToken]     = useState<WalletToken>(() => resolveWalletChainToken(asset).token);
  const [walletSendBalance,   setWalletSendBalance]   = useState<number | null>(null);
  const [walletSendBalFetch,  setWalletSendBalFetch]  = useState(false);
  const [walletSendAmount,    setWalletSendAmount]    = useState("");
  const [walletSendRecipient, setWalletSendRecipient] = useState("");
  const [walletSending,       setWalletSending]       = useState(false);
  const [walletSendTxHash,    setWalletSendTxHash]    = useState<string | null>(null);
  const [walletSendError,     setWalletSendError]     = useState<string | null>(null);

  // ── non-EVM wallet send state (BSV / LTC / XRP / etc.) ──────────────────
  const [nonEvmSendBalance,   setNonEvmSendBalance]   = useState<number | null>(null);
  const [nonEvmSendBalFetch,  setNonEvmSendBalFetch]  = useState(false);
  const [nonEvmSendAmount,    setNonEvmSendAmount]    = useState("");
  const [nonEvmSendRecipient, setNonEvmSendRecipient] = useState("");
  const [nonEvmSending,       setNonEvmSending]       = useState(false);
  const [nonEvmSendTxHash,    setNonEvmSendTxHash]    = useState<string | null>(null);
  const [nonEvmSendError,     setNonEvmSendError]     = useState<string | null>(null);
  const [passkeyRegistering,  setPasskeyRegistering]  = useState(false);
  const [passkeyRegistered,   setPasskeyRegistered]   = useState(false);

  // ── HandCash state ────────────────────────────────────────────────────────
  const hcAuthToken = useHandCashStore(s => s.authToken);
  const hcProfile   = useHandCashStore(s => s.profile);
  const [hcHandleInfo, setHcHandleInfo] = useState<{
    handle: string; address: string | null; displayName: string; avatarUrl: string | null; paymail: string;
  } | null>(null);
  const [hcHandleFetching, setHcHandleFetching] = useState(false);

  // ── withdraw chain selector (overrides network prop inside withdraw tab) ──
  const [withdrawChainMode, setWithdrawChainMode] = useState<string>(
    initialNonEvmChain?.toLowerCase() ?? (isEvmNetwork ? "evm" : network.toLowerCase())
  );
  // Reset non-EVM form when user switches chain
  useEffect(() => {
    setNonEvmSendBalance(null);
    setNonEvmSendAmount("");
    setNonEvmSendRecipient("");
    setNonEvmSendError(null);
    setNonEvmSendTxHash(null);
  }, [withdrawChainMode]);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setWalletSendTxHash(null);
      setWalletSendError(null);
      setWalletSendAmount("");
      setWalletSendRecipient("");
      setDepFromWalletTxHash(null);
      setDepFromWalletError(null);
      setDepFromWalletAmount("");
      setNonEvmSendBalance(null);
      setNonEvmSendAmount("");
      setNonEvmSendRecipient("");
      setNonEvmSendTxHash(null);
      setNonEvmSendError(null);
      setDepFromWalletBalance(null);
      setBsvTxHash("");
      setSolTxHash("");
      // Pre-select chain+token from a token row click, otherwise fall back to asset prop
      if (initialChainId) {
        const preChain = WALLET_CHAINS.find(c => c.id === initialChainId);
        if (preChain) {
          setWalletSendChain(preChain);
          let preToken: WalletToken | undefined = initialTokenSymbol
            ? (WALLET_TOKENS[initialChainId] ?? []).find(t => t.symbol.toUpperCase() === initialTokenSymbol.toUpperCase())
            : undefined;
          // Fall back to custom token store for user-added tokens (e.g. A8, APE)
          if (!preToken && initialTokenSymbol) {
            const ct = useCustomTokenStore.getState().getByChainId(initialChainId)
              .find(c => c.symbol.toUpperCase() === initialTokenSymbol.toUpperCase());
            if (ct) {
              preToken = { symbol: ct.symbol, decimals: ct.decimals, isNative: false, address: ct.address, color: ct.color };
            }
          }
          setWalletSendToken(preToken ?? (WALLET_TOKENS[initialChainId]?.[0] ?? resolveWalletChainToken(asset).token));
          setWalletSendBalance(null);
          return;
        }
      }
      const resolved = resolveWalletChainToken(asset);
      setWalletSendChain(resolved.chain);
      setWalletSendToken(resolved.token);
      setWalletSendBalance(null);
    }
  }, [open, asset, defaultRecipient, initialTab, initialChainId, initialTokenSymbol]);


  // ── deposit address ──────────────────────────────────────────────────────
  const { data: depositData, isLoading: depositLoading, refetch: refetchDeposit } =
    useQuery<DepositAddressResponse>({
      queryKey: ["deposit-address", walletAddress, depositChain.id],
      queryFn: async () => {
        if (!walletAddress) throw new Error("No wallet");
        const r = await fetch(
          `${API_BASE}/deposit/address?walletAddress=${encodeURIComponent(walletAddress)}&chainId=${depositChain.id}`
        );
        if (!r.ok) throw new Error("Failed to load deposit address");
        return r.json();
      },
      enabled: !!walletAddress && open && tab === "deposit" && !isNonEvm,
      staleTime: 60_000,
    });

  // ── bitcoin (BSV/BTC/BCH) deposit address ────────────────────────────────
  const { data: bitcoinDepositData, isLoading: bitcoinDepositLoading } =
    useQuery<BitcoinDepositResponse>({
      queryKey: ["bitcoin-deposit-address", network],
      queryFn: async () => {
        const r = await fetch(`${API_BASE}/deposit/bitcoin-address?network=${network.toLowerCase()}`);
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      },
      enabled: isBitcoinFork && open && tab === "deposit",
      staleTime: 300_000,
    });

  // ── BSV SPV pending deposits (auto-detected via mempool watcher) ──────────
  const { data: bsvPendingDeposits = [] } =
    useQuery<PendingBsvDeposit[]>({
      queryKey: ["bsv-pending-deposits", walletAddress],
      queryFn: async () => {
        if (!walletAddress) return [];
        const r = await fetch(
          `${API_BASE}/deposit/bsv-pending?walletAddress=${encodeURIComponent(walletAddress)}`,
        );
        if (!r.ok) return [];
        return r.json();
      },
      enabled: network.toLowerCase() === "bsv" && !!walletAddress && open && tab === "deposit",
      refetchInterval: 15_000,
      staleTime: 5_000,
    });

  // ── Solana deposit address ───────────────────────────────────────────────
  const { data: solanaDepositData, isLoading: solanaDepositLoading } =
    useQuery<SolanaDepositResponse>({
      queryKey: ["solana-deposit-address"],
      queryFn: async () => {
        const r = await fetch(`${API_BASE}/deposit/solana-address`);
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      },
      enabled: isSolana && open && tab === "deposit",
      staleTime: 300_000,
    });

  // ── Solana tx verify ─────────────────────────────────────────────────────
  const handleSolVerify = async () => {
    if (!solTxHash.trim() || solVerifying || !walletAddress) return;
    setSolVerifying(true);
    try {
      const r = await fetch(`${API_BASE}/deposit/solana-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, txHash: solTxHash.trim() }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast({ title: "Verification failed", description: data.error ?? "Could not verify transaction", variant: "destructive" });
      } else {
        toast({ title: "SOL deposit credited!", description: `${data.amount} SOL has been added to your trading balance.` });
        addNotification({ type: "deposit", title: "SOL Deposit Credited", body: `${data.amount} SOL added to your exchange balance.` });
        setSolTxHash("");
      }
    } catch {
      toast({ title: "Verification failed", description: "Network error — please try again.", variant: "destructive" });
    } finally {
      setSolVerifying(false);
    }
  };

  // ── AltChain deposit address ─────────────────────────────────────────────
  const { data: altchainData, isLoading: altchainLoading } =
    useQuery<AltChainDepositResponse>({
      queryKey: ["altchain-deposit-address", network],
      queryFn: async () => {
        const r = await fetch(`${API_BASE}/deposit/altchain-address?network=${network.toLowerCase()}`);
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      },
      enabled: isAltChain && open && tab === "deposit",
      staleTime: 300_000,
    });

  // ── BSV tx verify ────────────────────────────────────────────────────────
  const handleBsvVerify = async () => {
    if (!bsvTxHash.trim() || bsvVerifying || !walletAddress) return;
    setBsvVerifying(true);
    try {
      const r = await fetch(`${API_BASE}/deposit/bsv-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, txHash: bsvTxHash.trim() }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast({ title: "Verification failed", description: data.error ?? "Could not verify transaction", variant: "destructive" });
      } else {
        toast({ title: "BSV deposit credited!", description: `${data.amount} BSV has been added to your trading balance.` });
        addNotification({ type: "deposit", title: "BSV Deposit Credited", body: `${data.amount} BSV added to your exchange balance.` });
        setBsvTxHash("");
      }
    } catch {
      toast({ title: "Verification failed", description: "Network error — please try again.", variant: "destructive" });
    } finally {
      setBsvVerifying(false);
    }
  };

  // ── withdrawal history ───────────────────────────────────────────────────
  const { data: history = [], refetch: refetchHistory } = useQuery<WithdrawHistoryItem[]>({
    queryKey: ["withdrawal-history", walletAddress],
    queryFn: async () => {
      if (!walletAddress) return [];
      const r = await fetch(`${API_BASE}/withdrawals/${encodeURIComponent(walletAddress)}`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!walletAddress && open,
    refetchInterval: 30_000,
    staleTime: 2_000,
  });

  const hasGasError = history.some(
    h => isGasError(h.note) && (h.status === "cancelled" || h.status === "pending")
  );


  // ── deposit-from-wallet: native balance fetch ────────────────────────────
  const fetchDepFromWalletBalance = useCallback(async (chainId: number) => {
    if (!walletAddress) return;
    setDepFromWalletBalance(null);
    setDepFromWalletBalFetch(true);
    try {
      const rpc = CHAIN_RPC_URLS[chainId];
      if (!rpc) return;
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [walletAddress, "latest"] }),
      });
      const { result } = await res.json();
      setDepFromWalletBalance(Number(BigInt(result ?? "0x0")) / 1e18);
    } catch {
      setDepFromWalletBalance(null);
    } finally {
      setDepFromWalletBalFetch(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (open && tab === "deposit" && depositMode === "exchange" && isOrahWallet) {
      fetchDepFromWalletBalance(depositChain.id);
    }
  }, [open, tab, depositMode, depositChain.id, isOrahWallet, fetchDepFromWalletBalance]);

  // ── deposit-from-wallet: broadcast ──────────────────────────────────────
  const handleDepositFromWallet = async (depositAddress: string, nativeSymbol: string) => {
    const parsedAmt = parseFloat(depFromWalletAmount);
    if (!parsedAmt || !depositAddress || depFromWalletSending) return;
    setDepFromWalletSending(true);
    setDepFromWalletError(null);
    try {
      const account = await getViemAccountForAddress(walletAddress, {
        title: "Authorize deposit",
        subtitle: `Unlock your imported OrahDEX wallet to send ${depFromWalletAmount} ${nativeSymbol}.`,
      });
      const { createWalletClient, http, parseEther } = await import("viem");
      const chainDef = {
        id:             depositChain.id,
        name:           depositChain.short,
        nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: 18 },
        rpcUrls:        { default: { http: [CHAIN_RPC_URLS[depositChain.id]] } },
      } as const;
      const walletClient = createWalletClient({ account, chain: chainDef as any, transport: http(CHAIN_RPC_URLS[depositChain.id]) });
      const hash = await walletClient.sendTransaction({
        to:    depositAddress as `0x${string}`,
        value: parseEther(depFromWalletAmount),
      } as any);
      setDepFromWalletTxHash(hash);
      // Auto-fill the TX verify field so user can verify in one tap
      setTxHash(hash);
      toast({ title: "Deposit sent!", description: `${depFromWalletAmount} ${nativeSymbol} sent to OrahDEX. Tap Verify to credit your balance.` });
      addNotification({ type: "deposit", title: "Deposit Sent", body: `${depFromWalletAmount} ${nativeSymbol} sent on-chain. Verify to credit balance.` });
      setTimeout(() => fetchDepFromWalletBalance(depositChain.id), 4000);
    } catch (err: any) {
      const msg = err.shortMessage ?? err.message ?? "Transaction failed";
      setDepFromWalletError(msg);
      toast({ title: "Deposit failed", description: msg, variant: "destructive" });
    } finally {
      setDepFromWalletSending(false);
    }
  };

  // ── wallet send: EVM balance fetch ──────────────────────────────────────
  const fetchWalletBalance = useCallback(async (chain: WalletChain, token: WalletToken) => {
    if (!walletAddress) return;
    setWalletSendBalance(null);
    setWalletSendBalFetch(true);
    try {
      if (token.isNative) {
        // fetchEvmBalance handles wagmi, injected provider, and RPC fallbacks
        const bal = await fetchEvmBalance(walletAddress, chain.id);
        setWalletSendBalance(bal !== null ? parseFloat(bal) : null);
      } else if (token.address) {
        // ERC-20 balanceOf: try primary RPC then fallback
        const rpcs = [CHAIN_RPC_URLS[chain.id], CHAIN_RPC_FALLBACKS?.[chain.id]].filter(Boolean) as string[];
        const data  = "0x70a08231" + walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");
        let fetched = false;
        for (const rpc of rpcs) {
          try {
            const res = await fetch(rpc, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token.address, data }, "latest"] }),
            });
            if (!res.ok) continue;
            const json = await res.json();
            if (!json?.result) continue;
            const raw = BigInt(json.result);
            setWalletSendBalance(Number(raw) / Math.pow(10, token.decimals));
            fetched = true;
            break;
          } catch { continue; }
        }
        if (!fetched) setWalletSendBalance(null);
      }
    } catch {
      setWalletSendBalance(null);
    } finally {
      setWalletSendBalFetch(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (open && tab === "withdraw" && isOrahWallet && isEvmNetwork) {
      fetchWalletBalance(walletSendChain, walletSendToken);
    }
  }, [open, tab, walletSendChain, walletSendToken, isOrahWallet, isEvmNetwork, fetchWalletBalance]);

  // ── wallet send: non-EVM balance fetch (BSV, LTC, XRP, …) ───────────────
  const fetchNonEvmBalance = useCallback(async () => {
    const net     = withdrawChainMode.toLowerCase();
    const chainAddr = effectiveNonEvmAddresses?.[net] ?? (net !== "evm" ? undefined : walletAddress);
    if (!chainAddr) return;
    setNonEvmSendBalance(null);
    setNonEvmSendBalFetch(true);
    try {
      if (net === "bsv") {
        const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${chainAddr}/balance`);
        if (r.ok) {
          const { confirmed, unconfirmed } = await r.json();
          setNonEvmSendBalance(((confirmed ?? 0) + (unconfirmed ?? 0)) / 1e8);
        }
      } else if (net === "ltc") {
        const r = await fetch(`https://litecoinspace.org/api/address/${chainAddr}`);
        if (r.ok) {
          const d = await r.json();
          const funded = d.chain_stats?.funded_txo_sum ?? 0;
          const spent  = d.chain_stats?.spent_txo_sum  ?? 0;
          setNonEvmSendBalance((funded - spent) / 1e8);
        }
      } else if (net === "xrp") {
        const r = await fetch(`https://data.ripple.com/v2/accounts/${chainAddr}/balances`);
        if (r.ok) {
          const d = await r.json();
          const xrpEntry = (d.balances ?? []).find((b: any) => b.currency === "XRP");
          if (xrpEntry) setNonEvmSendBalance(parseFloat(xrpEntry.value));
        }
      } else if (net === "doge") {
        const r = await fetch(
          `https://api.blockchair.com/dogecoin/dashboards/address/${chainAddr}`,
        );
        if (r.ok) {
          const d = await r.json();
          const bal = d?.data?.[chainAddr]?.address?.balance;
          if (bal != null) setNonEvmSendBalance(Number(bal) / 1e8);
        }
      } else if (net === "trx") {
        const r = await fetch(`https://api.trongrid.io/v1/accounts/${chainAddr}`);
        if (r.ok) {
          const d = await r.json();
          const sun = d?.data?.[0]?.balance;
          if (sun != null) setNonEvmSendBalance(Number(sun) / 1_000_000);
        }
      } else if (net === "bch") {
        const addrKey = chainAddr.startsWith("bitcoincash:") ? chainAddr : `bitcoincash:${chainAddr}`;
        const r = await fetch(
          `https://api.blockchair.com/bitcoin-cash/dashboards/address/${encodeURIComponent(addrKey)}`,
        );
        if (r.ok) {
          const d   = await r.json();
          const key = Object.keys(d?.data ?? {})[0];
          const bal = d?.data?.[key]?.address?.balance;
          if (bal != null) setNonEvmSendBalance(Number(bal) / 1e8);
        }
      } else if (net === "sol") {
        const r = await fetch("https://api.mainnet-beta.solana.com", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [chainAddr] }),
        });
        if (r.ok) {
          const d = await r.json();
          const lamports = d?.result?.value;
          if (lamports != null) setNonEvmSendBalance(Number(lamports) / 1_000_000_000);
        }
      } else if (net === "btc") {
        const r = await fetch(`https://mempool.space/api/address/${chainAddr}`);
        if (r.ok) {
          const d = await r.json();
          const funded = d.chain_stats?.funded_txo_sum ?? 0;
          const spent  = d.chain_stats?.spent_txo_sum  ?? 0;
          setNonEvmSendBalance((funded - spent) / 1e8);
        }
      }
    } catch {
      setNonEvmSendBalance(null);
    } finally {
      setNonEvmSendBalFetch(false);
    }
  }, [walletAddress, effectiveNonEvmAddresses, withdrawChainMode]);

  useEffect(() => {
    if (open && tab === "withdraw" && (isOrahWallet || canSignNonEvm) && withdrawChainMode !== "evm") {
      fetchNonEvmBalance();
    }
  }, [open, tab, isOrahWallet, canSignNonEvm, withdrawChainMode, fetchNonEvmBalance]);

  // ── Resolve $handle to BSV address as user types ──────────────────────────
  useEffect(() => {
    const t = nonEvmSendRecipient.trim();
    if (withdrawChainMode !== "bsv" || !t || !isHandCashHandle(t)) {
      setHcHandleInfo(null);
      return;
    }
    const raw = t.replace(/^\$/, "").replace(/@handcash\.io$/i, "");
    let cancelled = false;
    setHcHandleFetching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/handcash/resolve-handle?handle=${encodeURIComponent(raw)}`);
        if (!cancelled && res.ok) {
          setHcHandleInfo(await res.json());
        } else if (!cancelled) {
          setHcHandleInfo(null);
        }
      } catch {
        if (!cancelled) setHcHandleInfo(null);
      } finally {
        if (!cancelled) setHcHandleFetching(false);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [nonEvmSendRecipient, withdrawChainMode]);

  // ── wallet send: non-EVM challenge/sign/broadcast ────────────────────────
  const handleNonEvmWalletSend = async () => {
    const parsedAmt = parseFloat(nonEvmSendAmount);
    if (!parsedAmt || !nonEvmSendRecipient.trim() || nonEvmSending) return;
    setNonEvmSending(true);
    setNonEvmSendError(null);
    try {
      const activeChain = withdrawChainMode.toLowerCase();
      const isBitcoinForkChain = ["bsv", "btc", "bch"].includes(activeChain);

      const chainAddress = isBitcoinForkChain
        ? (effectiveNonEvmAddresses?.[activeChain] ?? effectiveNonEvmAddresses?.[activeChain.toUpperCase()])
        : undefined;

      // ── BSV via HandCash: connected wallet + $handle recipient ──────────────
      // If the user has a HandCash wallet connected AND the recipient is a
      // $handle (or @handcash.io paymail), route the payment through the
      // HandCash SDK on the backend — no passkey or on-chain signing needed.
      if (activeChain === "bsv" && hcAuthToken && isHandCashHandle(nonEvmSendRecipient.trim())) {
        const destination = nonEvmSendRecipient.trim().replace(/^\$/, "").replace(/@handcash\.io$/i, "");
        const res = await fetch(`${API_BASE}/handcash/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ authToken: hcAuthToken, destination, amount: parsedAmt }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "HandCash payment failed");
        setNonEvmSendTxHash(data.txid ?? "submitted");
        toast({
          title:       "BSV sent via HandCash",
          description: `${parsedAmt} BSV → $${destination}. TXID: ${String(data.txid ?? "").slice(0, 16)}…`,
        });
        addNotification({
          type:  "withdrawal",
          title: "BSV Sent via HandCash",
          body:  `${parsedAmt} BSV sent to $${destination} via HandCash.`,
        });
        refetchHistory?.();
        useHandCashStore.getState().fetchBalance();
        return;
      }

      if (isBitcoinForkChain && !chainAddress) {
        throw new Error(
          `No ${activeChain.toUpperCase()} address found for this wallet. ` +
          "Please ensure your OrahWallet is set up correctly.",
        );
      }

      // ── BSV: direct on-chain transaction ────────────────────────────────────
      // Only used when the user has NO exchange balance (available === 0).
      // When available > 0, the user's BSV lives in the OrahDEX internal ledger
      // and must be withdrawn via /api/withdrawals (exchange path below), not
      // by building a raw P2PKH UTXO transaction.
      if (activeChain === "bsv" && available <= 0) {
        let recipient = nonEvmSendRecipient.trim();
        if (isHandCashHandle(recipient)) {
          const raw = recipient.replace(/^\$/, "").replace(/@handcash\.io$/i, "");
          const alreadyResolved = hcHandleInfo?.handle === raw ? hcHandleInfo.address : null;
          if (alreadyResolved) {
            recipient = alreadyResolved;
          } else {
            const rr = await fetch(`${API_BASE}/handcash/resolve-handle?handle=${encodeURIComponent(raw)}`);
            const rd = await rr.json();
            if (!rr.ok || !rd.address) throw new Error(`Could not resolve $${raw} to a BSV address. Enter the address directly or connect HandCash.`);
            recipient = rd.address;
          }
        }
        const result = await sendBsvFromAddress(
          resolvedSigningEvmAddress,
          chainAddress!,
          recipient,
          parsedAmt,
        );
        setNonEvmSendTxHash(result.txid);
        toast({
          title:       "BSV sent",
          description: `${parsedAmt} BSV sent on-chain. Fee: ${result.feeSat} sat. TXID: ${result.txid.slice(0, 16)}…`,
        });
        addNotification({
          type:  "withdrawal",
          title: "BSV Sent",
          body:  `${parsedAmt} BSV sent from wallet (fee: ${result.feeSat} sat).`,
          txid:  result.txid,
          href:  `https://whatsonchain.com/tx/${result.txid}`,
        });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 8_000);
        return;
      }

      // ── BTC: direct on-chain P2WPKH native-segwit ───────────────────────────
      if (activeChain === "btc") {
        const btcAddr = effectiveNonEvmAddresses?.["btc"] ?? effectiveNonEvmAddresses?.["BTC"];
        if (!btcAddr) throw new Error("No BTC address found for this wallet.");
        const result = await sendBtcFromAddress(
          resolvedSigningEvmAddress, btcAddr, nonEvmSendRecipient.trim(), parsedAmt,
        );
        setNonEvmSendTxHash(result.txid);
        toast({ title: "BTC sent", description: `${parsedAmt} BTC sent on-chain. Fee: ${result.feeSat} sat. TXID: ${result.txid.slice(0, 16)}…` });
        addNotification({ type: "withdrawal", title: "BTC Sent", body: `${parsedAmt} BTC sent from wallet (fee: ${result.feeSat} sat).`, txid: result.txid, href: `https://mempool.space/tx/${result.txid}` });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 8_000);
        return;
      }

      // ── LTC: direct on-chain P2PKH legacy ───────────────────────────────────
      if (activeChain === "ltc") {
        const ltcAddr = effectiveNonEvmAddresses?.["ltc"] ?? effectiveNonEvmAddresses?.["LTC"];
        if (!ltcAddr) throw new Error("No LTC address found for this wallet.");
        const result = await sendLtcFromAddress(
          resolvedSigningEvmAddress, ltcAddr, nonEvmSendRecipient.trim(), parsedAmt,
        );
        setNonEvmSendTxHash(result.txid);
        toast({ title: "LTC sent", description: `${parsedAmt} LTC sent on-chain. Fee: ${result.feeSat} lit. TXID: ${result.txid.slice(0, 16)}…` });
        addNotification({ type: "withdrawal", title: "LTC Sent", body: `${parsedAmt} LTC sent from wallet.`, txid: result.txid, href: `https://litecoinspace.org/tx/${result.txid}` });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 8_000);
        return;
      }

      // ── DOGE: direct on-chain P2PKH legacy ──────────────────────────────────
      if (activeChain === "doge") {
        const dogeAddr = effectiveNonEvmAddresses?.["doge"] ?? effectiveNonEvmAddresses?.["DOGE"];
        if (!dogeAddr) throw new Error("No DOGE address found for this wallet.");
        const result = await sendDogeFromAddress(
          resolvedSigningEvmAddress, dogeAddr, nonEvmSendRecipient.trim(), parsedAmt,
        );
        setNonEvmSendTxHash(result.txid);
        toast({ title: "DOGE sent", description: `${parsedAmt} DOGE sent on-chain. TXID: ${result.txid.slice(0, 16)}…` });
        addNotification({ type: "withdrawal", title: "DOGE Sent", body: `${parsedAmt} DOGE sent from wallet.`, txid: result.txid });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 8_000);
        return;
      }

      // ── XRP: direct on-chain Payment ────────────────────────────────────────
      if (activeChain === "xrp") {
        const xrpAddr = effectiveNonEvmAddresses?.["xrp"] ?? effectiveNonEvmAddresses?.["XRP"];
        if (!xrpAddr) throw new Error("No XRP address found for this wallet.");
        const result = await sendXrpFromAddress(
          resolvedSigningEvmAddress, xrpAddr, nonEvmSendRecipient.trim(), parsedAmt,
        );
        setNonEvmSendTxHash(result.txid);
        toast({ title: "XRP sent", description: `${parsedAmt} XRP sent on-chain. TXID: ${result.txid.slice(0, 16)}…` });
        addNotification({ type: "withdrawal", title: "XRP Sent", body: `${parsedAmt} XRP sent from wallet.`, txid: result.txid, href: `https://xrpscan.com/tx/${result.txid}` });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 8_000);
        return;
      }

      // ── TRX: direct on-chain transfer ────────────────────────────────────────
      if (activeChain === "trx") {
        const trxAddr = effectiveNonEvmAddresses?.["tron"] ?? effectiveNonEvmAddresses?.["trx"] ?? effectiveNonEvmAddresses?.["TRX"];
        if (!trxAddr) throw new Error("No TRX address found for this wallet.");
        const result = await sendTrxFromAddress(
          resolvedSigningEvmAddress, trxAddr, nonEvmSendRecipient.trim(), parsedAmt,
        );
        setNonEvmSendTxHash(result.txid);
        toast({ title: "TRX sent", description: `${parsedAmt} TRX sent on-chain. TXID: ${result.txid.slice(0, 16)}…` });
        addNotification({ type: "withdrawal", title: "TRX Sent", body: `${parsedAmt} TRX sent from wallet.`, txid: result.txid, href: `https://tronscan.org/#/transaction/${result.txid}` });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 8_000);
        return;
      }

      // ── BCH: direct on-chain BIP143+FORKID transaction ──────────────────────
      if (activeChain === "bch") {
        const bchAddr = effectiveNonEvmAddresses?.["bch"] ?? effectiveNonEvmAddresses?.["BCH"];
        if (!bchAddr) throw new Error("No BCH address found for this wallet.");
        const result = await sendBchFromAddress(
          resolvedSigningEvmAddress, bchAddr, nonEvmSendRecipient.trim(), parsedAmt,
        );
        setNonEvmSendTxHash(result.txid);
        toast({ title: "BCH sent", description: `${parsedAmt} BCH sent on-chain. Fee: ${result.feeSat} sat. TXID: ${result.txid.slice(0, 16)}…` });
        addNotification({ type: "withdrawal", title: "BCH Sent", body: `${parsedAmt} BCH sent from wallet (fee: ${result.feeSat} sat).`, txid: result.txid, href: `https://blockchair.com/bitcoin-cash/transaction/${result.txid}` });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 8_000);
        return;
      }

      // ── SOL: direct on-chain ed25519 SystemProgram.transfer ─────────────────
      if (activeChain === "sol") {
        const solAddr = effectiveNonEvmAddresses?.["sol"] ?? effectiveNonEvmAddresses?.["SOL"];
        if (!solAddr) throw new Error("No SOL address found for this wallet.");
        const result = await sendSolFromAddress(
          resolvedSigningEvmAddress, solAddr, nonEvmSendRecipient.trim(), parsedAmt,
        );
        setNonEvmSendTxHash(result.txid);
        toast({ title: "SOL sent", description: `${parsedAmt} SOL sent on-chain. TXID: ${result.txid.slice(0, 16)}…` });
        addNotification({ type: "withdrawal", title: "SOL Sent", body: `${parsedAmt} SOL sent from wallet.`, txid: result.txid, href: `https://solscan.io/tx/${result.txid}` });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 8_000);
        return;
      }

      // ── Exchange withdrawal path (fallback for any remaining chains) ─────────
      if (isBitcoinForkChain) {
        const challengeRes = await fetch(`${API_BASE}/withdraw/challenge`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ walletAddress, ...(chainAddress ? { bsvAddress: chainAddress } : {}) }),
        });
        if (!challengeRes.ok) {
          const err = await challengeRes.json().catch(() => ({}));
          throw new Error(err.error ?? "Failed to get withdrawal challenge");
        }
        const { message } = await challengeRes.json();
        const signature = await signBsvChallengeFromAddress(resolvedSigningEvmAddress, message);
        const wAsset = withdrawChainMode.toUpperCase();
        const withdrawRes = await fetch(`${API_BASE}/withdrawals`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            walletAddress, asset: wAsset, amount: parsedAmt,
            network: withdrawChainMode, networkLabel: wAsset,
            recipient: nonEvmSendRecipient.trim(), signature,
            ...(chainAddress ? { bsvSignerAddress: chainAddress } : {}),
          }),
        });
        const data = await withdrawRes.json().catch(() => ({}));
        if (!withdrawRes.ok) throw new Error(data.error ?? "Withdrawal failed");
        setNonEvmSendTxHash(data.txid ?? "submitted");
        toast({ title: "Withdrawal submitted", description: `${parsedAmt} ${wAsset} withdrawal is processing.` });
        addNotification({ type: "withdrawal", title: "Withdrawal Processing", body: `${parsedAmt} ${wAsset} sent from wallet.` });
        refetchHistory?.();
        setTimeout(() => fetchNonEvmBalance(), 6_000);
        return;
      }

      throw new Error(`On-chain signing not supported for ${activeChain.toUpperCase()}`);
    } catch (err: any) {
      const msg = err?.message ?? "Transaction failed";
      setNonEvmSendError(msg);
      toast({ title: "Send failed", description: msg, variant: "destructive" });
    } finally {
      setNonEvmSending(false);
    }
  };

  // ── wallet send: broadcast ───────────────────────────────────────────────
  const handleWalletSend = async () => {
    const parsedWalletAmount = parseFloat(walletSendAmount);
    if (!parsedWalletAmount || !walletSendRecipient.trim() || walletSending) return;
    setWalletSending(true);
    setWalletSendError(null);
    try {
      // ── Hardware wallet signing path ──────────────────────────────────────
      if (isHardwareWallet) {
        const deviceName = hardwareWalletType
          ? hardwareWalletType.charAt(0).toUpperCase() + hardwareWalletType.slice(1)
          : "hardware wallet";
        toast({ title: `Sign on your ${deviceName}`, description: "Approve the transaction on your device." });

        if (hardwareWalletType === "ledger") {
          const { dmkConnect, dmkSignTransaction, dmkDisconnect, dmkErrMsg } = await import("@/lib/ledgerDMK");
          const {
            createPublicClient, http, parseEther, parseUnits, serializeTransaction,
            encodeFunctionData,
          } = await import("viem");

          const chainDef = {
            id:         walletSendChain.id,
            name:       walletSendChain.name,
            nativeCurrency: { name: walletSendChain.symbol, symbol: walletSendChain.symbol, decimals: 18 },
            rpcUrls:    { default: { http: [CHAIN_RPC_URLS[walletSendChain.id]] } },
          } as const;

          const publicClient = createPublicClient({ chain: chainDef as any, transport: http(CHAIN_RPC_URLS[walletSendChain.id]) });
          const sender = walletAddress as `0x${string}`;
          const to     = walletSendRecipient.trim() as `0x${string}`;

          const [nonce, gasPrice, feeData] = await Promise.all([
            publicClient.getTransactionCount({ address: sender }),
            publicClient.getGasPrice(),
            publicClient.estimateFeesPerGas().catch(() => null),
          ]);

          let txData: `0x${string}` = "0x";
          let txValue = 0n;
          if (walletSendToken.isNative) {
            txValue = parseEther(walletSendAmount);
          } else {
            txData = encodeFunctionData({
              abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable",
                inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }],
                outputs: [{ name: "", type: "bool" }] }],
              functionName: "transfer",
              args: [to, parseUnits(walletSendAmount, walletSendToken.decimals)],
            });
          }

          const txTarget  = walletSendToken.isNative ? to : (walletSendToken.address as `0x${string}`);
          const gas       = await publicClient.estimateGas({ account: sender, to: txTarget, value: txValue, data: txData });
          const maxFee    = feeData?.maxFeePerGas        ?? gasPrice;
          const maxPrio   = feeData?.maxPriorityFeePerGas ?? gasPrice / 10n;

          const unsignedTx = {
            type:                 "eip1559" as const,
            chainId:              walletSendChain.id,
            nonce,
            gas,
            maxFeePerGas:         maxFee,
            maxPriorityFeePerGas: maxPrio,
            to:                   txTarget,
            value:                txValue,
            data:                 txData,
          };

          // Open Ledger DMK session, sign, broadcast
          let dmkSessionId: string | null = null;
          try {
            const dmkSess  = await dmkConnect();
            dmkSessionId   = dmkSess.sessionId;
            const derivPath = useWalletStore.getState().hardwareWalletPath ?? "m/44'/60'/0'/0/0";

            const signedTx = await dmkSignTransaction(dmkSess.sessionId, derivPath, {
              chainId:              unsignedTx.chainId,
              to:                   unsignedTx.to,
              value:                unsignedTx.value,
              data:                 unsignedTx.data,
              nonce:                unsignedTx.nonce,
              gasLimit:             unsignedTx.gas,
              maxFeePerGas:         unsignedTx.maxFeePerGas,
              maxPriorityFeePerGas: unsignedTx.maxPriorityFeePerGas,
            });

            const hash = await publicClient.sendRawTransaction({ serializedTransaction: signedTx as `0x${string}` });
            setWalletSendTxHash(hash);
            toast({ title: "Transaction sent!", description: `${walletSendAmount} ${walletSendToken.symbol} is being confirmed on-chain.` });
            addNotification({
              type: "withdrawal",
              title: "Ledger Transfer Sent",
              body: `${walletSendAmount} ${walletSendToken.symbol} sent via Ledger on ${walletSendChain.name}. TX: ${hash.slice(0, 12)}…`,
            });
            setTimeout(() => fetchWalletBalance(walletSendChain, walletSendToken), 4000);
          } catch (err: unknown) {
            const msg = dmkErrMsg(err);
            setWalletSendError(msg);
            toast({ title: "Ledger signing failed", description: msg, variant: "destructive" });
          } finally {
            if (dmkSessionId) dmkDisconnect(dmkSessionId).catch(() => {});
            setWalletSending(false);
          }
          return;
        }

        // Trezor / Keystone / GridPlus — show instruction
        setWalletSendError(`${deviceName} transaction signing — connect your device and use ${deviceName} Suite to broadcast.`);
        setWalletSending(false);
        return;
      }

      // ── Software wallet signing path (passkey / private key) ────────────
      const account = await getViemAccountForAddress(walletAddress, {
        title: "Authorize transfer",
        subtitle: `Unlock your imported OrahDEX wallet to send ${walletSendAmount} ${walletSendToken.symbol}.`,
      });

      const { createWalletClient, http, parseEther, parseUnits } = await import("viem");
      // build minimal chain object viem needs
      const chainDef = {
        id:         walletSendChain.id,
        name:       walletSendChain.name,
        nativeCurrency: { name: walletSendChain.symbol, symbol: walletSendChain.symbol, decimals: 18 },
        rpcUrls:    { default: { http: [CHAIN_RPC_URLS[walletSendChain.id]] } },
      } as const;

      const walletClient = createWalletClient({ account, chain: chainDef as any, transport: http(CHAIN_RPC_URLS[walletSendChain.id]) });

      let hash: `0x${string}`;
      if (walletSendToken.isNative) {
        hash = await walletClient.sendTransaction({
          to:    walletSendRecipient.trim() as `0x${string}`,
          value: parseEther(walletSendAmount),
        } as any);
      } else {
        hash = await walletClient.writeContract({
          address:      walletSendToken.address as `0x${string}`,
          abi:          ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [
            walletSendRecipient.trim() as `0x${string}`,
            parseUnits(walletSendAmount, walletSendToken.decimals),
          ],
        } as any);
      }

      setWalletSendTxHash(hash);
      toast({ title: "Transaction sent!", description: `${walletSendAmount} ${walletSendToken.symbol} is being confirmed on-chain.` });
      addNotification({
        type: "withdrawal",
        title: "On-Chain Transfer Sent",
        body: `${walletSendAmount} ${walletSendToken.symbol} sent on ${walletSendChain.name}. TX: ${hash.slice(0, 12)}…`,
      });
      // refresh balance after a short delay
      setTimeout(() => fetchWalletBalance(walletSendChain, walletSendToken), 4000);
    } catch (err: any) {
      const msg = err.shortMessage ?? err.message ?? "Transaction failed";
      setWalletSendError(msg);
      toast({ title: "Transfer failed", description: msg, variant: "destructive" });
    } finally {
      setWalletSending(false);
    }
  };

  // ── verify deposit TX ────────────────────────────────────────────────────
  const handleVerify = async () => {
    if (!txHash.trim()) return;
    setVerifying(true);
    try {
      const r = await fetch(`${API_BASE}/deposit/verify`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, txHash: txHash.trim(), chainId: depositChain.id }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Verification failed");
      toast({ title: "Deposit credited!", description: `${data.amount} ${data.asset} added to your OrahDEX balance.` });
      setTxHash("");
      refetchDeposit();
    } catch (err: any) {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
    } finally {
      setVerifying(false);
    }
  };

  const copy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const statusStyle = (s: string) => {
    if (s === "completed")  return "text-green-400  bg-green-400/10  border-green-400/20";
    if (s === "failed")     return "text-red-400    bg-red-400/10    border-red-400/20";
    if (s === "cancelled")  return "text-orange-400 bg-orange-400/10 border-orange-400/20";
    if (s === "processing") return "text-blue-400   bg-blue-400/10   border-blue-400/20";
    return "text-yellow-400 bg-yellow-400/10 border-yellow-400/20";
  };

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md max-h-[90dvh] overflow-y-auto bg-background border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm border shrink-0"
              style={{ backgroundColor: color + "22", borderColor: color + "44", color }}
            >
              {(withdrawChainMode !== "evm" ? withdrawChainMode.toUpperCase() : asset)[0]}
            </div>
            <span>
              {!visibleTabs || visibleTabs.length === 3
                ? "Deposit & Withdraw"
                : visibleTabs.includes("deposit") && !visibleTabs.includes("withdraw")
                  ? "Deposit"
                  : visibleTabs.includes("withdraw") && !visibleTabs.includes("deposit")
                    ? "Withdraw"
                    : "Deposit & Withdraw"}
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* Tab bar — hidden when only one tab is shown */}
        {(!visibleTabs || visibleTabs.length > 1) && (
          <div className="flex gap-1 p-1 rounded-xl bg-secondary/30">
            {([
              { key: "deposit",  label: "Deposit",  icon: <Download className="w-3.5 h-3.5" /> },
              { key: "withdraw", label: "Withdraw", icon: <Upload    className="w-3.5 h-3.5" /> },
              { key: "history",  label: "History",  icon: <History   className="w-3.5 h-3.5" />, badge: history.length },
            ] as const).filter(t => !visibleTabs || visibleTabs.includes(t.key)).map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex-1 py-1.5 rounded-lg text-sm font-semibold transition-all",
                  tab === t.key
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="flex items-center justify-center gap-1.5">
                  {t.icon}
                  {t.label}
                  {"badge" in t && t.badge > 0 && (
                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-primary/20 text-primary">
                      {t.badge}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── DEPOSIT TAB ──────────────────────────────────────────────────── */}
        {tab === "deposit" && (
          <div className="space-y-4">

            {/* ── BITCOIN FORK DEPOSIT UI (BSV / BTC / BCH) ── */}
            {isBitcoinFork && bitcoinDepositLoading && (
              <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading deposit address…</span>
              </div>
            )}

            {isBitcoinFork && !bitcoinDepositLoading && bitcoinDepositData?.supported && (
              <div className="space-y-3">
                    {/* Mode toggle */}
                    <div className="flex gap-1 p-1 rounded-xl bg-secondary/30">
                      <button
                        onClick={() => setDepositMode("exchange")}
                        className={cn("flex-1 py-2 rounded-lg text-xs font-bold transition-all",
                          depositMode === "exchange" ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"
                        )}
                      >Exchange Address</button>
                      <button
                        onClick={() => setDepositMode("wallet")}
                        className={cn("flex-1 py-2 rounded-lg text-xs font-bold transition-all",
                          depositMode === "wallet" ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"
                        )}
                      >Wallet Address</button>
                    </div>

                    {depositMode === "exchange" && bitcoinDepositData.address && (
                      <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-orange-400" />
                          <p className="text-xs font-bold text-orange-400 uppercase tracking-wide">OrahDEX {bitcoinDepositData.symbol} Deposit Address</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground -mt-1">
                          Funds sent here are credited to your <strong className="text-foreground">OrahDEX trading balance</strong>.
                        </p>
                        <div className="flex flex-col items-center gap-3">
                          <div className="p-3 bg-white rounded-xl shadow-sm">
                            <QRCodeCanvas value={bitcoinDepositData.address} size={148} level="M" includeMargin={false} />
                          </div>
                          <p className="text-[11px] text-muted-foreground">{bitcoinDepositData.label} Network</p>
                        </div>
                        <div className="flex items-center gap-2 bg-background/60 rounded-lg px-3 py-2 border border-orange-500/20">
                          <span className="font-mono text-xs text-foreground/80 flex-1 break-all select-all leading-relaxed">
                            {bitcoinDepositData.address}
                          </span>
                          <button onClick={() => copy(bitcoinDepositData.address!, "btc-dep-addr")} className="shrink-0 p-1 rounded-lg hover:bg-muted transition-colors">
                            {copiedId === "btc-dep-addr" ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded-lg bg-background/50 px-2.5 py-2 space-y-0.5">
                            <p className="text-muted-foreground">Accepted asset</p>
                            <p className="font-bold">{bitcoinDepositData.symbol} (native)</p>
                          </div>
                          <div className="rounded-lg bg-background/50 px-2.5 py-2 space-y-0.5">
                            <p className="text-muted-foreground">Min deposit</p>
                            <p className="font-bold">{bitcoinDepositData.minDeposit} {bitcoinDepositData.symbol}</p>
                          </div>
                        </div>

                        {/* BSV verify TX */}
                        <div className="space-y-2">
                          <label className="text-sm font-semibold">I've sent funds — verify deposit</label>
                          <div className="flex gap-2">
                            <Input
                              value={bsvTxHash}
                              onChange={e => setBsvTxHash(e.target.value.trim())}
                              placeholder="BSV transaction ID (txid)"
                              className="font-mono text-xs flex-1"
                            />
                            <Button onClick={handleBsvVerify} disabled={!bsvTxHash.trim() || bsvVerifying} size="sm" className="shrink-0 gap-1.5">
                              {bsvVerifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                              Verify
                            </Button>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            Paste the transaction ID from your BSV wallet after sending. Funds are credited instantly upon confirmation.
                          </p>
                        </div>

                        {/* ── SPV Pending Deposits ─────────────────────────── */}
                        {bsvPendingDeposits.length > 0 && (
                          <div className="space-y-2 pt-2 border-t border-orange-500/20">
                            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                              Auto-Detected Deposits
                            </p>
                            {bsvPendingDeposits.map(dep => (
                              <div
                                key={dep.txid}
                                className="flex items-center justify-between gap-2 rounded-lg bg-background/50 px-3 py-2 border border-border/40"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  {dep.status === "mempool" ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-yellow-400 bg-yellow-400/10 rounded-full px-2 py-0.5 shrink-0">
                                      <Clock className="w-2.5 h-2.5" /> Pending
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-green-400 bg-green-400/10 rounded-full px-2 py-0.5 shrink-0">
                                      <CheckCircle2 className="w-2.5 h-2.5" />
                                      {dep.confirmations !== null
                                        ? `${dep.confirmations} conf.`
                                        : dep.blockHeight
                                          ? `Block ${dep.blockHeight}`
                                          : "Confirmed"}
                                    </span>
                                  )}
                                  <span className="font-mono text-[11px] text-muted-foreground truncate">
                                    {dep.txid.slice(0, 10)}…
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className="text-xs font-bold">{dep.amountBsv} BSV</span>
                                  <a
                                    href={dep.explorerUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-orange-400 hover:text-orange-300 transition-colors"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {bitcoinDepositData.explorerAddress && (
                          <a href={bitcoinDepositData.explorerAddress} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1.5 text-[11px] text-orange-400 hover:text-orange-300 transition-colors">
                            <ExternalLink className="w-3 h-3" /> View address on explorer
                          </a>
                        )}
                      </div>
                    )}

                    {depositMode === "wallet" && (
                      <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 space-y-4">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-green-400" />
                          <p className="text-xs font-bold text-green-400 uppercase tracking-wide">Your Personal {bitcoinDepositData.symbol} Wallet Address</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground -mt-2">
                          Funds sent here go <strong className="text-foreground">directly to your wallet</strong> — not to your OrahDEX trading balance. Use this for personal receives.
                        </p>
                        {walletAddress && /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(walletAddress) ? (
                          <>
                            <div className="flex flex-col items-center gap-3">
                              <div className="p-3 bg-white rounded-xl shadow-sm">
                                <QRCodeCanvas value={walletAddress} size={148} level="M" includeMargin={false} />
                              </div>
                              <p className="text-[11px] text-muted-foreground">{bitcoinDepositData.label} · P2PKH</p>
                            </div>
                            <div className="flex items-center gap-2 bg-background/60 rounded-lg px-3 py-2 border border-green-500/20">
                              <span className="font-mono text-xs text-foreground/80 flex-1 break-all select-all leading-relaxed">{walletAddress}</span>
                              <button onClick={() => copy(walletAddress, "bsv-wallet-addr")} className="shrink-0 p-1 rounded-lg hover:bg-muted transition-colors">
                                {copiedId === "bsv-wallet-addr" ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
                            <AlertCircle className="w-8 h-8 opacity-40" />
                            <p className="text-sm text-center">Connect a {bitcoinDepositData.symbol} wallet to see your personal address.</p>
                          </div>
                        )}
                      </div>
                    )}
              </div>
            )}

            {/* ── BTC/BCH: coming soon ── */}
            {isBitcoinFork && !bitcoinDepositLoading && !bitcoinDepositData?.supported && (
              <div className="space-y-4">
                <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
                    <p className="text-xs font-bold text-yellow-400 uppercase tracking-wide">Exchange Deposit Coming Soon</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {bitcoinDepositData?.message ?? `${network.toUpperCase()} exchange deposits are not yet available. You can still receive ${network.toUpperCase()} to your personal wallet address below.`}
                  </p>
                </div>

                {walletAddress && (
                  <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 space-y-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-400" />
                      <p className="text-xs font-bold text-green-400 uppercase tracking-wide">Your Personal Wallet Address</p>
                    </div>
                    <div className="flex flex-col items-center gap-3">
                      <div className="p-3 bg-white rounded-xl shadow-sm">
                        <QRCodeCanvas value={walletAddress} size={148} level="M" includeMargin={false} />
                      </div>
                      <p className="text-[11px] text-muted-foreground">{networkLabel}</p>
                    </div>
                    <div className="flex items-center gap-2 bg-background/60 rounded-lg px-3 py-2 border border-green-500/20">
                      <span className="font-mono text-xs text-foreground/80 flex-1 break-all select-all leading-relaxed">{walletAddress}</span>
                      <button onClick={() => copy(walletAddress, "btc-wallet-addr")} className="shrink-0 p-1 rounded-lg hover:bg-muted transition-colors">
                        {copiedId === "btc-wallet-addr" ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── SOLANA: loading ── */}
            {isSolana && solanaDepositLoading && (
              <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading Solana deposit address…</span>
              </div>
            )}

            {/* ── SOLANA: exchange address + verify TX ── */}
            {isSolana && !solanaDepositLoading && solanaDepositData?.supported && solanaDepositData.address && (
              <div className="space-y-3">
                <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-purple-400" />
                    <p className="text-xs font-bold text-purple-400 uppercase tracking-wide">OrahDEX Solana Deposit Address</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Funds sent here are credited to your <strong className="text-foreground">OrahDEX trading balance</strong>. Send only SOL (native) to this address.
                  </p>
                  <div className="flex flex-col items-center gap-3">
                    <div className="p-3 bg-white rounded-xl shadow-sm">
                      <QRCodeCanvas value={solanaDepositData.address} size={148} level="M" includeMargin={false} />
                    </div>
                    <p className="text-[11px] text-muted-foreground">Solana Mainnet</p>
                  </div>
                  <div className="flex items-center gap-2 bg-background/60 rounded-lg px-3 py-2 border border-purple-500/20">
                    <span className="font-mono text-xs text-foreground/80 flex-1 break-all select-all leading-relaxed">
                      {solanaDepositData.address}
                    </span>
                    <button onClick={() => copy(solanaDepositData.address!, "sol-dep-addr")} className="shrink-0 p-1 rounded-lg hover:bg-muted transition-colors">
                      {copiedId === "sol-dep-addr" ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-background/50 px-2.5 py-2 space-y-0.5">
                      <p className="text-muted-foreground">Accepted asset</p>
                      <p className="font-bold">SOL (native)</p>
                    </div>
                    <div className="rounded-lg bg-background/50 px-2.5 py-2 space-y-0.5">
                      <p className="text-muted-foreground">Min deposit</p>
                      <p className="font-bold">{solanaDepositData.minDeposit} SOL</p>
                    </div>
                  </div>

                  {/* Solana verify TX */}
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">I've sent SOL — verify deposit</label>
                    <div className="flex gap-2">
                      <Input
                        value={solTxHash}
                        onChange={e => setSolTxHash(e.target.value.trim())}
                        placeholder="Solana transaction signature"
                        className="font-mono text-xs flex-1"
                      />
                      <Button onClick={handleSolVerify} disabled={!solTxHash.trim() || solVerifying} size="sm" className="shrink-0 gap-1.5">
                        {solVerifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        Verify
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Paste the transaction signature from your Solana wallet after sending. Funds are credited instantly upon on-chain confirmation.
                    </p>
                  </div>

                  {solanaDepositData.explorerAddress && (
                    <a href={solanaDepositData.explorerAddress} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-[11px] text-purple-400 hover:text-purple-300 transition-colors">
                      <ExternalLink className="w-3 h-3" /> View address on Solscan
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* ── SOLANA: not yet supported ── */}
            {isSolana && !solanaDepositLoading && !solanaDepositData?.supported && (
              <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
                  <p className="text-xs font-bold text-yellow-400 uppercase tracking-wide">Exchange Deposit Coming Soon</p>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {solanaDepositData?.message ?? "Solana exchange deposits are being configured. Please check back soon."}
                </p>
              </div>
            )}

            {/* ── ALTCHAIN: loading ── */}
            {isAltChain && altchainLoading && (
              <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading deposit address…</span>
              </div>
            )}

            {/* ── ALTCHAIN: exchange address + 24hr credit notice ── */}
            {isAltChain && !altchainLoading && altchainData?.supported && altchainData.address && (
              <div className="space-y-3">
                <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-400" />
                    <p className="text-xs font-bold text-blue-400 uppercase tracking-wide">
                      OrahDEX {altchainData.symbol} Deposit Address
                    </p>
                  </div>
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Send <strong className="text-foreground">{altchainData.symbol}</strong> to this address. Your OrahDEX trading balance is credited within <strong className="text-foreground">24 hours</strong> after network confirmation.
                  </p>
                  <div className="flex flex-col items-center gap-3">
                    <div className="p-3 bg-white rounded-xl shadow-sm">
                      <QRCodeCanvas value={altchainData.address} size={148} level="M" includeMargin={false} />
                    </div>
                    <p className="text-[11px] text-muted-foreground">{altchainData.label ?? networkLabel}</p>
                  </div>
                  <div className="flex items-center gap-2 bg-background/60 rounded-lg px-3 py-2 border border-blue-500/20">
                    <span className="font-mono text-xs text-foreground/80 flex-1 break-all select-all leading-relaxed">
                      {altchainData.address}
                    </span>
                    <button onClick={() => copy(altchainData.address!, "alt-dep-addr")} className="shrink-0 p-1 rounded-lg hover:bg-muted transition-colors">
                      {copiedId === "alt-dep-addr" ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                    </button>
                  </div>
                  {altchainData.minDeposit && (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg bg-background/50 px-2.5 py-2 space-y-0.5">
                        <p className="text-muted-foreground">Accepted asset</p>
                        <p className="font-bold">{altchainData.symbol} (native)</p>
                      </div>
                      <div className="rounded-lg bg-background/50 px-2.5 py-2 space-y-0.5">
                        <p className="text-muted-foreground">Min deposit</p>
                        <p className="font-bold">{altchainData.minDeposit} {altchainData.symbol}</p>
                      </div>
                    </div>
                  )}
                  {altchainData.explorerAddress && (
                    <a href={altchainData.explorerAddress} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-[11px] text-blue-400 hover:text-blue-300 transition-colors">
                      <ExternalLink className="w-3 h-3" /> View address on explorer
                    </a>
                  )}
                </div>
                <div className="flex gap-2.5 p-3 rounded-xl bg-blue-500/5 border border-blue-500/20">
                  <Zap className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    After sending, your deposit will be automatically detected and credited to your OrahDEX balance within 24 hours. No manual verification needed.
                  </p>
                </div>
              </div>
            )}

            {/* ── ALTCHAIN: not yet supported ── */}
            {isAltChain && !altchainLoading && !altchainData?.supported && (
              <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
                  <p className="text-xs font-bold text-yellow-400 uppercase tracking-wide">
                    {altchainData?.symbol ?? network.toUpperCase()} Exchange Deposits Coming Soon
                  </p>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {altchainData?.message ?? `${network.toUpperCase()} exchange deposits are being set up. Please check back soon or contact support.`}
                </p>
              </div>
            )}

            {/* ── EVM WALLET ADDRESS (non-Bitcoin, non-Solana, non-AltChain assets) ── */}
            {!isNonEvm && (<>
            {/* ── WALLET ADDRESS ── */}
            {walletAddress && (
              <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 space-y-4">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2 h-2 rounded-full bg-green-400" />
                  <p className="text-xs font-bold text-green-400 uppercase tracking-wide">Your Personal Wallet Address</p>
                </div>
                <p className="text-[11px] text-muted-foreground -mt-2">
                  Funds sent here go <strong className="text-foreground">directly to your wallet</strong> — not to your OrahDEX trading balance. Use this for personal receives.
                </p>

                {/* QR code */}
                <div className="flex flex-col items-center gap-3">
                  <div className="p-3 bg-white rounded-xl shadow-sm">
                    <QRCodeCanvas
                      value={walletAddress}
                      size={148}
                      level="M"
                      includeMargin={false}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">EVM · Ethereum / Base / BNB Chain / all L2s</p>
                </div>

                {/* Address row */}
                <div className="flex items-center gap-2 bg-background/60 rounded-lg px-3 py-2 border border-green-500/20">
                  <span className="font-mono text-xs text-foreground/80 flex-1 break-all select-all leading-relaxed">
                    {walletAddress}
                  </span>
                  <button
                    onClick={() => copy(walletAddress, "wallet-addr")}
                    className="shrink-0 p-1 rounded-lg hover:bg-muted transition-colors"
                  >
                    {copiedId === "wallet-addr"
                      ? <Check className="w-4 h-4 text-green-400" />
                      : <Copy className="w-4 h-4 text-muted-foreground" />}
                  </button>
                </div>

                <div className="flex gap-2.5 p-3 rounded-xl bg-green-500/8 border border-green-500/20">
                  <Zap className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    This is your OrahDEX passkey wallet address. Anyone can send EVM tokens here directly.
                  </p>
                </div>
              </div>
            )}

            </>)}

          </div>
        )}

        {/* ── WITHDRAW TAB ─────────────────────────────────────────────────── */}
        {tab === "withdraw" && (
          <div className="space-y-4">

            {/* ── Chain family selector ────────────────────────────────── */}
            <div className="flex flex-wrap gap-1.5">
              {NON_EVM_WITHDRAW_CHAINS.map(ch => (
                <button
                  key={ch.id}
                  onClick={() => setWithdrawChainMode(ch.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all",
                    withdrawChainMode === ch.id
                      ? "border-2"
                      : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                  )}
                  style={withdrawChainMode === ch.id
                    ? { borderColor: ch.color, backgroundColor: ch.color + "22", color: ch.color }
                    : {}}
                >
                  {ch.label}
                </button>
              ))}
            </div>

            {/* ── WALLET SEND — non-EVM (BSV, LTC, XRP…) ───────────────── */}
            {withdrawChainMode !== "evm" && (
              <>
                {/* Balance display — prefer OrahDEX exchange balance when available */}
                {available > 0 ? (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/25">
                    <div>
                      <p className="text-xs text-emerald-400 font-medium">OrahDEX Balance</p>
                      <p className="text-sm font-bold font-mono text-foreground">
                        {available.toFixed(8)} {withdrawChainMode.toUpperCase()}
                      </p>
                    </div>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase tracking-wide">
                      Trading
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-secondary/30 border border-border">
                    <div>
                      <p className="text-xs text-muted-foreground">On-chain Balance</p>
                      <p className="text-sm font-bold font-mono text-foreground">
                        {nonEvmSendBalFetch
                          ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</span>
                          : nonEvmSendBalance !== null
                            ? `${nonEvmSendBalance.toFixed(8)} ${withdrawChainMode.toUpperCase()}`
                            : <span className="text-muted-foreground/60">—</span>
                        }
                      </p>
                    </div>
                    <button
                      onClick={fetchNonEvmBalance}
                      disabled={nonEvmSendBalFetch}
                      className="text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-40"
                    >
                      Refresh
                    </button>
                  </div>
                )}

                {/* Amount */}
                {/* effectiveMax: exchange balance takes priority over on-chain balance */}
                {(() => {
                  const effectiveMax = available > 0 ? available : nonEvmSendBalance;
                  return (
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold">Amount ({withdrawChainMode.toUpperCase()})</label>
                  <div className="relative">
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      placeholder={`0.00 ${withdrawChainMode.toUpperCase()}`}
                      value={nonEvmSendAmount}
                      onChange={e => setNonEvmSendAmount(e.target.value)}
                      className="h-11 pr-14 font-mono"
                    />
                    {effectiveMax !== null && (
                      <button
                        onClick={() => setNonEvmSendAmount((Math.floor(effectiveMax * 1e8) / 1e8).toFixed(8))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-bold text-primary hover:text-primary/80 px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 transition-colors"
                      >
                        MAX
                      </button>
                    )}
                  </div>
                  {effectiveMax !== null && parseFloat(nonEvmSendAmount) > effectiveMax && (
                    <p className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Exceeds {available > 0 ? "OrahDEX" : "wallet"} balance
                    </p>
                  )}
                </div>
                  );
                })()}

                {/* Recipient */}
                {/* HandCash connected banner (BSV only) */}
                {hcProfile && withdrawChainMode.toLowerCase() === "bsv" && (
                  <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
                    <span className="text-base leading-none shrink-0 select-none">✋</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-emerald-300">${hcProfile.handle} · HandCash connected</p>
                      <p className="text-[10px] text-emerald-400/80">Type a <span className="font-mono">$handle</span> below to send BSV via HandCash without a passkey.</p>
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-sm font-semibold">
                    Recipient address
                    {withdrawChainMode.toLowerCase() === "bsv" && (
                      <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">or <span className="font-mono text-emerald-400">$handle</span></span>
                    )}
                  </label>
                  {/* Address book suggestions */}
                  {(() => {
                    const chain = withdrawChainMode.toUpperCase();
                    const { getByChain } = useAddressBookStore.getState();
                    const entries = getByChain(chain);
                    if (!entries.length || nonEvmSendRecipient) return null;
                    return (
                      <div className="flex flex-col gap-1">
                        {entries.map(e => {
                          const meta = WALLET_TYPE_META[e.walletType];
                          return (
                            <button
                              key={e.id}
                              type="button"
                              onClick={() => setNonEvmSendRecipient(e.address)}
                              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-muted/30 border border-border hover:bg-muted/50 text-left transition-colors"
                            >
                              <span className="text-base leading-none">{meta.icon}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-semibold truncate">{e.nickname}</span>
                                  <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0", meta.color)}>{meta.label}</span>
                                </div>
                                <span className="text-[10px] text-muted-foreground font-mono truncate block">{e.address}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                  <Input
                    placeholder={withdrawChainMode.toLowerCase() === "bsv" ? "$handle or BSV address" : addressPlaceholder}
                    value={nonEvmSendRecipient}
                    onChange={e => setNonEvmSendRecipient(e.target.value)}
                    className="h-11 font-mono text-xs"
                  />
                  {/* HandCash handle resolution preview */}
                  {withdrawChainMode.toLowerCase() === "bsv" && nonEvmSendRecipient.trim() && isHandCashHandle(nonEvmSendRecipient.trim()) && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border">
                      {hcHandleFetching ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" /><span className="text-xs text-muted-foreground">Resolving handle…</span></>
                      ) : hcHandleInfo ? (
                        <>
                          {hcHandleInfo.avatarUrl ? (
                            <img src={hcHandleInfo.avatarUrl} alt={hcHandleInfo.handle} className="w-5 h-5 rounded-full shrink-0 object-cover" />
                          ) : (
                            <span className="text-sm leading-none select-none shrink-0">✋</span>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-semibold text-foreground truncate">{hcHandleInfo.displayName} <span className="text-emerald-400 font-mono">${hcHandleInfo.handle}</span></p>
                            {hcHandleInfo.address && (
                              <p className="text-[9px] text-muted-foreground font-mono truncate">{hcHandleInfo.address.slice(0, 28)}…</p>
                            )}
                          </div>
                          {hcAuthToken
                            ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">via HandCash</span>
                            : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">on-chain</span>
                          }
                        </>
                      ) : (
                        <><AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" /><span className="text-xs text-muted-foreground">Handle not found or could not be resolved</span></>
                      )}
                    </div>
                  )}
                </div>

                {/* ── EVM-only wallet with no OrahDEX passkey → can't sign BSV/BTC/BCH ── */}
                {/* Hidden for BSV when HandCash is connected (HandCash covers the send) */}
                {!canSignNonEvm && ["bsv", "btc", "bch"].includes(withdrawChainMode.toLowerCase()) &&
                  !(withdrawChainMode.toLowerCase() === "bsv" && hcAuthToken) && (
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-red-500/10 border border-red-500/30">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-red-300">OrahWallet required for {withdrawChainMode.toUpperCase()} withdrawals</p>
                      <p className="text-[11px] text-red-400/80 mt-0.5">{withdrawChainMode.toUpperCase()} on-chain withdrawals are signed by the OrahDEX passkey wallet that owns the coins. Connect your OrahDEX passkey wallet to continue.</p>
                    </div>
                  </div>
                )}

                {/* ── Register passkey on this device ── */}
                {isOrahWallet && !passkeyRegistered && listPasskeyWallets().length === 0 && (
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-amber-300">OrahDEX Wallet not registered on this device</p>
                      <p className="text-[11px] text-amber-400/80 mt-0.5">Register it now so you can sign withdrawals with Face ID / Touch ID.</p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={passkeyRegistering}
                        onClick={async () => {
                          setPasskeyRegistering(true);
                          setNonEvmSendError(null);
                          try {
                            await loginWithPasskey();
                            setPasskeyRegistered(true);
                            toast({ title: "Passkey registered", description: "OrahDEX Wallet is now active on this device." });
                          } catch (err: any) {
                            setNonEvmSendError(err?.message ?? "Registration failed — please try again.");
                          } finally {
                            setPasskeyRegistering(false);
                          }
                        }}
                        className="mt-2 h-7 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                      >
                        {passkeyRegistering
                          ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Registering…</>
                          : "Register OrahDEX Wallet on this device"}
                      </Button>
                    </div>
                  </div>
                )}

                {nonEvmSendError && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{nonEvmSendError}</span>
                  </div>
                )}

                {nonEvmSendTxHash && (
                  <div className="rounded-xl border border-green-500/25 bg-green-500/8 overflow-hidden">
                    {/* Title row */}
                    <div className="flex items-center gap-2 px-3 py-2.5 border-b border-green-500/15">
                      <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                      <span className="text-sm font-semibold text-green-400">Withdrawal submitted</span>
                    </div>
                    {/* Txid */}
                    {nonEvmSendTxHash !== "submitted" && (
                      <div className="px-3 py-2.5 space-y-2">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Transaction ID</p>
                        <div className="flex items-center gap-2 bg-background/60 border border-border/40 rounded-lg px-3 py-2">
                          <span className="font-mono text-[11px] text-foreground/80 flex-1 truncate">
                            {nonEvmSendTxHash}
                          </span>
                          <button
                            type="button"
                            onClick={() => { navigator.clipboard.writeText(nonEvmSendTxHash); setCopiedId("withdraw-txid"); }}
                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {copiedId === "withdraw-txid"
                              ? <Check className="w-3.5 h-3.5 text-green-400" />
                              : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        {/* Explorer link — resolve by chain */}
                        {(() => {
                          const chain = withdrawChainMode.toLowerCase();
                          const url =
                            chain === "bsv"  ? `https://whatsonchain.com/tx/${nonEvmSendTxHash}` :
                            chain === "btc"  ? `https://mempool.space/tx/${nonEvmSendTxHash}` :
                            chain === "bch"  ? `https://blockchair.com/bitcoin-cash/transaction/${nonEvmSendTxHash}` :
                            chain === "ltc"  ? `https://blockchair.com/litecoin/transaction/${nonEvmSendTxHash}` :
                            chain === "doge" ? `https://blockchair.com/dogecoin/transaction/${nonEvmSendTxHash}` :
                            chain === "sol"  ? `https://explorer.solana.com/tx/${nonEvmSendTxHash}` :
                            chain === "xrp"  ? `https://xrpscan.com/tx/${nonEvmSendTxHash}` :
                            chain === "trx"  ? `https://tronscan.org/#/transaction/${nonEvmSendTxHash}` :
                            null;
                          return url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1.5 text-[11px] text-green-400/70 hover:text-green-400 transition-colors"
                            >
                              <ExternalLink className="w-3 h-3" />
                              View on explorer
                            </a>
                          ) : null;
                        })()}
                      </div>
                    )}
                  </div>
                )}

                {(() => {
                  const isBsvHandCashSend =
                    withdrawChainMode.toLowerCase() === "bsv" &&
                    hcAuthToken &&
                    isHandCashHandle(nonEvmSendRecipient.trim());
                  const canSend = isBsvHandCashSend || canSignNonEvm ||
                    !["bsv", "btc", "bch"].includes(withdrawChainMode.toLowerCase());
                  return (
                    <Button
                      onClick={handleNonEvmWalletSend}
                      disabled={
                        !nonEvmSendAmount || !nonEvmSendRecipient.trim() || nonEvmSending ||
                        (available > 0
                          ? parseFloat(nonEvmSendAmount) > available
                          : nonEvmSendBalance !== null && parseFloat(nonEvmSendAmount) > nonEvmSendBalance) ||
                        !canSend
                      }
                      className={cn(
                        "w-full gap-2 h-11 text-white",
                        isBsvHandCashSend
                          ? "bg-emerald-600 hover:bg-emerald-500"
                          : "bg-green-600 hover:bg-green-500",
                      )}
                    >
                      {nonEvmSending
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> {isBsvHandCashSend ? "Sending…" : "Authenticating…"}</>
                        : isBsvHandCashSend
                          ? <><span className="text-base leading-none select-none">✋</span> Send {nonEvmSendAmount ? `${nonEvmSendAmount} ` : ""}BSV via HandCash</>
                          : <><ArrowRight className="w-4 h-4" /> Send {nonEvmSendAmount ? `${nonEvmSendAmount} ` : ""}{withdrawChainMode.toUpperCase()} from Wallet</>
                      }
                    </Button>
                  );
                })()}
              </>
            )}

            {/* ── WALLET SEND — EVM (passkey wallet direct on-chain send) ── */}
            {withdrawChainMode === "evm" && (
              <>
                {/* Chain selector */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Network</label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {WALLET_CHAINS.slice(0, 4).map(ch => (
                      <button
                        key={ch.id}
                        onClick={() => {
                          setWalletSendChain(ch);
                          setWalletSendToken(WALLET_TOKENS[ch.id][0]);
                          setWalletSendBalance(null);
                          setWalletSendAmount("");
                        }}
                        className={cn(
                          "py-2 rounded-xl text-[11px] font-bold border transition-all text-center",
                          walletSendChain.id === ch.id
                            ? "border-2 text-white"
                            : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                        )}
                        style={walletSendChain.id === ch.id ? { borderColor: ch.color, backgroundColor: ch.color + "22", color: ch.color } : {}}
                      >
                        {ch.name}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {WALLET_CHAINS.slice(4).map(ch => (
                      <button
                        key={ch.id}
                        onClick={() => {
                          setWalletSendChain(ch);
                          setWalletSendToken(WALLET_TOKENS[ch.id][0]);
                          setWalletSendBalance(null);
                          setWalletSendAmount("");
                        }}
                        className={cn(
                          "py-2 rounded-xl text-[11px] font-bold border transition-all text-center",
                          walletSendChain.id === ch.id
                            ? "border-2 text-white"
                            : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                        )}
                        style={walletSendChain.id === ch.id ? { borderColor: ch.color, backgroundColor: ch.color + "22", color: ch.color } : {}}
                      >
                        {ch.name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Token selector */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Token</label>
                  <div className="flex flex-wrap gap-1.5">
                    {(() => {
                      const builtIn = WALLET_TOKENS[walletSendChain.id] ?? [];
                      const customRaw = useCustomTokenStore.getState().getByChainId(walletSendChain.id);
                      const customTokens: WalletToken[] = customRaw
                        .filter(ct => !builtIn.some(b => b.symbol.toUpperCase() === ct.symbol.toUpperCase()))
                        .map(ct => ({ symbol: ct.symbol, decimals: ct.decimals, isNative: false, address: ct.address, color: ct.color }));
                      return [...builtIn, ...customTokens].map(tok => (
                        <button
                          key={tok.symbol}
                          onClick={() => { setWalletSendToken(tok); setWalletSendBalance(null); setWalletSendAmount(""); }}
                          className={cn(
                            "px-3 py-1.5 rounded-lg text-xs font-bold border transition-all",
                            walletSendToken.symbol === tok.symbol
                              ? "text-white border-2"
                              : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                          )}
                          style={walletSendToken.symbol === tok.symbol ? { borderColor: tok.color, backgroundColor: tok.color + "22", color: tok.color } : {}}
                        >
                          {tok.symbol}
                        </button>
                      ));
                    })()}
                  </div>
                </div>

                {/* Wallet balance display */}
                <div className="flex items-center justify-between p-3 rounded-xl bg-secondary/30 border border-border">
                  <div>
                    <p className="text-xs text-muted-foreground">Wallet Balance</p>
                    <p className="text-sm font-bold font-mono text-foreground">
                      {walletSendBalFetch
                        ? "Loading…"
                        : walletSendBalance !== null
                          ? `${walletSendBalance.toLocaleString(undefined, { maximumFractionDigits: walletSendBalance < 0.001 ? 8 : 6 })} ${walletSendToken.symbol}`
                          : "—"}
                    </p>
                  </div>
                  <button
                    onClick={() => fetchWalletBalance(walletSendChain, walletSendToken)}
                    disabled={walletSendBalFetch}
                    className="p-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-40"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", walletSendBalFetch && "animate-spin")} />
                  </button>
                </div>

                {/* Amount */}
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold">Amount</label>
                  <div className="relative">
                    <Input
                      value={walletSendAmount}
                      onChange={e => setWalletSendAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="0.00"
                      className={cn(
                        "pr-16 font-mono text-base",
                        walletSendBalance !== null && parseFloat(walletSendAmount) > walletSendBalance
                          ? "border-red-500/60 focus-visible:ring-red-500/30" : ""
                      )}
                    />
                    {walletSendBalance !== null && (
                      <button
                        type="button"
                        onClick={() => setWalletSendAmount(walletSendBalance.toFixed(walletSendBalance < 0.001 ? 8 : 6))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-bold text-green-400 hover:text-green-300 px-2 py-0.5 rounded bg-green-400/10 hover:bg-green-400/20 transition-colors"
                      >
                        MAX
                      </button>
                    )}
                  </div>
                  {walletSendBalance !== null && parseFloat(walletSendAmount) > walletSendBalance && (
                    <p className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Exceeds wallet balance
                    </p>
                  )}
                </div>

                {/* Recipient */}
                <div className="space-y-1.5">
                  <label className="text-sm font-semibold">Send to address</label>
                  <Input
                    value={walletSendRecipient}
                    onChange={e => setWalletSendRecipient(e.target.value)}
                    placeholder="0x… recipient address"
                    className="font-mono text-xs"
                  />
                </div>

                {/* Biometric notice */}
                <div className="flex gap-2.5 p-3 rounded-xl bg-green-500/8 border border-green-500/20">
                  <Zap className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    This sends funds <strong className="text-foreground">directly from your passkey wallet</strong> on-chain. Face ID / Touch ID will authenticate the transaction — no exchange involved.
                  </p>
                </div>

                {/* Error */}
                {walletSendError && (
                  <div className="flex gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/25">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-red-300 leading-relaxed">{walletSendError}</p>
                  </div>
                )}

                {/* Success */}
                {walletSendTxHash && (
                  <div className="flex gap-2.5 p-3.5 rounded-xl bg-green-500/10 border border-green-500/25">
                    <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-xs font-semibold text-green-400">Transaction sent!</p>
                      <div className="flex items-center gap-1.5 bg-background/40 rounded-lg px-2 py-1.5 border border-green-500/20">
                        <span className="font-mono text-[10px] text-green-300 flex-1 truncate">{walletSendTxHash}</span>
                        <button onClick={() => copy(walletSendTxHash, "wallet-tx")} className="shrink-0 p-0.5">
                          {copiedId === "wallet-tx" ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                        </button>
                      </div>
                      <a
                        href={walletSendChain.explorer + walletSendTxHash}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-green-400 hover:text-green-300 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" /> View on {walletSendChain.name} explorer
                      </a>
                    </div>
                  </div>
                )}

                <Button
                  onClick={handleWalletSend}
                  disabled={
                    !walletSendAmount || !walletSendRecipient.trim() || walletSending ||
                    (walletSendBalance !== null && parseFloat(walletSendAmount) > walletSendBalance)
                  }
                  className="w-full gap-2 h-11 bg-green-600 hover:bg-green-500 text-white"
                >
                  {walletSending
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Authenticating…</>
                    : <><ArrowRight className="w-4 h-4" /> Send {walletSendAmount ? `${walletSendAmount} ` : ""}{walletSendToken.symbol} from Wallet</>}
                </Button>
              </>
            )}
          </div>
        )}

        {/* ── HISTORY TAB ──────────────────────────────────────────────────── */}
        {tab === "history" && (
          <div className="space-y-3 max-h-[420px] overflow-y-auto pr-0.5">

            {/* Queued withdrawal notice */}
            {hasGasError && (
              <div className="w-full flex items-start gap-2.5 p-3.5 rounded-xl bg-secondary/40 border border-border text-left">
                <Clock className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground">Withdrawal queued</p>
                  <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                    Your withdrawal is queued and will be processed automatically.
                  </p>
                </div>
              </div>
            )}

            {history.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <History className="w-10 h-10 opacity-30" />
                <p className="text-sm">No withdrawal history yet</p>
              </div>
            ) : (
              history.map(item => (
                <div key={item.id} className="p-3.5 rounded-xl border border-border bg-secondary/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm font-mono">
                      {item.amount.toLocaleString(undefined, { maximumFractionDigits: 8 })} {item.asset}
                    </span>
                    <span className={cn("text-[10px] font-black uppercase px-2 py-0.5 rounded-full border", statusStyle(item.status))}>
                      {item.status}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{item.networkLabel}</span>
                    <span>{new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                  </div>

                  <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground/80 bg-secondary/30 rounded-lg px-2.5 py-1.5">
                    <span className="truncate flex-1">{item.recipient}</span>
                    <button onClick={() => copy(item.recipient, `${item.id}-addr`)} className="shrink-0 p-0.5 hover:text-foreground transition-colors">
                      {copiedId === `${item.id}-addr` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>

                  {item.txid && (
                    <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground/80 bg-secondary/30 rounded-lg px-2.5 py-1.5">
                      <span className="text-muted-foreground/50 shrink-0">TX</span>
                      <span className="truncate flex-1">{item.txid}</span>
                      <button onClick={() => copy(item.txid!, `${item.id}-tx`)} className="shrink-0 p-0.5 hover:text-foreground transition-colors">
                        {copiedId === `${item.id}-tx` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                  )}

                  {item.note && (
                    item.note.startsWith("http") ? (
                      <a href={item.note} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors">
                        <ExternalLink className="w-3 h-3" /> View on block explorer
                      </a>
                    ) : (() => {
                      const summary = summariseNote(item.note as string);
                      const isLong  = (item.note as string).length > summary.length + 2;
                      const isOpen  = expandedNote === item.id;
                      return (
                        <div className="text-xs text-muted-foreground bg-secondary/30 rounded-lg px-2.5 py-2 space-y-1">
                          <p className="italic leading-relaxed">{isOpen ? item.note : summary}</p>
                          {isLong && (
                            <button onClick={() => setExpandedNote(isOpen ? null : item.id)} className="text-[11px] font-semibold text-primary hover:text-primary/80 transition-colors">
                              {isOpen ? "Show less" : "Show more"}
                            </button>
                          )}
                        </div>
                      );
                    })()
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
