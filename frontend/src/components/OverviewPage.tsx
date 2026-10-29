import React, { useEffect, useState } from 'react';
import {
  Activity,
  Users,
  Clock,
  ArrowUpRight,
  Sparkles,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
  Server,
  Gauge,
  Layers,
  Radio,
  Cpu,
  Zap,
  CircleDot,
  AlertTriangle,
} from 'lucide-react';
import { GatewayStatus, GoogleAccount, TrafficRecord, ModelsResponse } from '../types';
import { api } from '../services/api';

interface OverviewPageProps {
  status: GatewayStatus;
  accounts: GoogleAccount[];
  traffic: TrafficRecord[];
  onNavigateToAccounts: () => void;
  onNavigateToGateway: () => void;
  onNavigateToModels: () => void;
  onNavigateToTraffic: () => void;
}

const formatUptime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const formatTokens = (n: number): string => {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const timeAgo = (value?: string | number): string => {
  if (value === undefined || value === null || value === '') return 'never';
  let ts: number;
  if (typeof value === 'number') {
    // Core reports last_used as unix SECONDS; tolerate ms too.
    ts = value > 1e12 ? value : value * 1000;
  } else {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(value).trim() !== '') {
      ts = numeric > 1e12 ? numeric : numeric * 1000;
    } else {
      ts = Date.parse(value);
    }
  }
  if (!Number.isFinite(ts)) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
};

const quotaColor = (remaining: number): string => {
  if (remaining <= 0) return 'text-red-600';
  if (remaining < 25) return 'text-amber-600';
  return 'text-[#4E7B62]';
};

const quotaBar = (remaining: number): string => {
  if (remaining <= 0) return 'bg-red-400';
  if (remaining < 25) return 'bg-amber-400';
  if (remaining < 60) return 'bg-[#C25938]';
  return 'bg-[#4E7B62]';
};

const statusDot = (status: string): string => {
  if (status === 'active') return 'bg-emerald-500';
  if (status === 'error') return 'bg-red-500';
  if (status === 'cooldown') return 'bg-amber-500';
  return 'bg-stone-300';
};

/** Google avatar with a graceful initials fallback when the image fails. */
const AccountAvatar: React.FC<{ name: string; email: string; avatarUrl?: string }> = ({
  name,
  email,
  avatarUrl,
}) => {
  const [failed, setFailed] = useState(false);
  const initial = (name || email || '?')[0]?.toUpperCase();

  if (!avatarUrl || failed) {
    return (
      <div className="w-10 h-10 rounded-full bg-[#F2ECE4] flex items-center justify-center font-serif-editorial text-base text-[#C25938]">
        {initial}
      </div>
    );
  }

  return (
    <img
      src={avatarUrl}
      alt={name}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      className="w-10 h-10 rounded-full border border-[#EAE5DE] object-cover"
    />
  );
};

export const OverviewPage: React.FC<OverviewPageProps> = ({
  status,
  accounts,
  traffic,
  onNavigateToAccounts,
  onNavigateToGateway,
  onNavigateToModels,
  onNavigateToTraffic,
}) => {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [modelError, setModelError] = useState(false);

  // Load the live model catalog so the overview shows what the gateway serves.
  useEffect(() => {
    let cancelled = false;
    api
      .getModels()
      .then((res) => {
        if (!cancelled) setModels(res.data);
      })
      .catch(() => {
        if (!cancelled) setModelError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeAccounts = accounts.filter((a) => a.status === 'active');
  const blockedAccounts = accounts.filter((a) => a.status === 'error');
  const verifyAccounts = accounts.filter((a) => a.hasValidationLink);
  const primary = accounts.find((a) => a.isDefaultRouting) || activeAccounts[0];

  // Pool quota: the core reports percentage as REMAINING. Average across every
  // model the accounts advertise so the number reflects the whole pool.
  const allRemaining: number[] = [];
  for (const a of accounts) {
    for (const m of a.models5h || []) {
      if (typeof m.percentage === 'number') allRemaining.push(m.percentage);
    }
  }
  const poolRemaining =
    allRemaining.length > 0
      ? Math.round(allRemaining.reduce((s, v) => s + v, 0) / allRemaining.length)
      : null;
  const poolUsed = poolRemaining === null ? null : 100 - poolRemaining;

  const liveModelCount = models?.models?.filter((m) => m.live).length ?? 0;
  const totalModelCount = models?.models?.length ?? 0;

  const recent = traffic.slice(0, 6);
  const errorCount24h = traffic.filter((t) => t.status >= 400).length;

  // Requests per hour for the last 12 hours, derived from real records only.
  const hourly = React.useMemo(() => {
    const now = Date.now();
    const buckets = Array.from({ length: 12 }, () => 0);
    for (const t of traffic) {
      const ts = Date.parse(t.timestamp);
      if (!Number.isFinite(ts)) continue;
      const hoursAgo = Math.floor((now - ts) / 3_600_000);
      if (hoursAgo >= 0 && hoursAgo < 12) buckets[11 - hoursAgo] += 1;
    }
    return buckets;
  }, [traffic]);
  const hourlyMax = Math.max(1, ...hourly);

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* ============ Hero: system status ============ */}
      <div className="bg-gradient-to-r from-[#FAF2EF] to-[#FBF9F5] border border-[#EAE5DE] rounded-3xl p-7 relative overflow-hidden shadow-soft">
        <div className="relative z-10">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/80 border border-[#EAE5DE] text-[11px] font-medium text-[#C25938]">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Private Google AI Studio &amp; Gemini Relay</span>
            </div>
            <div
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                status.isRunning
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${status.isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
              <span>{status.isRunning ? 'Always-On · Serving' : 'Reconnecting'}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-serif-editorial text-3xl sm:text-4xl font-semibold text-[#2A2723] leading-tight">
                Everything, at a glance.
              </h2>
              <p className="text-sm text-[#706B65] mt-2 leading-relaxed font-sans-ui max-w-xl">
                Live state of the gateway, the account pool, per-model quota and the request
                stream. The gateway is always on — there is nothing to start or pause.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={onNavigateToGateway}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#C25938] hover:bg-[#B24E2E] text-white text-xs font-semibold shadow-soft transition-colors"
              >
                <span>API Keys &amp; Endpoints</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onNavigateToModels}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#FFFFFF] border border-[#EAE5DE] hover:bg-[#FAF7F2] text-xs font-medium text-[#2A2723] shadow-soft transition-colors"
              >
                <Layers className="w-3.5 h-3.5 text-[#706B65]" />
                <span>Browse Models</span>
              </button>
            </div>
          </div>
        </div>

        <div className="absolute right-6 -bottom-8 opacity-5 select-none pointer-events-none hidden md:block">
          <span className="font-serif-editorial text-[180px] font-bold text-[#C25938]">g</span>
        </div>
      </div>

      {/* ============ Primary metric row ============ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-5 shadow-soft">
          <div className="flex items-center justify-between text-xs text-[#706B65] mb-2 font-medium">
            <span>Gateway</span>
            <Server className="w-4 h-4 text-[#C25938]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-editorial text-3xl font-bold text-[#2A2723]">
              {status.isRunning ? 'Live' : 'Down'}
            </span>
            <span className="text-xs text-[#706B65]">:{status.port}</span>
          </div>
          <div className="text-[11px] text-[#9E988F] font-mono-code mt-2 flex items-center justify-between">
            <span>Up {formatUptime(status.uptimeSeconds)}</span>
            <span className={status.coreConnected ? 'text-[#4E7B62]' : 'text-amber-600'}>
              {status.coreConnected ? 'Core linked' : 'Core offline'}
            </span>
          </div>
        </div>

        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-5 shadow-soft">
          <div className="flex items-center justify-between text-xs text-[#706B65] mb-2 font-medium">
            <span>Accounts</span>
            <Users className="w-4 h-4 text-[#C25938]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-editorial text-3xl font-bold text-[#2A2723]">
              {activeAccounts.length}
            </span>
            <span className="text-xs text-[#706B65]">of {accounts.length} usable</span>
          </div>
          <div className="text-[11px] mt-2 flex items-center justify-between">
            <span className="text-[#9E988F] font-mono-code">
              {status.totalInFlight ?? 0}/{status.totalCapacity ?? 0} in flight
            </span>
            <button onClick={onNavigateToAccounts} className="text-[#C25938] hover:underline font-medium">
              Manage
            </button>
          </div>
        </div>

        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-5 shadow-soft">
          <div className="flex items-center justify-between text-xs text-[#706B65] mb-2 font-medium">
            <span>24h Throughput</span>
            <Activity className="w-4 h-4 text-[#C25938]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-editorial text-3xl font-bold text-[#2A2723]">
              {status.requestsLast24h.toLocaleString()}
            </span>
            <span className="text-xs text-[#706B65]">reqs</span>
          </div>
          <div className="text-[11px] text-[#9E988F] font-mono-code mt-2 flex items-center justify-between">
            <span>{formatTokens(status.tokensLast24h)} tokens</span>
            <span>
              {status.averageLatencyMs === null ? '—' : `${status.averageLatencyMs}ms avg`}
            </span>
          </div>
        </div>

        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-5 shadow-soft">
          <div className="flex items-center justify-between text-xs text-[#706B65] mb-2 font-medium">
            <span>Pool Quota Left</span>
            <Gauge className="w-4 h-4 text-[#C25938]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-editorial text-3xl font-bold text-[#2A2723]">
              {poolRemaining === null ? '—' : `${poolRemaining}%`}
            </span>
            <span className="text-xs text-[#706B65]">remaining</span>
          </div>
          <div className="w-full bg-[#F2ECE4] h-1.5 rounded-full overflow-hidden mt-2.5">
            <div
              className={`h-full rounded-full transition-all ${
                poolRemaining === null ? 'bg-stone-300' : quotaBar(poolRemaining)
              }`}
              style={{ width: `${poolRemaining === null ? 0 : Math.min(100, Math.max(0, poolRemaining))}%` }}
            />
          </div>
          <div className="text-[11px] text-[#9E988F] mt-1.5 flex justify-between">
            <span>{poolUsed === null ? 'no quota data' : `${poolUsed}% consumed`}</span>
            <span>{allRemaining.length} model meters</span>
          </div>
        </div>
      </div>

      {/* ============ Alerts (only when real problems exist) ============ */}
      {(verifyAccounts.length > 0 || blockedAccounts.length > 0) && (
        <div className="bg-[#FFFBF2] border border-[#F2E2C4] rounded-2xl p-5 shadow-soft">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-[#2A2723]">
                {verifyAccounts.length > 0
                  ? `${verifyAccounts.length} account${verifyAccounts.length > 1 ? 's' : ''} need Google verification`
                  : `${blockedAccounts.length} account${blockedAccounts.length > 1 ? 's' : ''} unavailable`}
              </h3>
              <div className="mt-2 space-y-1.5">
                {(verifyAccounts.length > 0 ? verifyAccounts : blockedAccounts).map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                    <span className="font-mono-code text-[#504C46]">{a.email}</span>
                    <span className="text-[#9E988F]">
                      {a.statusReason || 'requires verification'}
                    </span>
                  </div>
                ))}
              </div>
              <button
                onClick={onNavigateToAccounts}
                className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-[#C25938] hover:underline"
              >
                Fix in Accounts
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Account pool ============ */}
      <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl shadow-soft overflow-hidden">
        <div className="px-6 pt-5 pb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#EAE5DE]">
          <div>
            <h3 className="font-serif-editorial text-xl font-bold text-[#2A2723]">Account Pool</h3>
            <p className="text-xs text-[#706B65] mt-0.5">
              Every connected Google account, its live quota and test state
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono-code text-[#9E988F]">
              {activeAccounts.length} serving
              {blockedAccounts.length > 0 ? ` · ${blockedAccounts.length} blocked` : ''}
            </span>
            <button
              onClick={onNavigateToAccounts}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#EAE5DE] text-[11px] font-medium text-[#504C46] hover:bg-[#FAF7F2] transition-colors"
            >
              All accounts
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </div>

        {accounts.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-[#706B65]">No Google accounts connected yet.</p>
            <button
              onClick={onNavigateToAccounts}
              className="mt-3 text-xs font-semibold text-[#C25938] hover:underline"
            >
              Connect your first account →
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[#EAE5DE]">
            {accounts.map((a) => {
              const topModels = (a.models5h || []).slice(0, 3);
              // Name the lowest model explicitly — a bare "low 39%" is unreadable.
              const lowest = (a.models5h || []).reduce<{ name: string; percentage: number } | null>(
                (min, m) => (min === null || m.percentage < min.percentage ? m : min),
                null
              );
              const test = a.lastTestResult;
              return (
                <div key={a.id} className="px-6 py-4 flex flex-wrap items-center gap-4">
                  {/* Identity */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="relative shrink-0">
                      <AccountAvatar
                        name={a.name}
                        email={a.email}
                        avatarUrl={a.avatarUrl}
                      />
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${statusDot(a.status)}`}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[#2A2723] truncate">
                          {a.name}
                        </span>
                        {a.isDefaultRouting && (
                          <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-[#FAF2EF] text-[#C25938] border border-[#F2DDD5]">
                            Primary
                          </span>
                        )}
                        {a.hasValidationLink && (
                          <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                            Verify
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#9E988F] font-mono-code truncate">
                        {a.email}
                      </div>
                      <div className="text-[10px] text-[#B0AAA1] mt-0.5">
                        {a.tier} · used {timeAgo(a.lastUsedAt)}
                      </div>
                    </div>
                  </div>

                  {/* Per-model quota mini bars */}
                  <div className="flex-1 min-w-[180px] max-w-xs">
                    {topModels.length === 0 ? (
                      <span className="text-[11px] text-[#B0AAA1]">No quota reported</span>
                    ) : (
                      <div className="space-y-1.5">
                        {topModels.map((m) => (
                          <div key={m.name} className="flex items-center gap-2">
                            <span className="text-[10px] text-[#706B65] truncate flex-1" title={m.name}>
                              {m.name}
                            </span>
                            <div className="w-16 h-1 bg-[#F2ECE4] rounded-full overflow-hidden shrink-0">
                              <div
                                className={`h-full rounded-full ${quotaBar(m.percentage)}`}
                                style={{ width: `${Math.min(100, Math.max(0, m.percentage))}%` }}
                              />
                            </div>
                            <span
                              className={`text-[10px] font-mono-code font-semibold w-8 text-right shrink-0 ${quotaColor(m.percentage)}`}
                            >
                              {m.percentage}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* State */}
                  <div className="shrink-0 text-right min-w-[110px]">
                    <div className="text-[11px] font-medium">
                      {a.status === 'active' ? (
                        <span className="text-[#4E7B62]">Serving</span>
                      ) : a.status === 'error' ? (
                        <span className="text-red-600">Blocked</span>
                      ) : a.status === 'cooldown' ? (
                        <span className="text-amber-600">Cooling down</span>
                      ) : (
                        <span className="text-[#9E988F]">Standby</span>
                      )}
                    </div>
                    <div className="text-[10px] text-[#B0AAA1] font-mono-code">
                      {test
                        ? test.ok
                          ? `test ok · ${test.latencyMs}ms`
                          : 'test failed'
                        : 'not tested yet'}
                    </div>
                    {lowest && lowest.percentage < 100 && a.status === 'active' && (
                      <div
                        className={`text-[10px] font-mono-code truncate ${quotaColor(lowest.percentage)}`}
                        title={`${lowest.name}: ${lowest.percentage}% remaining`}
                      >
                        {lowest.percentage}% · {lowest.name}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ============ Routing + Traffic ============ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Routing / system config */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif-editorial text-lg font-bold text-[#2A2723]">Routing</h3>
            <Cpu className="w-4 h-4 text-[#706B65]" />
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[#706B65]">Strategy</span>
              <span className="font-mono-code text-[#2A2723]">
                {status.config?.rotationStrategy || '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#706B65]">Quota failover</span>
              <span className="font-mono-code">
                {status.config?.autoSwitchOnQuotaLimit ? (
                  <span className="text-[#4E7B62]">enabled</span>
                ) : (
                  <span className="text-[#9E988F]">disabled</span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#706B65]">Stream relay</span>
              <span className="font-mono-code">
                {status.config?.enableStreamRelay ? (
                  <span className="text-[#4E7B62]">on</span>
                ) : (
                  <span className="text-[#9E988F]">off</span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#706B65]">Capacity policy</span>
              <span className="font-mono-code text-[#2A2723]">
                {status.capacityPolicy === 'reject_429' ? 'reject 429' : 'queue'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#706B65]">Per-account cap</span>
              <span className="font-mono-code text-[#2A2723]">
                {status.maxConcurrentRequestsPerAccount ?? '—'} concurrent
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#706B65]">In flight</span>
              <span className="font-mono-code text-[#2A2723]">
                {status.totalInFlight ?? 0} / {status.totalCapacity ?? 0}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#706B65]">Success rate</span>
              <span className="font-mono-code">
                {status.successRate === null ? (
                  <span className="text-[#9E988F]">no data</span>
                ) : (
                  <span className={status.successRate >= 99 ? 'text-[#4E7B62]' : 'text-amber-600'}>
                    {status.successRate}%
                  </span>
                )}
              </span>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-[#EAE5DE] text-[11px] text-[#9E988F]">
            {primary ? (
              <div className="flex items-center gap-2">
                <CircleDot className="w-3 h-3 text-[#C25938]" />
                <span className="truncate">
                  Serving via <span className="font-mono-code text-[#504C46]">{primary.email}</span>
                </span>
              </div>
            ) : (
              <span>No routing account selected</span>
            )}
            {status.lastSwitch && (
              <div className="mt-1.5 text-[10px]">
                Last switch → {status.lastSwitch.toEmail} ({timeAgo(status.lastSwitch.at)})
              </div>
            )}
          </div>
        </div>

        {/* Traffic volume sparkline */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif-editorial text-lg font-bold text-[#2A2723]">
              Request Volume
            </h3>
            <Radio className="w-4 h-4 text-[#706B65]" />
          </div>

          <div className="flex items-end gap-1 h-24">
            {hourly.map((count, i) => (
              <div key={i} className="flex-1 flex flex-col justify-end h-full">
                <div
                  className={`w-full rounded-t transition-all ${
                    count === 0 ? 'bg-[#F2ECE4]' : 'bg-[#C25938]/70'
                  }`}
                  style={{ height: `${Math.max(3, (count / hourlyMax) * 100)}%` }}
                  title={`${count} request${count === 1 ? '' : 's'}`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-[#B0AAA1] mt-2 font-mono-code">
            <span>-12h</span>
            <span>-6h</span>
            <span>now</span>
          </div>

          <div className="mt-4 pt-4 border-t border-[#EAE5DE] grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[#706B65] text-[11px]">Total records</div>
              <div className="font-serif-editorial text-xl font-bold text-[#2A2723]">
                {traffic.length}
              </div>
            </div>
            <div>
              <div className="text-[#706B65] text-[11px]">Errors 24h</div>
              <div
                className={`font-serif-editorial text-xl font-bold ${
                  errorCount24h > 0 ? 'text-red-600' : 'text-[#2A2723]'
                }`}
              >
                {errorCount24h}
              </div>
            </div>
          </div>
        </div>

        {/* Models */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif-editorial text-lg font-bold text-[#2A2723]">Models</h3>
            <Zap className="w-4 h-4 text-[#706B65]" />
          </div>

          <div className="flex items-baseline gap-2">
            <span className="font-serif-editorial text-3xl font-bold text-[#2A2723]">
              {liveModelCount}
            </span>
            <span className="text-xs text-[#706B65]">served live</span>
          </div>
          <div className="text-[11px] text-[#9E988F] font-mono-code mt-1">
            {modelError
              ? 'catalog unavailable'
              : totalModelCount > liveModelCount
              ? `${totalModelCount} in catalog`
              : 'all advertised models live'}
          </div>

          <div className="mt-4 space-y-1.5 flex-1">
            {(models?.models || [])
              .filter((m) => m.live)
              .slice(0, 4)
              .map((m) => (
                <div key={m.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4E7B62] shrink-0" />
                  <span className="font-mono-code text-[#504C46] truncate">{m.id}</span>
                </div>
              ))}
            {liveModelCount === 0 && !modelError && (
              <span className="text-[11px] text-[#B0AAA1]">No live models reported</span>
            )}
          </div>

          <button
            onClick={onNavigateToModels}
            className="mt-4 w-full py-2 px-3 border border-[#EAE5DE] rounded-xl text-xs font-medium text-[#504C46] hover:bg-[#FAF7F2] flex items-center justify-center gap-1.5 transition-colors"
          >
            <span>Test models</span>
            <ChevronRight className="w-3.5 h-3.5 text-[#706B65]" />
          </button>
        </div>
      </div>

      {/* ============ Recent activity ============ */}
      <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="font-serif-editorial text-xl font-bold text-[#2A2723]">
              Recent Activity
            </h3>
            <p className="text-xs text-[#706B65]">
              Latest requests dispatched through the gateway
            </p>
          </div>
          <button
            onClick={onNavigateToTraffic}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#EAE5DE] text-[11px] font-medium text-[#504C46] hover:bg-[#FAF7F2] transition-colors"
          >
            Full traffic log
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>

        {recent.length === 0 ? (
          <div className="py-8 text-center text-xs text-[#9E988F]">
            No requests yet. Point a client at{' '}
            <span className="font-mono-code text-[#504C46]">
              http://localhost:{status.port}/v1
            </span>{' '}
            to see activity here.
          </div>
        ) : (
          <div className="divide-y divide-[#EAE5DE]">
            {recent.map((t) => (
              <div key={t.id} className="py-2.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      t.status >= 200 && t.status < 400
                        ? 'bg-emerald-500'
                        : t.status === 429
                        ? 'bg-amber-500'
                        : 'bg-red-500'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-medium text-[#2A2723]">{t.clientName}</span>
                      <span className="text-[10px] text-[#706B65] bg-[#FAF7F2] px-1.5 py-0.5 rounded border border-[#EAE5DE] font-mono-code">
                        {t.modelRouted}
                      </span>
                      <span
                        className={`text-[10px] font-mono-code ${
                          t.status >= 400 ? 'text-red-600' : 'text-[#4E7B62]'
                        }`}
                      >
                        {t.status}
                      </span>
                    </div>
                    <p className="text-[11px] text-[#9E988F] truncate font-mono-code">
                      via {t.backingAccountEmail} · {timeAgo(t.timestamp)}
                    </p>
                  </div>
                </div>
                <div className="text-right shrink-0 font-mono-code text-[11px]">
                  <div className="text-[#2A2723]">{t.latencyMs} ms</div>
                  <div className="text-[#9E988F]">{formatTokens(t.totalTokens)} tokens</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ============ Footer strip ============ */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-[#9E988F] px-1">
        <div className="flex items-center gap-2">
          {status.healthy ? (
            <ShieldCheck className="w-3.5 h-3.5 text-[#4E7B62]" />
          ) : (
            <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
          )}
          <span>
            {status.healthy ? 'System healthy' : 'Attention needed'} · zero data stored · prompts
            stream directly to Google
          </span>
        </div>
        <span className="font-mono-code">
          v{status.version} · core {status.coreConnected ? 'linked' : 'offline'}
          {status.corePid ? ` · pid ${status.corePid}` : ''}
        </span>
      </div>
    </div>
  );
};
