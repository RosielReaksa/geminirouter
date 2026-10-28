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
  AlertTriangle,
  ExternalLink,
  Zap,
} from 'lucide-react';
import { GoogleAccount } from '../types';
import { api } from '../services/api';

interface AccountsPageProps {
  accounts: GoogleAccount[];
  inFlightPerAccount?: Record<string, number>;
  maxCap?: number;
  onOpenOAuthModal: () => void;
  onRefreshQuotas: () => void;
  onDeleteAccount: (id: string) => void;
  onSetDefaultAccount: (id: string) => void;
  onUpdateAccounts?: (accounts: GoogleAccount[]) => void;
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
  onUpdateAccounts,
  isRefreshing,
}) => {
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [validatingAccountId, setValidatingAccountId] = useState<string | null>(null);
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null);

  const handleTestAccount = async (accountId: string) => {
    setTestingAccountId(accountId);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-2.5-flash' }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Test call failed: ${data.error || 'Unknown error'}`);
      }
      // Silently fetch fresh accounts data without wiping state
      const { data: freshList } = await api.getAccounts();
      if (freshList && freshList.length > 0 && onUpdateAccounts) {
        onUpdateAccounts(freshList);
      }
    } catch (err: any) {
      alert('Error testing account: ' + err.message);
    } finally {
      setTestingAccountId(null);
    }
  };

  const handleOpenValidationUrl = async (accountId: string) => {
    setValidatingAccountId(accountId);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/validation-url`);
      const data = await res.json();
      if (data.ok && data.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer');
      } else {
        alert(data.error || 'No validation URL returned by Google.');
      }
    } catch (err: any) {
      alert('Error fetching validation URL: ' + err.message);
    } finally {
      setValidatingAccountId(null);
    }
  };

  const handleSwitchClient = async (accountId: string, appTarget: 'ide' | 'agy' | 'classic') => {
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appTarget }),
      });
      const data = await res.json();
      if (data.success) {
        onRefreshQuotas();
      } else {
        alert(data.error || 'Failed to switch client target');
      }
    } catch (err: any) {
      alert('Error switching client: ' + err.message);
    }
  };

  const formatResetTime = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const diffMs = new Date(dateStr).getTime() - Date.now();
      if (diffMs <= 0) return 'reset soon';
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const days = Math.floor(hours / 24);
      if (days > 0) return `reset: ${days}d ${hours % 24}h`;
      return `reset: ${hours}h ${mins}m`;
    } catch {
      return dateStr;
    }
  };

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
            <span>{isRefreshing ? 'Testing & Refreshing...' : 'Refresh Quotas & Test All'}</span>
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

      {/* Account Cards or Clean Empty State */}
      {accounts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#EAE5DE] p-12 text-center shadow-soft">
          <div className="w-12 h-12 rounded-2xl bg-[#FAF2EF] text-[#C25938] flex items-center justify-center mx-auto mb-4 border border-[#F2DDD5]">
            <Users className="w-6 h-6" />
          </div>
          <h3 className="font-serif-editorial text-2xl font-bold text-[#2A2723]">
            No Google Accounts Connected
          </h3>
          <p className="text-sm text-[#706B65] mt-1.5 max-w-md mx-auto leading-relaxed">
            Your pool is clean and empty. Click <strong>Add Google Account</strong> to sign in and begin pooling quotas.
          </p>
          <button
            onClick={onOpenOAuthModal}
            className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#C25938] hover:bg-[#B24E2E] text-white text-xs font-semibold transition-all shadow-soft"
          >
            <Plus className="w-4 h-4" />
            <span>Add Google Account</span>
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {accounts.map((acc, accIndex) => {
            const isDropdownOpen = openDropdownId === acc.id;

            const models5h =
              acc.models5h && acc.models5h.length > 0
                ? acc.models5h
                : (acc.quotas || []).map((q) => ({
                    name: q.modelName,
                    reset: q.resetTime5h,
                    percentage: q.limitIn5h > 0 ? Math.round(((q.limitIn5h - q.requestsIn5h) / q.limitIn5h) * 100) : 100,
                  }));

            const modelsWeekly = acc.modelsWeekly && acc.modelsWeekly.length > 0 ? acc.modelsWeekly : [];

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
                      {acc.hasValidationLink && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-300 flex items-center gap-1 animate-pulse">
                          <AlertTriangle className="w-3 h-3 text-amber-600" />
                          <span>Verification Required</span>
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs text-[#706B65] mt-1.5 flex-wrap">
                      <span className="font-mono-code">{acc.email}</span>
                      <span className="text-[#DDD7CE]">·</span>

                      {acc.status === 'cooldown' ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                          <span>Cooling Down (Auto-Recovers)</span>
                        </span>
                      ) : acc.hasValidationLink ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded px-2 py-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                          <span>Needs Google Verification</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          <span>Active in Parallel Pool</span>
                        </span>
                      )}

                      <span className="text-[#DDD7CE]">·</span>
                      {(() => {
                        const inFlight = inFlightPerAccount?.[acc.id] ?? 0;
                        return (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] font-mono-code px-2 py-0.5 rounded bg-[#FAF7F2] border border-[#EAE5DE] text-[#706B65]"
                            title={`Current concurrent in-flight requests on this account: ${inFlight} of max ${maxCap}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${inFlight > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-stone-300'}`} />
                            <span>Active Leases: {inFlight} / {maxCap}</span>
                          </span>
                        );
                      })()}

                      {acc.lastTestResult && (
                        <>
                          <span className="text-[#DDD7CE]">·</span>
                          <span
                            className={`inline-flex items-center gap-1 text-[11px] font-mono-code px-2 py-0.5 rounded border ${
                              acc.lastTestResult.ok
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-red-50 text-red-700 border-red-200'
                            }`}
                            title={`Last test call at ${acc.lastTestResult.timestamp} (${acc.lastTestResult.latencyMs}ms)`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${acc.lastTestResult.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
                            <span>{acc.lastTestResult.ok ? `Working (${acc.lastTestResult.latencyMs}ms)` : 'Call Failed'}</span>
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right Actions */}
                <div className="flex items-center gap-2">
                  {/* Test Call & Refresh Button for this Account */}
                  <button
                    onClick={() => handleTestAccount(acc.id)}
                    disabled={testingAccountId === acc.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#EAE5DE] text-xs font-semibold text-[#504C46] transition-colors shadow-soft disabled:opacity-50"
                    title="Make a real test call specifically through this account to check if it is working, then refresh its quotas"
                  >
                    <Zap className={`w-3.5 h-3.5 ${testingAccountId === acc.id ? 'animate-spin text-[#C25938]' : 'text-amber-600'}`} />
                    <span>{testingAccountId === acc.id ? 'Testing...' : 'Test & Refresh'}</span>
                  </button>

                  {acc.hasValidationLink && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleOpenValidationUrl(acc.id)}
                        disabled={validatingAccountId === acc.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 border border-amber-300 text-xs font-semibold text-amber-800 transition-colors shadow-soft"
                        title="Open Google security checkpoint for this account"
                      >
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                        <span>{validatingAccountId === acc.id ? 'Opening...' : 'Verify ↗'}</span>
                      </button>

                      <button
                        onClick={onOpenOAuthModal}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#EAE5DE] text-xs font-medium text-[#706B65] transition-colors"
                        title="If the checkpoint link expired, re-sign in to refresh tokens"
                      >
                        <RefreshCw className="w-3 h-3 text-[#706B65]" />
                        <span>Re-login</span>
                      </button>
                    </div>
                  )}

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
                      <div className="absolute right-0 mt-1 w-52 rounded-xl bg-white border border-[#EAE5DE] shadow-modal py-1 z-20 text-xs">
                        <div className="px-3 py-1.5 text-[10px] font-bold text-[#9E988F] uppercase tracking-wider border-b border-[#EAE5DE]">
                          Account Pool Routing
                        </div>
                        <button
                          onClick={() => {
                            onSetDefaultAccount(acc.id);
                            setOpenDropdownId(null);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-[#FAF7F2] text-[#2A2723] flex items-center justify-between"
                        >
                          <span>Set Primary Route</span>
                          {acc.isDefaultRouting && (
                            <span className="text-[10px] text-[#4E7B62] font-bold">Active</span>
                          )}
                        </button>

                        <div className="border-t border-[#EAE5DE] my-1"></div>

                        <button
                          onClick={() => {
                            onDeleteAccount(acc.id);
                            setOpenDropdownId(null);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-[#FAF7F2] text-red-600 flex items-center gap-2"
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

              {/* Official Quota Groups from v0.26/v0.27 (Gemini Models, Claude & GPT Models) */}
              {acc.quotaGroups && acc.quotaGroups.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 mb-3 border-t border-[#EAE5DE]">
                  {acc.quotaGroups.map((group, gIdx) => (
                    <div key={gIdx} className="bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-[#2A2723]">{group.displayName}</span>
                        <span className="text-[10px] text-[#9E988F]">Summary</span>
                      </div>
                      <div className="space-y-1.5">
                        {group.buckets.map((b, bIdx) => {
                          const pct = Math.round((b.remainingFraction ?? 1) * 100);
                          const resetStr = formatResetTime(b.resetTime);
                          return (
                            <div key={bIdx} className="space-y-0.5">
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-[#706B65] font-medium">{b.displayName}</span>
                                <div className="flex items-center gap-2">
                                  {resetStr && <span className="font-mono-code text-[9px] text-[#9E988F]">{resetStr}</span>}
                                  <span className={`font-mono-code font-bold ${getQuotaTextColor(pct)}`}>{pct}%</span>
                                </div>
                              </div>
                              <div className="h-1.5 w-full bg-[#EAE5DE] rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all duration-300 ${getQuotaBarBg(pct)}`}
                                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

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
                            {formatResetTime(m.reset)}
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
                            {formatResetTime(w.reset)}
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
      )}
    </div>
  );
};
