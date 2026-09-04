import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { SolanaAdapter } from "@reown/appkit-adapter-solana";
import { BitcoinAdapter } from "@reown/appkit-adapter-bitcoin";
import {
  mainnet, polygon, arbitrum, optimism, base, bsc, avalanche,
  linea, zkSync, scroll, sepolia,
  solana, solanaTestnet, solanaDevnet,
  bitcoin, bitcoinTestnet,
} from "@reown/appkit/networks";
import { useThemeStore } from "../store/useThemeStore";

const projectId =
  (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined) ||
  "04663615251cf13fb1b043d754e7a17f";

const networks = [
  // EVM
  mainnet, polygon, arbitrum, optimism, base, bsc, avalanche,
  linea, zkSync, scroll, sepolia,
  // Solana
  solana, solanaTestnet, solanaDevnet,
  // Bitcoin
  bitcoin, bitcoinTestnet,
];

/**
 * localStorage key that persists the user's last chosen EVM chainId across sessions.
 * Read at module-load time so AppKit starts on the correct network instead of always
 * defaulting to mainnet, which would cause `subscribeAccount` to fire with chainId=1
 * and overwrite the user's Sepolia (or other testnet) selection on every refresh.
 */
const REOWN_CHAIN_KEY = "orah-reown-chain";

function readStoredChainId(): number {
  try { return parseInt(localStorage.getItem(REOWN_CHAIN_KEY) ?? "", 10) || 1; }
  catch { return 1; }
}

/** Persist the user's chosen EVM chainId so it survives page refresh. */
export function saveReownChain(chainId: number): void {
  try { localStorage.setItem(REOWN_CHAIN_KEY, String(chainId)); } catch {}
}

/** Read the stored OrahDEX theme so AppKit can open with the right themeMode. */
function readStoredOrahTheme(): "dark" | "light" | "amoled" | "system" {
  try {
    const raw = localStorage.getItem("aura-dex-theme");
    if (!raw) return "dark";
    const { state } = JSON.parse(raw);
    const t = state?.theme;
    if (t === "light" || t === "amoled" || t === "system") return t as "light" | "amoled" | "system";
    return "dark";
  } catch { return "dark"; }
}

const storedChainId = readStoredChainId();
const initialNetwork =
  (networks as readonly (typeof mainnet)[]).find((n) => n.id === storedChainId)
  ?? mainnet;

const _storedTheme = readStoredOrahTheme();
const _initialThemeMode: "dark" | "light" = _storedTheme === "light" ? "light" : "dark";

const evmNetworks = [
  mainnet, polygon, arbitrum, optimism, base, bsc, avalanche,
  linea, zkSync, scroll, sepolia,
];

export const wagmiAdapter  = new WagmiAdapter({ projectId, networks: evmNetworks });
export const solanaAdapter  = new SolanaAdapter();
export const bitcoinAdapter = new BitcoinAdapter();

const appKit = createAppKit({
  adapters: [wagmiAdapter, solanaAdapter, bitcoinAdapter],
  projectId,
  networks: networks as unknown as Parameters<typeof createAppKit>[0]["networks"],
  defaultNetwork: initialNetwork,
  metadata: {
    name: "OrahDEX",
    description: "OrahDEX — Multi-chain Exchange",
    url: typeof window !== "undefined" ? window.location.origin : "https://orahdex.io",
    icons: typeof window !== "undefined"
      ? [`${window.location.origin}${import.meta.env.BASE_URL}icon-512.png`]
      : ["https://orahdex.io/icon-512.png"],
  },
  features: {
    analytics:     false,
    email:         false,   // native social login handled in WalletChooserDialog
    socials:       false,   // native social login handled in WalletChooserDialog
    onramp:        true,
    swaps:         true,
  },
  enableWallets: true,
  themeMode: _initialThemeMode,
  themeVariables: {
    "--w3m-accent":               _storedTheme === "light" ? "#1fb757" : "#4ade80",
    "--w3m-color-mix-strength":   0,
    "--w3m-border-radius-master": "3px",
    "--w3m-font-family":          "Inter, system-ui, sans-serif",
    "--w3m-z-index":              9999,
  } as any,
});

/** Prevents the account subscription from re-connecting after intentional disconnect. */
let _suppressNextConnect = false;

/** Injects CSS into AppKit's shadow DOM to hide Reown branding. */
function hideReownBranding(): void {
  if (typeof window === "undefined") return;
  const inject = () => {
    const modal = document.querySelector("w3m-modal");
    if (!modal?.shadowRoot) return;
    const id = "orah-hide-branding";
    if (modal.shadowRoot.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      w3m-footer, w3m-legal-footer { display: none !important; height: 0 !important; }
      .w3m-footer { display: none !important; }
    `;
    modal.shadowRoot.appendChild(style);
  };
  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true });
  inject();
}

if (typeof window !== "undefined") {
  hideReownBranding();
}

/**
 * Converts HSL components to a #rrggbb hex string using the same algorithm
 * browsers use, so Reown token values exactly match OrahDEX's CSS variables.
 *
 * h: 0–360, s: 0–100, l: 0–100
 */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const val = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * val).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Applies OrahDEX's exact theme colours directly to the AppKit CSS token variables.
 *
 * All HSL source values come directly from index.css so the Reown modal
 * always matches the app's rendered colours with zero drift.
 *
 *   DARK    — :root         background hsl(216 20%  5%)
 *   AMOLED  — html.amoled   background hsl(0   0%   0%)
 *   LIGHT   — html.light    background hsl(210 20% 98%)
 */
function applyTokenOverrides(
  theme: "dark" | "light" | "amoled" | "system",
  effective: "dark" | "light",
): void {
  if (typeof window === "undefined") return;
  const r = document.documentElement;
  const set = (k: string, v: string) => r.style.setProperty(k, v);

  if (theme === "amoled") {
    // ── html.amoled ──────────────────────────────────────────────────────────
    // background  0  0%  0%    card  0  0%  3%    popover  0  0%  5%
    // secondary   0  0%  7%    border 0  0% 10%   foreground 210 20% 92%
    // muted-fg  215 16% 50%    primary 142 71% 58%
    const bg      = hslToHex(0,   0,  0);
    const card    = hslToHex(0,   0,  3);
    const popover = hslToHex(0,   0,  5);
    const surface = hslToHex(0,   0,  7);
    const border  = hslToHex(0,   0, 10);
    const text    = hslToHex(210, 20, 92);
    const muted   = hslToHex(215, 16, 50);
    const accent  = hslToHex(142, 71, 58);

    set("--apkt-tokens-theme-backgroundPrimary",      bg);
    set("--apkt-tokens-theme-backgroundInvert",       "#e0e0e0");
    set("--apkt-tokens-theme-foregroundPrimary",      card);
    set("--apkt-tokens-theme-foregroundSecondary",    popover);
    set("--apkt-tokens-theme-foregroundTertiary",     surface);
    set("--apkt-tokens-theme-borderPrimary",          border);
    set("--apkt-tokens-theme-borderPrimaryDark",      hslToHex(0, 0, 14));
    set("--apkt-tokens-theme-borderSecondary",        hslToHex(0, 0, 18));
    set("--apkt-tokens-theme-overlay",                "rgba(0,0,0,0.75)");
    set("--apkt-tokens-theme-textPrimary",            text);
    set("--apkt-tokens-theme-textSecondary",          muted);
    set("--apkt-tokens-theme-textTertiary",           hslToHex(215, 16, 62));
    set("--apkt-tokens-theme-textInvert",             bg);
    set("--apkt-tokens-theme-iconDefault",            muted);
    set("--apkt-tokens-theme-iconInverse",            text);
    set("--apkt-tokens-core-backgroundAccentPrimary", accent);
    set("--apkt-tokens-core-textAccentPrimary",       accent);
    set("--apkt-tokens-core-iconAccentPrimary",       accent);
    set("--apkt-tokens-core-borderAccentPrimary",     accent);

  } else if (effective === "light") {
    // ── html.light ───────────────────────────────────────────────────────────
    // background 210 20% 98%   card/popover 0  0% 100%   secondary 210 16% 93%
    // border     210 16% 86%   foreground  216 20% 10%   muted-fg  215 16% 40%
    // primary    142 71% 42%
    const bg      = hslToHex(210, 20, 98);
    const card    = "#ffffff";
    const surface = hslToHex(210, 16, 93);
    const border  = hslToHex(210, 16, 86);
    const text    = hslToHex(216, 20, 10);
    const muted   = hslToHex(215, 16, 40);
    const accent  = hslToHex(142, 71, 42);

    set("--apkt-tokens-theme-backgroundPrimary",      bg);
    set("--apkt-tokens-theme-backgroundInvert",       text);
    set("--apkt-tokens-theme-foregroundPrimary",      card);
    set("--apkt-tokens-theme-foregroundSecondary",    card);
    set("--apkt-tokens-theme-foregroundTertiary",     surface);
    set("--apkt-tokens-theme-borderPrimary",          border);
    set("--apkt-tokens-theme-borderPrimaryDark",      hslToHex(210, 16, 78));
    set("--apkt-tokens-theme-borderSecondary",        hslToHex(210, 16, 68));
    set("--apkt-tokens-theme-overlay",                "rgba(190,205,218,0.55)");
    set("--apkt-tokens-theme-textPrimary",            text);
    set("--apkt-tokens-theme-textSecondary",          muted);
    set("--apkt-tokens-theme-textTertiary",           hslToHex(215, 16, 52));
    set("--apkt-tokens-theme-textInvert",             "#ffffff");
    set("--apkt-tokens-theme-iconDefault",            muted);
    set("--apkt-tokens-theme-iconInverse",            text);
    set("--apkt-tokens-core-backgroundAccentPrimary", accent);
    set("--apkt-tokens-core-textAccentPrimary",       accent);
    set("--apkt-tokens-core-iconAccentPrimary",       accent);
    set("--apkt-tokens-core-borderAccentPrimary",     accent);

  } else {
    // ── :root (dark) ─────────────────────────────────────────────────────────
    // background  216 20%  5%   card     216 15%  9%   popover   216 15% 12%
    // secondary   216 15% 16%   border   216 15% 16%   foreground 210 20% 90%
    // muted-fg    215 16% 55%   primary  142 71% 58%
    const bg      = hslToHex(216, 20,  5);
    const card    = hslToHex(216, 15,  9);
    const popover = hslToHex(216, 15, 12);
    const surface = hslToHex(216, 15, 16);
    const text    = hslToHex(210, 20, 90);
    const muted   = hslToHex(215, 16, 55);
    const accent  = hslToHex(142, 71, 58);

    set("--apkt-tokens-theme-backgroundPrimary",      bg);
    set("--apkt-tokens-theme-backgroundInvert",       text);
    set("--apkt-tokens-theme-foregroundPrimary",      card);
    set("--apkt-tokens-theme-foregroundSecondary",    popover);
    set("--apkt-tokens-theme-foregroundTertiary",     surface);
    set("--apkt-tokens-theme-borderPrimary",          surface);
    set("--apkt-tokens-theme-borderPrimaryDark",      hslToHex(216, 15, 20));
    set("--apkt-tokens-theme-borderSecondary",        hslToHex(216, 15, 26));
    set("--apkt-tokens-theme-overlay",                "rgba(0,0,0,0.6)");
    set("--apkt-tokens-theme-textPrimary",            text);
    set("--apkt-tokens-theme-textSecondary",          muted);
    set("--apkt-tokens-theme-textTertiary",           hslToHex(215, 16, 66));
    set("--apkt-tokens-theme-textInvert",             bg);
    set("--apkt-tokens-theme-iconDefault",            muted);
    set("--apkt-tokens-theme-iconInverse",            text);
    set("--apkt-tokens-core-backgroundAccentPrimary", accent);
    set("--apkt-tokens-core-textAccentPrimary",       accent);
    set("--apkt-tokens-core-iconAccentPrimary",       accent);
    set("--apkt-tokens-core-borderAccentPrimary",     accent);
  }
}

/**
 * Syncs AppKit's modal theme to match the active OrahDEX theme.
 * Call whenever the OrahDEX theme changes (dark / amoled / light / system).
 */
export function syncReownTheme(theme: "dark" | "light" | "amoled" | "system"): void {
  if (typeof window === "undefined") return;

  const effective: "dark" | "light" =
    theme === "light" ? "light"
    : theme === "system"
      ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : "dark";

  try {
    appKit.setThemeMode(effective);
    (appKit as any).setThemeVariables({
      "--w3m-accent":               effective === "light" ? hslToHex(142, 71, 42) : hslToHex(142, 71, 58),
      "--w3m-color-mix-strength":   0,
      "--w3m-border-radius-master": "3px",
      "--w3m-font-family":          "Inter, system-ui, sans-serif",
      "--w3m-z-index":              9999,
    });
  } catch { /* AppKit not ready */ }

  // Apply immediately, then again after AppKit's async style flush
  applyTokenOverrides(theme, effective);
  setTimeout(() => applyTokenOverrides(theme, effective), 80);
}

// Apply theme overrides immediately at module-load time so the very first
// open of the modal already reflects the stored OrahDEX theme.
if (typeof window !== "undefined") {
  const _eff: "dark" | "light" =
    _storedTheme === "light" ? "light"
    : _storedTheme === "system"
      ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : "dark";
  applyTokenOverrides(_storedTheme, _eff);
}

// ── Auto-sync: mirror OrahDEX theme changes into AppKit in real time ────────
// Uses a Zustand store subscription so the sync works regardless of which
// layout (desktop / mobile / any page) renders the theme switcher. No React
// useEffect needed — this subscription is active for the lifetime of the module.
if (typeof window !== "undefined") {
  useThemeStore.subscribe((state) => syncReownTheme(state.theme));
}

/**
 * Returns true when the connected account came from an email or social login
 * (i.e. Reown's embedded/smart-account wallet, not an external signer).
 * connectorType values in AppKit 1.x: "EMAIL" | "SOCIAL" | "WALLET_CONNECT" |
 * "INJECTED" | "COINBASE_SDK" | "EIP6963" | "ANNOUNCED"
 */
export function isReownSocialOrEmail(): boolean {
  try {
    const state = (appKit as any).getState?.() ?? {};
    const ct: string = (state.connectorType ?? state.connector?.type ?? "").toUpperCase();
    return ct === "EMAIL" || ct === "SOCIAL";
  } catch {
    return false;
  }
}

export function subscribeReownAccount(
  cb: (address: string | null, chainId: number, isSocialOrEmail: boolean) => void
): () => void {
  try {
    return appKit.subscribeAccount((acc: any) => {
      if (acc?.isConnected && acc?.address) {
        if (_suppressNextConnect) return;
        // acc.chainId may be a number (1) or a CAIP-2 string ("eip155:11155111").
        let chainId: number;
        if (typeof acc.chainId === "number") {
          chainId = acc.chainId;
        } else if (typeof acc.chainId === "string" && acc.chainId.includes(":")) {
          chainId = parseInt(acc.chainId.split(":")[1], 10) || 1;
        } else {
          chainId = 1;
        }
        // Detect social/email via the acc object itself (most reliable) or
        // fall back to reading appKit state.
        const ct: string = ((acc as any).connectorType ?? "").toUpperCase();
        const isSocialOrEmail = ct === "EMAIL" || ct === "SOCIAL" || isReownSocialOrEmail();
        cb(acc.address as string, chainId, isSocialOrEmail);
      } else {
        _suppressNextConnect = false;
        cb(null, 1, false);
      }
    });
  } catch {
    return () => {};
  }
}

/**
 * Returns the wagmi config managed by the AppKit WagmiAdapter.
 * This is the config that tracks the active WalletConnect / Reown session
 * and is DIFFERENT from the minimal wagmiConfig exported by reown.ts.
 */
export function getAppKitWagmiConfig() {
  return wagmiAdapter.wagmiConfig;
}

export function openReownModal(): void {
  _suppressNextConnect = false;
  // Sync theme right before opening — guarantees the modal always opens in the
  // current OrahDEX theme even if the Zustand subscription hasn't fired yet
  // (e.g. the module just loaded for the first time after a theme change).
  try { syncReownTheme(readStoredOrahTheme()); } catch {}
  try {
    appKit.open({ view: "Connect" });
  } catch (e) {
    console.error("[OrahDEX] Failed to open Reown modal:", e);
  }
}

export function disconnectReown(): void {
  _suppressNextConnect = true;
  try {
    appKit.disconnect();
  } catch { /* */ }
}
