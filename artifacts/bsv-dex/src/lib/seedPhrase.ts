/**
 * OrahDEX HD Wallet — BIP39 + BIP44/SLIP-0010 multi-chain derivation (browser-safe).
 *
 * One seed phrase → nine chain addresses (each using its own BIP44 coin type):
 *   EVM (Ethereum, BSC, Polygon…)  : m/44'/60'/0'/0/0   secp256k1
 *   BTC (Bitcoin)                  : m/84'/0'/0'/0/0    secp256k1, P2WPKH bech32 (starts with "bc1q")
 *   BSV (Bitcoin SV)               : m/44'/236'/0'/0/0  secp256k1, P2PKH (starts with "1")
 *   BCH (Bitcoin Cash)             : m/44'/145'/0'/0/0  secp256k1, CashAddr (bitcoincash:q…)
 *   SOL (Solana)                   : m/44'/501'/0'/0'   ed25519 SLIP-0010 (Phantom-compatible)
 *   TRON                           : m/44'/195'/0'/0/0  secp256k1, keccak256+0x41 Base58Check (starts with "T")
 *   XRP (Ripple XRP Ledger)        : m/44'/144'/0'/0/0  secp256k1, XRP Base58 alphabet (starts with "r")
 *   LTC (Litecoin)                 : m/44'/2'/0'/0/0    secp256k1, P2PKH version 0x30 (starts with "L")
 *   DOGE (Dogecoin)                : m/44'/3'/0'/0/0    secp256k1, P2PKH version 0x1E (starts with "D")
 *
 * All addresses are fully compatible with MetaMask (incl. TRON snap), Trust Wallet, Phantom, Ledger, etc.
 */

import {
  generateMnemonic as scureGenerateMnemonic,
  mnemonicToAccount,
  english,
} from "viem/accounts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeed } from "@scure/bip39";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { hmac } from "@noble/hashes/hmac.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
// Note: @noble/curves (ed25519, secp256k1) are lazily imported inside the
// functions that use them to avoid iOS Safari module-initialization races
// where the static import resolves to `undefined` in split chunks.

// ─── BIP39 mnemonic generation ────────────────────────────────────────────────

export function generateMnemonic(wordCount: 12 | 24 = 12): string[] {
  const strength = wordCount === 12 ? 128 : 256;
  const phrase = scureGenerateMnemonic(english, strength);
  return phrase.split(" ");
}

// ─── Multi-chain address derivation ──────────────────────────────────────────

export interface HdWalletAddresses {
  evm: string;
  btc: string;
  bch: string;
  bsv: string;
  sol: string;
  tron: string;
  xrp: string;
  ltc: string;
  doge: string;
}

export async function deriveAllAddresses(mnemonic: string[]): Promise<HdWalletAddresses> {
  const phrase = mnemonic.join(" ");

  const evm = mnemonicToAccount(phrase, { accountIndex: 0, addressIndex: 0 }).address;

  const seed = await mnemonicToSeed(phrase);
  const root = HDKey.fromMasterSeed(seed);

  const btcKey = root.derive("m/84'/0'/0'/0/0");  // BIP84 Native SegWit
  const btc = deriveP2WPKH(btcKey);              // bech32 bc1q… address

  const bsvKey = root.derive("m/44'/236'/0'/0/0");
  const bsv = deriveP2PKH(bsvKey);

  const bchKey = root.derive("m/44'/145'/0'/0/0");
  const bch = deriveCashAddr(bchKey);

  const sol  = await deriveSolanaAddress(seed);
  // TRON uses its own BIP44 coin type 195 (m/44'/195'/0'/0/0) — a different key than EVM.
  // Deriving from EVM key via evmToTronAddress() gives the wrong address vs MetaMask / Trust Wallet.
  const tronKey = root.derive("m/44'/195'/0'/0/0");
  const tron = await deriveTronAddressFromHdKey(tronKey);

  const xrpKey  = root.derive("m/44'/144'/0'/0/0");
  const xrp  = deriveXrpAddress(xrpKey);

  const ltcKey  = root.derive("m/44'/2'/0'/0/0");
  const ltc  = deriveLtcAddress(ltcKey);

  const dogeKey = root.derive("m/44'/3'/0'/0/0");
  const doge = deriveDogeAddress(dogeKey);

  return { evm, btc, bch, bsv, sol, tron, xrp, ltc, doge };
}

// ─── Base58 with configurable alphabet ───────────────────────────────────────

const BITCOIN_BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const XRP_BASE58     = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

function base58EncodeWithAlphabet(bytes: Uint8Array, alphabet: string): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = "";
  for (const b of bytes) { if (b !== 0) break; result += alphabet[0]; }
  return result + digits.reverse().map(d => alphabet[d]).join("");
}

function base58Encode(bytes: Uint8Array): string {
  return base58EncodeWithAlphabet(bytes, BITCOIN_BASE58);
}

// ─── Base58Check (BTC / BSV / LTC / DOGE — Bitcoin alphabet) ─────────────────

function encodeBase58Check(payload: Uint8Array, version: number): string {
  const versioned = new Uint8Array(1 + payload.length);
  versioned[0] = version;
  versioned.set(payload, 1);
  const checksum = sha256(sha256(versioned)).slice(0, 4);
  const full = new Uint8Array(versioned.length + 4);
  full.set(versioned);
  full.set(checksum, versioned.length);
  return base58Encode(full);
}

/** Base58Check with a custom alphabet — used for XRP (XRP Ledger alphabet). */
function encodeBase58CheckWithAlphabet(payload: Uint8Array, version: number, alphabet: string): string {
  const versioned = new Uint8Array(1 + payload.length);
  versioned[0] = version;
  versioned.set(payload, 1);
  const checksum = sha256(sha256(versioned)).slice(0, 4);
  const full = new Uint8Array(versioned.length + 4);
  full.set(versioned);
  full.set(checksum, versioned.length);
  return base58EncodeWithAlphabet(full, alphabet);
}

// ─── P2PKH Base58Check (BSV — version 0x00 → starts with "1") ───────────────

function deriveP2PKH(key: HDKey): string {
  if (!key.publicKey) throw new Error("no public key");
  const pkh = hash160(key.publicKey);
  return encodeBase58Check(pkh, 0x00);
}

// ─── Bech32 (BTC Native SegWit P2WPKH — BIP84 → starts with "bc1q") ─────────

const BECH32_CHARSET  = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN      = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (const ch of hrp) ret.push(ch.charCodeAt(0) >> 5);
  ret.push(0);
  for (const ch of hrp) ret.push(ch.charCodeAt(0) & 31);
  return ret;
}

function bech32Encode(hrp: string, witnessVersion: number, program: Uint8Array): string {
  const data5 = Array.from(convertBits(program, 8, 5, true));
  const full   = [witnessVersion, ...data5];
  const expand = bech32HrpExpand(hrp);
  const mod    = bech32Polymod([...expand, ...full, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, p) => (mod >> (5 * (5 - p))) & 31);
  return hrp + "1" + [...full, ...checksum].map(d => BECH32_CHARSET[d]).join("");
}

/** BIP84 P2WPKH — Native SegWit, produces a "bc1q…" address. */
function deriveP2WPKH(key: HDKey): string {
  if (!key.publicKey) throw new Error("no public key");
  const pkh = hash160(key.publicKey);
  return bech32Encode("bc", 0, pkh);  // witness version 0 = P2WPKH
}

// ─── Tron (BIP44 coin type 195, m/44'/195'/0'/0/0 — different key from EVM) ───

/**
 * Derive a TRON address from an HD key at m/44'/195'/0'/0/0.
 * TRON uses secp256k1 + keccak256 (same algorithm as Ethereum) but a different
 * BIP44 path (coin type 195 vs 60), giving a distinct private key and address.
 * The 20-byte address is encoded with prefix 0x41 → Base58Check → "T…" address.
 * This matches MetaMask (TRON snap), Trust Wallet, Ledger, and all standard wallets.
 */
async function deriveTronAddressFromHdKey(key: HDKey): Promise<string> {
  if (!key.privateKey) throw new Error("no TRON private key");
  // Lazy import avoids iOS Safari module-initialization race where the static
  // import resolves to `undefined` when the chunk first executes.
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  // getPublicKey(privateKey, false) → 65-byte uncompressed point (04 || x || y)
  // This is equivalent to ProjectivePoint.fromHex(compressedPubKey).toRawBytes(false)
  // but avoids the point-decompression path that crashes on iOS Safari.
  const uncompressed = secp256k1.getPublicKey(key.privateKey, false);
  // keccak256 of the 64-byte payload (skip 0x04 prefix byte), take last 20 bytes
  const hash = keccak_256(uncompressed.slice(1));
  const addrHex = "0x" + Array.from(hash.slice(12)).map(b => b.toString(16).padStart(2, "0")).join("");
  return evmToTronAddress(addrHex);
}

/**
 * Convert an EVM address (0x…) to a Tron Base58Check address (T…).
 * Tron uses the same secp256k1 key as Ethereum and the same address hashing,
 * but prefixes the 20-byte address with 0x41 (Tron mainnet) before Base58Check.
 */
function evmToTronAddress(evmHex: string): string {
  const hex = evmHex.startsWith("0x") ? evmHex.slice(2) : evmHex;
  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  return encodeBase58Check(bytes, 0x41);  // 0x41 = Tron mainnet prefix → "T…"
}

// ─── XRP (XRP Ledger — version 0x00 with XRP Base58 alphabet → starts with "r") ─

function deriveXrpAddress(key: HDKey): string {
  if (!key.publicKey) throw new Error("no public key");
  const pkh = hash160(key.publicKey);
  return encodeBase58CheckWithAlphabet(pkh, 0x00, XRP_BASE58);
}

// ─── LTC (Litecoin — P2PKH version 0x30 → starts with "L") ──────────────────

function deriveLtcAddress(key: HDKey): string {
  if (!key.publicKey) throw new Error("no public key");
  const pkh = hash160(key.publicKey);
  return encodeBase58Check(pkh, 0x30);
}

// ─── DOGE (Dogecoin — P2PKH version 0x1E → starts with "D") ─────────────────

function deriveDogeAddress(key: HDKey): string {
  if (!key.publicKey) throw new Error("no public key");
  const pkh = hash160(key.publicKey);
  return encodeBase58Check(pkh, 0x1E);
}

// ─── Solana (ed25519 / SLIP-0010) ────────────────────────────────────────────

/**
 * Derive a Solana address using SLIP-0010 (ed25519 curve).
 * Path: m/44'/501'/0'/0' — same as Phantom wallet default.
 * Address = plain Base58 of the 32-byte ed25519 public key.
 */
async function deriveSolanaAddress(seed: Uint8Array): Promise<string> {
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const privateKey = slip10Derive(seed, [
    0x80000000 + 44,   // 44'
    0x80000000 + 501,  // 501'  (Solana coin type)
    0x80000000 + 0,    // 0'
    0x80000000 + 0,    // 0'
  ]);
  const publicKey = ed25519.getPublicKey(privateKey);
  return base58Encode(publicKey); // plain Base58, no checksum
}

/**
 * SLIP-0010 key derivation for ed25519 (hardened-only).
 * https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 */
function slip10Derive(seed: Uint8Array, indexes: number[]): Uint8Array {
  const seedKey = new TextEncoder().encode("ed25519 seed");
  let I = hmac(sha512, seedKey, seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  for (const index of indexes) {
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index >>> 0, false);
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }
  return key;
}

// ─── CashAddr (BCH) ──────────────────────────────────────────────────────────

function deriveCashAddr(key: HDKey): string {
  if (!key.publicKey) throw new Error("no public key");
  const pkh = hash160(key.publicKey);
  return encodeCashAddr("bitcoincash", pkh);
}

function encodeCashAddr(prefix: string, pkh: Uint8Array): string {
  const payload = new Uint8Array(pkh.length + 1);
  payload[0] = 0x00;
  payload.set(pkh, 1);

  const data5 = convertBits(payload, 8, 5, true);
  const checksum = cashAddrPolymod(prefix, data5);

  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  let encoded = prefix + ":";
  for (const b of data5) encoded += CHARSET[b];
  for (let i = 39; i >= 0; i--) encoded += CHARSET[Number((checksum >> BigInt(i * 5)) & 0x1fn)];
  return encoded;
}

function cashAddrPolymod(prefix: string, data: Uint8Array): bigint {
  const GENERATOR = [
    0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n,
  ];
  let checksum = 1n;
  for (const ch of prefix) {
    const b = BigInt(ch.charCodeAt(0) & 0x1f);
    const high = checksum >> 35n;
    checksum = ((checksum & 0x07ffffffffn) << 5n) ^ b;
    for (let i = 0; i < 5; i++) if ((high >> BigInt(i)) & 1n) checksum ^= GENERATOR[i];
  }
  const highSep = checksum >> 35n;
  checksum = ((checksum & 0x07ffffffffn) << 5n);
  for (let i = 0; i < 5; i++) if ((highSep >> BigInt(i)) & 1n) checksum ^= GENERATOR[i];
  for (const b of data) {
    const high = checksum >> 35n;
    checksum = ((checksum & 0x07ffffffffn) << 5n) ^ BigInt(b);
    for (let i = 0; i < 5; i++) if ((high >> BigInt(i)) & 1n) checksum ^= GENERATOR[i];
  }
  for (let j = 0; j < 8; j++) {
    const high = checksum >> 35n;
    checksum = ((checksum & 0x07ffffffffn) << 5n);
    for (let i = 0; i < 5; i++) if ((high >> BigInt(i)) & 1n) checksum ^= GENERATOR[i];
  }
  return checksum ^ 1n;
}

function convertBits(data: Uint8Array, from: number, to: number, pad: boolean): Uint8Array {
  let acc = 0, bits = 0;
  const result: number[] = [];
  const maxv = (1 << to) - 1;
  for (const val of data) {
    acc = (acc << from) | val;
    bits += from;
    while (bits >= to) { bits -= to; result.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) result.push((acc << (to - bits)) & maxv);
  return new Uint8Array(result);
}

// ─── HASH160 = SHA256 → RIPEMD160 ────────────────────────────────────────────

function hash160(pubkey: Uint8Array): Uint8Array {
  return ripemd160(sha256(pubkey));
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateMnemonic(
  input: string,
): { valid: boolean; words: string[]; error?: string } {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 12 && words.length !== 24) {
    return { valid: false, words, error: `Enter 12 or 24 words (you entered ${words.length})` };
  }
  const invalid = words.filter(w => !english.includes(w));
  if (invalid.length > 0) {
    return {
      valid: false, words,
      error: `Unknown word${invalid.length > 1 ? "s" : ""}: ${invalid.slice(0, 3).join(", ")}`,
    };
  }
  return { valid: true, words };
}
