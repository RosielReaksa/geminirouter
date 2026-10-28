import React, { useState } from 'react';
import {
  Users,
  Plus,
  RefreshCw,
  Power,
  MoreVertical,
  ChevronDown,
  Terminal,
  Laptop,
  Trash2,
  LayoutList,
} from 'lucide-react';
import { GoogleAccount } from '../types';

interface AccountsPageProps {
  accounts: GoogleAccount[];
  inFlightPerAccount?: Record<string, number>;
  maxCap?: number;
  onOpenOAuthModal: () => void;
  onRefreshQuotas: () => void;
  onDeleteAccount: (id: string) => void;
  onSetDefaultAccount: (id: string) => void;
  isRefreshing: boolean;
}

export const AccountsPage: React.FC<AccountsPageProps> = ({
  accounts,
  inFlightPerAccount,
  maxCap = 10,
  onOpenOAuthModal,
  onRefreshQuotas,
  onDeleteAccount,
  onSetDefaultAccount,
  isRefreshing,
}) => {
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);

  const getQuotaTextColor = (pct: number) => {
    if (pct >= 75) return 'text-emerald-600';
    if (pct >= 40) return 'text-amber-600';
    return 'text-red-600';
  };

  const getQuotaBarBg = (pct: number) => {
    if (pct >= 75) return 'bg-emerald-500';
    if (pct >= 40) return 'bg-amber-500';
    return 'bg-red-500';
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Title & Actions Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#C25938] mb-1.5">
            <Users className="w-4 h-4" />
            <span>Google Identities</span>
          </div>
          <h2 className="font-serif-editorial text-3xl font-semibold text-[#2A2723]">
            Accounts & Model Quotas
          </h2>
          <p className="text-sm text-[#706B65] mt-1 max-w-xl">
            Manage your connected Google accounts and inspect their respective 5-hour and 7-day rate limits.
            Requests automatically failover when an account's quota gets exhausted.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={onRefreshQuotas}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-[#EAE5DE] bg-white hover:bg-[#FAF7F2] text-xs font-medium text-[#504C46] transition-colors shadow-soft disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>{isRefreshing ? 'Refreshing...' : 'Refresh Quotas'}</span>
          </button>

          <button
            onClick={onOpenOAuthModal}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#C25938] hover:bg-[#B24E2E] text-white text-xs font-medium transition-all shadow-soft"
          >
            <Plus className="w-4 h-4" />
            <span>Add Google Account</span>
          </button>
        </div>
      </div>

      {/* Account Cards */}
      <div className="space-y-4">
        {accounts.map((acc, accIndex) => {
          const isDropdownOpen = openDropdownId === acc.id;

          const defaultModels5h = [
            { name: 'Claude Sonnet 5 5', reset: '4h 31m', percentage: 100 },
            { name: 'Gpt Oss 120b', reset: '4h 31m', percentage: 100 },
            { name: 'Claude Opus 5 5', reset: '4h 31m', percentage: 100 },
            { name: 'Gemini 3 Flash', reset: '4h 32m', percentage: accIndex === 3 ? 39 : 93 },
            { name: 'Gemini 3.5 Flash Lite', reset: '4h 32m', percentage: accIndex === 3 ? 39 : 93 },
            { name: 'Gemini 3.8 Flash', reset: '4h 32m', percentage: accIndex === 3 ? 39 : 93 },
            { name: 'Gemini Flash Lite', reset: '4h 32m', percentage: accIndex === 3 ? 39 : 93 },
            { name: 'Gemini 2.5 Pro', reset: '4h 32m', percentage: accIndex === 3 ? 39 : 93 },
            { name: 'Gemini Flash Image', reset: '4h 32m', percentage: accIndex === 3 ? 39 : 93 },
          ];

          const defaultModelsWeekly = [
            { name: 'Gemini', reset: '6d 7h', percentage: accIndex === 3 ? 48 : 98 },
            { name: 'Claude and GPT', reset: '6d 18h', percentage: accIndex === 3 ? 77 : 55 },
            { name: 'Gemini 4 Argon', reset: '6d 23h', percentage: 100 },
          ];

          const models5h =
            acc.models5h && acc.models5h.length > 0 ? acc.models5h : defaultModels5h;
          const modelsWeekly =
            acc.modelsWeekly && acc.modelsWeekly.length > 0 ? acc.modelsWeekly : defaultModelsWeekly;

          return (
            <div
              key={acc.id}
              className={`bg-white rounded-2xl border p-5 shadow-soft transition-all ${
                acc.isDefaultRouting
                  ? 'border-[#C25938]/40 ring-1 ring-[#C25938]/20'
                  : 'border-[#EAE5DE] hover:border-[#DDD7CE]'
              }`}
            >
              {/* Account Header */}
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  {acc.avatarUrl ? (
                    <img
                      src={acc.avatarUrl}
                      alt={acc.name}
                      className="w-10 h-10 rounded-full border border-[#EAE5DE] object-cover"
                    />
                  ) : (
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold shadow-soft"
                      style={{ backgroundColor: acc.avatarColor || '#C25938' }}
                    >
                      {acc.avatarLetter || acc.name?.[0]?.toUpperCase() || 'A'}
                    </div>
                  )}

                  {/* Name, badges and meta */}
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-[#2A2723]">{acc.name}</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-[#DDD7CE] text-[#706B65] uppercase tracking-wider">
                        GOOGLE
                      </span>
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#F2ECE4] text-[#706B65]">
                        {acc.tier || 'Google AI Pro'}
                      </span>
                      {acc.isRecommendedNext && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#FDF6EC] text-[#C97A1E] border border-[#EAD9B8]">
                          ★ Recommended Next
                        </span>
                      )}
                      {acc.isDefaultRouting && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#EEF5F1] text-[#4E7B62] border border-[#D3E4DB]">
                          Primary
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs text-[#706B65] mt-1 flex-wrap">
                      <span>{acc.email}</span>
                      <span className="text-[#DDD7CE]">·</span>

                      {acc.clientTarget === 'CLI' && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#4E7B62] bg-[#EEF5F1] border border-[#D3E4DB] rounded px-1.5 py-0.5">
                          <Terminal className="w-3 h-3" />
                          CLI
                        </span>
                      )}
                      {acc.clientTarget === 'IDE' && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#C25938] bg-[#FAF2EF] border border-[#F2DDD5] rounded px-1.5 py-0.5">
                          <Laptop className="w-3 h-3" />
                          IDE
                        </span>
                      )}
                      {(!acc.clientTarget || acc.clientTarget === 'Not in use') && (
                        <span className="text-[11px] text-[#9E988F]">Not in use</span>
                      )}

                      <span className="text-[#DDD7CE]">·</span>
                      <span className="text-[11px] text-[#9E988F]">
                        {acc.credits ?? 0} credits
                      </span>

                      <span className="text-[#DDD7CE]">·</span>
                      {(() => {
                        const inFlight = inFlightPerAccount?.[acc.id] ?? 0;
                        return (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] font-mono-code px-2 py-0.5 rounded bg-[#FAF7F2] border border-[#EAE5DE] text-[#706B65]"
                            title={`Current concurrent in-flight requests on this account: ${inFlight} of max ${maxCap}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${inFlight > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-stone-300'}`} />
                            <span>Leases: {inFlight} / {maxCap}</span>
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Right Actions */}
                <div className="flex items-center gap-1.5">
                  <div className="relative">
                    <button
                      onClick={() => setOpenDropdownId(isDropdownOpen ? null : acc.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#F2ECE4] hover:bg-[#EAE1D5] border border-[#DDD7CE] text-xs font-semibold text-[#2A2723] transition-colors"
                    >
                      <Power className="w-3 h-3 text-[#4E7B62]" />
                      <span>Use</span>
                      <ChevronDown className="w-3 h-3 text-[#706B65]" />
                    </button>

                    {isDropdownOpen && (
                      <div className="absolute right-0 mt-1 w-48 rounded-xl bg-white border border-[#EAE5DE] shadow-modal py-1 z-20 text-xs">
                        <button
                          onClick={() => {
                            onSetDefaultAccount(acc.id);
                            setOpenDropdownId(null);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-[#FAF7F2] text-[#2A2723] flex items-center justify-between"
                        >
                          <span>Set Primary Gateway</span>
                          {acc.isDefaultRouting && (
                            <span className="text-[10px] text-[#4E7B62] font-bold">Active</span>
                          )}
                        </button>
                        <button
                          onClick={() => {
                            onDeleteAccount(acc.id);
                            setOpenDropdownId(null);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-[#FAF7F2] text-red-600 flex items-center gap-2 border-t border-[#EAE5DE]"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Remove Account</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => setOpenDropdownId(isDropdownOpen ? null : acc.id)}
                    title="Account options"
                    className="p-1.5 rounded-lg hover:bg-[#F2ECE4] text-[#706B65] hover:text-[#2A2723] transition-colors"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 5-Hour Quota Grid */}
              {models5h.length > 0 && (
                <div className="flex items-start gap-3 pt-3 border-t border-[#EAE5DE]">
                  <span className="w-8 shrink-0 text-[10px] font-bold text-[#9E988F] pt-0.5 uppercase tracking-wide flex items-center gap-1">
                    <LayoutList className="w-3 h-3" />
                    5h
                  </span>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-2.5 flex-1">
                    {models5h.map((m, idx) => (
                      <div key={idx} className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center justify-between gap-1.5 text-[10px] leading-tight">
                          <span className="truncate text-[#504C46] font-medium" title={m.name}>
                            {m.name}
                          </span>
                          <span className="font-mono-code text-[9px] shrink-0 text-[#9E988F]">
                            {m.reset}
                          </span>
                          <span className={`font-mono-code text-[10px] font-bold shrink-0 ${getQuotaTextColor(m.percentage)}`}>
                            {m.percentage}%
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-[#F2ECE4] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${getQuotaBarBg(m.percentage)}`}
                            style={{ width: `${Math.min(100, Math.max(0, m.percentage))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Weekly Quota Grid */}
              {modelsWeekly.length > 0 && (
                <div className="flex items-start gap-3 pt-3 mt-2 border-t border-[#EAE5DE]">
                  <span className="w-8 shrink-0 text-[10px] font-bold text-[#9E988F] pt-0.5 uppercase tracking-wide">
                    Wk
                  </span>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-2.5 flex-1">
                    {modelsWeekly.map((w, idx) => (
                      <div key={idx} className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center justify-between gap-1.5 text-[10px] leading-tight">
                          <span className="truncate text-[#504C46] font-medium" title={w.name}>
                            {w.name}
                          </span>
                          <span className="font-mono-code text-[9px] shrink-0 text-[#9E988F]">
                            {w.reset}
                          </span>
                          <span className={`font-mono-code text-[10px] font-bold shrink-0 ${getQuotaTextColor(w.percentage)}`}>
                            {w.percentage}%
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-[#F2ECE4] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${getQuotaBarBg(w.percentage)}`}
                            style={{ width: `${Math.min(100, Math.max(0, w.percentage))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
