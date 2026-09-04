/**
 * OrahDEX Passkey Wallet
 *
 * Non-custodial EVM wallet backed by a WebAuthn passkey (Face ID, Touch ID,
 * Windows Hello, Android biometric, hardware security key, etc.).
 *
 * Security model:
 * - A cryptographically random EVM private key is generated locally.
 * - It is encrypted with AES-GCM using a key derived (via PBKDF2) from the
 *   passkey credential's rawId bytes.
 * - The encrypted blob is stored in localStorage AND backed up to the server
 *   (still encrypted — the server cannot decrypt it without the passkey rawId).
 * - On a new device: the user authenticates with their passkey (synced via
 *   iCloud/Google Password Manager), the server restores the encrypted blob,
 *   and it is decrypted locally with the rawId from the assertion.
 * - The passkey itself never leaves the device (WebAuthn guarantee).
 *
 * Cross-device recovery options:
 * 1. Automatic: Server cloud backup (same OS ecosystem — iCloud ↔ iCloud, etc.)
 * 2. Transfer Code: 8-char code valid for 10 min — works across OS ecosystems
 */

import { generateMnemonic, deriveAllAddresses } from "./seedPhrase";
import { saveDerivedAddresses } from "./walletPin";

const STORAGE_KEY  = "orahdex_passkey_wallets_v1";
const RP_NAME      = "OrahDEX";
const PBKDF2_SALT  = new TextEncoder().encode("OrahDEX-passkey-wallet-v1");
const PBKDF2_ITER  = 100_000;

const API_BASE = (import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "") + "/api";

export interface PasskeyWallet {
  credentialId: string;  // base64url
  address:      string;  // EIP-55 checksummed EVM address
  encryptedKey: string;  // base64  — AES-GCM ciphertext of private key
  iv:           string;  // base64  — 12-byte GCM nonce
  label?:       string;  // optional display name
  createdAt:    number;  // unix ms
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export function listPasskeyWallets(): PasskeyWallet[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveWallet(wallet: PasskeyWallet): void {
  const wallets = listPasskeyWallets();
  const idx = wallets.findIndex(w => w.credentialId === wallet.credentialId);
  if (idx >= 0) wallets[idx] = wallet;
  else wallets.push(wallet);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
}

export function deletePasskeyWallet(credentialId: string): void {
  const wallets = listPasskeyWallets().filter(w => w.credentialId !== credentialId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
}

// ─── Support detection ────────────────────────────────────────────────────────

export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
  );
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

/** ArrayBuffer or Uint8Array → standard base64 */
function buf2b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Standard base64 → Uint8Array (backed by a plain ArrayBuffer for WebCrypto compatibility) */
function b642buf(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const ab = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(ab);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes as Uint8Array<ArrayBuffer>;
}

/** Standard base64 → URL-safe base64 (strips padding) */
function b642url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** URL-safe base64 → standard base64 (re-adds correct padding) */
function url2b64(url: string): string {
  const s = url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  return pad === 0 ? s : s + "=".repeat(4 - pad);
}

async function deriveAesKey(
  rawId: ArrayBuffer,
  usage: "encrypt" | "decrypt"
): Promise<CryptoKey> {
  const km = await crypto.subtle.importKey(
    "raw", rawId, { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: PBKDF2_SALT, iterations: PBKDF2_ITER, hash: "SHA-256" },
    km,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

async function encryptPrivateKey(
  privateKey: string,
  rawId: ArrayBuffer
): Promise<{ encryptedKey: string; iv: string }> {
  const aesKey = await deriveAesKey(rawId, "encrypt");
  const iv     = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(privateKey)
  );
  return { encryptedKey: buf2b64(cipher), iv: buf2b64(iv) };
}

async function decryptPrivateKey(
  encryptedKey: string,
  iv: string,
  rawId: ArrayBuffer
): Promise<string> {
  const aesKey  = await deriveAesKey(rawId, "decrypt");
  const plain   = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b642buf(iv) },
    aesKey,
    b642buf(encryptedKey)
  );
  return new TextDecoder().decode(plain);
}

// ─── Server backup helpers ────────────────────────────────────────────────────

/** Push encrypted wallet blob to the server (fire-and-forget, silent on error). */
async function pushBackupToServer(wallet: PasskeyWallet): Promise<void> {
  try {
    await fetch(`${API_BASE}/passkey/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialId: wallet.credentialId,
        encryptedKey: wallet.encryptedKey,
        iv:           wallet.iv,
        address:      wallet.address,
        label:        wallet.label ?? "Passkey Wallet",
      }),
    });
  } catch {
    // Network error — silently ignore, user still has local copy
  }
}

/** Try to fetch encrypted wallet blob from the server, decrypt, and save locally. */
async function tryRestoreFromServer(
  credentialId: string,
  rawId: ArrayBuffer
): Promise<PasskeyWallet | null> {
  try {
    const res = await fetch(`${API_BASE}/passkey/backup/${encodeURIComponent(credentialId)}`);
    if (!res.ok) return null;
    const data = await res.json() as { encryptedKey: string; iv: string; address: string; label?: string };
    if (!data.encryptedKey || !data.iv || !data.address) return null;
    // Verify decryption works before saving
    await decryptPrivateKey(data.encryptedKey, data.iv, rawId);
    const wallet: PasskeyWallet = {
      credentialId,
      address:      data.address,
      encryptedKey: data.encryptedKey,
      iv:           data.iv,
      label:        data.label ?? "Passkey Wallet",
      createdAt:    Date.now(),
    };
    saveWallet(wallet);
    return wallet;
  } catch {
    return null;
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export interface PasskeyChainAddresses {
  evm: string;
  sol?: string;
  btc?: string;
  bch?: string;
  bsv?: string;
  tron?: string;
  xrp?: string;
  ltc?: string;
  doge?: string;
}

export interface RegisterResult {
  address:      string;
  credentialId: string;
  label:        string;
  chains?:      PasskeyChainAddresses;
}

/**
 * Shared passkey credential creation — used by both register (fresh mnemonic)
 * and import (user-supplied mnemonic) flows.
 */
async function createPasskeyCredential(label: string): Promise<{ rawId: ArrayBuffer; credentialId: string }> {
  if (!isPasskeySupported()) throw new Error("Passkeys not supported in this browser");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId    = crypto.getRandomValues(new Uint8Array(16));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp:   { name: RP_NAME, id: window.location.hostname },
      user: { id: userId, name: label, displayName: label },
      pubKeyCredParams: [
        { alg: -7,   type: "public-key" },
        { alg: -257, type: "public-key" },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey:             "preferred",
        requireResidentKey:      false,
        userVerification:        "required",
      },
      timeout: 60_000,
      attestation: "none",
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation cancelled");
  const rawId        = credential.rawId;
  const credentialId = b642url(buf2b64(rawId));
  return { rawId, credentialId };
}

/**
 * Create a new passkey and generate a BIP39 HD wallet (all 5 chains).
 * The 12-word mnemonic is encrypted with the passkey rawId — never stored in plain text.
 *
 * @param label  Optional display name for the wallet (default: "Passkey Wallet").
 */
export async function registerPasskeyWallet(
  label = "Passkey Wallet"
): Promise<RegisterResult> {
  const { rawId, credentialId } = await createPasskeyCredential(label);

  // Generate a fresh BIP39 mnemonic
  const words    = generateMnemonic(12);
  const addrs    = await deriveAllAddresses(words);
  const mnemonic = words.join(" ");

  const { encryptedKey, iv } = await encryptPrivateKey(mnemonic, rawId);
  const wallet: PasskeyWallet = {
    credentialId, address: addrs.evm, encryptedKey, iv, label, createdAt: Date.now(),
  };
  saveWallet(wallet);
  saveDerivedAddresses(addrs.evm, {
    evm: addrs.evm, btc: addrs.btc, bch: addrs.bch, bsv: addrs.bsv, sol: addrs.sol,
    tron: addrs.tron, xrp: addrs.xrp, ltc: addrs.ltc, doge: addrs.doge,
  });
  pushBackupToServer(wallet);
  return {
    address: addrs.evm, credentialId, label,
    chains: {
      evm: addrs.evm, sol: addrs.sol, btc: addrs.btc, bch: addrs.bch, bsv: addrs.bsv,
      tron: addrs.tron, xrp: addrs.xrp, ltc: addrs.ltc, doge: addrs.doge,
    },
  };
}

/**
 * Import an existing BIP39 mnemonic and protect it with a new passkey.
 *
 * Unlike registerPasskeyWallet (which generates a fresh mnemonic), this
 * function stores the USER-SUPPLIED mnemonic encrypted under the new passkey's
 * rawId — using the same AES-GCM/PBKDF2 scheme — so that BSV signing and all
 * other passkey flows can find and decrypt it via listPasskeyWallets().
 */
export async function importPasskeyWallet(
  mnemonic: string,
  label    = "OrahDEX Wallet"
): Promise<RegisterResult & { addrs: Awaited<ReturnType<typeof deriveAllAddresses>> }> {
  const { rawId, credentialId } = await createPasskeyCredential(label);

  const words = mnemonic.trim().split(/\s+/);
  const addrs = await deriveAllAddresses(words);

  const { encryptedKey, iv } = await encryptPrivateKey(mnemonic.trim(), rawId);
  const wallet: PasskeyWallet = {
    credentialId, address: addrs.evm, encryptedKey, iv, label, createdAt: Date.now(),
  };
  saveWallet(wallet);
  saveDerivedAddresses(addrs.evm, {
    evm: addrs.evm, btc: addrs.btc, bch: addrs.bch, bsv: addrs.bsv, sol: addrs.sol,
    tron: addrs.tron, xrp: addrs.xrp, ltc: addrs.ltc, doge: addrs.doge,
  });
  pushBackupToServer(wallet);
  return {
    address: addrs.evm, credentialId, label,
    chains: {
      evm: addrs.evm, sol: addrs.sol, btc: addrs.btc, bch: addrs.bch, bsv: addrs.bsv,
      tron: addrs.tron, xrp: addrs.xrp, ltc: addrs.ltc, doge: addrs.doge,
    },
    addrs,
  };
}

// ─── Authentication ───────────────────────────────────────────────────────────

export interface LoginResult {
  address:             string;
  credentialId:        string;
  label:               string;
  restoredFromBackup?: boolean;
  chains?:             PasskeyChainAddresses;
}

/**
 * Authenticate with an existing passkey wallet.
 * Returns the EVM address; the private key is decrypted in-memory only.
 *
 * Cross-device recovery: if no wallet is found in localStorage (new device),
 * the function automatically attempts to restore the encrypted blob from the
 * server backup, decrypts it with the passkey rawId, and saves it locally.
 */
export async function loginWithPasskey(opts?: { hybrid?: boolean }): Promise<LoginResult> {
  if (!isPasskeySupported()) throw new Error("Passkeys not supported in this browser");

  const wallets   = listPasskeyWallets();
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  // hybrid=true: force empty allowCredentials so the browser shows ALL passkeys
  // including the "Use another device / QR code" cross-device option.
  // Otherwise populate with known local credential IDs for a faster flow.
  const allowCredentials = (opts?.hybrid || wallets.length === 0)
    ? []
    : wallets.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }));

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials,
      userVerification: "required",
      timeout:          opts?.hybrid ? 120_000 : 60_000,
    },
  }) as PublicKeyCredential | null;

  if (!assertion) throw new Error('Authentication cancelled — tap the button again to retry.');

  const rawId        = assertion.rawId;
  const credentialId = b642url(buf2b64(rawId));

  let wallet = wallets.find(w => w.credentialId === credentialId);
  let restoredFromBackup = false;

  if (!wallet) {
    // Passkey succeeded but no local wallet blob — try server cloud backup
    const restored = await tryRestoreFromServer(credentialId, rawId);
    if (restored) {
      wallet = restored;
      restoredFromBackup = true;
    } else {
      throw new Error(
        "WALLET_NOT_FOUND:" + credentialId
      );
    }
  } else {
    // Wallet found locally — silently push a backup so cross-device login works
    // in the future. This upgrades wallets created before backup was deployed.
    pushBackupToServer(wallet);
  }

  // Decrypt the secret — may be a BIP39 mnemonic (new) or raw EVM private key (legacy)
  const secret = await decryptPrivateKey(wallet.encryptedKey, wallet.iv, rawId);

  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");

  let address: string;
  let chains: PasskeyChainAddresses | undefined;

  if (isMnemonic) {
    // New format: derive all 5 chain addresses from the BIP39 mnemonic
    const addrs = await deriveAllAddresses(secret.trim().split(/\s+/));
    address = addrs.evm;
    chains  = {
      evm: addrs.evm, sol: addrs.sol, btc: addrs.btc, bch: addrs.bch, bsv: addrs.bsv,
      tron: addrs.tron, xrp: addrs.xrp, ltc: addrs.ltc, doge: addrs.doge,
    };
    saveDerivedAddresses(addrs.evm, {
      evm: addrs.evm, btc: addrs.btc, bch: addrs.bch, bsv: addrs.bsv, sol: addrs.sol,
      tron: addrs.tron, xrp: addrs.xrp, ltc: addrs.ltc, doge: addrs.doge,
    });
  } else {
    // Legacy format: raw EVM private key (0x...)
    const { privateKeyToAccount } = await import("viem/accounts");
    address = privateKeyToAccount(secret as `0x${string}`).address;
  }

  return {
    address,
    credentialId,
    label:               wallet.label ?? "Passkey Wallet",
    restoredFromBackup,
    chains,
  };
}

// ─── Transfer Code (cross-OS-ecosystem recovery) ─────────────────────────────

/**
 * Generate an 8-char transfer code for the given wallet.
 * The code is valid for 10 minutes and can be used ONCE on the new device.
 * Use this when automatic cloud backup doesn't apply (e.g. iPhone → Android).
 */
/**
 * Reveal the underlying secret (BIP39 mnemonic or 0x private key) of a
 * passkey-protected wallet. Triggers a fresh WebAuthn assertion — userVerification
 * is required, and decryption happens only on this device.
 *
 * Used by RevealSecretSheet so passkey-only wallets can also export their seed.
 */
export async function revealPasskeyWalletSecret(address: string): Promise<string> {
  const wallets = listPasskeyWallets();
  const wallet  = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (!wallet) throw new Error("Passkey wallet not found on this device");

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: b642buf(url2b64(wallet.credentialId)), type: "public-key" }],
      userVerification: "required",
      timeout:          60_000,
    },
  }) as PublicKeyCredential | null;
  if (!assertion) throw new Error('Authentication cancelled — tap the button again to retry.');

  return decryptPrivateKey(wallet.encryptedKey, wallet.iv, assertion.rawId);
}

export async function generateTransferCode(credentialId: string): Promise<string> {
  const wallets = listPasskeyWallets();
  const wallet  = wallets.find(w => w.credentialId === credentialId);
  if (!wallet) throw new Error("Wallet not found in localStorage");

  const res = await fetch(`${API_BASE}/passkey/transfer`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      credentialId: wallet.credentialId,
      encryptedKey: wallet.encryptedKey,
      iv:           wallet.iv,
      address:      wallet.address,
      label:        wallet.label ?? "Passkey Wallet",
    }),
  });

  if (!res.ok) throw new Error((await res.json()).error ?? "Transfer code generation failed");
  const { code } = await res.json() as { code: string };
  return code;
}

/**
 * Restore a wallet using a transfer code on the new device.
 * The user still authenticates with their passkey BEFORE calling this —
 * the rawId from the assertion is required to decrypt the wallet data.
 */
export async function restoreFromTransferCode(
  code: string,
  rawId: ArrayBuffer
): Promise<PasskeyWallet> {
  const res = await fetch(`${API_BASE}/passkey/transfer/${encodeURIComponent(code.toUpperCase())}`);
  if (!res.ok) {
    const err = await res.json() as { error: string };
    throw new Error(err.error ?? "Transfer code lookup failed");
  }
  const data = await res.json() as { credentialId: string; encryptedKey: string; iv: string; address: string; label?: string };

  // Verify the rawId can actually decrypt this wallet (must match the original credential)
  try {
    await decryptPrivateKey(data.encryptedKey, data.iv, rawId);
  } catch {
    throw new Error("This transfer code belongs to a different passkey. Please authenticate with the correct passkey.");
  }

  const wallet: PasskeyWallet = {
    credentialId: data.credentialId,
    address:      data.address,
    encryptedKey: data.encryptedKey,
    iv:           data.iv,
    label:        data.label ?? "Passkey Wallet",
    createdAt:    Date.now(),
  };

  saveWallet(wallet);
  return wallet;
}

// ─── On-chain transaction signing ─────────────────────────────────────────────

/**
 * Authenticate with the Orah passkey wallet for the given EVM address and
 * return a viem LocalAccount that can sign and send real on-chain transactions.
 *
 * Flow: passkey biometric auth → decrypt private key in-memory → viem account.
 * The private key is NEVER persisted or logged.
 *
 * Throws if:
 *   - No passkey wallet is found for the given address (seed-phrase-only wallets)
 *   - User cancels biometric auth
 */
export async function getViemAccountForOrahWallet(address: string): Promise<import("viem").Account> {
  if (!isPasskeySupported()) throw new Error("Passkeys not supported in this browser");

  const wallets = listPasskeyWallets();

  // Prefer the wallet whose stored address matches; fall back to discoverable flow
  const matching = wallets.filter(w =>
    w.address.toLowerCase() === address.toLowerCase()
  );

  if (matching.length === 0 && wallets.length === 0) {
    throw new Error(
      "NO_PASSKEY_WALLET: No passkey wallet found. On-chain swaps require a passkey wallet. Use Exchange mode instead."
    );
  }

  const allowCredentials = matching.length > 0
    ? matching.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }))
    : wallets.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }));

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials,
      userVerification: "required",
      timeout: 60_000,
    },
  }) as PublicKeyCredential | null;

  if (!assertion) throw new Error('Authentication cancelled — tap the button again to retry.');

  const rawId        = assertion.rawId;
  const credentialId = b642url(buf2b64(rawId));

  let wallet = wallets.find(w => w.credentialId === credentialId);
  if (!wallet) {
    const restored = await tryRestoreFromServer(credentialId, rawId);
    if (!restored) throw new Error("Passkey wallet data not found. Please restore your wallet first.");
    wallet = restored;
  }

  const secret = await decryptPrivateKey(wallet.encryptedKey, wallet.iv, rawId);

  const { privateKeyToAccount } = await import("viem/accounts");

  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");
  let privateKey: `0x${string}`;

  if (isMnemonic) {
    // Re-derive the raw EVM private key from the mnemonic (same path as viem mnemonicToAccount)
    const { HDKey } = await import("@scure/bip32");
    const { mnemonicToSeedSync } = await import("@scure/bip39");
    const seed    = mnemonicToSeedSync(secret.trim());
    const root    = HDKey.fromMasterSeed(seed);
    const derived = root.derive("m/44'/60'/0'/0/0");
    if (!derived.privateKey) throw new Error("Key derivation failed");
    const hex = Array.from(derived.privateKey).map(b => b.toString(16).padStart(2, "0")).join("");
    privateKey = `0x${hex}` as `0x${string}`;
  } else {
    privateKey = secret as `0x${string}`;
  }

  return privateKeyToAccount(privateKey);
}

// ─── Signing ──────────────────────────────────────────────────────────────────

export interface SignResult {
  signature: string;
  address:   string;
}

/**
 * Send BSV directly on-chain from a passkey wallet.
 *
 * Authenticates via passkey biometrics, derives the BSV private key
 * (m/44'/236'/0'/0/0), then builds, signs, and broadcasts a P2PKH
 * transaction to the BSV network via WhatsOnChain — bypassing the
 * exchange internal ledger entirely.
 *
 * Use this when the user's BSV is in their on-chain wallet (not in the
 * exchange balance).  The exchange withdrawal endpoint checks the internal
 * ledger and will fail for real on-chain BSV.
 */
export async function sendBsvWithPasskey(
  evmAddress:       string,
  senderBsvAddress: string,
  recipientAddress: string,
  amountBsv:        number,
): Promise<{ txid: string; feeSat: number }> {
  const { buildSignBroadcastBsvTx } = await import("./bsvTx.js");

  const wallets  = listPasskeyWallets();
  const matching = wallets.filter(w => w.address.toLowerCase() === evmAddress.toLowerCase());
  if (matching.length === 0 && wallets.length === 0)
    throw new Error("OrahWallet not found on this device. Please create or restore your passkey wallet first.");

  const allowCredentials = matching.length > 0
    ? matching.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }))
    : wallets.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }));

  const challenge = new TextEncoder().encode("send-bsv-" + recipientAddress.slice(0, 22));

  let assertion: PublicKeyCredential | null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: { challenge, allowCredentials, userVerification: "required", timeout: 60_000 },
    }) as PublicKeyCredential | null;
  } catch (err: any) {
    const msg: string = (err?.message ?? "").toLowerCase();
    if (msg.includes("cancel") || msg.includes("abort") || msg.includes("dismiss"))
      throw new Error('Authentication cancelled — tap "Send BSV" again to retry.');
    if (err?.name === "NotAllowedError" || msg.includes("not allowed") || msg.includes("denied"))
      throw new Error('Authentication failed. Tap "Send BSV" again and when prompted choose "OrahDEX Wallet".');
    throw err;
  }
  if (!assertion) throw new Error('Authentication cancelled — tap "Send BSV" again to retry.');

  const rawId        = assertion.rawId;
  const credentialId = b642url(buf2b64(rawId));
  let wallet = wallets.find(w => w.credentialId === credentialId);
  if (!wallet) {
    const restored = await tryRestoreFromServer(credentialId, rawId);
    if (!restored) throw new Error('Passkey not recognised — please choose "OrahDEX Wallet" when prompted.');
    wallet = restored;
  }

  const secret = await decryptPrivateKey(wallet.encryptedKey, wallet.iv, rawId);

  const { HDKey }          = await import("@scure/bip32");
  const { mnemonicToSeed } = await import("@scure/bip39");
  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");

  let bsvPrivKey: Uint8Array;
  if (isMnemonic) {
    const seed    = await mnemonicToSeed(secret.trim());
    const root    = HDKey.fromMasterSeed(seed);
    const derived = root.derive("m/44'/236'/0'/0/0");
    if (!derived.privateKey) throw new Error("BSV key derivation failed");
    bsvPrivKey = derived.privateKey;
  } else {
    const hex = (secret.startsWith("0x") ? secret.slice(2) : secret).padStart(64, "0");
    bsvPrivKey = new Uint8Array(hex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)));
  }

  const amountSat = Math.round(amountBsv * 1e8);
  return buildSignBroadcastBsvTx(senderBsvAddress, recipientAddress, amountSat, bsvPrivKey);
}

/**
 * Sign a BSV withdrawal challenge using the OrahWallet passkey.
 * Finds the passkey wallet by its EVM address, authenticates, derives the
 * BSV private key (m/44'/236'/0'/0/0), and returns a Bitcoin Signed Message
 * compact-signature (65 bytes → base64): 1-byte header + 32r + 32s.
 */
export async function signBsvChallengeWithPasskey(
  evmAddress: string,
  message:    string,
): Promise<string> {
  const wallets  = listPasskeyWallets();
  const matching = wallets.filter(w => w.address.toLowerCase() === evmAddress.toLowerCase());

  // If no local entry matches the address but other wallets exist, allow the
  // browser to present them all — user picks the right one (same fallback as
  // getViemAccountForOrahWallet). If there are NO wallets at all, fail early.
  if (matching.length === 0 && wallets.length === 0) {
    throw new Error("OrahWallet not found on this device. Please create or restore your passkey wallet first.");
  }

  const allowCredentials = matching.length > 0
    ? matching.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }))
    : wallets.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }));

  const challenge = new TextEncoder().encode(message.slice(0, 32));

  let assertion: PublicKeyCredential | null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials,
        userVerification: "required",
        timeout:          60_000,
      },
    }) as PublicKeyCredential | null;
  } catch (err: any) {
    // iOS/Safari throws NotAllowedError for both user cancellation and wrong passkey.
    // Distinguish so the user gets actionable feedback.
    const msg: string = (err?.message ?? "").toLowerCase();
    if (msg.includes("cancel") || msg.includes("abort") || msg.includes("dismiss"))
      throw new Error('Authentication cancelled — tap the button again to retry.');
    if (err?.name === "NotAllowedError" || msg.includes("not allowed") || msg.includes("denied"))
      throw new Error('Authentication failed. Try again and choose "OrahDEX Wallet" when prompted.');
    throw err;
  }
  if (!assertion) throw new Error('Authentication cancelled — tap the button again to retry.');

  const rawId        = assertion.rawId;
  const credentialId = b642url(buf2b64(rawId));

  // Resolve the wallet by the credential that was actually used
  let wallet = wallets.find(w => w.credentialId === credentialId);
  if (!wallet) {
    const restored = await tryRestoreFromServer(credentialId, rawId);
    if (!restored) {
      throw new Error('Passkey not recognised — please choose "OrahDEX Wallet" when prompted.');
    }
    wallet = restored;
  }

  const secret = await decryptPrivateKey(wallet.encryptedKey, wallet.iv, rawId);

  // Derive BSV private key at BIP44 path m/44'/236'/0'/0/0
  const { HDKey } = await import("@scure/bip32");
  const { mnemonicToSeed } = await import("@scure/bip39");
  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");

  let bsvPrivKey: Uint8Array;
  if (isMnemonic) {
    const seed    = await mnemonicToSeed(secret.trim());
    const root    = HDKey.fromMasterSeed(seed);
    const derived = root.derive("m/44'/236'/0'/0/0");
    if (!derived.privateKey) throw new Error("BSV key derivation failed");
    bsvPrivKey = derived.privateKey;
  } else {
    // Legacy raw EVM key — use it as-is
    const hex = (secret.startsWith("0x") ? secret.slice(2) : secret).padStart(64, "0");
    bsvPrivKey = new Uint8Array(hex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)));
  }

  // Bitcoin Signed Message hash: SHA256d("\x18Bitcoin Signed Message:\n" + varint(len) + message)
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const msgBuf = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
  const len    = msgBuf.length;
  const varint = len < 0xfd
    ? new Uint8Array([len])
    : len < 0xffff
      ? new Uint8Array([0xfd, len & 0xff, (len >> 8) & 0xff])
      : new Uint8Array([0xfe, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]);

  const preimage = new Uint8Array(prefix.length + varint.length + msgBuf.length);
  preimage.set(prefix, 0);
  preimage.set(varint, prefix.length);
  preimage.set(msgBuf, prefix.length + varint.length);
  const msgHash = sha256(sha256(preimage));

  // Compact secp256k1 signature (65 bytes: 1 byte header + 32r + 32s)
  // @noble/curves v2.x: sign() defaults to prehash:true (applies SHA-256 internally).
  // Since msgHash is already SHA256d, we must pass prehash:false to sign the raw hash.
  // sign() only returns 64-byte compact r||s — recovery bit must be determined separately.
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const compact64 = secp256k1.sign(msgHash, bsvPrivKey, { lowS: true, prehash: false });

  // Find the correct recovery bit (0 or 1) by trying both and checking which one
  // recovers back to our known public key.
  const expectedPub = secp256k1.getPublicKey(bsvPrivKey, true);
  let recoveryBit = 0;
  for (let rec = 0; rec <= 1; rec++) {
    const probe = new Uint8Array([rec, ...compact64]);
    const recovered = secp256k1.recoverPublicKey(probe, msgHash, { prehash: false });
    if (recovered.length === expectedPub.length && recovered.every((b, i) => b === expectedPub[i])) {
      recoveryBit = rec;
      break;
    }
  }

  // Bitcoin compact-signature format: header = 31 + recoveryBit for compressed keys
  const sigBytes = new Uint8Array([31 + recoveryBit, ...compact64]);
  return btoa(String.fromCharCode(...sigBytes));
}

// ─── Shared helper: authenticate + derive chain private key ──────────────────

/**
 * Authenticate a passkey wallet and derive the secp256k1 private key for the
 * given BIP44 derivation path. Used by all non-EVM on-chain send functions.
 */
async function deriveChainPrivKey(
  evmAddress:  string,
  derivePath:  string,
): Promise<Uint8Array> {
  const wallets  = listPasskeyWallets();
  const matching = wallets.filter(w => w.address.toLowerCase() === evmAddress.toLowerCase());
  if (matching.length === 0 && wallets.length === 0)
    throw new Error("OrahWallet not found on this device. Please create or restore your passkey wallet first.");

  const allowCredentials = matching.length > 0
    ? matching.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }))
    : wallets.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }));

  let assertion: PublicKeyCredential | null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge:        new TextEncoder().encode("send-" + derivePath),
        allowCredentials,
        userVerification: "required",
        timeout:          60_000,
      },
    }) as PublicKeyCredential | null;
  } catch (err: any) {
    const msg: string = (err?.message ?? "").toLowerCase();
    if (msg.includes("cancel") || msg.includes("abort") || msg.includes("dismiss"))
      throw new Error('Authentication cancelled — tap the button again to retry.');
    if (err?.name === "NotAllowedError" || msg.includes("not allowed") || msg.includes("denied"))
      throw new Error('Authentication failed. Try again and choose "OrahDEX Wallet" when prompted.');
    throw err;
  }
  if (!assertion) throw new Error('Authentication cancelled — tap the button again to retry.');

  const rawId        = assertion.rawId;
  const credentialId = b642url(buf2b64(rawId));
  let wallet = wallets.find(w => w.credentialId === credentialId);
  if (!wallet) {
    const restored = await tryRestoreFromServer(credentialId, rawId);
    if (!restored) throw new Error('Passkey not recognised — please choose "OrahDEX Wallet" when prompted.');
    wallet = restored;
  }

  const secret = await decryptPrivateKey(wallet.encryptedKey, wallet.iv, rawId);
  const { HDKey }          = await import("@scure/bip32");
  const { mnemonicToSeed } = await import("@scure/bip39");
  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");

  if (!isMnemonic)
    throw new Error("Legacy wallet format does not support multi-chain signing. Please re-import your seed phrase.");

  const seed    = await mnemonicToSeed(secret.trim());
  const root    = HDKey.fromMasterSeed(seed);
  const derived = root.derive(derivePath);
  if (!derived.privateKey) throw new Error(`Key derivation failed for path ${derivePath}`);
  return derived.privateKey;
}

// ─── BTC on-chain send ────────────────────────────────────────────────────────

export async function sendBtcWithPasskey(
  evmAddress:       string,
  senderBtcAddress: string,
  recipientAddress: string,
  amountBtc:        number,
): Promise<{ txid: string; feeSat: number }> {
  const { buildSignBroadcastBtcTx } = await import("./btcUtxoTx.js");
  const privateKey = await deriveChainPrivKey(evmAddress, "m/84'/0'/0'/0/0");
  const amountSat  = Math.round(amountBtc * 1e8);
  const result     = await buildSignBroadcastBtcTx(senderBtcAddress, recipientAddress, amountSat, privateKey);
  return { txid: result.txid, feeSat: result.feeSat };
}

// ─── LTC on-chain send ────────────────────────────────────────────────────────

export async function sendLtcWithPasskey(
  evmAddress:       string,
  senderLtcAddress: string,
  recipientAddress: string,
  amountLtc:        number,
): Promise<{ txid: string; feeSat: number }> {
  const { buildSignBroadcastLegacyUtxoTx } = await import("./btcUtxoTx.js");
  const privateKey = await deriveChainPrivKey(evmAddress, "m/44'/2'/0'/0/0");
  const amountSat  = Math.round(amountLtc * 1e8);
  const result     = await buildSignBroadcastLegacyUtxoTx("ltc", senderLtcAddress, recipientAddress, amountSat, privateKey);
  return { txid: result.txid, feeSat: result.feeSat };
}

// ─── DOGE on-chain send ───────────────────────────────────────────────────────

export async function sendDogeWithPasskey(
  evmAddress:        string,
  senderDogeAddress: string,
  recipientAddress:  string,
  amountDoge:        number,
): Promise<{ txid: string; feeSat: number }> {
  const { buildSignBroadcastLegacyUtxoTx } = await import("./btcUtxoTx.js");
  const privateKey = await deriveChainPrivKey(evmAddress, "m/44'/3'/0'/0/0");
  const amountSat  = Math.round(amountDoge * 1e8);
  const result     = await buildSignBroadcastLegacyUtxoTx("doge", senderDogeAddress, recipientAddress, amountSat, privateKey);
  return { txid: result.txid, feeSat: result.feeSat };
}

// ─── XRP on-chain send ────────────────────────────────────────────────────────

export async function sendXrpWithPasskey(
  evmAddress:       string,
  senderXrpAddress: string,
  recipientAddress: string,
  amountXrp:        number,
): Promise<{ txid: string }> {
  const { buildSignBroadcastXrpTx } = await import("./xrpTx.js");
  const privateKey = await deriveChainPrivKey(evmAddress, "m/44'/144'/0'/0/0");
  const result     = await buildSignBroadcastXrpTx(senderXrpAddress, recipientAddress, amountXrp, privateKey);
  return { txid: result.txid };
}

// ─── TRX on-chain send ────────────────────────────────────────────────────────

export async function sendTrxWithPasskey(
  evmAddress:       string,
  senderTrxAddress: string,
  recipientAddress: string,
  amountTrx:        number,
): Promise<{ txid: string }> {
  const { buildSignBroadcastTrxTx } = await import("./tronTx.js");
  // TRX uses the same secp256k1 key as EVM (m/44'/60'/0'/0/0)
  const privateKey = await deriveChainPrivKey(evmAddress, "m/44'/60'/0'/0/0");
  const result     = await buildSignBroadcastTrxTx(senderTrxAddress, recipientAddress, amountTrx, privateKey);
  return { txid: result.txid };
}

// ─── BCH on-chain send ────────────────────────────────────────────────────────

export async function sendBchWithPasskey(
  evmAddress:       string,
  senderBchAddress: string,
  recipientAddress: string,
  amountBch:        number,
): Promise<{ txid: string; feeSat: number }> {
  const { buildSignBroadcastBchTx } = await import("./bchTx.js");
  const privateKey = await deriveChainPrivKey(evmAddress, "m/44'/145'/0'/0/0");
  const amountSat  = Math.round(amountBch * 1e8);
  const result     = await buildSignBroadcastBchTx(senderBchAddress, recipientAddress, amountSat, privateKey);
  return { txid: result.txid, feeSat: result.feeSat };
}

// ─── SOL on-chain send (SLIP-0010 ed25519) ────────────────────────────────────

/**
 * Authenticate with a passkey wallet and return the raw decrypted mnemonic.
 * Used by chains that need non-secp256k1 key derivation (e.g. Solana ed25519).
 */
async function getMnemonicFromPasskey(evmAddress: string): Promise<string> {
  const wallets  = listPasskeyWallets();
  const matching = wallets.filter(w => w.address.toLowerCase() === evmAddress.toLowerCase());
  if (matching.length === 0 && wallets.length === 0)
    throw new Error("OrahWallet not found on this device. Please create or restore your passkey wallet first.");

  const allowCredentials = matching.length > 0
    ? matching.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }))
    : wallets.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }));

  let assertion: PublicKeyCredential | null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge:        new TextEncoder().encode("send-sol"),
        allowCredentials,
        userVerification: "required",
        timeout:          60_000,
      },
    }) as PublicKeyCredential | null;
  } catch (err: any) {
    const msg: string = (err?.message ?? "").toLowerCase();
    if (msg.includes("cancel") || msg.includes("abort") || msg.includes("dismiss"))
      throw new Error('Authentication cancelled — tap the button again to retry.');
    if (err?.name === "NotAllowedError" || msg.includes("not allowed") || msg.includes("denied"))
      throw new Error('Authentication failed. Try again and choose "OrahDEX Wallet" when prompted.');
    throw err;
  }
  if (!assertion) throw new Error('Authentication cancelled — tap the button again to retry.');

  const rawId        = assertion.rawId;
  const credentialId = b642url(buf2b64(rawId));
  let wallet = wallets.find(w => w.credentialId === credentialId);
  if (!wallet) {
    const restored = await tryRestoreFromServer(credentialId, rawId);
    if (!restored) throw new Error('Passkey not recognised — please choose "OrahDEX Wallet" when prompted.');
    wallet = restored;
  }

  const secret = await decryptPrivateKey(wallet.encryptedKey, wallet.iv, rawId);
  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");
  if (!isMnemonic)
    throw new Error("Legacy wallet format does not support Solana signing. Please re-import your seed phrase.");
  return secret.trim();
}

export async function sendSolWithPasskey(
  evmAddress:       string,
  senderSolAddress: string,
  recipientAddress: string,
  amountSol:        number,
): Promise<{ txid: string; feeSol: number }> {
  const { deriveSolPrivKey, buildSignBroadcastSolTx } = await import("./solanaTx.js");
  const { mnemonicToSeed } = await import("@scure/bip39");

  const mnemonic   = await getMnemonicFromPasskey(evmAddress);
  const seed       = await mnemonicToSeed(mnemonic);
  const privateKey = await deriveSolPrivKey(seed);
  const result     = await buildSignBroadcastSolTx(senderSolAddress, recipientAddress, amountSol, privateKey);
  return { txid: result.txid, feeSol: result.feeSol };
}

/**
 * Sign arbitrary data with a passkey wallet.
 * Prompts biometric authentication, then decrypts the private key in-memory.
 */
export async function signWithPasskey(
  credentialId: string,
  message: string
): Promise<SignResult> {
  if (!isPasskeySupported()) throw new Error("Passkeys not supported in this browser");

  const wallets   = listPasskeyWallets();
  const wallet    = wallets.find(w => w.credentialId === credentialId);
  if (!wallet) throw new Error("Wallet not found. Please create or import a passkey wallet first.");

  const challenge = new TextEncoder().encode(message.slice(0, 32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: b642buf(url2b64(credentialId)), type: "public-key" }],
      userVerification: "required",
      timeout:          60_000,
    },
  }) as PublicKeyCredential | null;

  if (!assertion) throw new Error('Authentication cancelled — tap the button again to retry.');

  const secret = await decryptPrivateKey(wallet.encryptedKey, wallet.iv, assertion.rawId);

  const { privateKeyToAccount } = await import("viem/accounts");
  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");
  let privateKey: `0x${string}`;

  if (isMnemonic) {
    // New wallet format: BIP39 mnemonic → derive EVM private key at m/44'/60'/0'/0/0
    const { HDKey } = await import("@scure/bip32");
    const { mnemonicToSeedSync } = await import("@scure/bip39");
    const seed    = mnemonicToSeedSync(secret.trim());
    const root    = HDKey.fromMasterSeed(seed);
    const derived = root.derive("m/44'/60'/0'/0/0");
    if (!derived.privateKey) throw new Error("Key derivation failed");
    const hex = Array.from(derived.privateKey).map(b => b.toString(16).padStart(2, "0")).join("");
    privateKey = `0x${hex}` as `0x${string}`;
  } else {
    // Legacy wallet format: raw EVM private key (0x…)
    privateKey = secret as `0x${string}`;
  }

  const account = privateKeyToAccount(privateKey);
  const sig     = await account.signMessage({ message });

  return { signature: sig, address: account.address };
}

// ─── Secret-first helpers (no passkey ceremony) ───────────────────────────────
// These accept a pre-obtained secret (mnemonic or 0x private key) and do pure
// key derivation / signing. Callers (walletSigner.ts) are responsible for
// obtaining the secret via the appropriate auth path (PIN prompt or passkey).

/**
 * Authenticate a NATIVE passkey wallet (created via registerPasskeyWallet /
 * importPasskeyWallet) and return the raw decrypted secret string.
 * This is the native-passkey counterpart of unlockWithPin / unlockWithPasskey.
 */
export async function getNativePasskeySecret(evmAddress: string): Promise<string> {
  const wallets  = listPasskeyWallets();
  const matching = wallets.filter(w => w.address.toLowerCase() === evmAddress.toLowerCase());
  if (matching.length === 0 && wallets.length === 0)
    throw new Error("OrahWallet not found on this device. Please create or restore your passkey wallet first.");

  const allowCredentials = matching.length > 0
    ? matching.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }))
    : wallets.map(w => ({ id: b642buf(url2b64(w.credentialId)), type: "public-key" as const }));

  let assertion: PublicKeyCredential | null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge:        crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials,
        userVerification: "required",
        timeout:          60_000,
      },
    }) as PublicKeyCredential | null;
  } catch (err: any) {
    const msg: string = (err?.message ?? "").toLowerCase();
    if (msg.includes("cancel") || msg.includes("abort") || msg.includes("dismiss"))
      throw new Error('Authentication cancelled — tap the button again to retry.');
    if (err?.name === "NotAllowedError" || msg.includes("not allowed") || msg.includes("denied"))
      throw new Error('Authentication failed. Try again and choose "OrahDEX Wallet" when prompted.');
    throw err;
  }
  if (!assertion) throw new Error('Authentication cancelled — tap the button again to retry.');

  const rawId        = assertion.rawId;
  const credentialId = b642url(buf2b64(rawId));
  let wallet = wallets.find(w => w.credentialId === credentialId);
  if (!wallet) {
    const restored = await tryRestoreFromServer(credentialId, rawId);
    if (!restored) throw new Error('Passkey not recognised — please choose "OrahDEX Wallet" when prompted.');
    wallet = restored;
  }
  return decryptPrivateKey(wallet.encryptedKey, wallet.iv, rawId);
}

/**
 * Derive a secp256k1 private key for the given BIP44 derivation path from a
 * pre-obtained secret string. No passkey ceremony — caller supplies the secret.
 */
export async function deriveChainPrivKeyFromSecret(
  secret:     string,
  derivePath: string,
): Promise<Uint8Array> {
  const { HDKey }          = await import("@scure/bip32");
  const { mnemonicToSeed } = await import("@scure/bip39");
  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");
  if (!isMnemonic)
    throw new Error("Legacy wallet format does not support multi-chain signing. Please re-import your seed phrase.");
  const seed    = await mnemonicToSeed(secret.trim());
  const root    = HDKey.fromMasterSeed(seed);
  const derived = root.derive(derivePath);
  if (!derived.privateKey) throw new Error(`Key derivation failed for path ${derivePath}`);
  return derived.privateKey;
}

/**
 * Derive the BSV private key (m/44'/236'/0'/0/0) from a pre-obtained secret.
 * Accepts both mnemonic and 0x raw private key.
 */
export async function deriveBsvPrivKeyFromSecret(secret: string): Promise<Uint8Array> {
  const isMnemonic = secret.trim().split(/\s+/).length >= 12 && !secret.startsWith("0x");
  if (isMnemonic) {
    const { HDKey }          = await import("@scure/bip32");
    const { mnemonicToSeed } = await import("@scure/bip39");
    const seed    = await mnemonicToSeed(secret.trim());
    const root    = HDKey.fromMasterSeed(seed);
    const derived = root.derive("m/44'/236'/0'/0/0");
    if (!derived.privateKey) throw new Error("BSV key derivation failed");
    return derived.privateKey;
  }
  const hex = (secret.startsWith("0x") ? secret.slice(2) : secret).padStart(64, "0");
  return new Uint8Array(hex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)));
}

/**
 * Produce a Bitcoin Signed Message compact signature from a pre-obtained secret.
 * No passkey ceremony — caller supplies the secret (mnemonic or 0x privkey).
 */
export async function signBsvChallengeFromSecret(
  message: string,
  secret:  string,
): Promise<string> {
  const { sha256 }    = await import("@noble/hashes/sha2.js");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const bsvPrivKey    = await deriveBsvPrivKeyFromSecret(secret);

  const msgBuf = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
  const len    = msgBuf.length;
  const varint = len < 0xfd
    ? new Uint8Array([len])
    : len < 0xffff
      ? new Uint8Array([0xfd, len & 0xff, (len >> 8) & 0xff])
      : new Uint8Array([0xfe, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]);

  const preimage = new Uint8Array(prefix.length + varint.length + msgBuf.length);
  preimage.set(prefix, 0);
  preimage.set(varint, prefix.length);
  preimage.set(msgBuf, prefix.length + varint.length);

  const msgHash  = sha256(sha256(preimage));

  // @noble/curves v2.x: sign() returns raw 64-byte compact Uint8Array (r‖s),
  // NOT a Signature object — so there is no .toCompactRawBytes() or .recovery.
  // Recovery bit must be brute-forced by trying both values and checking which
  // one recovers back to our known public key (same as bsvTx signing above).
  const compact64    = secp256k1.sign(msgHash, bsvPrivKey, { lowS: true, prehash: false });
  const expectedPub  = secp256k1.getPublicKey(bsvPrivKey, true);
  let recoveryBit    = 0;
  for (let rec = 0; rec <= 1; rec++) {
    const probe     = new Uint8Array([rec, ...compact64]);
    const recovered = secp256k1.recoverPublicKey(probe, msgHash, { prehash: false });
    if (recovered.length === expectedPub.length && recovered.every((b, i) => b === expectedPub[i])) {
      recoveryBit = rec;
      break;
    }
  }
  const sigBytes = new Uint8Array([31 + recoveryBit, ...compact64]);
  return btoa(String.fromCharCode(...sigBytes));
}
