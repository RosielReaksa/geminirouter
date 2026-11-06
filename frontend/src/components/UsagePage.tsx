import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  BarChart3,
  Sparkles,
  Bot,
  Cpu,
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  Clock,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Activity,
  Zap,
  CheckCircle2,
  AlertCircle,
  Database,
  Users,
  Info,
} from 'lucide-react';
import { TrafficRecord, GoogleAccount, CacheStats } from '../types';
import { api } from '../services/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModelStats {
  id: string;
  requests: number;
  tokens: number;
  cachedTokens: number;
  errors: number;
  avgLatencyMs: number;
  successRate: number;
  lastUsed: number | null;
}

interface FamilyGroup {
  key: 'gemini' | 'claude' | 'gpt';
  label: string;
  tagline: string;
  icon: React.ElementType;
  // solid accent colors (hex) for inline styles
  accentColor: string;
  accentLight: string;
  accentBorder: string;
  badgeBg: string;
  badgeText: string;
  barColor: string;
  models: ModelStats[];
  totalRequests: number;
  totalTokens: number;
  totalCachedTokens: number;
  totalErrors: number;
  avgLatencyMs: number;
  successRate: number;
}

// ─── Capacity types ───────────────────────────────────────────────────────────

interface FamilyCapacity {
  family: 'gemini' | 'claude_gpt';
  label: string;
  icon: React.ElementType;
  barColor: string;
  accentLight: string;
  accentBorder: string;
  accentColor: string;
  // aggregated across all active accounts
  weeklyRemainingFraction: number;   // avg of remainingFraction across accounts (0-1)
  fiveHourRemainingFraction: number;
  tokensUsed7d: number;
  tokensLimit7d: number;
  activeAccounts: number;
  totalAccounts: number;
  throttledCount: number;           // models currently throttled across all accounts
  accountDetail: Array<{
    email: string;
    name: string;
    status: GoogleAccount['status'];
    weeklyFraction: number;
    fiveHourFraction: number;
  }>;
}

// Derive token capacity data from accounts list
function deriveCapacity(accounts: GoogleAccount[]): FamilyCapacity[] {
  const geminiAccounts: FamilyCapacity['accountDetail'] = [];
  const gpAccounts: FamilyCapacity['accountDetail'] = [];

  let geminiWeeklySum = 0, geminiWeeklyCount = 0;
  let gemini5hSum = 0, gemini5hCount = 0;
  let geminiTokensUsed = 0, geminiTokensLimit = 0;
  let geminiThrottled = 0;

  let gpWeeklySum = 0, gpWeeklyCount = 0;
  let gp5hSum = 0, gp5hCount = 0;
  let gpTokensUsed = 0, gpTokensLimit = 0;
  let gpThrottled = 0;

  for (const acc of accounts) {
    // Pull fractions from quotaGroups (the richest data source)
    const groups = acc.quotaGroups ?? [];
    let gWeekly: number | null = null, g5h: number | null = null;
    let pWeekly: number | null = null, p5h: number | null = null;

    for (const grp of groups) {
      const name = (grp.displayName ?? '').toLowerCase();
      const isGemini = name.includes('gemini');
      const is3p = /claude|gpt|3p/.test(name);
      for (const bucket of grp.buckets ?? []) {
        const frac = bucket.remainingFraction ?? 1;
        if (isGemini) {
          if (bucket.window === 'weekly') gWeekly = frac;
          if (bucket.window === '5h') g5h = frac;
        } else if (is3p) {
          if (bucket.window === 'weekly') pWeekly = frac;
          if (bucket.window === '5h') p5h = frac;
        }
      }
    }

    // Accumulate Gemini
    if (gWeekly !== null) { geminiWeeklySum += gWeekly; geminiWeeklyCount++; }
    if (g5h !== null) { gemini5hSum += g5h; gemini5hCount++; }

    // Accumulate 3p (Claude/GPT)
    if (pWeekly !== null) { gpWeeklySum += pWeekly; gpWeeklyCount++; }
    if (p5h !== null) { gp5hSum += p5h; gp5hCount++; }

    // Token sums from quotas[] (tokensIn7d / limitIn7d)
    for (const q of acc.quotas ?? []) {
      const mid = (q.modelId ?? '').toLowerCase();
      const isGeminiModel = !/(claude|gpt|oss|3p|sonnet|opus|haiku)/.test(mid);
      if (isGeminiModel) {
        geminiTokensUsed += q.tokensIn7d ?? 0;
        geminiTokensLimit += q.limitIn7d ?? 0;
        if (q.isThrottled) geminiThrottled++;
      } else {
        gpTokensUsed += q.tokensIn7d ?? 0;
        gpTokensLimit += q.limitIn7d ?? 0;
        if (q.isThrottled) gpThrottled++;
      }
    }

    // Per-account detail rows
    if (gWeekly !== null || g5h !== null) {
      geminiAccounts.push({
        email: acc.email,
        name: acc.name,
        status: acc.status,
        weeklyFraction: gWeekly ?? 1,
        fiveHourFraction: g5h ?? 1,
      });
    }
    if (pWeekly !== null || p5h !== null) {
      gpAccounts.push({
        email: acc.email,
        name: acc.name,
        status: acc.status,
        weeklyFraction: pWeekly ?? 1,
        fiveHourFraction: p5h ?? 1,
      });
    }
  }

  const result: FamilyCapacity[] = [];

  if (geminiWeeklyCount > 0 || geminiTokensLimit > 0) {
    result.push({
      family: 'gemini',
      label: 'Google Gemini',
      icon: Sparkles,
      barColor: '#3b82f6',
      accentLight: '#eff6ff',
      accentBorder: '#bfdbfe',
      accentColor: '#1d4ed8',
      weeklyRemainingFraction: geminiWeeklyCount > 0 ? geminiWeeklySum / geminiWeeklyCount : 1,
      fiveHourRemainingFraction: gemini5hCount > 0 ? gemini5hSum / gemini5hCount : 1,
      tokensUsed7d: geminiTokensUsed,
      tokensLimit7d: geminiTokensLimit,
      activeAccounts: geminiAccounts.filter((a) => a.status === 'active').length,
      totalAccounts: geminiAccounts.length,
      throttledCount: geminiThrottled,
      accountDetail: geminiAccounts,
    });
  }

  if (gpWeeklyCount > 0 || gpTokensLimit > 0) {
    result.push({
      family: 'claude_gpt',
      label: 'Claude & GPT',
      icon: Bot,
      barColor: '#f97316',
      accentLight: '#fff7ed',
      accentBorder: '#fed7aa',
      accentColor: '#c2410c',
      weeklyRemainingFraction: gpWeeklyCount > 0 ? gpWeeklySum / gpWeeklyCount : 1,
      fiveHourRemainingFraction: gp5hCount > 0 ? gp5hSum / gp5hCount : 1,
      tokensUsed7d: gpTokensUsed,
      tokensLimit7d: gpTokensLimit,
      activeAccounts: gpAccounts.filter((a) => a.status === 'active').length,
      totalAccounts: gpAccounts.length,
      throttledCount: gpThrottled,
      accountDetail: gpAccounts,
    });
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const formatTokens = (n: number): string => {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const formatLatency = (ms: number): string => {
  if (!ms || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const timeAgo = (ts: number | null): string => {
  if (!ts) return 'never';
  const delta = Math.floor((Date.now() - ts) / 1000);
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
};

const modelFamily = (id: string): 'gemini' | 'claude' | 'gpt' => {
  const lower = id.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('gpt') || lower.includes('oss')) return 'gpt';
  return 'gemini';
};

const shortModelName = (id: string): string =>
  id
    .replace(/^gemini-/, 'Gemini ')
    .replace(/^claude-/, 'Claude ')
    .replace(/^gpt-/, 'GPT ')
    .replace(/-(latest|exp|preview)(-\d+)?/gi, '')
    .replace(/-(flash|pro|ultra|opus|sonnet|haiku|lite|high|low|medium|image|thinking)/gi, ' $1')
    .replace(/-(\d)/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();

// ─── Family metadata ─────────────────────────────────────────────────────────

type FamilyKey = FamilyGroup['key'];
const FAMILY_META: Record<FamilyKey, Omit<FamilyGroup, 'models' | 'totalRequests' | 'totalTokens' | 'totalCachedTokens' | 'totalErrors' | 'avgLatencyMs' | 'successRate'>> = {
  gemini: {
    key: 'gemini',
    label: 'Google Gemini',
    tagline: 'Gemini 2.5 / 3.x · Flash · Pro · Ultra',
    icon: Sparkles,
    accentColor: '#1d4ed8',
    accentLight: '#eff6ff',
    accentBorder: '#bfdbfe',
    badgeBg: '#dbeafe',
    badgeText: '#1e40af',
    barColor: '#3b82f6',
  },
  claude: {
    key: 'claude',
    label: 'Anthropic Claude',
    tagline: 'Claude 3.x · Opus · Sonnet · Haiku',
    icon: Bot,
    accentColor: '#c2410c',
    accentLight: '#fff7ed',
    accentBorder: '#fed7aa',
    badgeBg: '#ffedd5',
    badgeText: '#9a3412',
    barColor: '#f97316',
  },
  gpt: {
    key: 'gpt',
    label: 'OpenAI-compatible',
    tagline: 'GPT-OSS and other compatible endpoints',
    icon: Cpu,
    accentColor: '#6d28d9',
    accentLight: '#f5f3ff',
    accentBorder: '#ddd6fe',
    badgeBg: '#ede9fe',
    badgeText: '#5b21b6',
    barColor: '#8b5cf6',
  },
};

function deriveGroups(records: TrafficRecord[]): FamilyGroup[] {
  const byModel = new Map<string, {
    requests: number; tokens: number; cachedTokens: number; errors: number;
    latencyTotal: number; latencyCount: number; lastUsed: number | null;
  }>();

  for (const rec of records) {
    const id = rec.modelRequested || rec.modelRouted || 'unknown';
    if (!id || id === 'unknown') continue;
    const e = byModel.get(id) ?? { requests: 0, tokens: 0, cachedTokens: 0, errors: 0, latencyTotal: 0, latencyCount: 0, lastUsed: null };
    e.requests += 1;
    e.tokens += rec.totalTokens || 0;
    e.cachedTokens += rec.cachedTokens ?? 0;
    if (rec.status >= 400) e.errors += 1;
    if (rec.latencyMs > 0) { e.latencyTotal += rec.latencyMs; e.latencyCount += 1; }
    const ts = Date.parse(rec.timestamp);
    if (Number.isFinite(ts) && (!e.lastUsed || ts > e.lastUsed)) e.lastUsed = ts;
    byModel.set(id, e);
  }

  const families: Record<FamilyKey, ModelStats[]> = { gemini: [], claude: [], gpt: [] };
  for (const [id, data] of byModel) {
    const fk = modelFamily(id);
    const avg = data.latencyCount > 0 ? Math.round(data.latencyTotal / data.latencyCount) : 0;
    const sr = data.requests > 0 ? Math.round(((data.requests - data.errors) / data.requests) * 100) : 100;
    families[fk].push({ id, requests: data.requests, tokens: data.tokens, cachedTokens: data.cachedTokens, errors: data.errors, avgLatencyMs: avg, successRate: sr, lastUsed: data.lastUsed });
  }
  for (const fk of Object.keys(families) as FamilyKey[]) families[fk].sort((a, b) => b.requests - a.requests);

  return (Object.keys(FAMILY_META) as FamilyKey[])
    .filter((fk) => families[fk].length > 0)
    .map((fk) => {
      const models = families[fk];
      const totalRequests = models.reduce((s, m) => s + m.requests, 0);
      const totalTokens = models.reduce((s, m) => s + m.tokens, 0);
      const totalCachedTokens = models.reduce((s, m) => s + m.cachedTokens, 0);
      const totalErrors = models.reduce((s, m) => s + m.errors, 0);
      const lm = models.filter((m) => m.avgLatencyMs > 0);
      const avgLatencyMs = lm.length > 0 ? Math.round(lm.reduce((s, m) => s + m.avgLatencyMs, 0) / lm.length) : 0;
      const successRate = totalRequests > 0 ? Math.round(((totalRequests - totalErrors) / totalRequests) * 100) : 100;
      return { ...FAMILY_META[fk], models, totalRequests, totalTokens, totalCachedTokens, totalErrors, avgLatencyMs, successRate };
    });
}

// ─── Stat pill ────────────────────────────────────────────────────────────────

// ─── Capacity Panel ───────────────────────────────────────────────────────────

const FractionBar: React.FC<{ value: number; color: string; height?: number }> = ({ value, color, height = 10 }) => {
  const pct = Math.round(Math.min(100, Math.max(0, value * 100)));
  const bgColor = pct <= 10 ? '#fee2e2' : pct <= 30 ? '#fef3c7' : '#f1f5f9';
  const fillColor = pct <= 10 ? '#ef4444' : pct <= 30 ? '#f59e0b' : color;
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height, background: bgColor }}>
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${pct}%`, background: fillColor }}
      />
    </div>
  );
};

const CapacityPanel: React.FC<{
  capacities: FamilyCapacity[];
  accountsLoading: boolean;
  accountCount: number;
}> = ({ capacities, accountsLoading, accountCount }) => {
  const [expanded, setExpanded] = useState(false);

  if (accountsLoading) {
    return (
      <div className="rounded-2xl border border-[#EAE5DE] bg-white shadow-sm px-6 py-5 flex items-center gap-3 text-stone-400">
        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
        <span className="text-sm">Loading token capacity from connected accounts…</span>
      </div>
    );
  }

  if (capacities.length === 0) {
    return (
      <div className="rounded-2xl border border-[#EAE5DE] bg-white shadow-sm px-6 py-5 flex items-center gap-3 text-stone-400">
        <Database className="w-4 h-4 shrink-0" />
        <span className="text-sm">No quota data available — connect accounts to see token capacity.</span>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[#EAE5DE] bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="w-full flex items-center gap-3 px-6 py-4 hover:bg-stone-50/60 transition-colors text-left"
      >
        <div className="w-9 h-9 rounded-xl bg-stone-100 flex items-center justify-center shrink-0">
          <Database className="w-4 h-4 text-stone-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-[#2A2723]">Token Capacity</div>
          <div className="text-[12px] text-stone-500 mt-0.5">
            Predicted remaining quota across {accountCount} connected account{accountCount !== 1 ? 's' : ''} · weekly window
          </div>
        </div>

        {/* Summary badges */}
        <div className="hidden sm:flex items-center gap-4 mr-2">
          {capacities.map((cap) => {
            const Icon = cap.icon;
            const pct = Math.round(cap.weeklyRemainingFraction * 100);
            const color = pct <= 10 ? '#ef4444' : pct <= 30 ? '#f59e0b' : cap.accentColor;
            return (
              <div key={cap.family} className="flex items-center gap-2 px-3 py-1.5 rounded-xl" style={{ background: cap.accentLight, border: `1px solid ${cap.accentBorder}` }}>
                <Icon style={{ width: 14, height: 14, color: cap.accentColor }} />
                <span className="text-[12px] font-medium" style={{ color: cap.accentColor }}>{cap.label}</span>
                <span className="text-sm font-bold font-mono" style={{ color }}>{pct}%</span>
                <span className="text-[11px] text-stone-400">left</span>
              </div>
            );
          })}
        </div>

        <div className="text-stone-400 ml-1 shrink-0">
          {expanded ? <ChevronDown style={{ width: 18, height: 18 }} /> : <ChevronRight style={{ width: 18, height: 18 }} />}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-stone-100">
          <div className="grid gap-px bg-stone-100" style={{ gridTemplateColumns: `repeat(${capacities.length}, 1fr)` }}>
            {capacities.map((cap) => {
              const Icon = cap.icon;
              const weeklyPct = Math.round(cap.weeklyRemainingFraction * 100);
              const fiveHPct = Math.round(cap.fiveHourRemainingFraction * 100);
              const tokensRemaining = Math.max(0, cap.tokensLimit7d - cap.tokensUsed7d);
              const tokenPct = cap.tokensLimit7d > 0 ? Math.round((tokensRemaining / cap.tokensLimit7d) * 100) : null;

              return (
                <div key={cap.family} className="bg-white px-6 py-5">
                  {/* Family header */}
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: cap.accentLight, border: `1.5px solid ${cap.accentBorder}` }}>
                      <Icon style={{ width: 16, height: 16, color: cap.accentColor }} />
                    </div>
                    <div>
                      <div className="text-sm font-bold" style={{ color: cap.accentColor }}>{cap.label}</div>
                      <div className="text-[11px] text-stone-400 flex items-center gap-1.5">
                        <Users style={{ width: 10, height: 10 }} />
                        {cap.activeAccounts} active / {cap.totalAccounts} accounts
                        {cap.throttledCount > 0 && (
                          <span className="ml-1 text-amber-500 font-medium">· {cap.throttledCount} throttled</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Weekly quota bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">Weekly Remaining</span>
                      <span className="text-sm font-bold font-mono" style={{ color: weeklyPct <= 10 ? '#ef4444' : weeklyPct <= 30 ? '#f59e0b' : cap.accentColor }}>
                        {weeklyPct}%
                      </span>
                    </div>
                    <FractionBar value={cap.weeklyRemainingFraction} color={cap.barColor} height={10} />
                    <div className="text-[11px] text-stone-400 mt-1">avg across all accounts</div>
                  </div>

                  {/* 5-hour quota bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">5-Hour Window</span>
                      <span className="text-sm font-bold font-mono" style={{ color: fiveHPct <= 10 ? '#ef4444' : fiveHPct <= 30 ? '#f59e0b' : cap.accentColor }}>
                        {fiveHPct}%
                      </span>
                    </div>
                    <FractionBar value={cap.fiveHourRemainingFraction} color={cap.barColor} height={8} />
                  </div>

                  {/* Token estimate */}
                  {cap.tokensLimit7d > 0 && (
                    <div className="mb-4 p-3 rounded-xl" style={{ background: cap.accentLight, border: `1px solid ${cap.accentBorder}` }}>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-1">Token Budget (7d)</div>
                      <div className="text-lg font-bold font-mono" style={{ color: cap.accentColor }}>
                        ~{formatTokens(tokensRemaining)} remaining
                      </div>
                      <div className="text-[11px] text-stone-400 mt-0.5">
                        {formatTokens(cap.tokensUsed7d)} used of {formatTokens(cap.tokensLimit7d)} total
                        {tokenPct !== null && ` · ${tokenPct}% left`}
                      </div>
                      {cap.tokensLimit7d > 0 && (
                        <div className="mt-2">
                          <FractionBar value={tokensRemaining / cap.tokensLimit7d} color={cap.barColor} height={6} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Per-account breakdown */}
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-2">Account Breakdown</div>
                    {cap.accountDetail.map((acc) => {
                      const wPct = Math.round(acc.weeklyFraction * 100);
                      const hPct = Math.round(acc.fiveHourFraction * 100);
                      const isErr = acc.status === 'error' || acc.status === 'cooldown';
                      return (
                        <div key={acc.email} className="flex items-center gap-3 py-2 border-b border-stone-50 last:border-0">
                          {/* Avatar initials */}
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                            style={{ background: cap.accentLight, color: cap.accentColor, border: `1px solid ${cap.accentBorder}` }}
                          >
                            {acc.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] font-medium text-[#2A2723] truncate">{acc.name}</div>
                            <div className="text-[10px] text-stone-400 truncate">{acc.email}</div>
                          </div>
                          {/* Status */}
                          <div className="text-right shrink-0">
                            {isErr ? (
                              <span className="text-[11px] font-semibold text-red-500 capitalize">{acc.status}</span>
                            ) : (
                              <div className="flex flex-col items-end gap-0.5">
                                <span className="text-[11px] font-bold font-mono" style={{ color: wPct <= 10 ? '#ef4444' : wPct <= 30 ? '#f59e0b' : cap.accentColor }}>
                                  {wPct}% wk
                                </span>
                                <span className="text-[10px] text-stone-400">{hPct}% 5h</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer note */}
          <div className="flex items-start gap-2 px-6 py-3 bg-stone-50 border-t border-stone-100">
            <Info className="w-3.5 h-3.5 text-stone-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-stone-400 leading-relaxed">
              Remaining fractions are sourced live from the core quota snapshots per account.
              Token budget is estimated from <code className="text-[10px] bg-stone-100 px-1 rounded">tokensIn7d</code> / <code className="text-[10px] bg-stone-100 px-1 rounded">limitIn7d</code> per model quota entry and summed across all accounts.
              Actual capacity may vary — Google resets windows on a rolling basis.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Stat pill ────────────────────────────────────────────────────────────────

const StatPill: React.FC<{ label: string; value: React.ReactNode; dim?: boolean }> = ({ label, value, dim }) => (
  <div className="flex flex-col items-end">
    <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400 mb-0.5 leading-none">{label}</span>
    <span className={`text-sm font-bold font-mono leading-tight ${dim ? 'text-stone-400' : 'text-[#2A2723]'}`}>{value}</span>
  </div>
);

// ─── Model row ────────────────────────────────────────────────────────────────

const ModelRow: React.FC<{
  model: ModelStats;
  rank: number;
  maxRequests: number;
  barColor: string;
  accentBorder: string;
}> = ({ model, rank, maxRequests, barColor, accentBorder }) => {
  const pct = maxRequests > 0 ? (model.requests / maxRequests) * 100 : 0;
  const srOk = model.successRate >= 95;
  const srWarn = model.successRate >= 80;
  const inputTokens = model.tokens + model.cachedTokens;
  const cachePct = inputTokens > 0 ? Math.round((model.cachedTokens / inputTokens) * 100) : 0;

  return (
    <div
      className="grid gap-x-4 items-center px-6 py-4 border-b border-stone-100 last:border-0 hover:bg-stone-50/70 transition-colors"
      style={{ gridTemplateColumns: 'minmax(0,1fr) 110px 110px 110px 90px 100px 80px' }}
    >
      {/* Model name + bar */}
      <div className="min-w-0 pr-2">
        <div className="flex items-center gap-2 mb-2">
          <span
            className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0"
            style={{ background: accentBorder, color: barColor }}
          >
            {rank}
          </span>
          <span className="text-sm font-semibold text-[#2A2723] truncate" title={model.id}>
            {shortModelName(model.id)}
          </span>
        </div>
        {/* Request bar */}
        <div className="w-full h-2 rounded-full bg-stone-100 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: barColor }}
          />
        </div>
      </div>

      {/* Requests */}
      <div className="text-right">
        <div className="text-base font-bold font-mono text-[#2A2723]">{model.requests.toLocaleString()}</div>
        <div className="text-[11px] text-stone-400 mt-0.5">{Math.round(pct)}% of family</div>
      </div>

      {/* Tokens */}
      <div className="text-right">
        <div className="text-sm font-semibold font-mono text-[#2A2723]">{formatTokens(model.tokens)}</div>
        <div className="text-[11px] text-stone-400 mt-0.5">tokens</div>
      </div>

      {/* Cached tokens */}
      <div className="text-right">
        {model.cachedTokens > 0 ? (
          <>
            <div className="text-sm font-semibold font-mono text-[#1d4ed8]">{formatTokens(model.cachedTokens)}</div>
            <div className="text-[11px] text-stone-400 mt-0.5">cached ({cachePct}%)</div>
          </>
        ) : (
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-[11px] text-stone-300">—</span>
            <div className="text-[10px] text-stone-400">no cache</div>
          </div>
        )}
      </div>

      {/* Errors */}
      <div className="text-right">
        {model.errors > 0 ? (
          <>
            <div className="text-sm font-bold font-mono text-red-500">{model.errors}</div>
            <div className="text-[11px] text-red-400 mt-0.5">errors</div>
          </>
        ) : (
          <div className="flex flex-col items-end gap-0.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <div className="text-[11px] text-stone-300">clean</div>
          </div>
        )}
      </div>

      {/* Avg latency */}
      <div className="text-right">
        <div className="text-sm font-semibold font-mono text-[#2A2723]">{formatLatency(model.avgLatencyMs)}</div>
        <div className="text-[11px] text-stone-400 mt-0.5">avg latency</div>
      </div>

      {/* Success rate */}
      <div className="text-right">
        <div className={`text-base font-bold font-mono ${srOk ? 'text-emerald-600' : srWarn ? 'text-amber-500' : 'text-red-500'}`}>
          {model.successRate}%
        </div>
        <div className={`text-[11px] mt-0.5 ${srOk ? 'text-emerald-400' : srWarn ? 'text-amber-400' : 'text-red-400'}`}>
          {srOk ? 'healthy' : srWarn ? 'degraded' : 'poor'}
        </div>
      </div>
    </div>
  );
};

// ─── Family card ─────────────────────────────────────────────────────────────

const FamilyCard: React.FC<{ group: FamilyGroup; defaultExpanded?: boolean }> = ({ group, defaultExpanded = true }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const Icon = group.icon;
  const srOk = group.successRate >= 95;
  const srWarn = group.successRate >= 80;
  const TrendIcon = srOk ? TrendingUp : srWarn ? Minus : TrendingDown;
  const srColor = srOk ? '#059669' : srWarn ? '#d97706' : '#dc2626';

  return (
    <div
      className="rounded-2xl bg-white shadow-sm overflow-hidden"
      style={{ border: `1.5px solid ${group.accentBorder}` }}
    >
      {/* ── Header (clickable) ── */}
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="w-full text-left"
        style={{ background: group.accentLight }}
      >
        <div className="flex items-center gap-4 px-6 py-5">
          {/* Icon badge */}
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
            style={{ background: group.badgeBg, border: `1.5px solid ${group.accentBorder}` }}
          >
            <Icon style={{ width: 22, height: 22, color: group.accentColor }} />
          </div>

          {/* Label */}
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold" style={{ color: group.accentColor }}>{group.label}</div>
            <div className="text-[13px] text-stone-500 mt-0.5 truncate">{group.tagline}</div>
          </div>

          {/* Stats row — hidden on small screens */}
          <div className="hidden md:flex items-center gap-6 mr-2">
            <StatPill label="Requests" value={group.totalRequests.toLocaleString()} />
            <StatPill label="Tokens" value={formatTokens(group.totalTokens)} />
            {group.totalCachedTokens > 0 && (
              <StatPill label="Cached" value={formatTokens(group.totalCachedTokens)} dim />
            )}
            <StatPill label="Errors" value={group.totalErrors > 0 ? <span style={{ color: '#dc2626' }}>{group.totalErrors}</span> : '—'} />
            <StatPill label="Avg Latency" value={formatLatency(group.avgLatencyMs)} />
            <div className="flex flex-col items-end">
              <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400 mb-0.5 leading-none">Success</span>
              <span className="text-sm font-bold font-mono flex items-center gap-1" style={{ color: srColor }}>
                <TrendIcon style={{ width: 14, height: 14 }} />
                {group.successRate}%
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400 mb-0.5 leading-none">Models</span>
              <span className="text-sm font-bold font-mono text-[#2A2723]">{group.models.length}</span>
            </div>
          </div>

          {/* Expand chevron */}
          <div className="text-stone-400 ml-1 shrink-0">
            {expanded
              ? <ChevronDown style={{ width: 20, height: 20 }} />
              : <ChevronRight style={{ width: 20, height: 20 }} />}
          </div>
        </div>

        {/* Mobile stats strip */}
        <div
          className="md:hidden flex items-center gap-5 px-6 pb-4 text-sm flex-wrap"
        >
          <span className="text-stone-500"><strong className="text-[#2A2723] font-mono">{group.totalRequests.toLocaleString()}</strong> req</span>
          <span className="text-stone-500"><strong className="text-[#2A2723] font-mono">{formatTokens(group.totalTokens)}</strong> tok</span>
          {group.totalCachedTokens > 0 && (
            <span className="text-stone-500"><strong className="text-[#1d4ed8] font-mono">{formatTokens(group.totalCachedTokens)}</strong> cached</span>
          )}
          <span className="font-mono font-bold" style={{ color: srColor }}>{group.successRate}% ok</span>
        </div>
      </button>

      {/* ── Model table ── */}
      {expanded && (
        <>
          {/* Table column headers */}
          <div
            className="grid gap-x-4 px-6 py-3 border-b border-stone-100"
            style={{
              gridTemplateColumns: 'minmax(0,1fr) 110px 110px 110px 90px 100px 80px',
              background: '#fafaf9',
            }}
          >
            {(['Model', 'Requests', 'Tokens', 'Cached', 'Errors', 'Avg Latency', 'OK %'] as const).map((h, i) => (
              <div key={h} className={`text-xs font-bold uppercase tracking-widest text-stone-400 ${i > 0 ? 'text-right' : ''}`}>
                {h}
              </div>
            ))}
          </div>

          {/* Model rows */}
          {group.models.map((m, idx) => (
            <ModelRow
              key={m.id}
              model={m}
              rank={idx + 1}
              maxRequests={group.models[0]?.requests ?? 1}
              barColor={group.barColor}
              accentBorder={group.accentBorder}
            />
          ))}
        </>
      )}
    </div>
  );
};

// ─── Summary panel ────────────────────────────────────────────────────────────

const SummaryPanel: React.FC<{
  groups: FamilyGroup[];
  cacheStats: CacheStats | null;
  isLive: boolean;
  refreshedAt: Date | null;
  onRefresh: () => void;
  refreshing: boolean;
  windowLabel: string;
}> = ({ groups, cacheStats, isLive, refreshedAt, onRefresh, refreshing, windowLabel }) => {
  const totalReq = groups.reduce((s, g) => s + g.totalRequests, 0);
  const totalTok = groups.reduce((s, g) => s + g.totalTokens, 0);
  const totalCached = groups.reduce((s, g) => s + g.totalCachedTokens, 0);
  const totalErr = groups.reduce((s, g) => s + g.totalErrors, 0);
  const overallSR = totalReq > 0 ? Math.round(((totalReq - totalErr) / totalReq) * 100) : 100;

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="rounded-2xl border border-[#EAE5DE] bg-white shadow-sm overflow-hidden">
      {/* Top row: global numbers + refresh */}
      <div className="flex flex-wrap items-start gap-6 px-6 pt-5 pb-4">
        {/* KPI tiles */}
        <div className="flex flex-wrap gap-8 flex-1 min-w-0">
          {[
            { label: 'Total Requests', value: totalReq.toLocaleString(), color: '#2A2723' },
            { label: 'Total Tokens', value: formatTokens(totalTok), color: '#2A2723' },
            totalCached > 0
              ? {
                  label: 'Cache Savings',
                  value: `${formatTokens(totalCached)} (${Math.round((totalCached / (totalTok + totalCached)) * 100)}%)`,
                  color: '#1d4ed8',
                }
              : { label: 'Cache Savings', value: '—', color: '#706B65' },
            { label: 'Total Errors', value: totalErr.toLocaleString(), color: totalErr > 0 ? '#dc2626' : '#2A2723' },
            {
              label: 'Success Rate',
              value: `${overallSR}%`,
              color: overallSR >= 95 ? '#059669' : overallSR >= 80 ? '#d97706' : '#dc2626',
            },
            { label: 'Families Active', value: String(groups.length), color: '#2A2723' },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-400 mb-1">{label}</div>
              <div className="text-2xl font-bold font-mono" style={{ color }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Right: live badge + refresh */}
        <div className="flex items-start gap-3 shrink-0 pt-1">
          <div className="text-right">
            <div className="flex items-center justify-end gap-1.5 text-[12px]">
              {isLive ? (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-emerald-600 font-semibold">Live</span>
                </>
              ) : (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-stone-300" />
                  <span className="text-stone-500">Demo</span>
                </>
              )}
            </div>
            <div className="text-[11px] text-stone-400 mt-1 flex items-center justify-end gap-1">
              <Clock style={{ width: 11, height: 11 }} />
              <span>Last {windowLabel}</span>
              {refreshedAt && <span>· {timeAgo(refreshedAt.getTime())}</span>}
            </div>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#EAE5DE] text-sm font-medium text-[#706B65] hover:bg-[#F2ECE4] hover:text-[#2A2723] transition-colors disabled:opacity-40"
          >
            {refreshing
              ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
              : <RefreshCw style={{ width: 14, height: 14 }} />}
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Stacked share bar */}
      {totalReq > 0 && (
        <div className="px-6 pb-5">
          <div className="flex h-3 rounded-full overflow-hidden gap-0.5 mb-3">
            {groups.map((g) => (
              <div
                key={g.key}
                className="transition-all duration-700 first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(g.totalRequests / totalReq) * 100}%`,
                  background: g.barColor,
                }}
                title={`${g.label}: ${g.totalRequests} requests (${Math.round((g.totalRequests / totalReq) * 100)}%)`}
              />
            ))}
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-5">
            {groups.map((g) => (
              <div key={g.key} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: g.barColor }} />
                <span className="text-[12px] text-stone-500">{g.label}</span>
                <span className="text-[12px] font-bold font-mono" style={{ color: g.barColor }}>
                  {g.totalRequests.toLocaleString()}
                </span>
                <span className="text-[11px] text-stone-400">
                  ({Math.round((g.totalRequests / totalReq) * 100)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Time-range picker ────────────────────────────────────────────────────────

type TimeWindow = '1h' | '6h' | '24h' | '7d';
const TIME_WINDOWS: { label: string; key: TimeWindow; ms: number }[] = [
  { label: '1 h', key: '1h', ms: 60 * 60 * 1000 },
  { label: '6 h', key: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24 h', key: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7 d', key: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

// ─── Main page ────────────────────────────────────────────────────────────────

interface UsagePageProps {
  onReady?: () => void;
}

export const UsagePage: React.FC<UsagePageProps> = ({ onReady }) => {
  const [window_, setWindow] = useState<TimeWindow>('24h');
  const [records, setRecords] = useState<TrafficRecord[]>([]);
  const [groups, setGroups] = useState<FamilyGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Capacity state — fetched from accounts API
  const [capacities, setCapacities] = useState<FamilyCapacity[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountCount, setAccountCount] = useState(0);
  // Cache stats — fetched from core audit SQLite via /api/usage/cache
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const onReadyRef = useRef(onReady);
  const activeRef = useRef(true);
  const pollingRef = useRef(false);

  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  // Fetch accounts for capacity data — once on mount, then every 60 s
  const fetchAccounts = useCallback(async () => {
    try {
      const result = await api.getAccounts();
      if (!activeRef.current) return;
      const accounts = Array.isArray(result.data) ? result.data : [];
      setAccountCount(accounts.length);
      setCapacities(deriveCapacity(accounts));
    } catch {
      // silent — capacity panel shows "no data" state
    } finally {
      if (activeRef.current) setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAccounts();
    const t = setInterval(() => void fetchAccounts(), 60_000);
    return () => clearInterval(t);
  }, [fetchAccounts]);

  const windowMs = TIME_WINDOWS.find((w) => w.key === window_)?.ms ?? 24 * 60 * 60 * 1000;
  const windowLabel = TIME_WINDOWS.find((w) => w.key === window_)?.label ?? '24 h';

  const fetchData = useCallback(async (silent = false) => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);

    try {
      const now = Date.now();
      const from = now - windowMs;
      const [trafficResult, cacheResult] = await Promise.all([
        api.getTraffic({ from, to: now }),
        api.getCacheStats({ from, to: now }),
      ]);
      if (!activeRef.current) return;
      setIsLive(trafficResult.isLiveApi);
      const data = Array.isArray(trafficResult.data) ? trafficResult.data : [];
      const filtered = data.filter((r) => {
        const ts = Date.parse(r.timestamp);
        return Number.isFinite(ts) && ts >= from && ts <= now;
      });
      setRecords(filtered);
      setGroups(deriveGroups(filtered));
      setCacheStats(cacheResult.data.available ? cacheResult.data : null);
      setRefreshedAt(new Date());
    } catch (err: any) {
      if (activeRef.current) setError(err?.message || 'Failed to load usage data.');
    } finally {
      if (activeRef.current) {
        setLoading(false);
        setRefreshing(false);
        onReadyRef.current?.();
      }
      pollingRef.current = false;
    }
  }, [windowMs]);

  // Initial load + re-load when window changes
  useEffect(() => {
    activeRef.current = true;
    void fetchData(false);
    return () => { activeRef.current = false; };
  }, [fetchData]);

  // 15-second polling, paused when tab hidden
  useEffect(() => {
    let timer: number | null = null;
    const schedule = () => {
      if (document.visibilityState === 'visible') {
        timer = window.setTimeout(() => { void fetchData(true).then(schedule); }, 15_000);
      }
    };
    const onVisible = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState === 'visible') void fetchData(true).then(schedule);
    };
    document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => {
      activeRef.current = false;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchData]);

  const handleRefresh = () => void fetchData(true);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Page heading + time picker */}
      <div className="flex flex-wrap items-start gap-4 justify-between">
        <div>
          <h1 className="font-serif-editorial text-2xl font-bold text-[#2A2723] flex items-center gap-2.5">
            <BarChart3 className="w-6 h-6 text-[#C25938]" />
            Model Usage
          </h1>
          <p className="text-sm text-[#706B65] mt-1">
            Requests &amp; tokens grouped by model family · prompt-cache savings visible · refreshes every 15 s
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Live indicator */}
          {isLive && !loading && (
            <div className="flex items-center gap-1.5 text-[12px] text-emerald-600 font-medium px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-xl">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </div>
          )}

          {/* Time window pills */}
          <div className="flex items-center gap-1 bg-stone-100 p-1 rounded-xl">
            {TIME_WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                onClick={() => setWindow(w.key)}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  window_ === w.key
                    ? 'bg-white text-[#C25938] shadow-sm border border-[#EAE5DE]'
                    : 'text-stone-500 hover:text-[#2A2723]'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Token Capacity Panel — always shown, independent of traffic data */}
      <CapacityPanel
        capacities={capacities}
        accountsLoading={accountsLoading}
        accountCount={accountCount}
      />

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-stone-400">
          <Loader2 className="w-9 h-9 animate-spin" />
          <span className="text-sm font-medium">Loading usage data…</span>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-8 py-10 text-center">
          <XCircle className="w-12 h-12 text-red-300 mx-auto mb-4" />
          <p className="text-sm font-semibold text-red-700 mb-1">Failed to load usage data</p>
          <p className="text-xs text-red-500 mb-4">{error}</p>
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-red-100 text-red-700 text-sm font-medium hover:bg-red-200 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Try again
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && groups.length === 0 && (
        <div className="rounded-2xl border border-[#EAE5DE] bg-white px-8 py-20 text-center">
          <Activity className="w-14 h-14 text-stone-200 mx-auto mb-5" />
          <p className="text-base font-bold text-[#2A2723] mb-2">No requests in the last {windowLabel}</p>
          <p className="text-sm text-stone-400 mb-6 max-w-sm mx-auto">
            Usage data appears here as soon as the gateway serves its first request.
            Try a wider time window or check the Traffic Monitor.
          </p>
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-[#EAE5DE] text-sm font-medium text-[#706B65] hover:bg-[#F2ECE4] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      )}

      {/* Summary + family cards */}
      {!loading && !error && groups.length > 0 && (
        <>
          <SummaryPanel
            groups={groups}
            cacheStats={cacheStats}
            isLive={isLive}
            refreshedAt={refreshedAt}
            onRefresh={handleRefresh}
            refreshing={refreshing}
            windowLabel={windowLabel}
          />

          <div className="space-y-4">
            {groups.map((group, i) => (
              <FamilyCard key={group.key} group={group} defaultExpanded={i === 0} />
            ))}
          </div>

          <p className="text-center text-xs text-stone-400 pb-4">
            Showing <strong>{records.length.toLocaleString()}</strong> request{records.length !== 1 ? 's' : ''} in the last {windowLabel}.
            {isLive ? ' Sourced live from gateway audit log.' : ' Running in demo mode.'}
          </p>
        </>
      )}
    </div>
  );
};

export default UsagePage;
