import React, { useState } from 'react';
import {
  Activity,
  Search,
  CheckCircle2,
  XCircle,
  Loader2,
  X,
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

interface TrafficPageProps {
  traffic: TrafficRecord[];
  onReady?: () => void;
}

export const TrafficPage: React.FC<TrafficPageProps> = ({ traffic, onReady }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | '200' | '429'>('all');
  const [timeRange, setTimeRange] = useState<TrafficTimeRange | null>(readTrafficTimeRange);
  const [rangeTraffic, setRangeTraffic] = useState<TrafficRecord[]>([]);
  const [rangeLoading, setRangeLoading] = useState(() => Boolean(readTrafficTimeRange()));
  const [rangeIsLive, setRangeIsLive] = useState(true);

  React.useEffect(() => {
    if (!timeRange) {
      setRangeTraffic([]);
      setRangeLoading(false);
      return;
    }

    let active = true;
    setRangeLoading(true);
    api.getTraffic(timeRange).then(({ data, isLiveApi }) => {
      if (!active) return;
      setRangeTraffic(data);
      setRangeIsLive(isLiveApi);
    }).catch(() => {
      if (active) {
        setRangeTraffic([]);
        setRangeIsLive(false);
      }
    }).finally(() => {
      if (active) {
        setRangeLoading(false);
        onReady?.();
      }
    });

    return () => { active = false; };
  }, [timeRange?.from, timeRange?.to]);

  const visibleTraffic = timeRange ? rangeTraffic : traffic;
  const filteredTraffic = visibleTraffic.filter((t) => {
    const matchesSearch =
      t.clientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.modelRequested.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.backingAccountEmail.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus =
      statusFilter === 'all'
        ? true
        : statusFilter === '200'
        ? t.status === 200
        : t.status === 429;

    return matchesSearch && matchesStatus;
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const rangeErrorCount = rangeTraffic.filter((record) => record.status >= 400).length;
  const rangeModelCount = new Set(rangeTraffic.map((record) => record.modelRequested)).size;
  const rangeAccountCount = new Set(rangeTraffic.map((record) => record.backingAccountEmail)).size;
  const rangeAverageLatency = rangeTraffic.length
    ? Math.round(rangeTraffic.reduce((sum, record) => sum + record.latencyMs, 0) / rangeTraffic.length)
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
          and which Google account served each request.
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
          {(['all', '200', '429'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setStatusFilter(filter)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === filter
                  ? 'bg-[#C25938] text-white'
                  : 'bg-[#FAF7F2] border border-[#EAE5DE] text-[#706B65] hover:text-[#2A2723]'
              }`}
            >
              {filter === 'all' ? 'All Codes' : filter === '200' ? '200 Success' : '429 Throttled'}
            </button>
          ))}
        </div>
      </div>

      {/* Table Container */}
      <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#FAF7F2] text-[#706B65] font-semibold border-b border-[#EAE5DE]">
              <tr>
                <th className="py-3.5 px-4">Time</th>
                <th className="py-3.5 px-4">Client</th>
                <th className="py-3.5 px-4">Model & Route</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Latency</th>
                <th className="py-3.5 px-4">Tokens (In / Out)</th>
                <th className="py-3.5 px-4">Served By Account</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EAE5DE] text-[#2A2723]">
              {rangeLoading ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-[#706B65]">
                    <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin text-[#C25938]" />Loading matching requests…</span>
                  </td>
                </tr>
              ) : filteredTraffic.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-[#706B65]">
                    {timeRange ? 'No requests were recorded during this hour.' : 'No traffic records matched your filter.'}
                  </td>
                </tr>
              ) : (
                filteredTraffic.map((t) => {
                  const date = new Date(t.timestamp);
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
                      <td className="py-3.5 px-4 font-mono-code text-[#706B65] whitespace-nowrap">
                        {timeFormatted}
                      </td>
                      <td className="py-3.5 px-4 font-medium whitespace-nowrap">
                        <span className="bg-[#FAF7F2] border border-[#EAE5DE] px-2 py-0.5 rounded text-[11px] text-[#2A2723]">
                          {t.clientName}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
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
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {t.status === 200 ? (
                          <span className="inline-flex items-center gap-1 font-mono-code text-[11px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3" />
                            200 OK
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-mono-code text-[11px] text-red-700 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">
                            <XCircle className="w-3 h-3" />
                            {t.status}
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono-code text-[#504C46] whitespace-nowrap">
                        {t.latencyMs} ms
                      </td>
                      <td className="py-3.5 px-4 font-mono-code text-[#504C46] whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <span>{t.totalTokens.toLocaleString()}</span>
                          <span className="text-[10px] text-[#9E988F]">
                            ({t.promptTokens} / {t.completionTokens})
                          </span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 font-mono-code text-xs text-[#706B65] whitespace-nowrap">
                        {t.backingAccountEmail}
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
