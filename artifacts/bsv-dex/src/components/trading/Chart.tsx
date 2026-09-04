import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  createChart, ColorType,
  CandlestickSeries, HistogramSeries, LineSeries, AreaSeries, BarSeries,
  CrosshairMode,
} from 'lightweight-charts';
import type { Candle } from '@workspace/api-client-react';
import { useThemeStore } from '@/store/useThemeStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  Maximize2, Minimize2, ZoomIn, ZoomOut, AlignCenter,
  Camera, ChevronDown, ChevronUp,
  TrendingUp, BarChart2,
} from 'lucide-react';

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

/* ── Types ──────────────────────────────────────────────────────────────── */
type ChartType = 'candle' | 'heikinashi' | 'bar' | 'line' | 'area' | 'baseline';
type SubIndicator = 'none' | 'rsi' | 'macd' | 'stoch' | 'cci' | 'williams';

interface ChartProps {
  symbol?: string;
  data?: Candle[];
  interval?: string;
  onIntervalChange?: (interval: string) => void;
  hideIntervalBar?: boolean;
  subIndicator?: SubIndicator;
}

/* ── Intervals ──────────────────────────────────────────────────────────── */
const INTERVALS = [
  { id: '1m', label: '1m' }, { id: '3m', label: '3m' }, { id: '5m', label: '5m' },
  { id: '15m', label: '15m' }, { id: '30m', label: '30m' }, { id: '1h', label: '1h' },
  { id: '2h', label: '2h' }, { id: '4h', label: '4h' }, { id: '6h', label: '6h' },
  { id: '12h', label: '12h' }, { id: '1d', label: '1D' }, { id: '3d', label: '3D' },
  { id: '1w', label: '1W' }, { id: '1M', label: '1M' },
  { id: '1Y', label: '1Y' }, { id: '2Y', label: '2Y' },
  { id: '5Y', label: '5Y' }, { id: '10Y', label: '10Y' }, { id: 'All', label: 'All' },
];

/* Map long-range presets → actual API interval + candle limit */
const RANGE_PRESET_MAP: Record<string, { apiInterval: string; limit: number }> = {
  '1Y':  { apiInterval: '1d', limit: 365 },
  '2Y':  { apiInterval: '1w', limit: 104 },
  '5Y':  { apiInterval: '1w', limit: 261 },
  '10Y': { apiInterval: '1M', limit: 120 },
  'All': { apiInterval: '1M', limit: 1500 },
};

/* Intervals that use the full A-to-Z history endpoint (Bitfinex inception data) */
const HISTORY_INTERVALS = new Set(['5Y', '10Y', 'All']);

/* ── Chart type definitions ─────────────────────────────────────────────── */
const CHART_TYPES: { id: ChartType; label: string; svg: string }[] = [
  { id: 'candle',      label: 'Candlestick',  svg: 'M5,2 L5,5 M5,9 L5,12 M3,5 L7,5 L7,9 L3,9 Z' },
  { id: 'heikinashi',  label: 'Heikin Ashi',  svg: 'M5,1 L5,4 M5,10 L5,13 M3,4 L7,4 L7,10 L3,10 Z' },
  { id: 'bar',         label: 'Bar',          svg: 'M7,2 L7,12 M7,4 L4,4 M7,9 L10,9' },
  { id: 'line',        label: 'Line',         svg: 'M1,10 L4,6 L7,8 L10,4 L13,5' },
  { id: 'area',        label: 'Area',         svg: 'M1,10 L4,6 L7,8 L10,4 L13,5 L13,12 L1,12 Z' },
  { id: 'baseline',    label: 'Baseline',     svg: 'M1,7 L13,7 M1,10 C3,8 5,5 7,7 C9,9 11,5 13,6' },
];

/* ── Overlay indicator definitions ─────────────────────────────────────── */
const OVERLAY_INDICATORS = [
  { id: 'ma7',    label: 'MA7',    color: '#f59e0b', type: 'sma', period: 7 },
  { id: 'ma25',   label: 'MA25',   color: '#3b82f6', type: 'sma', period: 25 },
  { id: 'ma99',   label: 'MA99',   color: '#ef4444', type: 'sma', period: 99 },
  { id: 'ema12',  label: 'EMA12',  color: '#a78bfa', type: 'ema', period: 12 },
  { id: 'ema26',  label: 'EMA26',  color: '#fb923c', type: 'ema', period: 26 },
  { id: 'ema50',  label: 'EMA50',  color: '#34d399', type: 'ema', period: 50 },
  { id: 'ema200', label: 'EMA200', color: '#f472b6', type: 'ema', period: 200 },
  { id: 'vwap',   label: 'VWAP',   color: '#22d3ee', type: 'vwap', period: 0 },
  { id: 'bb',     label: 'BB',     color: '#94a3b8', type: 'bb', period: 20 },
] as const;

const SUB_INDICATORS: { id: SubIndicator; label: string }[] = [
  { id: 'none',     label: 'None' },
  { id: 'rsi',      label: 'RSI' },
  { id: 'macd',     label: 'MACD' },
  { id: 'stoch',    label: 'Stoch' },
  { id: 'cci',      label: 'CCI' },
  { id: 'williams', label: '%R' },
];

const USD_QUOTES = new Set(['USDT','USDC','USD','BUSD','TUSD','USDD','DAI','FDUSD']);

/* ── Theme colours ──────────────────────────────────────────────────────── */
function getChartColors(theme: string) {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const eff  = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
  switch (eff) {
    case 'amoled': return { bg:'#000000', text:'#9ca3af', grid:'#111111', border:'#1c1c1c', cross:'#000000', subBg:'#050505' };
    case 'light':  return { bg:'#ffffff', text:'#374151', grid:'#e5e7eb', border:'#d1d5db', cross:'#ffffff', subBg:'#f9fafb' };
    default:       return { bg:'#0d1117', text:'#848e9c', grid:'#1a2030', border:'#2b3139', cross:'#0d1117', subBg:'#0b0f18' };
  }
}

/* ── Math Utilities ─────────────────────────────────────────────────────── */
function sma(data: number[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function ema(data: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const result: (number | null)[] = [];
  let val: number | null = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    if (val === null) { val = data.slice(0, period).reduce((a, b) => a + b, 0) / period; }
    else              { val = data[i] * k + val * (1 - k); }
    result.push(val);
  }
  return result;
}

function calcRsi(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(period).fill(null);
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(100 - 100 / (1 + ag / (al || 1e-10)));
  for (let i = period + 1; i < closes.length; i++) {
    ag = (ag * (period - 1) + gains[i - 1]) / period;
    al = (al * (period - 1) + losses[i - 1]) / period;
    result.push(100 - 100 / (1 + ag / (al || 1e-10)));
  }
  return result;
}

function calcMacd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaF = ema(closes, fast);
  const emaS = ema(closes, slow);
  const macdLine = emaF.map((f, i) => f != null && emaS[i] != null ? f - emaS[i]! : null);
  const macdVals = macdLine.filter(v => v != null) as number[];
  const sigVals  = ema(macdVals, signal);
  let si = 0;
  const sigAligned = macdLine.map(m => m != null ? (sigVals[si++] ?? null) : null);
  const hist = macdLine.map((m, i) => m != null && sigAligned[i] != null ? m - sigAligned[i]! : null);
  return { macd: macdLine, signal: sigAligned, hist };
}

function calcBB(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: (number | null)[] = [], lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
    const sl  = closes.slice(i - period + 1, i + 1);
    const mn  = mid[i]!;
    const std = Math.sqrt(sl.reduce((s, v) => s + (v - mn) ** 2, 0) / period) * mult;
    upper.push(mn + std);
    lower.push(mn - std);
  }
  return { upper, middle: mid, lower };
}

function calcVwap(candles: Candle[]): (number | null)[] {
  let cpv = 0, cv = 0;
  return candles.map(c => {
    const vol = (c as any).volume ?? 0;
    cpv += ((c.high + c.low + c.close) / 3) * vol;
    cv  += vol;
    return cv > 0 ? cpv / cv : null;
  });
}

function calcStoch(candles: Candle[], kPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rawK: (number | null)[] = candles.map((_, i) => {
    if (i < kPeriod - 1) return null;
    const sl = candles.slice(i - kPeriod + 1, i + 1);
    const lo = Math.min(...sl.map(c => c.low));
    const hi = Math.max(...sl.map(c => c.high));
    return hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  });
  const rawKVals = rawK.filter(v => v != null) as number[];
  const smoothK  = sma(rawKVals, kSmooth);
  let si = 0;
  const kLine = rawK.map(v => v != null ? (smoothK[si++] ?? null) : null);
  const kForD  = kLine.filter(v => v != null) as number[];
  const dVals  = sma(kForD, dSmooth);
  let di = 0;
  const dLine = kLine.map(v => v != null ? (dVals[di++] ?? null) : null);
  return { k: kLine, d: dLine };
}

function calcCci(candles: Candle[], period = 20): (number | null)[] {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const sl  = candles.slice(i - period + 1, i + 1);
    const tps = sl.map(c => (c.high + c.low + c.close) / 3);
    const smaV = tps.reduce((a, b) => a + b, 0) / period;
    const md   = tps.reduce((a, b) => a + Math.abs(b - smaV), 0) / period;
    return md === 0 ? 0 : (tps[tps.length - 1] - smaV) / (0.015 * md);
  });
}

function calcWilliams(candles: Candle[], period = 14): (number | null)[] {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const sl = candles.slice(i - period + 1, i + 1);
    const hi = Math.max(...sl.map(c => c.high));
    const lo = Math.min(...sl.map(c => c.low));
    return hi === lo ? -50 : ((hi - candles[i].close) / (hi - lo)) * -100;
  });
}

function computeHeikinAshi(candles: Candle[]): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], prev = result[i - 1];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen  = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    result.push({ ...c, open: haOpen, high: Math.max(c.high, haOpen, haClose), low: Math.min(c.low, haOpen, haClose), close: haClose });
  }
  return result;
}

/* ── Zoom-adaptive interval helpers ────────────────────────────────────── */
const INTERVAL_SECONDS: [number, string][] = [
  [60,      '1m'],
  [180,     '3m'],
  [300,     '5m'],
  [900,     '15m'],
  [1800,    '30m'],
  [3600,    '1h'],
  [7200,    '2h'],
  [14400,   '4h'],
  [21600,   '6h'],
  [43200,   '12h'],
  [86400,   '1d'],
  [259200,  '3d'],
  [604800,  '1w'],
  [2592000, '1M'],
];

/** Pick the interval that would give ~150 candles for a given visible span (seconds). */
function bestIntervalForSpan(spanSec: number): string {
  const target = spanSec / 150;
  for (const [secs, iv] of INTERVAL_SECONDS) {
    if (target <= secs) return iv;
  }
  return '1M';
}

/* ── Adaptive precision ─────────────────────────────────────────────────── */
function priceFormat(price: number) {
  const p = price < 0.001 ? 8 : price < 0.1 ? 6 : price < 1 ? 4 : price < 100 ? 2 : 1;
  const m = price < 0.001 ? 0.00000001 : price < 0.1 ? 0.000001 : price < 1 ? 0.0001 : price < 100 ? 0.01 : 0.1;
  return { type: 'price' as const, precision: p, minMove: m };
}

function fmtPrice(v: number, price: number): string {
  const dp = price < 0.001 ? 8 : price < 0.1 ? 6 : price < 1 ? 4 : price < 100 ? 2 : 1;
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/* ══════════════════════════════════════════════════════════════════════════
   ORAHCHART — Maximum Features Edition
══════════════════════════════════════════════════════════════════════════ */
function OrahChart({ symbol, interval, onIntervalChange, subIndicator: subIndicatorProp, hideIntervalBar, data: fallbackData }: {
  symbol: string; interval: string; onIntervalChange?: (iv: string) => void; subIndicator?: SubIndicator; hideIntervalBar?: boolean; data?: Candle[];
}) {
  const mainRef   = useRef<HTMLDivElement>(null);
  const subRef    = useRef<HTMLDivElement>(null);
  const chartRef  = useRef<ReturnType<typeof createChart> | null>(null);
  const subChartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);
  /* Always-current candles ref so crosshair callback never goes stale */
  const candlesRef = useRef<Candle[]>([]);
  /* Always-current display candles ref for live last-bar updates */
  const displayCandlesRef = useRef<Candle[]>([]);

  /* series refs */
  const priceSeriesRef   = useRef<any>(null);
  const volSeriesRef     = useRef<any>(null);
  const ma7Ref   = useRef<any>(null);
  const ma25Ref  = useRef<any>(null);
  const ma99Ref  = useRef<any>(null);
  const ema12Ref = useRef<any>(null);
  const ema26Ref = useRef<any>(null);
  const ema50Ref = useRef<any>(null);
  const ema200Ref= useRef<any>(null);
  const vwapRef  = useRef<any>(null);
  const bbUpperRef = useRef<any>(null);
  const bbMidRef   = useRef<any>(null);
  const bbLowerRef = useRef<any>(null);
  /* sub indicator refs */
  const subLine1Ref = useRef<any>(null);
  const subLine2Ref = useRef<any>(null);
  const subHistRef  = useRef<any>(null);

  /* zoom-adaptive refs */
  const zoomRangeRef        = useRef<{ from: number; to: number } | null>(null);
  const autoIntervalRef     = useRef(false);
  const zoomTimerRef2       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effectiveIntervalRef = useRef(interval);

  const { theme } = useThemeStore();
  const { showTradingViewWatermark } = useSettingsStore();
  const [candles, setCandles]     = useState<Candle[]>([]);
  const [loading, setLoading]     = useState(true);
  const [chartType, setChartType] = useState<ChartType>(() => {
    const saved = localStorage.getItem('orahdex-chart-type') as ChartType | null;
    return saved && ['candle','heikinashi','bar','line','area','baseline'].includes(saved) ? saved : 'candle';
  });
  const [subInd, setSubInd]       = useState<SubIndicator>(subIndicatorProp ?? 'none');
  const [activeOverlays, setActiveOverlays] = useState<Set<string>>(new Set());
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);

  /* Persist chart type across refreshes */
  useEffect(() => { localStorage.setItem('orahdex-chart-type', chartType); }, [chartType]);

  // Sync external subIndicator prop → internal state (allows parent to control it)
  useEffect(() => {
    if (subIndicatorProp) setSubInd(subIndicatorProp);
  }, [subIndicatorProp]);
  const [autoInterval, setAutoInterval] = useState<string | null>(null);
  const [showVol, setShowVol]     = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [chartReady, setChartReady] = useState(false);
  const [subReady, setSubReady]   = useState(false);
  const [hoverInfo, setHoverInfo] = useState<{ o:number;h:number;l:number;c:number;v:number;t:number } | null>(null);
  const [ticker, setTicker]       = useState<{ last: number; change: number; high: number; low: number; vol: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Keep effectiveIntervalRef current; reset autoInterval on parent-driven interval change */
  const effectiveInterval = autoInterval ?? interval;
  useEffect(() => { effectiveIntervalRef.current = effectiveInterval; }, [effectiveInterval]);
  useEffect(() => { setAutoInterval(null); }, [interval]);

  /* parsed symbol */
  const parts = useMemo(() => {
    const clean = symbol.replace(/-PERP|PERP/gi, '');
    const p = clean.split(/[\/\-]/);
    return { base: p[0] ?? 'BSV', quote: p[1] ?? 'USDT' };
  }, [symbol]);
  const isUsd = USD_QUOTES.has(parts.quote.toUpperCase());
  const pPrefix = isUsd ? '$' : '';
  const pSuffix = isUsd ? '' : ` ${parts.quote}`;

  /* ── Fetch candles ──────────────────────────────────────────────────── */
  const fetchCandles = useCallback(async () => {
    try {
      let url: string;
      if (HISTORY_INTERVALS.has(interval)) {
        /* Full history from coin inception — server resamples daily→weekly/monthly */
        const res = interval === '5Y' ? '1w' : '1M';
        url = `${BASE_URL}/api/markets/${encodeURIComponent(symbol)}/history?interval=${res}`;
      } else {
        const preset = RANGE_PRESET_MAP[interval];
        const apiInterval = preset ? preset.apiInterval : interval;
        const limit = preset
          ? preset.limit
          : ['1d','3d','1w','1M'].includes(interval) ? 300 : 500;
        url = `${BASE_URL}/api/markets/${encodeURIComponent(symbol)}/candles?interval=${apiInterval}&limit=${limit}`;
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        console.warn("[Chart] Candle fetch failed", { symbol, interval, status: res.status });
        return;
      }
      const raw = await res.json();
      const arr: Candle[] = Array.isArray(raw) ? raw : raw.candles ?? [];
      const MIN_TS = 1000000000; // Sep 2001 — anything older is a bad timestamp
      const sorted = arr.filter(c => c?.time && Number(c.time) > MIN_TS && c.open && c.high && c.low && c.close)
        .sort((a, b) => Number(a.time) - Number(b.time));
      if (sorted.length) setCandles(sorted);
    } catch (err) {
      console.warn("[Chart] Candle fetch error", { err, symbol, interval });
    }
    finally { setLoading(false); }
  }, [symbol, interval]);

  const fetchTicker = useCallback(async () => {
    try {
      const r = await fetch(`${BASE_URL}/api/markets/${encodeURIComponent(symbol)}/ticker`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const t = await r.json();
      if (t.lastPrice) {
        const chg = typeof t.priceChangePercent === 'number' && isFinite(t.priceChangePercent)
          ? t.priceChangePercent
          : t.openPrice > 0 ? ((t.lastPrice - t.openPrice) / t.openPrice) * 100 : 0;
        setTicker({ last: t.lastPrice, change: chg, high: t.highPrice ?? 0, low: t.lowPrice ?? 0, vol: t.volume ?? 0 });
      }
    } catch (err) {
      console.warn("[Chart] Ticker fetch error", { err, symbol });
    }
  }, [symbol]);

  /**
   * Zoom-triggered fetch: loads candles at `iv` without clearing existing data,
   * then restores `restoreRange` after the chart updates.
   */
  const fetchForZoom = useCallback(async (iv: string, restoreRange: { from: number; to: number }) => {
    try {
      const preset = RANGE_PRESET_MAP[iv];
      const apiIv  = preset ? preset.apiInterval : iv;
      const lim    = preset ? preset.limit : ['1d','3d','1w','1M'].includes(iv) ? 300 : 500;
      const url = `${BASE_URL}/api/markets/${encodeURIComponent(symbol)}/candles?interval=${apiIv}&limit=${lim}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const raw = await res.json();
      const arr: Candle[] = Array.isArray(raw) ? raw : raw.candles ?? [];
      const MIN_TS = 1000000000;
      const sorted = arr
        .filter(c => c?.time && Number(c.time) > MIN_TS && c.open && c.high && c.low && c.close)
        .sort((a, b) => Number(a.time) - Number(b.time));
      if (!sorted.length) return;
      /* Mark that the next updatePriceSeries should restore range, not fitContent */
      zoomRangeRef.current  = restoreRange;
      autoIntervalRef.current = true;
      setAutoInterval(iv);
      setCandles(sorted);
    } catch (_) {}
  }, [symbol]);

  useEffect(() => {
    setLoading(true);
    // Don't clear candles here — let old data persist until new data arrives
    setTicker(null); setHoverInfo(null);
    fetchCandles(); fetchTicker();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => { fetchCandles(); fetchTicker(); }, 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchCandles, fetchTicker]);

  /* When the API fetch completes with no data, fall back to the provided candles */
  useEffect(() => {
    if (!loading && candles.length === 0 && fallbackData && fallbackData.length > 0) {
      setCandles(fallbackData);
    }
  }, [loading, candles.length, fallbackData]);

  /* Keep candlesRef always current so crosshair callback is never stale */
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  /* ── Computed indicator data ────────────────────────────────────────── */
  const closes  = useMemo(() => candles.map(c => c.close), [candles]);
  const indicatorData = useMemo(() => {
    if (!closes.length) return {};
    return {
      ma7:    sma(closes, 7),
      ma25:   sma(closes, 25),
      ma99:   sma(closes, 99),
      ema12:  ema(closes, 12),
      ema26:  ema(closes, 26),
      ema50:  ema(closes, 50),
      ema200: ema(closes, 200),
      vwap:   calcVwap(candles),
      bb:     calcBB(closes, 20, 2),
      rsi:    calcRsi(closes, 14),
      macd:   calcMacd(closes, 12, 26, 9),
      stoch:  calcStoch(candles, 14, 3, 3),
      cci:    calcCci(candles, 20),
      williams: calcWilliams(candles, 14),
    };
  }, [closes, candles]);

  /* Sanitize candles — strip zeros, NaN, and statistical outliers that
     would cause the chart to zoom out to extreme scales               */
  const sanitizedCandles = useMemo(() => {
    if (!candles.length) return candles;
    // Step 1: basic validity
    const valid = candles.filter(c =>
      c.open > 0 && c.close > 0 && c.high > 0 && c.low > 0 &&
      isFinite(c.open) && isFinite(c.close) && isFinite(c.high) && isFinite(c.low) &&
      c.high >= c.low && c.high >= Math.min(c.open, c.close)
    );
    if (!valid.length) return candles;
    // Step 2: compute median close to detect extreme outliers
    const sorted = [...valid].map(c => c.close).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Allow candles within 20x of median (catches real crashes/pumps but blocks garbage data)
    const filtered = valid.filter(c =>
      c.close >= median / 20 && c.close <= median * 20 &&
      c.open  >= median / 20 && c.open  <= median * 20 &&
      c.high  <= median * 25 && c.low   >= median / 25
    );
    return filtered.length >= 5 ? filtered : valid;
  }, [candles]);

  const displayCandles = useMemo(() =>
    chartType === 'heikinashi' ? computeHeikinAshi(sanitizedCandles) : sanitizedCandles,
  [sanitizedCandles, chartType]);

  /* Keep displayCandlesRef always current */
  useEffect(() => { displayCandlesRef.current = displayCandles; }, [displayCandles]);

  /* ── Live last-bar update — fires on every ticker tick ───────────────────
     Calls series.update() instead of setData() so only the last bar redraws */
  useEffect(() => {
    const series = priceSeriesRef.current;
    const livePrice = ticker?.last;
    if (!series || !livePrice || livePrice <= 0) return;
    const dc = displayCandlesRef.current;
    if (!dc.length) return;
    const last = dc[dc.length - 1];
    const t = Number(last.time) as any;
    try {
      if (chartType === 'candle' || chartType === 'heikinashi' || chartType === 'bar') {
        series.update({ time: t, open: last.open, high: Math.max(last.high, livePrice), low: Math.min(last.low, livePrice), close: livePrice });
      } else {
        series.update({ time: t, value: livePrice });
      }
    } catch (_) {}
    /* Keep crosshair hover info in sync with live price */
    const cr = candlesRef.current;
    if (cr.length) {
      const lr = cr[cr.length - 1];
      lr.close = livePrice;
      lr.high  = Math.max(lr.high, livePrice);
      lr.low   = Math.min(lr.low,  livePrice);
    }
  }, [ticker, chartType]);

  /* ── Create main chart ──────────────────────────────────────────────── */
  useEffect(() => {
    const el = mainRef.current;
    if (!el || candles.length === 0 || chartRef.current) return;
    const c = getChartColors(theme);
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text, fontFamily: "'Inter', sans-serif", attributionLogo: showTradingViewWatermark },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.05, bottom: 0.2 }, minimumWidth: 72 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#4ade80', labelBackgroundColor: c.cross, style: 2, width: 1 },
        horzLine: { color: '#4ade80', labelBackgroundColor: c.cross, style: 2, width: 1 },
      },
      handleScroll: { vertTouchDrag: false },
    });

    /* Volume series */
    const volSeries = chart.addSeries(HistogramSeries, { color: '#4ade8025', priceFormat: { type: 'volume' }, priceScaleId: 'volume' });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeriesRef.current = volSeries;

    /* Crosshair subscription → OHLCV hover info (uses ref to avoid stale closure) */
    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.point) { setHoverInfo(null); return; }
      const live = candlesRef.current;
      const idx = live.findIndex(c => Number(c.time) === Number(param.time));
      if (idx >= 0) {
        const c = live[idx];
        setHoverInfo({ o: c.open, h: c.high, l: c.low, c: c.close, v: (c as any).volume ?? 0, t: Number(c.time) });
      }
    });

    chartRef.current = chart;
    setChartReady(true);
    return () => { chart.remove(); chartRef.current = null; setChartReady(false); };
  }, [candles.length > 0]);

  /* ── Create sub chart ───────────────────────────────────────────────── */
  useEffect(() => {
    const el = subRef.current;
    if (!el || subInd === 'none') { setSubReady(false); return; }
    if (subChartRef.current) return;
    const c = getChartColors(theme);
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: c.subBg }, textColor: c.text, fontFamily: "'Inter', sans-serif", attributionLogo: showTradingViewWatermark },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, visible: true },
      rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.1, bottom: 0.1 }, minimumWidth: 72 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#4ade80', labelBackgroundColor: c.subBg, style: 2, width: 1 },
        horzLine: { color: '#4ade80', labelBackgroundColor: c.subBg, style: 2, width: 1 },
      },
      handleScroll: { vertTouchDrag: false },
    });
    subChartRef.current = chart;

    /* Sync time ranges — wrapped in try/catch because the sub chart may not
       have any series data yet when the callback fires during initialization */
    if (chartRef.current) {
      chartRef.current.timeScale().subscribeVisibleTimeRangeChange(range => {
        if (!range || !subChartRef.current) return;
        try { subChartRef.current.timeScale().setVisibleRange(range as any); } catch (_) {}
      });
      subChartRef.current.timeScale().subscribeVisibleTimeRangeChange(range => {
        if (!range || !chartRef.current) return;
        try { chartRef.current.timeScale().setVisibleRange(range as any); } catch (_) {}
      });
    }

    setSubReady(true);
    return () => { chart.remove(); subChartRef.current = null; setSubReady(false); };
  }, [subInd !== 'none', candles.length > 0]);

  /* ── Destroy sub chart when subInd = none ───────────────────────────── */
  useEffect(() => {
    if (subInd === 'none' && subChartRef.current) {
      subChartRef.current.remove();
      subChartRef.current = null;
      subLine1Ref.current = null;
      subLine2Ref.current = null;
      subHistRef.current  = null;
      setSubReady(false);
    }
  }, [subInd]);

  /* ── Re-apply theme colours ─────────────────────────────────────────── */
  useEffect(() => {
    const c = getChartColors(theme);
    for (const ch of [chartRef.current, subChartRef.current]) {
      if (!ch) continue;
      ch.applyOptions({
        layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text },
        grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
        timeScale: { borderColor: c.border },
        rightPriceScale: { borderColor: c.border },
        crosshair: {
          vertLine: { color: '#4ade80', labelBackgroundColor: c.cross },
          horzLine: { color: '#4ade80', labelBackgroundColor: c.cross },
        },
      });
    }
  }, [theme]);

  /* ── Rebuild price series when chartType changes ────────────────────── */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartReady || !candles.length) return;
    if (priceSeriesRef.current) { try { chart.removeSeries(priceSeriesRef.current); } catch (_) {} priceSeriesRef.current = null; }

    let series: any;
    const pf = priceFormat(candles[candles.length - 1].close);

    if (chartType === 'candle' || chartType === 'heikinashi') {
      series = chart.addSeries(CandlestickSeries, { upColor: '#0ecb81', downColor: '#f6465d', borderVisible: false, wickUpColor: '#0ecb81', wickDownColor: '#f6465d' });
    } else if (chartType === 'bar') {
      series = chart.addSeries(BarSeries, { upColor: '#0ecb81', downColor: '#f6465d' });
    } else if (chartType === 'line') {
      series = chart.addSeries(LineSeries, { color: '#4ade80', lineWidth: 2 });
    } else if (chartType === 'area') {
      series = chart.addSeries(AreaSeries, { lineColor: '#4ade80', topColor: '#4ade8040', bottomColor: '#4ade8004', lineWidth: 2 });
    } else {
      series = chart.addSeries(AreaSeries, { lineColor: '#4ade80', topColor: '#4ade8030', bottomColor: '#4ade8005', lineWidth: 2 });
    }
    series.applyOptions({ priceFormat: pf });
    priceSeriesRef.current = series;
    updatePriceSeries();
  }, [chartReady, chartType]);

  /* ── Helper: push data to price series ─────────────────────────────── */
  const updatePriceSeries = useCallback(() => {
    const series = priceSeriesRef.current;
    if (!series || !displayCandles.length) return;
    const pf = priceFormat(displayCandles[displayCandles.length - 1].close);
    series.applyOptions({ priceFormat: pf });
    if (chartType === 'candle' || chartType === 'heikinashi' || chartType === 'bar') {
      series.setData(displayCandles.map(c => ({ time: Number(c.time) as any, open: c.open, high: c.high, low: c.low, close: c.close })));
    } else {
      series.setData(displayCandles.map(c => ({ time: Number(c.time) as any, value: c.close })));
    }
    /* After a zoom-triggered fetch restore the user's visible range instead of fitContent */
    if (autoIntervalRef.current && zoomRangeRef.current) {
      const { from, to } = zoomRangeRef.current;
      try { chartRef.current?.timeScale().setVisibleRange({ from: from as any, to: to as any }); } catch (_) {}
      autoIntervalRef.current = false;
      zoomRangeRef.current = null;
    } else {
      /* rAF ensures the chart has processed setData (computed its full extent) before we fit */
      requestAnimationFrame(() => {
        chartRef.current?.timeScale().fitContent();
        subChartRef.current?.timeScale().fitContent();
      });
    }
  }, [displayCandles, chartType]);

  /* ── Push candle data whenever candles change ───────────────────────── */
  useEffect(() => {
    if (!chartReady || !candles.length) return;
    updatePriceSeries();

    /* Volume */
    if (volSeriesRef.current && showVol) {
      volSeriesRef.current.setData(candles.map(c => ({
        time: Number(c.time) as any,
        value: (c as any).volume ?? 0,
        color: c.close >= c.open ? '#0ecb8125' : '#f6465d25',
      })));
    }
    if (volSeriesRef.current && !showVol) { volSeriesRef.current.setData([]); }
  }, [candles, chartReady, showVol, updatePriceSeries]);

  /* ── Overlay indicators ─────────────────────────────────────────────── */
  const overlayRefs: Record<string, React.MutableRefObject<any>> = {
    ma7: ma7Ref, ma25: ma25Ref, ma99: ma99Ref,
    ema12: ema12Ref, ema26: ema26Ref, ema50: ema50Ref, ema200: ema200Ref,
    vwap: vwapRef,
  };

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartReady || !candles.length || !Object.keys(indicatorData).length) return;

    /* Remove all overlay series first */
    for (const ref of Object.values(overlayRefs)) {
      if (ref.current) { try { chart.removeSeries(ref.current); } catch (_) {} ref.current = null; }
    }
    for (const ref of [bbUpperRef, bbMidRef, bbLowerRef]) {
      if (ref.current) { try { chart.removeSeries(ref.current); } catch (_) {} ref.current = null; }
    }

    const timestamps = candles.map(c => Number(c.time) as any);

    /* Add active overlays */
    const addLine = (ref: React.MutableRefObject<any>, color: string, data: (number|null)[], dash = false) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: dash ? 2 : 0, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
      s.setData(data.map((v, i) => v != null ? { time: timestamps[i], value: v } : null).filter(Boolean) as any);
      ref.current = s;
    };

    for (const ind of OVERLAY_INDICATORS) {
      if (!activeOverlays.has(ind.id)) continue;
      if (ind.type === 'sma' || ind.type === 'ema') {
        const key = ind.id as keyof typeof indicatorData;
        const d = indicatorData[key] as (number|null)[];
        if (d) addLine(overlayRefs[ind.id], ind.color, d);
      } else if (ind.id === 'vwap' && indicatorData.vwap) {
        addLine(vwapRef, ind.color, indicatorData.vwap as (number|null)[]);
      } else if (ind.id === 'bb' && indicatorData.bb) {
        const bb = indicatorData.bb as ReturnType<typeof calcBB>;
        addLine(bbUpperRef, '#94a3b880', bb.upper, true);
        addLine(bbMidRef,   '#94a3b8',   bb.middle, false);
        addLine(bbLowerRef, '#94a3b880', bb.lower, true);
      }
    }
  }, [candles, chartReady, activeOverlays, indicatorData]);

  /* ── Sub indicator data ─────────────────────────────────────────────── */
  useEffect(() => {
    const chart = subChartRef.current;
    if (!chart || !subReady || subInd === 'none' || !candles.length) return;

    for (const ref of [subLine1Ref, subLine2Ref, subHistRef]) {
      if (ref.current) { try { chart.removeSeries(ref.current); } catch (_) {} ref.current = null; }
    }

    const timestamps = candles.map(c => Number(c.time) as any);
    const addSub = (ref: React.MutableRefObject<any>, color: string, data: (number|null)[], width = 1) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: width as any, crosshairMarkerVisible: false, lastValueVisible: true, priceLineVisible: false });
      s.setData(data.map((v, i) => v != null ? { time: timestamps[i], value: v } : null).filter(Boolean) as any);
      ref.current = s;
      return s;
    };
    const addHist = (ref: React.MutableRefObject<any>, data: (number|null)[]) => {
      const s = chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 6, minMove: 0.000001 }, lastValueVisible: true, priceLineVisible: false });
      s.setData(data.map((v, i) => v != null ? { time: timestamps[i], value: v, color: v >= 0 ? '#0ecb8160' : '#f6465d60' } : null).filter(Boolean) as any);
      ref.current = s;
    };

    if (subInd === 'rsi' && indicatorData.rsi) {
      addSub(subLine1Ref, '#f59e0b', indicatorData.rsi as (number|null)[], 1);
      /* overbought/oversold price lines */
      if (subLine1Ref.current) {
        subLine1Ref.current.createPriceLine({ price: 70, color: '#ef444450', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'OB' });
        subLine1Ref.current.createPriceLine({ price: 30, color: '#0ecb8150', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'OS' });
        subLine1Ref.current.createPriceLine({ price: 50, color: '#94a3b830', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      }
    } else if (subInd === 'macd' && indicatorData.macd) {
      const { macd: m, signal: sig, hist } = indicatorData.macd as ReturnType<typeof calcMacd>;
      addHist(subHistRef, hist);
      addSub(subLine1Ref, '#3b82f6', m, 1);
      addSub(subLine2Ref, '#f59e0b', sig, 1);
    } else if (subInd === 'stoch' && indicatorData.stoch) {
      const { k, d } = indicatorData.stoch as ReturnType<typeof calcStoch>;
      addSub(subLine1Ref, '#3b82f6', k, 1);
      addSub(subLine2Ref, '#f59e0b', d, 1);
      if (subLine1Ref.current) {
        subLine1Ref.current.createPriceLine({ price: 80, color: '#ef444450', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '80' });
        subLine1Ref.current.createPriceLine({ price: 20, color: '#0ecb8150', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '20' });
      }
    } else if (subInd === 'cci' && indicatorData.cci) {
      addSub(subLine1Ref, '#a78bfa', indicatorData.cci as (number|null)[], 1);
      if (subLine1Ref.current) {
        subLine1Ref.current.createPriceLine({ price: 100,  color: '#ef444450', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '+100' });
        subLine1Ref.current.createPriceLine({ price: -100, color: '#0ecb8150', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '-100' });
        subLine1Ref.current.createPriceLine({ price: 0,    color: '#94a3b830', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      }
    } else if (subInd === 'williams' && indicatorData.williams) {
      addSub(subLine1Ref, '#34d399', indicatorData.williams as (number|null)[], 1);
      if (subLine1Ref.current) {
        subLine1Ref.current.createPriceLine({ price: -20, color: '#ef444450', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '-20' });
        subLine1Ref.current.createPriceLine({ price: -80, color: '#0ecb8150', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '-80' });
      }
    }

    /* Sync initial time range */
    const range = chartRef.current?.timeScale().getVisibleRange();
    if (range) chart.timeScale().setVisibleRange(range as any);
  }, [subReady, subInd, candles, indicatorData]);

  /* ── Subscribe to visible time range changes → auto-switch interval ─── */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartReady) return;

    const handler = (range: any) => {
      if (!range) return;
      const from = range.from as number;
      const to   = range.to   as number;
      const span = to - from;
      if (span <= 0 || !isFinite(span)) return;

      if (zoomTimerRef2.current) clearTimeout(zoomTimerRef2.current);
      zoomTimerRef2.current = setTimeout(() => {
        const best  = bestIntervalForSpan(span);
        const curIv = effectiveIntervalRef.current;
        /* Don't auto-switch for long-range presets (1Y/2Y/5Y etc.) */
        if (RANGE_PRESET_MAP[curIv] || best === curIv) return;
        fetchForZoom(best, { from, to });
      }, 900);
    };

    chart.timeScale().subscribeVisibleTimeRangeChange(handler);
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handler);
      if (zoomTimerRef2.current) clearTimeout(zoomTimerRef2.current);
    };
  }, [chartReady, fetchForZoom]);

  /* ── Zoom helpers ───────────────────────────────────────────────────── */
  const fitContent = () => { chartRef.current?.timeScale().fitContent(); subChartRef.current?.timeScale().fitContent(); };
  const zoomIn  = () => { const ts = chartRef.current?.timeScale(); if (ts) { const r = ts.getVisibleRange(); if (r) { const mid = ((r.from as number)+(r.to as number))/2, span=((r.to as number)-(r.from as number))*0.35; ts.setVisibleRange({ from: (mid-span) as any, to: (mid+span) as any }); } } };
  const zoomOut = () => { const ts = chartRef.current?.timeScale(); if (ts) { const r = ts.getVisibleRange(); if (r) { const mid = ((r.from as number)+(r.to as number))/2, span=((r.to as number)-(r.from as number))*0.7; ts.setVisibleRange({ from: (mid-span) as any, to: (mid+span) as any }); } } };

  /* ── Screenshot ─────────────────────────────────────────────────────── */
  const screenshot = () => {
    const canvas = mainRef.current?.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${symbol.replace('/','-')}-${interval}-${Date.now()}.png`;
    a.click();
  };

  /* ── Derived display values ─────────────────────────────────────────── */
  const lastP    = ticker?.last ?? candles[candles.length - 1]?.close ?? 0;
  const isUp     = (ticker?.change ?? 0) >= 0;
  const decimals = lastP < 0.000001 ? 12 : lastP < 0.0001 ? 10 : lastP < 0.01 ? 8 : lastP < 1 ? 6 : lastP < 100 ? 4 : 2;
  const col      = getChartColors(theme);
  const isLight  = col.bg === '#ffffff';
  const borderC  = `1px solid ${col.grid}`;

  const subLabel: Record<SubIndicator, string> = {
    none: '', rsi: 'RSI (14)', macd: 'MACD (12, 26, 9)', stoch: 'Stochastic (14, 3, 3)', cci: 'CCI (20)', williams: 'Williams %R (14)',
  };

  const toggleOverlay = (id: string) => setActiveOverlays(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div ref={wrapRef} className={`flex flex-col ${fullscreen ? 'fixed inset-0 z-[9999]' : 'h-full'}`} style={{ backgroundColor: col.bg, color: col.text }}>

      {/* ── TOP STATS BAR ── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 overflow-x-auto scrollbar-hide" style={{ borderColor: col.grid }}>
        <span className="text-xs font-black text-green-400 shrink-0">{symbol.replace(/-PERP/i, '')}</span>
        {lastP > 0 && (
          <>
            <span className="text-sm font-bold font-mono shrink-0" style={{ color: isUp ? '#0ecb81' : '#f6465d' }}>
              {pPrefix}{lastP.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{pSuffix}
            </span>
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${isUp ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'}`}>
              {isUp ? '+' : ''}{(ticker?.change ?? 0).toFixed(2)}%
            </span>
            {ticker && (
              <>
                <span className="text-[10px] shrink-0" style={{ color: col.text }}>H: <span style={{ color: '#0ecb81' }}>{pPrefix}{fmtPrice(ticker.high, lastP)}</span></span>
                <span className="text-[10px] shrink-0" style={{ color: col.text }}>L: <span style={{ color: '#f6465d' }}>{pPrefix}{fmtPrice(ticker.low, lastP)}</span></span>
                <span className="text-[10px] shrink-0" style={{ color: col.text }}>Vol: <span className="font-mono">{ticker.vol > 1e6 ? `${(ticker.vol/1e6).toFixed(2)}M` : ticker.vol > 1e3 ? `${(ticker.vol/1e3).toFixed(2)}K` : ticker.vol.toFixed(2)}</span></span>
              </>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <span className="text-[10px] text-green-400/70 font-mono">OrahDEX Live</span>
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
        </div>
      </div>

      {/* ── TOOLBAR ── */}
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b shrink-0 overflow-x-auto scrollbar-hide" style={{ borderColor: col.grid }}>

        {/* Intervals — hidden when parent provides its own interval UI */}
        {!hideIntervalBar && (
          <>
            <div className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto scrollbar-hide">
              {INTERVALS.map(iv => (
                <button key={iv.id}
                  onClick={() => { setAutoInterval(null); onIntervalChange?.(iv.id); }}
                  className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                    (autoInterval ? autoInterval === iv.id : interval === iv.id)
                      ? autoInterval
                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                        : 'bg-green-500/20 text-green-400 border border-green-500/40'
                      : isLight ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-800' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
                  }`}
                  title={autoInterval && autoInterval === iv.id ? 'Auto-selected for current zoom' : undefined}
                >{iv.label}</button>
              ))}
            </div>
            {/* Auto-resolution badge */}
            {autoInterval && (
              <button
                onClick={() => { setAutoInterval(null); onIntervalChange?.(interval); }}
                className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-all"
                title="Auto-selected interval based on zoom level — click to reset"
              >
                Auto
              </button>
            )}
            <div className="w-px h-5 mx-1 shrink-0" style={{ background: col.grid }} />
          </>
        )}

        {hideIntervalBar && <div className="flex-1" />}

        <div className="w-px h-5 mx-1 shrink-0" style={{ background: col.grid }} />

        {/* Chart types */}
        {CHART_TYPES.map(ct => (
          <button key={ct.id} title={ct.label} onClick={() => setChartType(ct.id)}
            className={`shrink-0 p-1 rounded transition-all ${chartType === ct.id ? 'text-green-400 bg-green-500/15' : isLight ? 'text-gray-400 hover:text-gray-700 hover:bg-gray-100' : 'text-muted-foreground hover:text-foreground hover:bg-white/8'}`}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d={ct.svg} fill={ct.id === 'area' ? 'currentColor' : 'none'} fillOpacity={ct.id === 'area' ? 0.15 : 0} />
            </svg>
          </button>
        ))}

        <div className="w-px h-5 mx-1 shrink-0" style={{ background: col.grid }} />

        {/* Sub indicator selector */}
        <div className="flex items-center gap-0.5 shrink-0">
          {SUB_INDICATORS.filter(s => s.id !== 'none').map(s => (
            <button key={s.id} onClick={() => setSubInd(prev => prev === s.id ? 'none' : s.id)}
              className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
                subInd === s.id
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                  : isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
              }`}
            >{s.label}</button>
          ))}
        </div>

        <div className="w-px h-5 mx-1 shrink-0" style={{ background: col.grid }} />

        {/* Overlay indicator panel toggle */}
        <button onClick={() => setShowIndicatorPanel(p => !p)} title="Indicators"
          className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
            showIndicatorPanel || activeOverlays.size > 0
              ? 'text-green-400 bg-green-500/15 border border-green-500/30'
              : isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-muted-foreground hover:bg-white/5'
          }`}
        >
          <TrendingUp className="w-3 h-3" />
          {activeOverlays.size > 0 && <span className="text-green-400">{activeOverlays.size}</span>}
          {showIndicatorPanel ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>

        {/* Volume toggle */}
        <button onClick={() => setShowVol(p => !p)} title="Toggle Volume"
          className={`shrink-0 p-1 rounded transition-all ${showVol ? 'text-green-400 bg-green-500/15' : isLight ? 'text-gray-400 hover:bg-gray-100' : 'text-muted-foreground hover:bg-white/5'}`}
        >
          <BarChart2 className="w-3.5 h-3.5" />
        </button>

        <div className="w-px h-5 mx-1 shrink-0" style={{ background: col.grid }} />

        {/* Zoom controls */}
        <button onClick={zoomIn}  title="Zoom In"  className={`shrink-0 p-1 rounded ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}><ZoomIn  className="w-3.5 h-3.5" /></button>
        <button onClick={zoomOut} title="Zoom Out" className={`shrink-0 p-1 rounded ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}><ZoomOut className="w-3.5 h-3.5" /></button>
        <button onClick={fitContent} title="Fit" className={`shrink-0 p-1 rounded ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}><AlignCenter className="w-3.5 h-3.5" /></button>

        <div className="w-px h-5 mx-1 shrink-0" style={{ background: col.grid }} />

        {/* Screenshot */}
        <button onClick={screenshot} title="Save chart image" className={`shrink-0 p-1 rounded ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}><Camera className="w-3.5 h-3.5" /></button>

        {/* Fullscreen */}
        <button onClick={() => setFullscreen(p => !p)} title="Fullscreen" className={`shrink-0 p-1 rounded ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}>
          {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* ── INDICATOR PANEL ── */}
      {showIndicatorPanel && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b shrink-0" style={{ borderColor: col.grid, background: `${col.grid}40` }}>
          {OVERLAY_INDICATORS.map(ind => {
            const on = activeOverlays.has(ind.id);
            return (
              <button key={ind.id} onClick={() => toggleOverlay(ind.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all border ${
                  on ? 'border-opacity-60' : 'border-opacity-20 opacity-50'
                }`}
                style={{
                  borderColor: ind.color,
                  background: on ? `${ind.color}18` : 'transparent',
                  color: on ? ind.color : col.text,
                }}
              >
                <span className="w-2.5 h-0.5 rounded-full inline-block shrink-0" style={{ background: ind.color }} />
                {ind.label}
              </button>
            );
          })}
          <div className="ml-auto text-[10px]" style={{ color: col.text, opacity: 0.5 }}>Click to toggle overlays</div>
        </div>
      )}

      {/* ── MAIN CHART ── */}
      <div className="flex-1 min-h-0 relative" style={{ minHeight: subInd !== 'none' ? 0 : undefined }}>
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-3" style={{ backgroundColor: col.bg }}>
            <div className="flex gap-1">{[0,1,2].map(i => (<span key={i} className="w-2 h-2 rounded-full bg-green-400 animate-bounce" style={{ animationDelay: `${i*150}ms` }} />))}</div>
            <p className="text-xs" style={{ color: col.text }}>Loading {parts.base}/{parts.quote}…</p>
          </div>
        )}
        <div ref={mainRef} className="w-full h-full" />
        {/* Watermark — top-left corner */}
        {!loading && (
          <div className="absolute top-3 left-3 pointer-events-none z-[5]">
            <span
              className="select-none font-black uppercase"
              style={{
                fontSize: '13px',
                fontFamily: "'Inter', sans-serif",
                color: theme === 'light' ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.18)',
                letterSpacing: '0.15em',
              }}
            >
              OrahDEX
            </span>
          </div>
        )}
        {/* ── OHLCV HOVER INFO — absolute so it never shifts the chart layout ── */}
        {hoverInfo && (
          <div
            className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 px-3 py-1 text-[10px] font-mono pointer-events-none"
            style={{ background: `${col.bg}e8`, borderBottom: `1px solid ${col.grid}` }}
          >
            <span>O <span className="font-bold" style={{ color: hoverInfo.c >= hoverInfo.o ? '#0ecb81' : '#f6465d' }}>{pPrefix}{fmtPrice(hoverInfo.o, lastP)}</span></span>
            <span>H <span className="font-bold text-green-400">{pPrefix}{fmtPrice(hoverInfo.h, lastP)}</span></span>
            <span>L <span className="font-bold text-red-400">{pPrefix}{fmtPrice(hoverInfo.l, lastP)}</span></span>
            <span>C <span className="font-bold" style={{ color: hoverInfo.c >= hoverInfo.o ? '#0ecb81' : '#f6465d' }}>{pPrefix}{fmtPrice(hoverInfo.c, lastP)}</span></span>
            {hoverInfo.v > 0 && <span>V <span className="font-bold text-blue-400">{hoverInfo.v > 1e6 ? `${(hoverInfo.v/1e6).toFixed(3)}M` : hoverInfo.v > 1e3 ? `${(hoverInfo.v/1e3).toFixed(3)}K` : hoverInfo.v.toFixed(4)}</span></span>}
            {hoverInfo.c > hoverInfo.o
              ? <span className="text-green-400 font-bold">▲ {(((hoverInfo.c - hoverInfo.o) / hoverInfo.o) * 100).toFixed(2)}%</span>
              : <span className="text-red-400 font-bold">▼ {(((hoverInfo.o - hoverInfo.c) / hoverInfo.o) * 100).toFixed(2)}%</span>
            }
          </div>
        )}
      </div>

      {/* ── SUB INDICATOR CHART ── */}
      {subInd !== 'none' && (
        <div className="shrink-0 border-t" style={{ height: '130px', borderColor: col.grid }}>
          <div className="flex items-center gap-2 px-3 py-0.5 border-b" style={{ borderColor: col.grid, background: `${col.grid}30` }}>
            <span className="text-[10px] font-bold text-amber-400">{subLabel[subInd]}</span>
            {subInd === 'macd' && (
              <span className="text-[10px]" style={{ color: col.text, opacity: 0.5 }}>
                <span className="text-blue-400">— MACD</span> · <span className="text-amber-400">— Signal</span> · <span style={{ color: '#0ecb81' }}>▮ Hist</span>
              </span>
            )}
            {subInd === 'stoch' && (
              <span className="text-[10px]" style={{ color: col.text, opacity: 0.5 }}>
                <span className="text-blue-400">— %K</span> · <span className="text-amber-400">— %D</span>
              </span>
            )}
          </div>
          <div ref={subRef} className="w-full" style={{ height: '103px' }} />
        </div>
      )}

      {/* ── BOTTOM STATUS BAR ── */}
      <div className="px-3 py-1 border-t shrink-0 flex items-center justify-between" style={{ borderColor: col.grid }}>
        <span className="text-[10px]" style={{ color: col.text, opacity: 0.5 }}>
          {parts.base}/{parts.quote} · {INTERVALS.find(i => i.id === effectiveInterval)?.label ?? effectiveInterval}
          {autoInterval ? <span style={{ color: '#60a5fa' }}> · Auto</span> : null}
          {' '}· OrahDEX Sovereign Engine
        </span>
        <div className="flex items-center gap-2">
          {activeOverlays.size > 0 && (
            <span className="text-[10px] text-green-400/60">
              {[...activeOverlays].map(id => OVERLAY_INDICATORS.find(o => o.id === id)?.label).filter(Boolean).join(' · ')}
            </span>
          )}
          <span className="text-[10px] text-green-400/60 font-mono">BSV ⚡</span>
        </div>
      </div>

    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPORT
══════════════════════════════════════════════════════════════════════════ */
export function Chart({ symbol = 'BTC/USDT', interval = '1h', onIntervalChange, subIndicator, hideIntervalBar, data }: ChartProps) {
  return <OrahChart symbol={symbol} interval={interval} onIntervalChange={onIntervalChange} subIndicator={subIndicator} hideIntervalBar={hideIntervalBar} data={data} />;
}
