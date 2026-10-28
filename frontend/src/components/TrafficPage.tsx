import React, { useState } from 'react';
import {
  Activity,
  Search,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { TrafficRecord } from '../types';

interface TrafficPageProps {
  traffic: TrafficRecord[];
}

export const TrafficPage: React.FC<TrafficPageProps> = ({ traffic }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | '200' | '429'>('all');

  const filteredTraffic = traffic.filter((t) => {
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
  });

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
              {filteredTraffic.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-[#706B65]">
                    No traffic records matched your filter.
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
