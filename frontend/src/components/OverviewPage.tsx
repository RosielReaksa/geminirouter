import React from 'react';
import {
  Activity,
  Users,
  Clock,
  ArrowUpRight,
  Power,
  Sparkles,
  ChevronRight,
} from 'lucide-react';
import { GatewayStatus, GoogleAccount, TrafficRecord } from '../types';

interface OverviewPageProps {
  status: GatewayStatus;
  accounts: GoogleAccount[];
  traffic: TrafficRecord[];
  onToggleGateway: () => void;
  onNavigateToAccounts: () => void;
  onNavigateToGateway: () => void;
  isToggling: boolean;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
  status,
  accounts,
  traffic,
  onToggleGateway,
  onNavigateToAccounts,
  onNavigateToGateway,
  isToggling,
}) => {
  const activeAccount = accounts.find((a) => a.isDefaultRouting) || accounts[0];

  // Calculate total requests and total tokens used in active 5-hour window
  const total5hUsed = accounts.reduce((acc, a) => {
    return (
      acc +
      a.quotas.reduce((qAcc, q) => qAcc + q.requestsIn5h, 0)
    );
  }, 0);

  const total5hLimit = accounts.reduce((acc, a) => {
    return (
      acc +
      a.quotas.reduce((qAcc, q) => qAcc + q.limitIn5h, 0)
    );
  }, 0);

  const poolQuotaPercent = total5hLimit > 0 ? Math.round((total5hUsed / total5hLimit) * 100) : 0;

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Top Banner / Welcome with Editorial Claude Aesthetic */}
      <div className="bg-gradient-to-r from-[#FAF2EF] to-[#FBF9F5] border border-[#EAE5DE] rounded-3xl p-7 relative overflow-hidden shadow-soft">
        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/80 border border-[#EAE5DE] text-[11px] font-medium text-[#C25938] mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Private Google AI Studio & Gemini Relay</span>
          </div>

          <h2 className="font-serif-editorial text-3xl sm:text-4xl font-semibold text-[#2A2723] leading-tight">
            Unified Quotas. Zero Leakage. OpenRouter-Compatible.
          </h2>

          <p className="text-sm text-[#706B65] mt-2.5 leading-relaxed font-sans-ui">
            Your private proxy aggregates multiple Google accounts into a single high-throughput OpenAI/Anthropic endpoint.
            Requests automatically fail over to healthy accounts when rate limits are approached.
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-5">
            <button
              onClick={onToggleGateway}
              disabled={isToggling}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-xs shadow-soft transition-all ${
                status.isRunning
                  ? 'bg-[#FFFFFF] border border-[#EAE5DE] text-amber-800 hover:bg-[#F2ECE4]'
                  : 'bg-[#C25938] hover:bg-[#B24E2E] text-white'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              <span>{status.isRunning ? 'Pause Gateway' : 'Start Gateway Daemon'}</span>
            </button>

            <button
              onClick={onNavigateToGateway}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#FFFFFF] border border-[#EAE5DE] hover:bg-[#FAF7F2] text-xs font-medium text-[#2A2723] shadow-soft transition-colors"
            >
              <span>Get API Keys & Endpoints</span>
              <ArrowUpRight className="w-3.5 h-3.5 text-[#706B65]" />
            </button>
          </div>
        </div>

        {/* Decorative subtle visual watermark */}
        <div className="absolute right-6 -bottom-8 opacity-5 select-none pointer-events-none hidden md:block">
          <span className="font-serif-editorial text-[180px] font-bold text-[#C25938]">g</span>
        </div>
      </div>

      {/* Metric Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Gateway Health */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-5 shadow-soft">
          <div className="flex items-center justify-between text-xs text-[#706B65] mb-2 font-medium">
            <span>Daemon Health</span>
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                status.isRunning ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
            />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-editorial text-3xl font-bold text-[#2A2723]">
              {status.isRunning ? 'Operational' : 'Paused'}
            </span>
          </div>
          <div className="text-[11px] text-[#9E988F] font-mono-code mt-2 flex items-center justify-between">
            <span>Port {status.port}</span>
            <span>{status.successRate}% Success</span>
          </div>
        </div>

        {/* Active Accounts */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-5 shadow-soft">
          <div className="flex items-center justify-between text-xs text-[#706B65] mb-2 font-medium">
            <span>Enrolled Accounts</span>
            <Users className="w-4 h-4 text-[#C25938]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-editorial text-3xl font-bold text-[#2A2723]">
              {status.activeAccountsCount}
            </span>
            <span className="text-xs text-[#706B65]">
              of {status.totalAccountsCount} active
            </span>
          </div>
          <div className="text-[11px] text-[#9E988F] mt-2 flex items-center justify-between">
            <span>Pool failover enabled</span>
            <button
              onClick={onNavigateToAccounts}
              className="text-[#C25938] hover:underline font-medium"
            >
              View accounts
            </button>
          </div>
        </div>

        {/* 24h Requests */}
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
            <span>{(status.tokensLast24h / 1000000).toFixed(2)}M tokens</span>
            <span>Avg {status.averageLatencyMs}ms</span>
          </div>
        </div>

        {/* Aggregate 5h Window Quota Pool */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-5 shadow-soft">
          <div className="flex items-center justify-between text-xs text-[#706B65] mb-2 font-medium">
            <span>5h Quota Pool</span>
            <Clock className="w-4 h-4 text-[#C25938]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif-editorial text-3xl font-bold text-[#2A2723]">
              {poolQuotaPercent}%
            </span>
            <span className="text-xs text-[#706B65]">utilized</span>
          </div>
          <div className="w-full bg-[#EAE5DE] h-1.5 rounded-full overflow-hidden mt-2.5">
            <div
              className="h-full bg-[#4E7B62] rounded-full transition-all"
              style={{ width: `${Math.min(100, poolQuotaPercent)}%` }}
            />
          </div>
          <div className="text-[11px] text-[#9E988F] mt-1.5 flex justify-between">
            <span>{total5hUsed} used</span>
            <span>{total5hLimit - total5hUsed} left in pool</span>
          </div>
        </div>
      </div>

      {/* Active Routing & Quick Quotas Split Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Active Backing Account Card */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft flex flex-col justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-[#706B65] mb-3 flex items-center justify-between">
              <span>Primary Routing Account</span>
              <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full font-medium">
                Live
              </span>
            </div>

            {activeAccount && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <img
                    src={activeAccount.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${activeAccount.name}`}
                    alt={activeAccount.name}
                    className="w-12 h-12 rounded-full border border-[#EAE5DE] object-cover"
                  />
                  <div className="min-w-0">
                    <h4 className="font-medium text-sm text-[#2A2723] truncate">
                      {activeAccount.name}
                    </h4>
                    <p className="text-xs text-[#706B65] font-mono-code truncate">
                      {activeAccount.email}
                    </p>
                    <span className="text-[11px] text-[#9E988F] block mt-0.5">
                      {activeAccount.tier}
                    </span>
                  </div>
                </div>

                <div className="bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl p-3 text-xs space-y-2">
                  <div className="flex justify-between text-[#706B65]">
                    <span>Gemini 2.5 Pro (5h)</span>
                    <span className="font-mono-code font-semibold text-[#2A2723]">
                      {activeAccount.quotas[0]?.requestsIn5h} / {activeAccount.quotas[0]?.limitIn5h} reqs
                    </span>
                  </div>
                  <div className="flex justify-between text-[#706B65]">
                    <span>Gemini 2.5 Flash (5h)</span>
                    <span className="font-mono-code font-semibold text-[#2A2723]">
                      {activeAccount.quotas[1]?.requestsIn5h} / {activeAccount.quotas[1]?.limitIn5h} reqs
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={onNavigateToAccounts}
            className="mt-5 w-full py-2 px-3 border border-[#EAE5DE] rounded-xl text-xs font-medium text-[#504C46] hover:bg-[#FAF7F2] flex items-center justify-center gap-1.5 transition-colors"
          >
            <span>Manage All {accounts.length} Google Accounts</span>
            <ChevronRight className="w-3.5 h-3.5 text-[#706B65]" />
          </button>
        </div>

        {/* Right: Recent Requests Stream */}
        <div className="lg:col-span-2 bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-serif-editorial text-xl font-bold text-[#2A2723]">
                  Recent Activity
                </h3>
                <p className="text-xs text-[#706B65]">
                  Latest API completions dispatched via your local gateway
                </p>
              </div>
              <span className="text-[11px] font-mono-code text-[#9E988F]">
                Streaming
              </span>
            </div>

            <div className="divide-y divide-[#EAE5DE] text-xs">
              {traffic.slice(0, 4).map((t) => (
                <div key={t.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        t.status === 200 ? 'bg-emerald-500' : 'bg-red-500'
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-[#2A2723]">{t.clientName}</span>
                        <span className="text-[10px] text-[#706B65] bg-[#FAF7F2] px-1.5 py-0.2 rounded border border-[#EAE5DE] font-mono-code">
                          {t.modelRouted}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#9E988F] truncate font-mono-code">
                        via {t.backingAccountEmail}
                      </p>
                    </div>
                  </div>

                  <div className="text-right shrink-0 font-mono-code text-[11px]">
                    <div className="text-[#2A2723]">{t.latencyMs} ms</div>
                    <div className="text-[#9E988F]">{t.totalTokens} tokens</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-3 border-t border-[#EAE5DE] flex justify-between items-center text-xs text-[#706B65]">
            <span>Continuous log tracking enabled</span>
            <span className="font-mono-code text-[#C25938]">{status.version}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
