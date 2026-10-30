import React, { useEffect, useState } from 'react';
import {
  Activity,
  Users,
  Clock,
  ArrowUpRight,
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
  Loader2,
} from 'lucide-react';
import {
  GatewayStatus,
  GoogleAccount,
  TrafficRecord,
  ModelsResponse,
  TrafficVolumeRange,
  TrafficVolumeResponse,
} from '../types';
import { api } from '../services/api';

interface OverviewPageProps {
  status: GatewayStatus;
  accounts: GoogleAccount[];
  traffic: TrafficRecord[];
  onReady?: () => void;
  onNavigateToAccounts: () => void;
  onNavigateToGateway: () => void;
  onNavigateToModels: () => void;
  onNavigateToTraffic: (range?: { from: number; to: number }) => void;
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
  onReady,
  onNavigateToAccounts,
  onNavigateToGateway,
  onNavigateToModels,
  onNavigateToTraffic,
}) => {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [modelError, setModelError] = useState(false);
  const [graphRange, setGraphRange] = useState<TrafficVolumeRange>('12h');
  const [rangeVolume, setRangeVolume] = useState<TrafficVolumeResponse | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);

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
      })
      .finally(() => {
        if (!cancelled) onReady?.();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (graphRange === '12h') {
      setRangeLoading(false);
      return;
    }

    let active = true;
    setRangeLoading(true);
    api.getTrafficVolume(graphRange).then(({ data, isLiveApi }) => {
      if (!active) return;
      setRangeVolume(isLiveApi ? data : { ...data, available: false });
    }).catch(() => {
      if (active) setRangeVolume(null);
    }).finally(() => {
      if (active) setRangeLoading(false);
    });

    return () => { active = false; };
  }, [graphRange]);

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
  // Use the server's complete 12-hour audit summary; the traffic table only
  // loads its latest 50 rows and is not a complete source for this chart.
  const fallbackHourly = React.useMemo(() => {
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
  const hourly = status.requestVolume12h ?? fallbackHourly;
  const requestsLast12h = status.requestsLast12h ?? traffic.length;
  const statusWindowEnd = Date.parse(status.requestVolume12hWindowEnd || '');
  const chartWindowEnd = Number.isFinite(statusWindowEnd) ? statusWindowEnd : Date.now();
  const fallbackBuckets = hourly.map((requests, index) => ({
    from: new Date(chartWindowEnd - (hourly.length - index) * 60 * 60 * 1000).toISOString(),
    to: new Date(chartWindowEnd - (hourly.length - index - 1) * 60 * 60 * 1000).toISOString(),
    requests,
    errors: 0,
  }));
  const currentRangeVolume = rangeVolume?.range === graphRange ? rangeVolume : null;
  const graphAvailable = graphRange === '12h' || currentRangeVolume?.available === true;
  const graphBuckets = graphRange === '12h'
    ? fallbackBuckets
    : graphAvailable
    ? (currentRangeVolume?.buckets || [])
    : [];
  const graphRequestTotal = graphRange === '12h'
    ? requestsLast12h
    : currentRangeVolume?.totalRequests ?? 0;
  const fallbackErrors12h = traffic.filter((record) => {
    const age = Date.now() - Date.parse(record.timestamp);
    return record.status >= 400 && age >= 0 && age < 12 * 60 * 60 * 1000;
  }).length;
  const graphErrorTotal = graphRange === '12h'
    ? status.errorsLast12h ?? fallbackErrors12h
    : currentRangeVolume?.totalErrors ?? 0;
  const graphPeakRequests = Math.max(0, ...graphBuckets.map((bucket) => bucket.requests));
  const graphPeakLabel = graphRange === '7d' ? 'Peak 6h interval' : 'Peak hour';
  const hourlyMax = Math.max(1, ...graphBuckets.map((bucket) => bucket.requests));
  const chartLeft = 52;
  const chartRight = 992;
  const chartTop = 18;
  const chartBottom = 190;
  const chartHeight = chartBottom - chartTop;
  const chartPoints = graphBuckets.map((bucket, index) => ({
    x: chartLeft + index * ((chartRight - chartLeft) / Math.max(1, graphBuckets.length - 1)),
    y: chartBottom - (bucket.requests / hourlyMax) * chartHeight,
    count: bucket.requests,
    from: Date.parse(bucket.from),
    to: Date.parse(bucket.to),
  }));
  const chartLine = chartPoints.map((point, index) =>
    `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`,
  ).join(' ');
  const chartArea = chartPoints.length
    ? `${chartLine} L ${chartRight} ${chartBottom} L ${chartLeft} ${chartBottom} Z`
    : '';
  const timelineLabels: Record<TrafficVolumeRange, string[]> = {
    '12h': ['12 hours ago', '9h', '6h', '3h', 'Now'],
    '24h': ['24 hours ago', '18h', '12h', '6h', 'Now'],
    '7d': ['7 days ago', '5d', '3d', '1d', 'Now'],
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* ============ Full-width live request graph ============ */}
      <section className="bg-white border border-[#EAE5DE] rounded-3xl p-5 sm:p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#C25938]">
              <Radio className="w-4 h-4" />
              <span>Live traffic · last {graphRange}</span>
              <span className={`ml-1 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 normal-case tracking-normal ${
                status.isRunning
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-amber-200 bg-amber-50 text-amber-700'
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${status.isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                {status.isRunning ? 'Serving' : 'Reconnecting'}
              </span>
            </div>
            <h2 className="mt-1.5 font-serif-editorial text-2xl sm:text-3xl font-semibold leading-tight text-[#2A2723]">
              Request volume
            </h2>
            <p className="mt-1 text-[13px] text-[#706B65]">
              {graphRange === '7d' ? 'Requests grouped into six-hour intervals.' : 'Requests grouped by hour.'} Select a point to inspect its requests.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div role="group" aria-label="Graph time range" className="inline-flex rounded-xl border border-[#EAE5DE] bg-[#FAF7F2] p-1">
              {(['12h', '24h', '7d'] as const).map((range) => (
                <button
                  key={range}
                  type="button"
                  aria-pressed={graphRange === range}
                  onClick={() => setGraphRange(range)}
                  className={`min-w-11 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors ${graphRange === range ? 'bg-[#C25938] text-white shadow-soft' : 'text-[#706B65] hover:text-[#2A2723]'}`}
                >
                  {range}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={onNavigateToGateway}
                className="flex items-center gap-1.5 rounded-xl bg-[#C25938] px-4 py-2.5 text-xs font-semibold text-white shadow-soft transition-colors hover:bg-[#B24E2E]"
              >
                <span>API Keys &amp; Endpoints</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={onNavigateToModels}
                className="flex items-center gap-1.5 rounded-xl border border-[#EAE5DE] bg-white px-4 py-2.5 text-xs font-medium text-[#2A2723] shadow-soft transition-colors hover:bg-[#FAF7F2]"
              >
                <Layers className="h-3.5 w-3.5 text-[#706B65]" />
                <span>Browse Models</span>
              </button>
            </div>
          </div>
        </div>

        <div className="relative mt-4 h-36 w-full sm:h-40 lg:h-44">
          <svg
            viewBox="0 0 1000 214"
            preserveAspectRatio="none"
            role="img"
            aria-label={graphAvailable ? `Request volume over the last ${graphRange}. ${graphRequestTotal.toLocaleString()} requests total.` : `Request history for the last ${graphRange} is unavailable.`}
            className="h-full w-full overflow-visible"
          >
            <defs>
              <linearGradient id="request-volume-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#C25938" stopOpacity="0.24" />
                <stop offset="100%" stopColor="#C25938" stopOpacity="0.015" />
              </linearGradient>
            </defs>
            {[chartTop, chartTop + chartHeight / 2, chartBottom].map((y, index) => {
              const value = index === 0 ? hourlyMax : index === 1 ? Math.round(hourlyMax / 2) : 0;
              return (
                <g key={y}>
                  <line x1={chartLeft} x2={chartRight} y1={y} y2={y} stroke="#EEEAE4" strokeDasharray={index === 2 ? '0' : '4 6'} />
                  <text x="0" y={y + 4} fill="#9E988F" fontSize="11" fontFamily="monospace">{value.toLocaleString()}</text>
                </g>
              );
            })}
            {chartArea && <path d={chartArea} fill="url(#request-volume-fill)" />}
            {chartLine && <path d={chartLine} fill="none" stroke="#C25938" strokeWidth="3" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />}
            {chartPoints.map((point, index) => (
              <g
                key={index}
                role="button"
                tabIndex={0}
                aria-label={`${point.count.toLocaleString()} requests between ${new Date(point.from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} and ${new Date(point.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Open traffic details.`}
                className="cursor-pointer outline-none"
                onClick={() => onNavigateToTraffic({ from: point.from, to: point.to })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onNavigateToTraffic({ from: point.from, to: point.to });
                  }
                }}
              >
                <circle cx={point.x} cy={point.y} r="13" fill="transparent" />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={index === chartPoints.length - 1 ? 5 : 3.5}
                  fill={index === chartPoints.length - 1 ? '#4E7B62' : '#FFFFFF'}
                  stroke={index === chartPoints.length - 1 ? '#FFFFFF' : '#C25938'}
                  strokeWidth="2"
                />
                <title>{`${point.count.toLocaleString()} requests. Click to inspect this hour.`}</title>
              </g>
            ))}
          </svg>
          {rangeLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/75 text-xs text-[#706B65] backdrop-blur-[1px]" role="status">
              <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin text-[#C25938]" />Loading {graphRange} traffic…</span>
            </div>
          )}
          {!rangeLoading && !graphAvailable && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-[#9E988F]">
              Live traffic history is unavailable for this range.
            </div>
          )}
        </div>
        <div className="ml-12 mt-0.5 flex justify-between text-[10px] font-mono-code text-[#9E988F]">
          {timelineLabels[graphRange].map((label) => <span key={label}>{label}</span>)}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-[#EAE5DE] pt-3 sm:grid-cols-3 sm:gap-0">
          <div className="sm:pr-6">
            <div className="text-[11px] text-[#706B65]">Requests · last {graphRange}</div>
            <div className="mt-0.5 font-serif-editorial text-xl font-bold text-[#2A2723]">{graphAvailable ? graphRequestTotal.toLocaleString() : '—'}</div>
          </div>
          <div className="sm:border-l sm:border-[#EAE5DE] sm:px-6">
            <div className="text-[11px] text-[#706B65]">{graphPeakLabel}</div>
            <div className="mt-0.5 font-serif-editorial text-xl font-bold text-[#2A2723]">{graphAvailable ? graphPeakRequests.toLocaleString() : '—'}<span className="ml-1 text-xs font-sans-ui font-normal text-[#706B65]">requests</span></div>
          </div>
          <div className="sm:border-l sm:border-[#EAE5DE] sm:pl-6">
            <div className="text-[11px] text-[#706B65]">Errors · last {graphRange}</div>
            <div className={`mt-0.5 font-serif-editorial text-xl font-bold ${graphErrorTotal > 0 ? 'text-red-600' : 'text-[#2A2723]'}`}>{graphAvailable ? graphErrorTotal.toLocaleString() : '—'}</div>
          </div>
        </div>
      </section>

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
              {accounts.length > 3
                ? `Showing 3 of ${accounts.length} connected accounts with live quota and test state`
                : 'Every connected Google account, its live quota and test state'}
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
            {accounts.slice(0, 3).map((a) => {
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
            onClick={() => onNavigateToTraffic()}
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
              {typeof window !== 'undefined' ? window.location.origin : `http://localhost:${status.port}`}/v1
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
