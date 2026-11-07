import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Search,
  CheckCircle2,
  Clock3,
  XCircle,
  Loader2,
  X,
  KeyRound,
} from 'lucide-react';
import { TrafficRecord } from '../types';
import { api } from '../services/api';
import { navigate } from '../router';

interface TrafficTimeRange {
  from: number;
  to: number;
}

const readTrafficTimeRange = (): TrafficTimeRange | null => {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('from') || !params.has('to')) return null;
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null;
};

const formatRangeTime = (timestamp: number) => new Date(timestamp).toLocaleString([], {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

const PENDING_NOTICE_AFTER_MS = 2 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Core traffic sometimes carries an opaque account id instead of an email. */
const shortAccountLabel = (value: string): string => {
  if (UUID_RE.test(value)) return `${value.slice(0, 8)}…`;
  return value;
};

/** API-key calls are stored as "Gemini API · <key label>"; show the key label. */
const servedByLabel = (record: TrafficRecord): string => {
  if (record.provider === 'gemini-api') {
    return record.backingAccountEmail.replace(/^Gemini API\s*[·•-]\s*/i, '');
  }
  return shortAccountLabel(record.backingAccountEmail);
};

const formatElapsed = (elapsedMs: number): string => {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
};

interface TrafficPageProps {
  traffic: TrafficRecord[];
  onReady?: () => void;
}

const EgressCell: React.FC<{ record: TrafficRecord }> = ({ record }) => {
  if (!record.egressIp) {
    return <span className="text-[#9E988F]">—</span>;
  }
  const country = record.egressCountry?.toUpperCase() ?? '';
  const viaProxy = record.egressVia === 'proxy';
  return (
    <div
      className="flex items-center gap-2"
      title={viaProxy ? "Left through this account's or API key's Webshare proxy" : 'Left directly from the gateway host'}
    >
      {country ? (
        <img
          src={`https://flagcdn.com/w20/${country.toLowerCase()}.png`}
          srcSet={`https://flagcdn.com/w40/${country.toLowerCase()}.png 2x`}
          alt={country}
          width={20}
          height={15}
          loading="lazy"
          className="h-[15px] w-5 shrink-0 rounded-[2px] object-cover ring-1 ring-black/5"
        />
      ) : (
        <span className="inline-block h-[15px] w-5 shrink-0 rounded-[2px] bg-stone-200" aria-hidden />
      )}
      <div className="flex flex-col leading-tight">
        <span className="font-mono-code text-[11px] text-[#2A2723]">{record.egressIp}</span>
        <span className="text-[10px] text-[#9E988F]">
          {country || 'Unknown'} · {viaProxy ? 'proxy' : 'direct'}
        </span>
      </div>
    </div>
  );
};

export const TrafficPage: React.FC<TrafficPageProps> = ({ traffic, onReady }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | '200' | 'error'>('all');
  const [timeRange, setTimeRange] = useState<TrafficTimeRange | null>(readTrafficTimeRange);
  const [rangeTraffic, setRangeTraffic] = useState<TrafficRecord[]>([]);
  const [rangeLoading, setRangeLoading] = useState(() => Boolean(readTrafficTimeRange()));
  const [rangeIsLive, setRangeIsLive] = useState(true);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const onReadyRef = useRef(onReady);
  const rangeFrom = timeRange?.from;
  const rangeTo = timeRange?.to;

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const interval = setInterval(() => setClockNow(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (rangeFrom === undefined || rangeTo === undefined) return;

    let active = true;
    let loading = false;
    let firstLoad = true;
    let timer: number | null = null;
    const scheduleNext = () => {
      if (active && document.visibilityState === 'visible') {
        timer = window.setTimeout(() => void loadRange(), 15000);
      }
    };

    const loadRange = async () => {
      if (!active || loading) return;
      if (document.visibilityState !== 'visible') return;

      loading = true;
      try {
        const { data, isLiveApi } = await api.getTraffic({ from: rangeFrom, to: rangeTo });
        if (active) {
          setRangeTraffic(isLiveApi ? data : []);
          setRangeIsLive(isLiveApi);
        }
      } catch {
        if (active) {
          setRangeIsLive(false);
          if (firstLoad) setRangeTraffic([]);
        }
      } finally {
        loading = false;
        if (active) {
          if (firstLoad) {
            firstLoad = false;
            setRangeLoading(false);
            onReadyRef.current?.();
          }
          scheduleNext();
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void loadRange();
    };

    void loadRange();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [rangeFrom, rangeTo]);

  const visibleTraffic = timeRange ? rangeTraffic : traffic;
  const filteredTraffic = visibleTraffic.filter((t) => {
    const matchesSearch =
      t.clientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.modelRequested.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.modelRouted.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.backingAccountEmail.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (t.gatewayKeyName || '').toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      statusFilter === 'all'
        ? true
        : statusFilter === '200'
        ? t.status === 200
        : t.status >= 400;

    return matchesSearch && matchesStatus;
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const rangeErrorCount = rangeTraffic.filter((record) => record.status >= 400).length;
  const rangeModelCount = new Set(rangeTraffic.map((record) => record.modelRequested)).size;
  const rangeAccountCount = new Set(rangeTraffic.map((record) => record.backingAccountEmail)).size;
  const completedRangeTraffic = rangeTraffic.filter((record) => record.outcome !== 'in_progress');
  const rangeAverageLatency = completedRangeTraffic.length
    ? Math.round(completedRangeTraffic.reduce((sum, record) => sum + record.latencyMs, 0) / completedRangeTraffic.length)
    : 0;

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Title & Introduction */}
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#C25938] mb-1.5">
          <Activity className="w-4 h-4" />
          <span>Real-time Telemetry</span>
        </div>
        <h2 className="font-serif-editorial text-3xl font-semibold text-[#2A2723]">
          Traffic & Request Monitor
        </h2>
        <p className="text-sm text-[#706B65] mt-1 max-w-xl">
          Live stream of API completions routed through geminirouter. Inspect latency, token usage,
          and whether a Google account or an AI Studio API key served each request.
        </p>
      </div>

      {timeRange && (
        <section className="rounded-2xl border border-[#EAE5DE] bg-white p-4 sm:p-5 shadow-soft">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#C25938]">
                Selected graph hour
              </div>
              <div className="mt-1 text-sm font-medium text-[#2A2723]">
                {formatRangeTime(timeRange.from)} – {formatRangeTime(timeRange.to)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setTimeRange(null);
                setRangeLoading(false);
                setRangeTraffic([]);
                navigate('/app/traffic', { replace: true });
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#EAE5DE] px-3 py-1.5 text-xs font-medium text-[#706B65] hover:bg-[#FAF7F2] hover:text-[#2A2723]"
            >
              <X className="h-3.5 w-3.5" /> Clear hour
            </button>
          </div>

          {rangeLoading ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-[#706B65]" role="status">
              <Loader2 className="h-4 w-4 animate-spin text-[#C25938]" />
              Loading requests for this hour…
            </div>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[#EEEAE4] pt-4 sm:grid-cols-4">
                <div><div className="text-[10px] text-[#9E988F]">Requests</div><div className="mt-0.5 font-serif-editorial text-xl font-semibold">{rangeTraffic.length.toLocaleString()}</div></div>
                <div><div className="text-[10px] text-[#9E988F]">Errors</div><div className={`mt-0.5 font-serif-editorial text-xl font-semibold ${rangeErrorCount ? 'text-red-600' : ''}`}>{rangeErrorCount.toLocaleString()}</div></div>
                <div><div className="text-[10px] text-[#9E988F]">Models · accounts</div><div className="mt-0.5 font-serif-editorial text-xl font-semibold">{rangeModelCount} · {rangeAccountCount}</div></div>
                <div><div className="text-[10px] text-[#9E988F]">Avg. latency</div><div className="mt-0.5 font-serif-editorial text-xl font-semibold">{rangeAverageLatency.toLocaleString()}<span className="ml-1 text-[11px] font-sans-ui font-normal text-[#706B65]">ms</span></div></div>
              </div>
              {!rangeIsLive && (
                <p className="mt-3 text-[11px] text-amber-700">Live audit data is unavailable; showing local traffic data where available.</p>
              )}
            </>
          )}
        </section>
      )}

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#FFFFFF] border border-[#EAE5DE] p-4 rounded-2xl shadow-soft">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9E988F]" />
          <input
            type="text"
            placeholder="Search by client, model, or account email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl pl-9 pr-4 py-2 text-xs text-[#2A2723] focus:outline-none focus:border-[#C25938]"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <span className="text-xs text-[#706B65] font-medium hidden sm:inline">Filter:</span>
          {(['all', '200', 'error'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setStatusFilter(filter)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === filter
                  ? 'bg-[#C25938] text-white'
                  : 'bg-[#FAF7F2] border border-[#EAE5DE] text-[#706B65] hover:text-[#2A2723]'
              }`}
            >
              {filter === 'all' ? 'All Codes' : filter === '200' ? '200 Success' : 'Errors'}
            </button>
          ))}
        </div>
      </div>

      {/* Table Container */}
      <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-xs">
            <thead className="bg-[#FAF7F2] text-[#706B65] font-semibold border-b border-[#EAE5DE]">
              <tr>
                <th className="py-3.5 px-3 whitespace-nowrap">Time</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Client</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Client Key</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Model & Route</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Status</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Latency</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Tokens (In / Out)</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Cached</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Served By</th>
                <th className="py-3.5 px-3 whitespace-nowrap">Egress IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EAE5DE] text-[#2A2723]">
              {rangeLoading ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-[#706B65]">
                    <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin text-[#C25938]" />Loading matching requests…</span>
                  </td>
                </tr>
              ) : filteredTraffic.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-10 text-[#706B65]">
                    {timeRange ? 'No requests were recorded during this hour.' : 'No traffic records matched your filter.'}
                  </td>
                </tr>
              ) : (
                filteredTraffic.map((t) => {
                  const date = new Date(t.timestamp);
                  const isPending = t.outcome === 'in_progress';
                  const requestStartedAt = Date.parse(t.timestamp);
                  const elapsedMs = isPending && Number.isFinite(requestStartedAt)
                    ? Math.max(0, clockNow - requestStartedAt)
                    : 0;
                  const hasPendingNotice = isPending && elapsedMs >= PENDING_NOTICE_AFTER_MS;
                  const timeFormatted = date.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  });

                  return (
                    <tr
                      key={t.id}
                      className="hover:bg-[#FAF9F5]/70 transition-colors"
                    >
                      <td className="py-3.5 px-3 font-mono-code text-[#706B65] whitespace-nowrap">
                        {timeFormatted}
                      </td>
                      <td className="py-3.5 px-3 font-medium whitespace-nowrap">
                        <span className="bg-[#FAF7F2] border border-[#EAE5DE] px-2 py-0.5 rounded text-[11px] text-[#2A2723]">
                          {t.clientName}
                        </span>
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        {t.gatewayKeyName ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-[#EAE5DE] bg-[#FFFFFF] px-2 py-0.5 text-[10px] font-medium text-[#504C46]">
                            <KeyRound className="h-2.5 w-2.5 text-[#C25938]" />
                            {t.gatewayKeyName}
                          </span>
                        ) : (
                          <span className="text-[#9E988F]">—</span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span className="font-mono-code font-semibold text-[#2A2723]">
                            {t.modelRouted}
                          </span>
                          {t.modelRequested !== t.modelRouted && (
                            <span className="text-[10px] text-[#9E988F] font-mono-code">
                              from {t.modelRequested}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        {isPending ? (
                          <div className="max-w-[250px] whitespace-normal">
                            <span
                              title="The gateway has not saved a final response for this request. It may still be running; if the calling app has stopped, its completion was not recorded."
                              className={`inline-flex items-center gap-1 whitespace-nowrap font-mono-code text-[11px] px-2 py-0.5 rounded-full border ${
                                hasPendingNotice
                                  ? 'text-amber-800 bg-amber-50 border-amber-300'
                                  : 'text-amber-700 bg-amber-50 border-amber-200'
                              }`}
                            >
                              {hasPendingNotice ? (
                                <Clock3 className="w-3 h-3" />
                              ) : (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              )}
                              {hasPendingNotice
                                ? `No result recorded · ${formatElapsed(elapsedMs)}`
                                : `Waiting · ${formatElapsed(elapsedMs)}`}
                            </span>
                            {hasPendingNotice && (
                              <span className="mt-1 block text-[10px] leading-4 text-amber-800/80">
                                No finish event is saved. The log cannot tell whether the client is still waiting or the request ended without reporting back.
                              </span>
                            )}
                          </div>
                        ) : t.status === 200 ? (
                          <span className="inline-flex items-center gap-1 font-mono-code text-[11px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3" />
                            200 OK
                          </span>
                        ) : t.status === 0 ? (
                          <span className="inline-flex items-center gap-1 font-mono-code text-[11px] text-stone-600 bg-stone-100 px-2 py-0.5 rounded-full border border-stone-200">
                            <XCircle className="w-3 h-3" />
                            Aborted
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-mono-code text-[11px] text-red-700 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">
                            <XCircle className="w-3 h-3" />
                            {t.status}
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 font-mono-code text-[#504C46] whitespace-nowrap">
                        {isPending ? `Open for ${formatElapsed(elapsedMs)}` : `${t.latencyMs} ms`}
                      </td>
                      <td className="py-3.5 px-3 font-mono-code text-[#504C46] whitespace-nowrap">
                        {isPending ? (
                          <span className="text-[#9E988F]">Not recorded</span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span>{t.totalTokens.toLocaleString()}</span>
                            <span className="text-[10px] text-[#9E988F]">
                              ({t.promptTokens} / {t.completionTokens})
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-3 font-mono-code text-xs whitespace-nowrap">
                        {isPending ? (
                          <span className="text-[#9E988F]">—</span>
                        ) : t.cachedTokens && t.cachedTokens > 0 ? (
                          <span className="text-[#1d4ed8] font-semibold">
                            {t.cachedTokens.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-[#9E988F]">—</span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 text-xs text-[#706B65]">
                        {isPending && t.backingAccountEmail === 'unknown' ? (
                          <span className="whitespace-nowrap">Not assigned yet</span>
                        ) : (
                          <div
                            className="flex min-w-0 max-w-[220px] items-center gap-1.5"
                            title={t.backingAccountEmail}
                          >
                            {t.provider === 'gemini-api' && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#F2DDD5] bg-[#FAF2EF] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#C25938]">
                                <KeyRound className="h-2.5 w-2.5" /> key
                              </span>
                            )}
                            <span className="truncate font-mono-code">
                              {servedByLabel(t)}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <EgressCell record={t} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
