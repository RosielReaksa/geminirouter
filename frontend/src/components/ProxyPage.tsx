import React, { useEffect, useState, useCallback } from 'react';
import {
  Network,
  Save,
  RotateCcw,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Loader2,
  Copy,
  Ban,
  Clock,
} from 'lucide-react';
import { ProxyConfig, ProxyHealthStatus, ProxyListSummary } from '../types';
import { api } from '../services/api';

interface ProxyPageProps {
  onReady?: () => void;
}

export const ProxyPage: React.FC<ProxyPageProps> = ({ onReady }) => {
  const [config, setConfig] = useState<ProxyConfig>({
    enabled: false,
    hasApiKey: false,
    proxyCount: 0,
    accountCount: 0,
    lastFetchedAt: 0,
    fetchIntervalMs: 600000,
    lastError: null,
  });
  const [proxyList, setProxyList] = useState<ProxyListSummary>({
    enabled: false,
    proxies: [],
  });
  const [formEnabled, setFormEnabled] = useState(false);
  const [formApiKey, setFormApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const { data } = await api.getProxyConfig();
      setConfig(data);
      setFormEnabled(data.enabled);
      // The key is write-only: the server never returns it, so the field stays
      // blank and `hasApiKey` tells us whether one is stored server-side.
      setFormApiKey('');
      setHasKey(Boolean(data.hasApiKey));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load proxy configuration.');
    } finally {
      onReady?.();
    }
  }, [onReady]);

  const fetchProxyList = useCallback(async () => {
    try {
      const { data } = await api.getProxyList();
      setProxyList(data);
    } catch {
      // silent — proxy list is supplementary
    }
  }, []);

  useEffect(() => {
    // Deferred one microtask: both loaders set state after their await, and the
    // deferral keeps the effect free of synchronous state writes.
    void Promise.resolve().then(fetchConfig);
    void Promise.resolve().then(fetchProxyList);
  }, [fetchConfig, fetchProxyList]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const trimmedKey = formApiKey.trim();
      // Only send the key when the user typed a new one; a blank field keeps
      // the key already stored server-side.
      const { data } = await api.updateProxyConfig({
        enabled: formEnabled,
        ...(trimmedKey ? { webshareApiKey: trimmedKey } : {}),
      });
      setConfig(data);
      setHasKey(Boolean(data.hasApiKey));
      setFormApiKey('');
      if (data.error) {
        setError(data.error);
      } else if (data.sync && data.sync.reloaded === false) {
        setError(
          'Assignments saved, but the running core did not reload them. Restart geminirouter-core to apply the new proxies.',
        );
      } else if (data.sync && data.sync.failed > 0) {
        setError(
          `Saved, but the core refused ${data.sync.failed} account update(s): ${data.sync.errors.join('; ')}`,
        );
      } else {
        setSaved(true);
        setMessage(
          data.sync
            ? `Proxy configuration saved — ${data.sync.applied} account${data.sync.applied === 1 ? '' : 's'} updated.`
            : 'Proxy configuration saved.',
        );
        setTimeout(() => { setSaved(false); setMessage(null); }, 3000);
      }
      await fetchProxyList();
    } catch (err: any) {
      setError(err?.message || 'Failed to save proxy configuration.');
    } finally {
      setSaving(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const { data } = await api.refreshProxyList();
      if (!data.ok) {
        setError(data.error || 'Failed to refresh the proxy list from Webshare.');
      } else if (data.reloaded === false) {
        setError(
          'Inventory refreshed, but the running core did not reload it. Restart geminirouter-core to apply the new proxies.',
        );
      } else if ((data.failed ?? 0) > 0) {
        setError(
          `Inventory refreshed, but the core refused ${data.failed} account update(s): ${(data.errors ?? []).join('; ')}`,
        );
      } else {
        setMessage(
          `Proxy list refreshed — ${data.proxyCount} prox${data.proxyCount === 1 ? 'y' : 'ies'} · ${data.applied ?? 0} account${(data.applied ?? 0) === 1 ? '' : 's'} updated.`,
        );
        setTimeout(() => setMessage(null), 3000);
      }
      await Promise.all([fetchConfig(), fetchProxyList()]);
    } catch (err: any) {
      setError(err?.message || 'Failed to refresh the proxy list from Webshare.');
    } finally {
      setRefreshing(false);
    }
  };

  const handleProxyStatus = async (
    proxy: ProxyListSummary['proxies'][number],
    action: 'quarantine' | 'retire' | 'restore',
  ) => {
    const key = `${proxy.address}:${proxy.port}`;
    setStatusBusy(key);
    setError(null);
    setMessage(null);
    try {
      const { data } = await api.setProxyStatus(proxy.address, proxy.port, action);
      setProxyList(data);
      setMessage(
        action === 'quarantine'
          ? `${key} quarantined for 24 hours. Accounts and keys on it were moved to healthy IPs.`
          : action === 'retire'
            ? `${key} retired. It will not be assigned again until restored.`
            : `${key} restored and available for assignment.`,
      );
      setTimeout(() => setMessage(null), 5000);
      await fetchConfig();
    } catch (err: any) {
      setError(err?.message || 'Could not update the proxy status.');
    } finally {
      setStatusBusy(null);
    }
  };

  const toggleKeyVisibility = () => setShowKey((p) => !p);

  const copyKey = () => {
    if (!formApiKey) return;
    navigator.clipboard.writeText(formApiKey);
    setMessage('API key copied to clipboard.');
    setTimeout(() => setMessage(null), 2000);
  };

  const statusLabel: Record<ProxyHealthStatus, string> = {
    assigned: 'In use',
    available: 'Available',
    cooling: 'Cooling',
    retired: 'Retired',
  };

  const statusClass: Record<ProxyHealthStatus, string> = {
    assigned: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    available: 'bg-stone-50 text-stone-600 border-stone-200',
    cooling: 'bg-amber-50 text-amber-700 border-amber-200',
    retired: 'bg-red-50 text-red-700 border-red-200',
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Title & Introduction */}
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#C25938] mb-1.5">
          <Network className="w-4 h-4" />
          <span>Proxy Configuration</span>
        </div>
        <h2 className="font-serif-editorial text-3xl font-semibold text-[#2A2723]">
          Webshare Proxy Routing
        </h2>
        <p className="text-sm text-[#706B65] mt-1 max-w-xl">
          Route each connected account's upstream traffic through its own Webshare
          IP. The proxy is applied per account in the core, so quota checks,
          cooldown and failover keep accounting for real traffic.
        </p>
      </div>

      {/* Status banner */}
      {config.enabled && config.proxyCount > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200">
          <ShieldAlert className="w-5 h-5 text-emerald-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[#2A2723]">Proxy routing is active</div>
            <div className="text-xs text-emerald-700 mt-0.5">
              {config.proxyCount} proxy{config.proxyCount !== 1 ? 's' : ''} configured · {config.accountCount} account(s) assigned
            </div>
          </div>
        </div>
      )}
      {config.enabled && config.proxyCount === 0 && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
          <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[#2A2723]">Proxy mode enabled, no proxies assigned</div>
            <div className="text-xs text-amber-700 mt-0.5">
              Save your Webshare API key and refresh to assign proxies to accounts.
            </div>
          </div>
        </div>
      )}
      {!config.enabled && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-stone-50 border border-stone-200">
          <ShieldAlert className="w-5 h-5 text-stone-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[#2A2723]">Proxy routing is disabled</div>
            <div className="text-xs text-[#706B65] mt-0.5">
              All traffic routes through the local core gateway (single IP).
            </div>
          </div>
        </div>
      )}

      {config.lastError && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
          <XCircle className="w-5 h-5 text-amber-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[#2A2723]">Last Webshare refresh failed</div>
            <div className="text-xs text-amber-700 mt-0.5 break-words">{config.lastError}</div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-start gap-2">
            <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="text-sm text-red-700">{error}</div>
          </div>
        </div>
      )}

      {/* Configuration form */}
      <form onSubmit={handleSave} className="space-y-6">
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft space-y-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#2A2723]">
            <ShieldAlert className="w-4 h-4 text-[#C25938]" />
            <span>Proxy Mode</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={formEnabled}
              onClick={() => setFormEnabled(!formEnabled)}
              disabled={saving}
              className={`relative inline-flex w-11 h-6 shrink-0 cursor-pointer rounded-full border-2 transition-colors ${formEnabled ? 'bg-emerald-500 border-emerald-500' : 'bg-stone-200 border-stone-300'} ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <span
                className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  formEnabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span className="text-sm text-[#706B65]">
              {formEnabled ? 'Enabled — route accounts through Webshare proxies' : 'Disabled — direct gateway routing'}
            </span>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#706B65] mb-1.5">
              Webshare API Key
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
                disabled={saving}
                placeholder={hasKey ? 'Leave blank to keep the stored key' : 'your-webshare-api-key'}
                className="w-full bg-[#FAF7F2] border border-[#EAE5DE] rounded-xl pl-10 pr-10 py-2.5 text-xs text-[#2A2723] focus:outline-none focus:border-[#C25938] disabled:bg-stone-100 disabled:text-stone-400"
              />
              <button
                type="button"
                onClick={toggleKeyVisibility}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[#706B65] hover:text-[#2A2723]"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                onClick={copyKey}
                disabled={!formApiKey || saving}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-[#706B65] hover:text-[#C25938] disabled:opacity-40"
                title="Copy API key"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
            {hasKey && !formApiKey && (
              <div className="mt-1 text-[10px] text-stone-400">
                {'•'.repeat(20)} · key stored server-side
              </div>
            )}
            <p className="text-[10px] text-stone-400 mt-1">
              Your Webshare API key from <a href="https://dashboard.webshare.io" target="_blank" rel="noreferrer" className="text-[#C25938] hover:underline">dashboard.webshare.io</a>. Stored server-side only; never returned to the browser.
            </p>
          </div>

          <div className="pt-3 flex items-center gap-3">
            <button
              type="submit"
              disabled={saving || (formEnabled && !hasKey && !formApiKey.trim())}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50 ${
                saving || (formEnabled && !hasKey && !formApiKey.trim())
                  ? 'bg-stone-200 text-stone-400 border border-stone-200 cursor-not-allowed'
                  : 'bg-[#C25938] text-white border border-[#C25938] hover:bg-[#a5462b] hover:border-[#a5462b]'
              }`}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <Save className="w-3.5 h-3.5 shrink-0" />}
              {saving ? 'Saving…' : 'Save Configuration'}
            </button>
            {saved && (
              <span className="text-xs text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Saved
              </span>
            )}
          </div>
        </div>

        {/* Refresh proxy list */}
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft space-y-3">
          <div className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-[#C25938]" />
            <span className="text-sm font-semibold text-[#2A2723]">Refresh Proxy List</span>
          </div>
          <p className="text-[10px] text-stone-400">
            Fetches the latest proxy inventory from Webshare, assigns the least-used proxy to each account, and applies the result to the core.
          </p>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || (!hasKey && !formApiKey.trim())}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50 ${
              refreshing || (!hasKey && !formApiKey.trim())
                ? 'bg-stone-200 text-stone-400 border border-stone-200 cursor-not-allowed'
                : 'bg-[#FAF7F2] border border-[#EAE5DE] text-[#2A2723] hover:bg-[#F2ECE4] hover:text-[#C25938]'
            }`}
          >
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 mr-2" /> : <RotateCcw className="w-3.5 h-3.5 shrink-0 mr-2" />}
            Refresh from Webshare
          </button>
          <div className="text-[10px] text-stone-400">
            Last fetched: {config.lastFetchedAt ? new Date(config.lastFetchedAt).toLocaleTimeString() : 'Never'}
            {config.fetchIntervalMs > 0 && <> · auto-refresh every {Math.max(1, Math.round(config.fetchIntervalMs / 60000))} min</>}
          </div>
        </div>
      </form>

      {/* Proxy list */}
      {proxyList.proxies.length > 0 && (
        <div className="bg-[#FFFFFF] border border-[#EAE5DE] rounded-2xl p-6 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-[#2A2723]">Assigned Proxies</h3>
            <span className="text-xs font-mono text-[#C25938]">{proxyList.proxies.length} proxy{proxyList.proxies.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#FAF7F2] text-[#706B65] font-semibold border-b border-[#EAE5DE]">
                <tr>
                  <th className="py-3 px-4">Address</th>
                  <th className="py-3 px-4">Port</th>
                  <th className="py-3 px-4">Country</th>
                  <th className="py-3 px-4">Assigned Accounts</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EAE5DE] text-[#2A2723]">
                {proxyList.proxies.map((p, i) => (
                  <tr key={i} className="hover:bg-[#FAF9F5]/70 transition-colors">
                    <td className="py-3.5 px-4 font-mono-code text-[#504C46]">{p.address}</td>
                    <td className="py-3.5 px-4 font-mono-code text-[#504C46]">{p.port}</td>
                    <td className="py-3.5 px-4 font-mono-code text-[#504C46] uppercase">{p.country}</td>
                    <td className="py-3.5 px-4 font-mono-code text-[#504C46]">
                      {p.assignedTo ? p.assignedTo : <span className="text-stone-400">—</span>}
                    </td>
                  <td className="py-3.5 px-4">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass[p.status]}`}
                      >
                        {p.status === 'cooling' && <Clock className="h-3 w-3" />}
                        {p.status === 'retired' && <Ban className="h-3 w-3" />}
                        {statusLabel[p.status]}
                      </span>
                      {p.status === 'cooling' && p.quarantineUntil && (
                        <div className="mt-1 text-[10px] text-[#9E988F]">
                          until {new Date(p.quarantineUntil).toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-end gap-1.5">
                        {(p.status === 'cooling' || p.status === 'retired') && (
                          <button
                            type="button"
                            onClick={() => void handleProxyStatus(p, 'restore')}
                            disabled={statusBusy !== null}
                            className="inline-flex items-center gap-1 rounded-lg border border-[#EAE5DE] bg-[#FAF7F2] px-2 py-1 text-[10px] font-medium text-[#504C46] transition-colors hover:bg-[#F2ECE4] hover:text-[#C25938] disabled:opacity-50"
                          >
                            {statusBusy === `${p.address}:${p.port}` ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3" />
                            )}
                            Restore
                          </button>
                        )}
                        {p.status !== 'cooling' && p.status !== 'retired' && (
                          <button
                            type="button"
                            onClick={() => void handleProxyStatus(p, 'quarantine')}
                            disabled={statusBusy !== null}
                            className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
                          >
                            {statusBusy === `${p.address}:${p.port}` ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Clock className="h-3 w-3" />
                            )}
                            Quarantine
                          </button>
                        )}
                        {p.status !== 'retired' && (
                          <button
                            type="button"
                            onClick={() => void handleProxyStatus(p, 'retire')}
                            disabled={statusBusy !== null}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
                          >
                            {statusBusy === `${p.address}:${p.port}` ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Ban className="h-3 w-3" />
                            )}
                            Retire
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-[10px] text-[#9E988F]">
            Removing a banned account quarantines its IP for 24 hours before another account or API key can use it.
            Retire an IP permanently when it has caused repeat bans; a retired IP is never assigned until restored.
          </p>
        </div>
      )}

      {message && (
        <div className="text-xs px-3 py-1.5 rounded-xl bg-[#FAF2EF] text-[#C25938] border border-[#F2DDD5] font-medium animate-in fade-in">
          {message}
        </div>
      )}
    </div>
  );
};

export default ProxyPage;
