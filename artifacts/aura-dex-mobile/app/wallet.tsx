import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Platform, TextInput, ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useWallet, ConnectedWallet } from "@/context/WalletContext";
import * as ExpoCrypto from "expo-crypto";
import { generateMnemonic, deriveAddress, validateMnemonic } from "@/utils/seedPhrase";

const C = Colors.dark;
const PIN_LENGTH = 6;

const EVM_WALLETS = [
  { id: "metamask", name: "MetaMask", icon: "🦊", desc: "Most popular Ethereum wallet", network: "evm" as const, popular: true },
  { id: "walletconnect", name: "WalletConnect", icon: "🔗", desc: "Connect any mobile wallet via QR", network: "evm" as const, popular: true },
  { id: "coinbase", name: "Coinbase Wallet", icon: "🔵", desc: "Self-custody by Coinbase", network: "evm" as const, popular: true },
  { id: "rainbow", name: "Rainbow", icon: "🌈", desc: "Fun, simple Ethereum wallet", network: "evm" as const },
  { id: "trust", name: "Trust Wallet", icon: "🛡️", desc: "Multi-chain mobile wallet", network: "evm" as const },
  { id: "phantom", name: "Phantom", icon: "👻", desc: "Multichain — ETH, SOL, BTC", network: "evm" as const },
];

const BSV_WALLETS = [
  { id: "handcash", name: "HandCash", icon: "✋", desc: "Social BSV wallet", network: "bsv" as const, popular: true },
  { id: "relayx", name: "RelayX", icon: "⚡", desc: "BSV DeFi wallet", network: "bsv" as const, popular: true },
  { id: "panda", name: "Panda Wallet", icon: "🐼", desc: "Browser extension for BSV", network: "bsv" as const, popular: true },
  { id: "sensilet", name: "Sensilet", icon: "🔷", desc: "sCrypt smart contract wallet", network: "bsv" as const },
  { id: "yours", name: "Yours Wallet", icon: "💛", desc: "Open-source BSV wallet", network: "bsv" as const },
];

type WalletView = "landing" | "create" | "import" | "connect" | "pinSetup";
type ConnectTab = "evm" | "bsv";
type WalletNetwork = "evm" | "bsv";

interface WalletEntry {
  id: string;
  name: string;
  icon: string;
  desc: string;
  network: WalletNetwork;
  popular?: boolean;
}

function generateAddress(network: WalletNetwork): string {
  if (network === "evm") {
    const bytes = new Uint8Array(20);
    ExpoCrypto.getRandomValues(bytes);
    return "0x" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  }
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = new Uint8Array(33);
  ExpoCrypto.getRandomValues(bytes);
  return "1" + Array.from(bytes, b => chars[b % chars.length]).join("");
}

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const { connect, wallet, disconnect } = useWallet();
  const [view, setView] = useState<WalletView>("landing");
  // Holds the wallet to connect AFTER PIN setup
  const [pendingWallet, setPendingWallet] = useState<ConnectedWallet | null>(null);

  const handleClose = () => router.back();

  const getTitle = () => {
    if (view === "landing") return "Get Started";
    if (view === "create") return "Create Wallet";
    if (view === "import") return "Import Wallet";
    if (view === "pinSetup") return "Secure Wallet";
    return "Connect Wallet";
  };

  // Called by Create/Import views when address is ready — go to PIN setup
  const handleWalletReady = useCallback((w: ConnectedWallet) => {
    setPendingWallet(w);
    setView("pinSetup");
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: C.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 50 : insets.top + 8 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {view !== "landing" && (
            <TouchableOpacity style={styles.backBtn} onPress={() => setView("landing")}>
              <Feather name="arrow-left" size={18} color={C.text} />
            </TouchableOpacity>
          )}
          <View>
            <Text style={styles.title}>{getTitle()}</Text>
            <Text style={styles.subtitle}>✦ Trade means DEX</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
          <Feather name="x" size={20} color={C.text} />
        </TouchableOpacity>
      </View>

      {view === "landing" && <LandingView onSelect={setView} wallet={wallet} disconnect={disconnect} />}
      {view === "create" && <CreateView onWalletReady={handleWalletReady} />}
      {view === "import" && <ImportView onWalletReady={handleWalletReady} />}
      {view === "connect" && <ConnectView connect={connect} onDone={handleClose} />}
      {view === "pinSetup" && pendingWallet && (
        <PinSetupView pendingWallet={pendingWallet} onDone={handleClose} />
      )}
    </View>
  );
}

function LandingView({
  onSelect, wallet, disconnect,
}: { onSelect: (v: WalletView) => void; wallet: any; disconnect: () => void }) {
  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 40 }}>
      <Text style={styles.landingSubtitle}>Non-custodial · On-chain settlement · No registration</Text>

      {wallet && (
        <View style={styles.connectedCard}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={styles.connectedDot} />
            <View>
              <Text style={styles.connectedTitle}>Connected: {wallet.provider}</Text>
              <Text style={styles.connectedAddr}>{wallet.address.slice(0, 14)}...{wallet.address.slice(-6)}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); disconnect(); }}>
            <Feather name="log-out" size={16} color={C.sell} />
          </TouchableOpacity>
        </View>
      )}

      {[
        {
          view: "create" as WalletView,
          icon: "plus-circle", iconColor: C.primary, bgColor: C.primary + "18",
          title: "Create New Wallet",
          desc: "Generate a new wallet with a secure 12 or 24-word seed phrase. Works on BSV and EVM chains.",
          tags: ["BIP39", "BSV", "EVM"],
          tagColor: C.primary,
        },
        {
          view: "import" as WalletView,
          icon: "download", iconColor: "#A78BFA", bgColor: "#7C3AED18",
          title: "Import Existing Wallet",
          desc: "Restore access using your 12 or 24-word seed phrase from any BIP39-compatible wallet.",
          tags: ["Seed Phrase", "12 or 24 words"],
          tagColor: "#A78BFA",
        },
        {
          view: "connect" as WalletView,
          icon: "link", iconColor: "#60A5FA", bgColor: "#3B82F618",
          title: "Connect Wallet",
          desc: "Link MetaMask, WalletConnect, HandCash, RelayX and 10+ other wallets.",
          tags: ["🦊", "🔗", "✋", "⚡"],
          tagColor: "#60A5FA",
        },
      ].map((item) => (
        <TouchableOpacity
          key={item.view}
          style={styles.optionCard}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onSelect(item.view); }}
          activeOpacity={0.8}
        >
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14, marginBottom: 12 }}>
            <View style={[styles.optionIconWrap, { backgroundColor: item.bgColor }]}>
              <Feather name={item.icon as any} size={20} color={item.iconColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.optionTitle}>{item.title}</Text>
              <Text style={styles.optionDesc}>{item.desc}</Text>
            </View>
            <Feather name="chevron-right" size={16} color={C.textMuted} style={{ marginTop: 4 }} />
          </View>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {item.tags.map((tag) => (
              <View key={tag} style={[styles.tagPill, { backgroundColor: item.tagColor + "18" }]}>
                <Text style={[styles.tagText, { color: item.tagColor }]}>{tag}</Text>
              </View>
            ))}
          </View>
        </TouchableOpacity>
      ))}

      <View style={styles.infoCard}>
        <Feather name="shield" size={15} color={C.primary} />
        <Text style={styles.infoText}>
          <Text style={{ fontFamily: "Inter_700Bold", color: C.primary }}>Non-custodial & Trustless. </Text>
          Orah DEX never holds your funds or stores your seed phrase. All trades settle on-chain.
        </Text>
      </View>
    </ScrollView>
  );
}

function CreateView({ onWalletReady }: { onWalletReady: (w: ConnectedWallet) => void }) {
  const [network, setNetwork] = useState<WalletNetwork>("bsv");
  const [wordCount, setWordCount] = useState<12 | 24>(12);
  const [mnemonic, setMnemonic] = useState<string[]>(() => generateMnemonic(12));
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const regen = () => {
    setMnemonic(generateMnemonic(wordCount));
    setRevealed(false); setCopied(false); setConfirmed(false);
  };

  const handleCreate = async () => {
    if (!confirmed || !revealed) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const address = await deriveAddress(mnemonic, network);
    onWalletReady({ address, provider: "aura-wallet", network });
  };

  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 40 }}>
      {/* Network */}
      <View>
        <Text style={styles.sectionLabel}>Network</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(["bsv", "evm"] as WalletNetwork[]).map((n) => (
            <TouchableOpacity key={n} style={[styles.toggleBtn, network === n && styles.toggleBtnActive]}
              onPress={() => { Haptics.selectionAsync(); setNetwork(n); }}>
              <Text style={[styles.toggleBtnText, network === n && styles.toggleBtnTextActive]}>
                {n === "bsv" ? "₿ Bitcoin SV" : "🌐 EVM"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Word count */}
      <View>
        <Text style={styles.sectionLabel}>Phrase Length</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {([12, 24] as const).map((n) => (
            <TouchableOpacity key={n} style={[styles.toggleBtn, wordCount === n && styles.toggleBtnActive]}
              onPress={() => { Haptics.selectionAsync(); setWordCount(n); setMnemonic(generateMnemonic(n)); setRevealed(false); setCopied(false); }}>
              <Text style={[styles.toggleBtnText, wordCount === n && styles.toggleBtnTextActive]}>{n} words</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Seed grid */}
      <View style={styles.seedGrid}>
        {mnemonic.map((word, i) => (
          <View key={i} style={[styles.seedCell, { width: wordCount === 12 ? "30%" : "23%" }]}>
            <Text style={styles.seedNum}>{i + 1}.</Text>
            <Text style={[styles.seedWord, !revealed && { color: "transparent", textShadowColor: C.text, textShadowRadius: 8 }]}>{word}</Text>
          </View>
        ))}
        {!revealed && (
          <TouchableOpacity style={styles.revealOverlay} onPress={() => setRevealed(true)}>
            <Feather name="eye" size={20} color={C.primary} />
            <Text style={styles.revealText}>Tap to Reveal</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Actions */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TouchableOpacity style={styles.outlineBtn} onPress={regen}>
          <Feather name="refresh-cw" size={14} color={C.textSecondary} />
          <Text style={styles.outlineBtnText}>Regenerate</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.outlineBtn, { flex: 1, justifyContent: "center", borderColor: revealed ? C.primary + "50" : C.cardBorder }]}
          onPress={() => { if (!revealed) return; setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          disabled={!revealed}
        >
          <Feather name={copied ? "check" : "copy"} size={14} color={revealed ? C.primary : C.textMuted} />
          <Text style={[styles.outlineBtnText, { color: revealed ? C.primary : C.textMuted }]}>
            {copied ? "Copied!" : "Copy Phrase"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Warning */}
      <View style={styles.warnCard}>
        <Feather name="alert-triangle" size={14} color="#FBBF24" />
        <Text style={styles.warnText}>
          Write this phrase down and store it somewhere safe.{" "}
          <Text style={{ fontFamily: "Inter_700Bold", color: "#FBBF24" }}>Never share it with anyone.</Text>
          {" "}Anyone with your seed phrase has full access to your funds.
        </Text>
      </View>

      {/* Confirm */}
      <TouchableOpacity
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}
        onPress={() => { Haptics.selectionAsync(); setConfirmed(!confirmed); }}
      >
        <View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>
          {confirmed && <Feather name="check" size={12} color="#000" />}
        </View>
        <Text style={styles.checkboxLabel}>
          I have written down my seed phrase and stored it safely. I understand it cannot be recovered.
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.primaryBtn, (!confirmed || !revealed) && { opacity: 0.4 }]}
        onPress={handleCreate}
        disabled={!confirmed || !revealed}
      >
        <Text style={styles.primaryBtnText}>Create Wallet</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function ImportView({ onWalletReady }: { onWalletReady: (w: ConnectedWallet) => void }) {
  const [network, setNetwork] = useState<WalletNetwork>("bsv");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const wordCount = input.trim().split(/\s+/).filter(Boolean).length;

  const handleImport = async () => {
    const result = validateMnemonic(input);
    if (!result.valid) { setError(result.error ?? "Invalid phrase"); return; }
    setError(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const addr = await deriveAddress(result.words, network);
    onWalletReady({ address: addr, provider: "aura-wallet", network });
  };  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 40 }}>
      <View>
        <Text style={styles.sectionLabel}>Network</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(["bsv", "evm"] as WalletNetwork[]).map((n) => (
            <TouchableOpacity key={n} style={[styles.toggleBtn, network === n && styles.toggleBtnActive]}
              onPress={() => { Haptics.selectionAsync(); setNetwork(n); }}>
              <Text style={[styles.toggleBtnText, network === n && styles.toggleBtnTextActive]}>
                {n === "bsv" ? "₿ Bitcoin SV" : "🌐 EVM"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Text style={styles.sectionLabel}>Seed Phrase</Text>
          <Text style={[styles.sectionLabel, { textTransform: "none", letterSpacing: 0 }]}>{wordCount} words</Text>
        </View>
        <TextInput
          style={[styles.seedInput, error ? { borderColor: C.sell + "80" } : {}]}
          placeholder="Enter your 12 or 24-word seed phrase, separated by spaces..."
          placeholderTextColor={C.textMuted}
          value={input}
          onChangeText={(t) => { setInput(t); setError(null); }}
          multiline
          numberOfLines={5}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
        {error && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
            <Feather name="alert-triangle" size={12} color={C.sell} />
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: C.sell }}>{error}</Text>
          </View>
        )}
      </View>

      <View style={{ flexDirection: "row", gap: 8 }}>
        {["12 words", "24 words", "BIP39"].map((tag) => (
          <View key={tag} style={styles.tagPillSmall}><Text style={styles.tagPillSmallText}>{tag}</Text></View>
        ))}
      </View>

      <View style={styles.warnCard}>
        <Feather name="alert-triangle" size={14} color="#FBBF24" />
        <Text style={styles.warnText}>
          Never enter your seed phrase on untrusted sites. Orah DEX never stores or transmits your phrase — all derivation is local.
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.importBtn, input.trim().length === 0 && { opacity: 0.4 }]}
        onPress={handleImport}
        disabled={input.trim().length === 0}
      >
        <Feather name="download" size={16} color="#fff" />
        <Text style={styles.primaryBtnText}>Import Wallet</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function ConnectView({ connect, onDone }: { connect: any; onDone: () => void }) {
  const [tab, setTab] = useState<ConnectTab>("evm");
  const [connecting, setConnecting] = useState<string | null>(null);

  const wallets = tab === "evm" ? EVM_WALLETS : BSV_WALLETS;
  const popular = wallets.filter((w) => w.popular);
  const others = wallets.filter((w) => !w.popular);

  const handleConnect = (w: WalletEntry) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setConnecting(w.id);
    setTimeout(() => {
      connect({ address: generateAddress(w.network), provider: w.id, network: w.network });
      setConnecting(null);
      onDone();
    }, 1200);
  };

  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ flexDirection: "row", gap: 8, padding: 16 }}>
        {(["evm", "bsv"] as ConnectTab[]).map((t) => (
          <TouchableOpacity key={t}
            style={[styles.networkTab, tab === t && styles.networkTabActive]}
            onPress={() => { Haptics.selectionAsync(); setTab(t); }}>
            <Text style={[styles.networkTabText, tab === t && styles.networkTabTextActive]}>
              {t === "evm" ? "🌐 EVM / Web3" : "₿ Bitcoin SV"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionLabel2}>Popular</Text>
      {popular.map((w) => <WalletRow key={w.id} wallet={w} connecting={connecting} onConnect={handleConnect} />)}
      <Text style={[styles.sectionLabel2, { marginTop: 8 }]}>More Wallets</Text>
      {others.map((w) => <WalletRow key={w.id} wallet={w} connecting={connecting} onConnect={handleConnect} />)}

      <View style={[styles.infoCard, { marginHorizontal: 20, marginTop: 16 }]}>
        <Feather name="shield" size={15} color={C.primary} />
        <Text style={styles.infoText}>
          <Text style={{ fontFamily: "Inter_700Bold", color: C.primary }}>Non-custodial & Trustless. </Text>
          Orah DEX never holds your funds. All trades settle directly on-chain.
        </Text>
      </View>
    </ScrollView>
  );
}

function WalletRow({ wallet, connecting, onConnect }: {
  wallet: WalletEntry; connecting: string | null; onConnect: (w: WalletEntry) => void;
}) {
  const isConnecting = connecting === wallet.id;
  const isDisabled = !!connecting;
  return (
    <TouchableOpacity
      style={[styles.walletRow, isConnecting && styles.walletRowActive, isDisabled && !isConnecting && { opacity: 0.4 }]}
      onPress={() => onConnect(wallet)} disabled={isDisabled} activeOpacity={0.75}>
      <Text style={styles.walletEmoji}>{wallet.icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.walletName}>{wallet.name}</Text>
        <Text style={styles.walletDesc}>{wallet.desc}</Text>
      </View>
      {isConnecting
        ? <View style={styles.spinner}><Text style={{ color: C.primary, fontSize: 12, fontFamily: "Inter_700Bold" }}>···</Text></View>
        : <Feather name="chevron-right" size={16} color={C.textMuted} />}
    </TouchableOpacity>
  );
}

// ── PIN Setup View ─────────────────────────────────────────────────────────────
// Shown after a seed phrase wallet is created or imported. The user sets a
// 6-digit PIN and optionally enables biometric unlock.

const PIN_KEYPAD_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["", "0", "del"],
] as const;

function PinSetupView({
  pendingWallet,
  onDone,
}: {
  pendingWallet: ConnectedWallet;
  onDone: () => void;
}) {
  const { connect, setPin, toggleBiometrics, hasBiometrics } = useWallet();
  const [step, setStep] = useState<"enter" | "confirm" | "biometrics">("enter");
  const [firstPin, setFirstPin] = useState("");
  const [digits, setDigits] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleDigit = useCallback((d: string) => {
    if (digits.length >= PIN_LENGTH) return;
    Haptics.selectionAsync();
    const next = [...digits, d];
    setDigits(next);
    if (next.length === PIN_LENGTH) {
      setTimeout(() => advance(next.join("")), 80);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits, step, firstPin]);

  const handleDelete = () => {
    Haptics.selectionAsync();
    setDigits((p) => p.slice(0, -1));
    setError(null);
  };

  const advance = (pin: string) => {
    if (step === "enter") {
      setFirstPin(pin);
      setDigits([]);
      setStep("confirm");
    } else {
      if (pin === firstPin) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (hasBiometrics) {
          setStep("biometrics");
        } else {
          finalize(false);
        }
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError("PINs don't match — try again.");
        setDigits([]);
        setStep("enter");
        setFirstPin("");
      }
    }
  };

  const finalize = async (enableBio: boolean) => {
    setSaving(true);
    try {
      await setPin(firstPin);
      if (enableBio) await toggleBiometrics(true);
      connect(pendingWallet);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  const skipPin = () => {
    connect(pendingWallet);
    onDone();
  };

  if (step === "biometrics") {
    return (
      <View style={pinSetupStyles.centerWrap}>
        <View style={[pinSetupStyles.iconWrap, { backgroundColor: C.primary + "20" }]}>
          <Feather name="smile" size={44} color={C.primary} />
        </View>
        <Text style={pinSetupStyles.title}>Enable Biometrics?</Text>
        <Text style={pinSetupStyles.sub}>
          Use Face ID or Fingerprint alongside your PIN for faster, more convenient unlocking.
        </Text>
        <TouchableOpacity
          style={[pinSetupStyles.primaryBtn, { marginBottom: 12 }, saving && { opacity: 0.6 }]}
          onPress={() => finalize(true)}
          disabled={saving}
        >
          {saving
            ? <ActivityIndicator color="#000" size="small" />
            : <><Feather name="smile" size={18} color="#000" /><Text style={pinSetupStyles.primaryBtnText}>Enable Biometrics</Text></>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[pinSetupStyles.outlineBtn, saving && { opacity: 0.6 }]}
          onPress={() => finalize(false)}
          disabled={saving}
        >
          <Text style={pinSetupStyles.outlineBtnText}>Skip, PIN only</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={pinSetupStyles.scroll}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[pinSetupStyles.iconWrap, { backgroundColor: C.primary + "18" }]}>
        <Feather name="lock" size={36} color={C.primary} />
      </View>
      <Text style={pinSetupStyles.title}>
        {step === "enter" ? "Set a 6-digit PIN" : "Confirm your PIN"}
      </Text>
      <Text style={pinSetupStyles.sub}>
        {step === "enter"
          ? "Your PIN protects access to your wallet on this device."
          : "Re-enter the same PIN to confirm."}
      </Text>

      <View style={pinSetupStyles.dotsRow}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <View key={i} style={[pinSetupStyles.dot, i < digits.length && pinSetupStyles.dotFilled]} />
        ))}
      </View>

      {error && <Text style={pinSetupStyles.errorText}>{error}</Text>}

      <View style={pinSetupStyles.keypad}>
        {PIN_KEYPAD_ROWS.map((row, ri) => (
          <View key={ri} style={pinSetupStyles.keyRow}>
            {row.map((key, ki) => {
              if (!key) return <View key={ki} style={pinSetupStyles.keyBtn} />;
              if (key === "del") {
                return (
                  <TouchableOpacity key="del" style={pinSetupStyles.keyBtn} onPress={handleDelete}>
                    <Feather name="delete" size={20} color={C.textSecondary} />
                  </TouchableOpacity>
                );
              }
              return (
                <TouchableOpacity
                  key={key}
                  style={[pinSetupStyles.keyBtn, pinSetupStyles.keyBtnNum]}
                  onPress={() => handleDigit(key)}
                  activeOpacity={0.7}
                >
                  <Text style={pinSetupStyles.keyText}>{key}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>

      <TouchableOpacity style={{ marginTop: 20 }} onPress={skipPin}>
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, color: C.textMuted, textAlign: "center" }}>
          Skip for now
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const pinSetupStyles = StyleSheet.create({
  scroll: { padding: 24, paddingBottom: 48, alignItems: "center" },
  centerWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 },
  iconWrap: { width: 84, height: 84, borderRadius: 26, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  title: { fontFamily: "Inter_700Bold", fontSize: 24, color: C.text, textAlign: "center", marginBottom: 8 },
  sub: { fontFamily: "Inter_400Regular", fontSize: 14, color: C.textSecondary, textAlign: "center", lineHeight: 21, marginBottom: 28, maxWidth: 300 },
  dotsRow: { flexDirection: "row", gap: 18, marginBottom: 14 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: C.cardBorder, backgroundColor: "transparent" },
  dotFilled: { backgroundColor: C.primary, borderColor: C.primary },
  errorText: { fontFamily: "Inter_400Regular", fontSize: 13, color: C.sell, marginBottom: 8, textAlign: "center" },
  keypad: { width: "100%", gap: 14, marginTop: 8 },
  keyRow: { flexDirection: "row", justifyContent: "center", gap: 20 },
  keyBtn: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center" },
  keyBtnNum: { backgroundColor: C.card, borderWidth: 1, borderColor: C.cardBorder },
  keyText: { fontFamily: "Inter_600SemiBold", fontSize: 24, color: C.text },
  primaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: C.primary, borderRadius: 14, paddingVertical: 15,
    width: "100%",
  },
  primaryBtnText: { fontFamily: "Inter_700Bold", fontSize: 15, color: "#000" },
  outlineBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    borderRadius: 14, paddingVertical: 15, borderWidth: 1.5, borderColor: C.cardBorder,
    width: "100%",
  },
  outlineBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 15, color: C.textSecondary },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between",
    paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: C.separator,
  },
  backBtn: {
    width: 32, height: 32, borderRadius: 9, backgroundColor: C.card,
    borderWidth: 1, borderColor: C.cardBorder, alignItems: "center", justifyContent: "center",
  },
  title: { fontFamily: "Inter_700Bold", fontSize: 22, color: C.text },
  subtitle: { fontFamily: "Inter_500Medium", fontSize: 11, color: C.primary, marginTop: 3, opacity: 0.8 },
  closeBtn: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: C.card,
    borderWidth: 1, borderColor: C.cardBorder, alignItems: "center", justifyContent: "center",
  },
  landingSubtitle: { fontFamily: "Inter_400Regular", fontSize: 13, color: C.textMuted, lineHeight: 20 },
  connectedCard: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: C.buyBg, borderRadius: 14, borderWidth: 1, borderColor: C.buy + "30",
    paddingHorizontal: 16, paddingVertical: 12,
  },
  connectedDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.buy },
  connectedTitle: { fontFamily: "Inter_600SemiBold", fontSize: 13, color: C.buy },
  connectedAddr: { fontFamily: "Inter_400Regular", fontSize: 11, color: C.textSecondary, marginTop: 2 },
  optionCard: {
    backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.cardBorder, padding: 16,
  },
  optionIconWrap: {
    width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center",
  },
  optionTitle: { fontFamily: "Inter_700Bold", fontSize: 15, color: C.text, marginBottom: 4 },
  optionDesc: { fontFamily: "Inter_400Regular", fontSize: 13, color: C.textSecondary, lineHeight: 19 },
  tagPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20 },
  tagText: { fontFamily: "Inter_600SemiBold", fontSize: 11 },
  infoCard: {
    flexDirection: "row", gap: 10, alignItems: "flex-start",
    backgroundColor: C.primary + "08", borderRadius: 14,
    borderWidth: 1, borderColor: C.primary + "20", padding: 14,
  },
  infoText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 13, color: C.textSecondary, lineHeight: 19 },
  sectionLabel: {
    fontFamily: "Inter_600SemiBold", fontSize: 11, color: C.textMuted,
    textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8,
  },
  sectionLabel2: {
    fontFamily: "Inter_600SemiBold", fontSize: 11, color: C.textMuted,
    textTransform: "uppercase", letterSpacing: 0.8,
    paddingHorizontal: 20, marginBottom: 8, marginTop: 4,
  },
  toggleBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 12,
    borderWidth: 1.5, borderColor: C.cardBorder, alignItems: "center",
  },
  toggleBtnActive: { backgroundColor: C.primary + "15", borderColor: C.primary + "60" },
  toggleBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 13, color: C.textSecondary },
  toggleBtnTextActive: { color: C.primary },
  seedGrid: {
    flexDirection: "row", flexWrap: "wrap", gap: 6,
    backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.cardBorder,
    padding: 12, position: "relative",
  },
  seedCell: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: C.surface, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 7,
  },
  seedNum: { fontFamily: "Inter_400Regular", fontSize: 10, color: C.textMuted, width: 16 },
  seedWord: { fontFamily: "Inter_600SemiBold", fontSize: 12, color: C.text },
  revealOverlay: {
    position: "absolute", inset: 0, top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: C.background + "CC",
    borderRadius: 14, alignItems: "center", justifyContent: "center", gap: 8,
  } as any,
  revealText: { fontFamily: "Inter_600SemiBold", fontSize: 13, color: C.primary },
  outlineBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 12, borderWidth: 1, borderColor: C.cardBorder,
  },
  outlineBtnText: { fontFamily: "Inter_500Medium", fontSize: 13, color: C.textSecondary },
  warnCard: {
    flexDirection: "row", gap: 10, alignItems: "flex-start",
    backgroundColor: "#FBBF2410", borderRadius: 14, borderWidth: 1, borderColor: "#FBBF2430", padding: 14,
  },
  warnText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 12, color: "#FCD34D", lineHeight: 18 },
  checkbox: {
    width: 22, height: 22, borderRadius: 7, borderWidth: 2, borderColor: C.cardBorder,
    alignItems: "center", justifyContent: "center", backgroundColor: C.surface,
  },
  checkboxChecked: { backgroundColor: C.primary, borderColor: C.primary },
  checkboxLabel: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 13, color: C.textSecondary, lineHeight: 19 },
  primaryBtn: {
    backgroundColor: C.primary, borderRadius: 14, paddingVertical: 15,
    alignItems: "center", shadowColor: C.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10,
  },
  importBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: "#7C3AED", borderRadius: 14, paddingVertical: 15,
    shadowColor: "#7C3AED", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10,
  },
  primaryBtnText: { fontFamily: "Inter_700Bold", fontSize: 15, color: "#fff" },
  seedInput: {
    backgroundColor: C.card, borderRadius: 14, borderWidth: 1.5, borderColor: C.cardBorder,
    padding: 14, fontFamily: "Inter_400Regular", fontSize: 14, color: C.text,
    minHeight: 120, textAlignVertical: "top",
  },
  tagPillSmall: { backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  tagPillSmallText: { fontFamily: "Inter_500Medium", fontSize: 11, color: C.textMuted },
  doneContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 40 },
  doneIcon: { width: 90, height: 90, borderRadius: 28, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  doneTitle: { fontFamily: "Inter_700Bold", fontSize: 26, color: C.text, textAlign: "center" },
  doneSub: { fontFamily: "Inter_400Regular", fontSize: 14, color: C.textSecondary, textAlign: "center", lineHeight: 22 },
  networkTab: {
    flex: 1, paddingVertical: 11, borderRadius: 12,
    borderWidth: 1.5, borderColor: C.cardBorder, alignItems: "center",
  },
  networkTabActive: { backgroundColor: C.primary + "15", borderColor: C.primary + "60" },
  networkTabText: { fontFamily: "Inter_600SemiBold", fontSize: 13, color: C.textSecondary },
  networkTabTextActive: { color: C.primary },
  walletRow: {
    flexDirection: "row", alignItems: "center", gap: 14,
    marginHorizontal: 20, marginBottom: 8,
    backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.cardBorder,
    paddingHorizontal: 16, paddingVertical: 14,
  },
  walletRowActive: { borderColor: C.primary + "60", backgroundColor: C.primary + "08" },
  walletEmoji: { fontSize: 24, width: 36, textAlign: "center" },
  walletName: { fontFamily: "Inter_600SemiBold", fontSize: 14, color: C.text },
  walletDesc: { fontFamily: "Inter_400Regular", fontSize: 12, color: C.textMuted, marginTop: 2 },
  spinner: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: C.primary, alignItems: "center", justifyContent: "center" },
});
