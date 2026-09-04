import { useState, useEffect, useCallback } from "react";
import {
  Flame, ExternalLink, Search, ChevronRight, Lock, Unlock,
  TrendingUp, Star, Clock, Coins, CheckCircle2, Loader2,
  AlertTriangle, RefreshCw, Shield, Zap, Info, Droplets,
  ArrowDownToLine, ArrowUpFromLine, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWalletStore } from "@/store/useWalletStore";
import { useWalletModalStore } from "@/store/useWalletModalStore";
import { useToast } from "@/hooks/use-toast";
import { CoinLogo } from "@/components/CoinLogo";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ────────────────────────────────────────────────────────────────────

interface PosCoin {
  symbol: string;
  name: string;
  apy: number;
  nativeApy: number;
  lockDays: number;
  minStake: number;
  chain: string;
  providers: ProviderRef[];
}

interface ProviderRef {
  id: string;
  name: string;
  logo: string;
  url: string;
  tvl: string;
  rating: number;
}

interface Provider {
  id: string;
  name: string;
  logo: string;
  url: string;
  description: string;
  coins: string[];
  tvl: string;
  rating: number;
}

interface StakingPosition {
  id: string;
  coin: string;
  amount: string;
  apy: string;
  lockDays: string;
  status: string;
  rewardAccrued: string;
  startedAt: string;
  unlocksAt: string;
  daysRemaining: number;
  canUnstake: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtApy(apy: number) {
  return `${apy.toFixed(1)}%`;
}

function fmtAmount(a: string | number, decimals = 6) {
  const n = parseFloat(String(a));
  if (!isFinite(n)) return "0";
  if (n === 0) return "0";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: decimals });
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5 text-yellow-400 text-xs">
      <Star size={10} fill="currentColor" />
      <span className="text-[var(--color-text-secondary)]">{rating.toFixed(1)}</span>
    </span>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function MobileStaking() {
  const [tab, setTab] = useState<"liquidity" | "earn" | "providers">("liquidity");

  const TABS = [
    { id: "liquidity" as const, label: "Liquidity", icon: <Droplets size={13} /> },
    { id: "earn"      as const, label: "Earn",      icon: <Flame size={13} />    },
    { id: "providers" as const, label: "Providers", icon: <Shield size={13} />   },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[var(--color-bg)]">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 mb-3">
          <Droplets size={20} className="text-blue-400" />
          <h1 className="text-lg font-bold text-[var(--color-text)]">Earn &amp; Stake</h1>
        </div>
        {/* Tab bar */}
        <div className="flex gap-1 bg-[var(--color-surface)] rounded-xl p-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1",
                tab === t.id
                  ? "bg-blue-500 text-white shadow"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              )}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "liquidity" ? <LiquidityTab /> :
         tab === "earn"      ? <EarnTab />       :
                               <ProvidersTab />  }
      </div>
    </div>
  );
}

// ── Liquidity Tab ─────────────────────────────────────────────────────────────

interface LpPool {
  id: string; coinA: string; coinB: string; baseApy: number; label: string;
  featured: boolean; description: string;
  lockTiers: { days: number; label: string; bonus: number }[];
  minDeposit: Record<string, number>;
  tvl: Record<string, number>;
}

interface LpPosition {
  id: string; pool: string; coin: string; amount: string; apy: string;
  lockDays: string; status: string; rewardAccrued: string;
  startedAt: string; unlocksAt: string; daysRemaining: number; canWithdraw: boolean;
}

function LiquidityTab() {
  const { address } = useWalletStore();
  const { open: openWalletModal } = useWalletModalStore();
  const { toast } = useToast();

  const [pools,      setPools]      = useState<LpPool[]>([]);
  const [positions,  setPositions]  = useState<LpPosition[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [selected,   setSelected]   = useState<LpPool | null>(null);
  const [coin,       setCoin]       = useState<string>("");
  const [lockDays,   setLockDays]   = useState(0);
  const [amount,     setAmount]     = useState("");
  const [depositing, setDepositing] = useState(false);
  const [withdrawing,setWithdrawing]= useState<string | null>(null);
  const [showForm,   setShowForm]   = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const poolsRes = await fetch(`${API_BASE}/api/lp/pools`);
      const poolsRaw = await poolsRes.json();
      const poolsData: LpPool[] = Array.isArray(poolsRaw) ? poolsRaw : [];
      setPools(poolsData);
      if (!selected && poolsData.length) {
        setSelected(poolsData[0]);
        setCoin(poolsData[0].coinA);
      }
      if (address) {
        const posRes = await fetch(`${API_BASE}/api/lp/positions?walletAddress=${encodeURIComponent(address)}`);
        const posData: LpPosition[] = await posRes.json();
        setPositions(Array.isArray(posData) ? posData : []);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [address, selected]);

  useEffect(() => { fetchAll(); }, [address]);

  const handleDeposit = async () => {
    if (!address) { openWalletModal(); return; }
    if (!selected || !amount || parseFloat(amount) <= 0) {
      toast({ title: "Enter an amount", variant: "destructive" }); return;
    }
    setDepositing(true);
    try {
      const r = await fetch(`${API_BASE}/api/lp/deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, pool: selected.id, coin, amount: parseFloat(amount), lockDays }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Deposit failed");
      toast({ title: "Liquidity deposited!", description: d.message });
      setAmount(""); setShowForm(false);
      await fetchAll();
    } catch (e: any) {
      toast({ title: "Deposit failed", description: e.message, variant: "destructive" });
    }
    setDepositing(false);
  };

  const handleWithdraw = async (pos: LpPosition) => {
    if (!address) return;
    setWithdrawing(pos.id);
    try {
      const r = await fetch(`${API_BASE}/api/lp/withdraw/${pos.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Withdraw failed");
      toast({ title: "Withdrawn!", description: d.message });
      await fetchAll();
    } catch (e: any) {
      toast({ title: "Withdraw failed", description: e.message, variant: "destructive" });
    }
    setWithdrawing(null);
  };

  const tier      = selected?.lockTiers.find(t => t.days === lockDays) ?? selected?.lockTiers[0];
  const totalApy  = (selected?.baseApy ?? 0) + (tier?.bonus ?? 0);
  const estReward = amount && parseFloat(amount) > 0 && lockDays > 0
    ? parseFloat(amount) * (totalApy / 100) * (lockDays / 365)
    : 0;

  const activePositions    = positions.filter(p => p.status === "active");
  const withdrawnPositions = positions.filter(p => p.status === "withdrawn");

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 size={28} className="animate-spin text-blue-400" />
    </div>
  );

  return (
    <div className="p-4 space-y-4">

      {/* Info banner */}
      <div className="flex items-start gap-2.5 p-3 bg-blue-500/8 border border-blue-500/20 rounded-xl">
        <Droplets size={16} className="text-blue-400 shrink-0 mt-0.5" />
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
          Deposit coins into OrahDEX liquidity pools. Your funds power live trades and earn a share of all trading fees plus an APY bonus.
        </p>
      </div>

      {/* Pool list */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">Available Pools</div>
        {pools.map(pool => {
          const tvlA  = pool.tvl[pool.coinA] ?? 0;
          const tvlB  = pool.tvl[pool.coinB] ?? 0;
          const isSelected = selected?.id === pool.id;
          return (
            <div key={pool.id} role="button" tabIndex={0}
              onClick={() => { setSelected(pool); setCoin(pool.coinA); setShowForm(true); setAmount(""); }}
              onKeyDown={e => e.key === "Enter" && (setSelected(pool), setCoin(pool.coinA), setShowForm(true), setAmount(""))}
              className={cn(
                "w-full text-left p-3 rounded-xl border transition-all cursor-pointer",
                isSelected && showForm
                  ? "border-blue-500/60 bg-blue-500/8"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-blue-500/30"
              )}
            >
              <div className="flex items-center gap-3">
                {/* Coin pair logos */}
                <div className="flex items-center -space-x-2 shrink-0">
                  <CoinLogo symbol={pool.coinA} size={28} />
                  <CoinLogo symbol={pool.coinB} size={22} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-[var(--color-text)] text-sm">{pool.label}</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)] truncate">{pool.description}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-bold text-green-400">{pool.baseApy}%+</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">base APY</div>
                </div>
                <ChevronDown size={14} className={cn("text-[var(--color-text-secondary)] shrink-0 transition-transform", isSelected && showForm && "rotate-180")} />
              </div>
              {/* TVL if any */}
              {(tvlA > 0 || tvlB > 0) && (
                <div className="mt-2 pt-2 border-t border-[var(--color-border)] flex gap-3 text-[10px] text-[var(--color-text-secondary)]">
                  {tvlA > 0 && <span>TVL {pool.coinA}: <span className="text-[var(--color-text)] font-medium">{fmtAmount(tvlA, 4)}</span></span>}
                  {tvlB > 0 && <span>TVL {pool.coinB}: <span className="text-[var(--color-text)] font-medium">{fmtAmount(tvlB, 4)}</span></span>}
                </div>
              )}

              {/* Deposit form — inline under selected pool */}
              {isSelected && showForm && (
                <div className="mt-3 pt-3 border-t border-[var(--color-border)] space-y-3" onClick={e => e.stopPropagation()}>

                  {/* Coin side selector */}
                  <div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] uppercase tracking-wide font-medium mb-1.5">Deposit coin</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[pool.coinA, pool.coinB].map(c => (
                        <button key={c} type="button"
                          onClick={() => setCoin(c)}
                          className={cn(
                            "py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5 border transition-all",
                            coin === c
                              ? "bg-blue-500 text-white border-blue-500 shadow"
                              : "bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text-secondary)]"
                          )}
                        >
                          <CoinLogo symbol={c} size={16} />{c}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Lock period */}
                  <div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] uppercase tracking-wide font-medium mb-1.5">Lock period</div>
                    <div className="grid grid-cols-4 gap-1">
                      {pool.lockTiers.map(t => (
                        <button key={t.days} type="button"
                          onClick={() => setLockDays(t.days)}
                          className={cn(
                            "py-1.5 rounded-lg text-center border transition-all",
                            lockDays === t.days
                              ? "bg-blue-500 text-white border-blue-500 shadow"
                              : "bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-blue-500/40"
                          )}
                        >
                          <div className="text-[11px] font-bold">{t.days === 0 ? "Flex" : `${t.days}d`}</div>
                          {t.bonus > 0 && <div className={cn("text-[9px]", lockDays === t.days ? "text-blue-100" : "text-green-400")}>+{t.bonus}%</div>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Amount */}
                  <div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] uppercase tracking-wide font-medium mb-1.5">Amount</div>
                    <div className="flex items-center gap-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl px-3 py-2 focus-within:border-blue-500/60 transition-colors">
                      <input
                        type="number" min="0" step="any" placeholder="0.00"
                        value={amount}
                        onChange={e => setAmount(e.target.value)}
                        className="flex-1 bg-transparent text-base font-bold text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-secondary)]"
                      />
                      <span className="text-sm text-[var(--color-text-secondary)] font-medium shrink-0">{coin}</span>
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] mt-1">
                      Min: {pool.minDeposit[coin] ?? "—"} {coin}
                    </div>
                  </div>

                  {/* APY preview */}
                  <div className="grid grid-cols-3 gap-2 p-3 bg-green-500/8 border border-green-500/20 rounded-xl text-center">
                    <div>
                      <div className="text-[10px] text-[var(--color-text-secondary)]">Total APY</div>
                      <div className="text-sm font-bold text-green-400">{totalApy.toFixed(1)}%</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[var(--color-text-secondary)]">Period</div>
                      <div className="text-sm font-bold text-[var(--color-text)]">{lockDays === 0 ? "Flex" : `${lockDays}d`}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[var(--color-text-secondary)]">Est. Reward</div>
                      <div className="text-sm font-bold text-[var(--color-text)]">
                        {estReward > 0 ? `~${fmtAmount(estReward, 6)}` : "—"}
                      </div>
                    </div>
                  </div>

                  {/* Deposit button */}
                  <button type="button" onClick={handleDeposit} disabled={depositing}
                    className={cn(
                      "w-full py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all",
                      depositing
                        ? "bg-blue-500/50 text-white cursor-not-allowed"
                        : "bg-blue-500 hover:bg-blue-600 text-white active:scale-[0.98]"
                    )}
                  >
                    {depositing
                      ? <><Loader2 size={15} className="animate-spin" />Depositing…</>
                      : address
                        ? <><ArrowDownToLine size={15} />Deposit Liquidity</>
                        : "Connect Wallet to Deposit"
                    }
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Active positions */}
      {address && activePositions.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide flex items-center gap-1.5">
            <Droplets size={13} className="text-blue-400" /> Your Liquidity Positions
          </div>
          {activePositions.map(pos => {
            const locked = pos.daysRemaining > 0;
            const isWd   = withdrawing === pos.id;
            return (
              <div key={pos.id} className="p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl">
                <div className="flex items-center gap-2.5 mb-2">
                  <div className="flex items-center -space-x-1.5 shrink-0">
                    <CoinLogo symbol={pos.coin} size={28} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-[var(--color-text)] text-sm">{fmtAmount(pos.amount)} {pos.coin}</span>
                      <span className="text-[10px] text-[var(--color-text-secondary)]">in {pos.pool}</span>
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      {parseFloat(pos.apy).toFixed(2)}% APY · {pos.lockDays}d lock
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-medium text-green-400">+{fmtAmount(pos.rewardAccrued, 6)}</div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">earned</div>
                  </div>
                </div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
                    {locked ? <><Lock size={9} />{pos.daysRemaining}d remaining</> : <><Unlock size={9} />Ready to withdraw</>}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    Unlocks {new Date(pos.unlocksAt).toLocaleDateString()}
                  </div>
                </div>
                <button type="button" onClick={() => handleWithdraw(pos)} disabled={isWd || locked}
                  className={cn(
                    "w-full py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1 transition-all",
                    isWd
                      ? "bg-[var(--color-bg)] text-[var(--color-text-secondary)] cursor-not-allowed"
                      : locked
                        ? "bg-[var(--color-bg)] text-[var(--color-text-secondary)] border border-[var(--color-border)] cursor-not-allowed opacity-50"
                        : "bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25"
                  )}
                >
                  {isWd
                    ? <><Loader2 size={11} className="animate-spin" />Withdrawing…</>
                    : locked
                      ? <><Lock size={11} />Locked</>
                      : <><ArrowUpFromLine size={11} />Withdraw + Rewards</>
                  }
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Completed */}
      {withdrawnPositions.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide flex items-center gap-1.5">
            <CheckCircle2 size={13} /> Withdrawn
          </div>
          {withdrawnPositions.slice(0, 5).map(pos => (
            <div key={pos.id} className="flex items-center justify-between p-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl opacity-60 text-xs">
              <div className="flex items-center gap-2">
                <CoinLogo symbol={pos.coin} size={20} />
                <span className="text-[var(--color-text)]">{fmtAmount(pos.amount)} {pos.coin} · {pos.pool}</span>
              </div>
              <span className="text-green-400">+{fmtAmount(pos.rewardAccrued, 6)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Empty state for non-connected */}
      {!address && (
        <button type="button" onClick={openWalletModal}
          className="w-full py-3 rounded-xl border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-secondary)] hover:border-blue-500/40 hover:text-blue-400 transition-all">
          Connect wallet to see your positions
        </button>
      )}
    </div>
  );
}

// ── Providers Tab ─────────────────────────────────────────────────────────────

function ProvidersTab() {
  const [coins, setCoins] = useState<PosCoin[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCoin, setSelectedCoin] = useState<PosCoin | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"coins" | "detail">("coins");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [coinsRes, providersRes] = await Promise.all([
          fetch(`${API_BASE}/api/staking/coins`),
          fetch(`${API_BASE}/api/staking/providers`),
        ]);
        const coinsRaw = await coinsRes.json();
        const provRaw  = await providersRes.json();
        if (cancelled) return;
        // API returns { coins: [...], dataSource, custodialDisclosure } — unwrap
        const coinsData: PosCoin[]  = Array.isArray(coinsRaw) ? coinsRaw
          : Array.isArray(coinsRaw?.coins) ? coinsRaw.coins : [];
        const provData:  Provider[] = Array.isArray(provRaw)  ? provRaw  : [];
        setCoins(coinsData);
        setProviders(provData);
        if (coinsData.length) setSelectedCoin(coinsData[0]);
      } catch {
        // silently fall through — empty state shown
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = coins.filter(c =>
    !search ||
    c.symbol.toLowerCase().includes(search.toLowerCase()) ||
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={28} className="animate-spin text-orange-400" />
      </div>
    );
  }

  if (view === "detail" && selectedCoin) {
    const coinProviders = providers.filter(p => p.coins.includes(selectedCoin.symbol));
    return (
      <div className="p-4 space-y-4">
        {/* Back + coin header */}
        <button
          onClick={() => setView("coins")}
          className="flex items-center gap-1 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
        >
          ← All coins
        </button>

        <div className="flex items-center gap-3 p-4 bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)]">
          <CoinLogo symbol={selectedCoin.symbol} size={44} />
          <div className="flex-1 min-w-0">
            <div className="font-bold text-[var(--color-text)] text-lg">{selectedCoin.name}</div>
            <div className="text-xs text-[var(--color-text-secondary)]">{selectedCoin.symbol} · {selectedCoin.chain} network</div>
          </div>
          <div className="text-right">
            <div className="text-xl font-bold text-green-400">{fmtApy(selectedCoin.apy)}</div>
            <div className="text-xs text-[var(--color-text-secondary)]">Est. APY</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <StatCard label="Lock Period" value={selectedCoin.lockDays === 0 ? "None" : `${selectedCoin.lockDays}d`} />
          <StatCard label="Min Stake" value={`${selectedCoin.minStake} ${selectedCoin.symbol}`} />
          <StatCard label="Providers" value={String(coinProviders.length)} />
        </div>

        {/* Provider list */}
        <div>
          <div className="text-sm font-semibold text-[var(--color-text)] mb-2 flex items-center gap-1">
            <Shield size={14} className="text-orange-400" />
            Staking Providers
          </div>
          {coinProviders.length === 0 ? (
            <div className="text-center py-8 text-[var(--color-text-secondary)] text-sm">
              No providers available yet for {selectedCoin.symbol}
            </div>
          ) : (
            <div className="space-y-2">
              {coinProviders.map(p => (
                <ProviderCard key={p.id} provider={p} coin={selectedCoin.symbol} />
              ))}
            </div>
          )}
        </div>

        <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300 flex items-start gap-2">
          <Info size={14} className="mt-0.5 flex-shrink-0 text-blue-400" />
          <span>
            Clicking "Stake" will open the provider's website. OrahDEX does not custody funds for external providers — you interact directly with the protocol.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" />
        <input
          className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl pl-9 pr-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)] outline-none focus:border-orange-500/60 transition-colors"
          placeholder="Search coin (ETH, SOL, DOT…)"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Stats ribbon */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="PoS Coins" value={String(coins.length)} icon={<Coins size={12} />} />
        <StatCard label="Providers" value={String(providers.length)} icon={<Shield size={12} />} />
        <StatCard label="Best APY" value={coins.length ? fmtApy(Math.max(...coins.map(c => c.apy))) : "—"} icon={<TrendingUp size={12} />} />
      </div>

      {/* Coin list */}
      <div className="space-y-1.5">
        {filtered.length === 0 && (
          <div className="text-center py-10 text-[var(--color-text-secondary)] text-sm">
            No coins found for "{search}"
          </div>
        )}
        {filtered.map(coin => (
          <button
            key={coin.symbol}
            onClick={() => { setSelectedCoin(coin); setView("detail"); }}
            className="w-full flex items-center gap-3 p-3 bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover,var(--color-surface))] border border-[var(--color-border)] rounded-xl transition-all text-left group"
          >
            <CoinLogo symbol={coin.symbol} size={36} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-[var(--color-text)] text-sm">{coin.symbol}</span>
                {coin.lockDays === 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 text-[10px] font-medium">Liquid</span>
                )}
              </div>
              <div className="text-xs text-[var(--color-text-secondary)]">{coin.name} · {coin.providers.length} provider{coin.providers.length !== 1 ? "s" : ""}</div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-sm font-bold text-green-400">{fmtApy(coin.apy)}</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                {coin.lockDays === 0 ? "no lock" : `${coin.lockDays}d lock`}
              </div>
            </div>
            <ChevronRight size={15} className="text-[var(--color-text-secondary)] group-hover:text-[var(--color-text)] transition-colors flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

function ProviderCard({ provider, coin }: { provider: Provider; coin: string }) {
  const coinIdx = provider.coins.indexOf(coin);
  const stakeUrl = buildStakeUrl(provider.id, coin);

  return (
    <div className="p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl">
      <div className="flex items-start gap-3">
        <img
          src={provider.logo}
          alt={provider.name}
          className="w-9 h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] object-contain flex-shrink-0"
          onError={e => { (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Crect width='36' height='36' fill='%23334155' rx='8'/%3E%3Ctext x='18' y='24' text-anchor='middle' font-size='14' fill='%23f97316'%3E⚡%3C/text%3E%3C/svg%3E"; }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-[var(--color-text)] text-sm">{provider.name}</span>
            <StarRating rating={provider.rating} />
            <span className="text-[10px] text-[var(--color-text-secondary)] bg-[var(--color-bg)] px-1.5 py-0.5 rounded-full border border-[var(--color-border)]">
              TVL ${provider.tvl}
            </span>
          </div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-2">{provider.description}</div>
        </div>
      </div>
      <a
        href={stakeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium transition-colors"
      >
        Stake {coin}
        <ExternalLink size={13} />
      </a>
    </div>
  );
}

function buildStakeUrl(providerId: string, coin: string): string {
  const c = coin.toLowerCase();
  switch (providerId) {
    case "lido":
      if (coin === "ETH")   return "https://stake.lido.fi";
      if (coin === "SOL")   return "https://solana.lido.fi";
      if (coin === "MATIC") return "https://polygon.lido.fi";
      return "https://lido.fi";
    case "everstake":      return `https://everstake.one/${c}-staking`;
    case "validatrium":    return `https://validatrium.com/${c}`;
    case "ankr":           return `https://www.ankr.com/staking/stake/${c}/`;
    case "chorus-one":     return `https://chorus.one/networks/${c}`;
    case "rocket-pool":    return "https://stake.rocketpool.net";
    case "marinade":       return "https://marinade.finance/app/";
    case "stakefish":      return `https://stake.fish/${c}/`;
    case "figment":        return `https://figment.io/staking/${c}/`;
    case "p2p":            return `https://p2p.org/${c}-staking/`;
    default:               return "#";
  }
}

// ── Earn Tab (Native OrahDEX staking) ────────────────────────────────────────

const LOCK_PERIODS = [
  { days: 30,  label: "30 days",  bonus: 0    },
  { days: 60,  label: "60 days",  bonus: 0.5  },
  { days: 90,  label: "90 days",  bonus: 1.0  },
  { days: 180, label: "180 days", bonus: 2.0  },
];

function EarnTab() {
  const { address, network, internalEvmAddress } = useWalletStore();
  const { open: openWallet } = useWalletModalStore();
  const { toast } = useToast();

  // External EVM wallets (non-Orah 0x addresses) must sign before staking
  const isExternalEvm = !!(
    address &&
    network === "evm" &&
    /^0x[0-9a-fA-F]{40}$/.test(address) &&
    address.toLowerCase() !== (internalEvmAddress ?? "").toLowerCase()
  );

  const [coins, setCoins] = useState<PosCoin[]>([]);
  const [positions, setPositions] = useState<StakingPosition[]>([]);
  const [loadingCoins, setLoadingCoins] = useState(true);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [staking, setStaking] = useState(false);
  const [unstakingId, setUnstakingId] = useState<string | null>(null);

  const [selectedCoin, setSelectedCoin] = useState<PosCoin | null>(null);
  const [amount, setAmount] = useState("");
  const [lockDays, setLockDays] = useState(30);
  const [coinSearch, setCoinSearch] = useState("");
  const [showCoinPicker, setShowCoinPicker] = useState(false);

  // Derived APY with lock bonus
  const selectedPeriod = LOCK_PERIODS.find(p => p.days === lockDays) ?? LOCK_PERIODS[0];
  const effectiveApy = selectedCoin ? selectedCoin.nativeApy + selectedPeriod.bonus : 0;
  const estimatedReward = selectedCoin && amount
    ? parseFloat(amount) * (effectiveApy / 100) * (lockDays / 365)
    : 0;

  const fetchCoins = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/api/staking/coins`);
      const raw  = await res.json();
      // API returns { coins: [...], dataSource, custodialDisclosure } — unwrap
      const data: PosCoin[] = Array.isArray(raw) ? raw
        : Array.isArray(raw?.coins) ? raw.coins : [];
      setCoins(data);
      if (data.length && !selectedCoin) setSelectedCoin(data[0]);
    } finally {
      setLoadingCoins(false);
    }
  }, [selectedCoin]);

  const fetchPositions = useCallback(async () => {
    if (!address) return;
    setLoadingPositions(true);
    try {
      const res  = await fetch(`${API_BASE}/api/staking/positions?walletAddress=${encodeURIComponent(address)}`);
      const data = await res.json();
      setPositions(Array.isArray(data) ? data : []);
    } finally {
      setLoadingPositions(false);
    }
  }, [address]);

  useEffect(() => { fetchCoins(); }, [fetchCoins]);
  useEffect(() => { fetchPositions(); }, [fetchPositions]);

  async function handleStake() {
    if (!address) { openWallet(); return; }
    if (!selectedCoin || !amount || parseFloat(amount) <= 0) {
      toast({ title: "Enter an amount", variant: "destructive" }); return;
    }
    if (parseFloat(amount) < selectedCoin.minStake) {
      toast({ title: `Minimum stake is ${selectedCoin.minStake} ${selectedCoin.symbol}`, variant: "destructive" }); return;
    }
    setStaking(true);
    try {
      // ── Step 1: For external EVM wallets, obtain a signing challenge ────────
      let nonce: string | undefined;
      let signature: string | undefined;

      if (isExternalEvm) {
        const challengeRes = await fetch(`${API_BASE}/api/staking/challenge`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            walletAddress: address,
            coin:          selectedCoin.symbol,
            amount:        String(parseFloat(amount)),
            lockDays,
          }),
        });
        if (!challengeRes.ok) {
          const e = await challengeRes.json().catch(() => ({})) as any;
          throw new Error(e.error ?? "Failed to obtain staking challenge");
        }
        const challenge = await challengeRes.json() as { nonce: string; message: string };

        // ── Step 2: Sign the challenge message with the connected wallet ──────
        toast({
          title:       "Sign to confirm",
          description: "Your wallet will ask you to sign a message to authorise the stake.",
        });
        try {
          const { signMessage } = await import("@wagmi/core");
          const { getWagmiConfig } = await import("@/lib/reown");
          const cfg = getWagmiConfig();
          if (!cfg) throw new Error("Wallet not initialised. Please refresh and reconnect.");
          signature = await signMessage(cfg, {
            account: address as `0x${string}`,
            message: challenge.message,
          });
          nonce = challenge.nonce;
        } catch (err: any) {
          if (err?.code === 4001 || err?.code === "ACTION_REJECTED" || /rejected/i.test(err?.message)) {
            throw new Error("Signature rejected — stake cancelled.");
          }
          throw new Error(err?.message ?? "Wallet signature failed");
        }
      }

      // ── Step 3: Submit the stake (with signature for EVM, without for others) ─
      const res = await fetch(`${API_BASE}/api/staking/stake`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          walletAddress: address,
          coin:          selectedCoin.symbol,
          amount:        parseFloat(amount),
          lockDays,
          ...(nonce && signature ? { nonce, signature } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Stake failed");
      toast({
        title:       `Staked ${amount} ${selectedCoin.symbol}`,
        description: `Earning ${effectiveApy.toFixed(2)}% APY for ${lockDays} days`,
      });
      setAmount("");
      await fetchPositions();
    } catch (err: any) {
      toast({ title: err.message ?? "Failed to stake", variant: "destructive" });
    } finally {
      setStaking(false);
    }
  }

  async function handleUnstake(pos: StakingPosition) {
    if (!address) return;
    setUnstakingId(pos.id);
    try {
      const res = await fetch(`${API_BASE}/api/staking/unstake/${pos.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unstake failed");
      toast({ title: `Unstaked ${fmtAmount(pos.amount)} ${pos.coin}`, description: `Reward accrued: ${fmtAmount(pos.rewardAccrued, 8)} ${pos.coin}` });
      await fetchPositions();
    } catch (err: any) {
      toast({ title: err.message ?? "Failed to unstake", variant: "destructive" });
    } finally {
      setUnstakingId(null);
    }
  }

  const activePositions   = positions.filter(p => p.status === "active");
  const completedPositions = positions.filter(p => p.status !== "active");
  const filteredCoins = coins.filter(c =>
    !coinSearch ||
    c.symbol.toLowerCase().includes(coinSearch.toLowerCase()) ||
    c.name.toLowerCase().includes(coinSearch.toLowerCase())
  );

  if (loadingCoins) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={28} className="animate-spin text-orange-400" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Info banner */}
      <div className="p-3 rounded-xl bg-orange-500/10 border border-orange-500/20 text-xs text-orange-200 flex items-start gap-2">
        <Zap size={14} className="mt-0.5 flex-shrink-0 text-orange-400" />
        <span>
          OrahDEX Native Staking locks your exchange balance and pays a fixed APY. Longer lock periods earn a bonus rate.
        </span>
      </div>

      {/* Coin selector */}
      <div>
        <label className="text-xs text-[var(--color-text-secondary)] uppercase tracking-wide font-medium mb-1.5 block">Select Coin</label>
        <button
          onClick={() => setShowCoinPicker(v => !v)}
          className="w-full flex items-center gap-3 p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl transition-colors hover:border-orange-500/40"
        >
          {selectedCoin ? (
            <>
              <CoinLogo symbol={selectedCoin.symbol} size={32} />
              <div className="flex-1 text-left min-w-0">
                <div className="font-semibold text-[var(--color-text)] text-sm">{selectedCoin.symbol}</div>
                <div className="text-xs text-[var(--color-text-secondary)]">{selectedCoin.name}</div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-bold text-green-400">{fmtApy(selectedCoin.nativeApy)} base</div>
                <div className="text-[10px] text-[var(--color-text-secondary)]">native APY</div>
              </div>
            </>
          ) : (
            <span className="text-[var(--color-text-secondary)] text-sm">Select a coin…</span>
          )}
          <ChevronRight size={15} className={cn("text-[var(--color-text-secondary)] transition-transform", showCoinPicker && "rotate-90")} />
        </button>

        {showCoinPicker && (
          <div className="mt-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl overflow-hidden shadow-xl">
            <div className="p-2 border-b border-[var(--color-border)]">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" />
                <input
                  className="w-full bg-[var(--color-bg)] rounded-lg pl-8 pr-3 py-1.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)] outline-none"
                  placeholder="Search…"
                  value={coinSearch}
                  onChange={e => setCoinSearch(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-52 overflow-y-auto">
              {filteredCoins.map(c => (
                <button
                  key={c.symbol}
                  onClick={() => { setSelectedCoin(c); setShowCoinPicker(false); setCoinSearch(""); }}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--color-bg)] transition-colors",
                    selectedCoin?.symbol === c.symbol && "bg-orange-500/10"
                  )}
                >
                  <CoinLogo symbol={c.symbol} size={24} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-[var(--color-text)]">{c.symbol}</div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] truncate">{c.name}</div>
                  </div>
                  <span className="text-xs font-medium text-green-400 flex-shrink-0">{fmtApy(c.nativeApy)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Lock period */}
      <div>
        <label className="text-xs text-[var(--color-text-secondary)] uppercase tracking-wide font-medium mb-1.5 block">Lock Period</label>
        <div className="grid grid-cols-4 gap-1.5">
          {LOCK_PERIODS.map(p => (
            <button
              key={p.days}
              onClick={() => setLockDays(p.days)}
              className={cn(
                "py-2 rounded-xl text-center transition-all",
                lockDays === p.days
                  ? "bg-orange-500 text-white shadow"
                  : "bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-orange-500/40"
              )}
            >
              <div className="text-xs font-bold">{p.days}d</div>
              {p.bonus > 0 && (
                <div className={cn("text-[9px]", lockDays === p.days ? "text-orange-100" : "text-green-400")}>
                  +{p.bonus}%
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Amount + APY preview */}
      <div>
        <label className="text-xs text-[var(--color-text-secondary)] uppercase tracking-wide font-medium mb-1.5 block">Amount</label>
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 focus-within:border-orange-500/60 transition-colors">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="any"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="flex-1 bg-transparent text-lg font-bold text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-secondary)]"
            />
            <span className="text-sm font-medium text-[var(--color-text-secondary)] flex-shrink-0">
              {selectedCoin?.symbol ?? "—"}
            </span>
          </div>
          {selectedCoin && (
            <div className="text-[10px] text-[var(--color-text-secondary)] mt-1">
              Min: {selectedCoin.minStake} {selectedCoin.symbol}
            </div>
          )}
        </div>
      </div>

      {/* APY card */}
      {selectedCoin && (
        <div className="p-3 bg-green-500/8 border border-green-500/20 rounded-xl grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-xs text-[var(--color-text-secondary)]">APY</div>
            <div className="text-sm font-bold text-green-400">{fmtApy(effectiveApy)}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-text-secondary)]">Period</div>
            <div className="text-sm font-bold text-[var(--color-text)]">{lockDays}d</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-text-secondary)]">Est. Reward</div>
            <div className="text-sm font-bold text-[var(--color-text)]">
              {estimatedReward > 0 ? `~${fmtAmount(estimatedReward, 6)} ${selectedCoin.symbol}` : "—"}
            </div>
          </div>
        </div>
      )}

      {/* Stake button */}
      <button
        onClick={handleStake}
        disabled={staking}
        className={cn(
          "w-full py-3 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2",
          staking
            ? "bg-orange-500/50 text-white cursor-not-allowed"
            : "bg-orange-500 hover:bg-orange-600 text-white active:scale-[0.98]"
        )}
      >
        {staking ? (
          <><Loader2 size={16} className="animate-spin" /> Staking…</>
        ) : address ? (
          <><Flame size={16} /> Stake Now</>
        ) : (
          "Connect Wallet to Stake"
        )}
      </button>

      {/* Positions */}
      {address && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-1.5">
              <Lock size={14} className="text-orange-400" />
              Active Positions
            </div>
            <button
              onClick={fetchPositions}
              disabled={loadingPositions}
              className="p-1.5 rounded-lg hover:bg-[var(--color-surface)] transition-colors"
            >
              <RefreshCw size={13} className={cn("text-[var(--color-text-secondary)]", loadingPositions && "animate-spin")} />
            </button>
          </div>

          {loadingPositions ? (
            <div className="text-center py-6">
              <Loader2 size={20} className="animate-spin text-orange-400 mx-auto" />
            </div>
          ) : activePositions.length === 0 ? (
            <div className="text-center py-6 text-[var(--color-text-secondary)] text-sm border border-dashed border-[var(--color-border)] rounded-xl">
              No active staking positions yet
            </div>
          ) : (
            <div className="space-y-2">
              {activePositions.map(pos => (
                <PositionCard
                  key={pos.id}
                  position={pos}
                  onUnstake={handleUnstake}
                  unstakingId={unstakingId}
                />
              ))}
            </div>
          )}

          {completedPositions.length > 0 && (
            <>
              <div className="text-sm font-semibold text-[var(--color-text-secondary)] flex items-center gap-1.5 pt-1">
                <CheckCircle2 size={14} />
                Completed
              </div>
              <div className="space-y-1.5">
                {completedPositions.slice(0, 5).map(pos => (
                  <div
                    key={pos.id}
                    className="p-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl opacity-60"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <CoinLogo symbol={pos.coin} size={20} />
                        <span className="text-[var(--color-text)]">{fmtAmount(pos.amount)} {pos.coin}</span>
                      </div>
                      <span className="text-green-400">+{fmtAmount(pos.rewardAccrued, 8)} {pos.coin}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PositionCard({
  position: pos,
  onUnstake,
  unstakingId,
}: {
  position: StakingPosition;
  onUnstake: (pos: StakingPosition) => void;
  unstakingId: string | null;
}) {
  const isUnstaking = unstakingId === pos.id;
  const locked = pos.daysRemaining > 0;
  const apy = parseFloat(pos.apy);

  return (
    <div className="p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl">
      <div className="flex items-center gap-2.5 mb-2">
        <CoinLogo symbol={pos.coin} size={32} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-[var(--color-text)] text-sm">{fmtAmount(pos.amount)} {pos.coin}</span>
            {locked
              ? <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 text-[10px]"><Lock size={8} /> Locked</span>
              : <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 text-[10px]"><Unlock size={8} /> Unlocked</span>
            }
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)]">
            {apy.toFixed(2)}% APY · {pos.lockDays}d lock
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-xs font-medium text-green-400">+{fmtAmount(pos.rewardAccrued, 6)}</div>
          <div className="text-[10px] text-[var(--color-text-secondary)]">earned</div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
          <Clock size={10} />
          {locked ? `${pos.daysRemaining}d remaining` : "Ready to unstake"}
        </div>
        <div className="text-[10px] text-[var(--color-text-secondary)]">
          Unlocks {new Date(pos.unlocksAt).toLocaleDateString()}
        </div>
      </div>

      <button
        onClick={() => onUnstake(pos)}
        disabled={isUnstaking || locked}
        className={cn(
          "w-full py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1",
          isUnstaking
            ? "bg-[var(--color-bg)] text-[var(--color-text-secondary)] cursor-not-allowed"
            : locked
              ? "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/25"
              : "bg-green-500/15 text-green-400 border border-green-500/30 hover:bg-green-500/25"
        )}
      >
        {isUnstaking ? (
          <><Loader2 size={11} className="animate-spin" /> Unstaking…</>
        ) : locked ? (
          <><AlertTriangle size={11} /> Early Unstake</>
        ) : (
          <><Unlock size={11} /> Unstake</>
        )}
      </button>
    </div>
  );
}

// ── Shared stat card ─────────────────────────────────────────────────────────

function StatCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-2.5 text-center">
      {icon && <div className="flex justify-center text-orange-400 mb-0.5">{icon}</div>}
      <div className="text-xs font-bold text-[var(--color-text)]">{value}</div>
      <div className="text-[10px] text-[var(--color-text-secondary)]">{label}</div>
    </div>
  );
}
