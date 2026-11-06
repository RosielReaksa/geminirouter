import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Gauge,
  KeyRound,
  Loader2,
  Network,
  Plus,
  Power,
  RefreshCw,
  Sparkles,
  Trash2,
  XCircle,
  Users,
  Zap,
} from 'lucide-react';
import {
  GeminiApiConfig,
  GeminiApiKey,
  GeminiApiSharedRouting,
  GeminiApiTestResult,
} from '../types';
import { api } from '../services/api';

interface GeminiApiPageProps {
  onReady?: () => void;
}

const FALLBACK_CONFIG: GeminiApiConfig = {
  models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
  limits: { rpm: 15, tpm: 250000, rpd: 500 },
  queue: { depth: 0, active: 0, maxWaitMs: 30000, maxConcurrentPerKey: 4, maxQueueSize: 200 },
  proxy: { enabled: false, available: 0, hasApiKey: false, assigned: 0 },
  sharedRouting: 'balanced',
  keys: [],
};

const MODEL_META: Record<string, { name: string; note: string }> = {
  'gemini-3.1-flash-lite': {
    name: 'Gemini 3.1 Flash Lite',
    note: 'Fast, low-cost text model for chat and extraction.',
  },
  'gemini-3.5-flash-lite': {
    name: 'Gemini 3.5 Flash Lite',
    note: 'Newest lite model, served by AI Studio keys or connected accounts.',
  },
};

const ROUTING_OPTIONS: Array<{
  key: GeminiApiSharedRouting;
  label: string;
  note: string;
}> = [
  {
    key: 'balanced',
    label: 'Balanced',
    note: 'Alternates calls between AI Studio keys and connected Google accounts.',
  },
  {
    key: 'keys',
    label: 'API keys',
    note: 'Only the AI Studio keys serve these two models.',
  },
  {
    key: 'accounts',
    label: 'Accounts',
    note: 'Only the connected Google accounts serve these two models.',
  },
];

const formatCompact = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
};

const formatWhen = (iso?: string): string => {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'Never';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const barTone = (percent: number): string => {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 65) return 'bg-amber-500';
  return 'bg-emerald-500';
};

const UsageBar: React.FC<{ label: string; used: number; limit: number; suffix?: string }> = ({
  label,
  used,
  limit,
  suffix,
}) => {
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="min-w-[120px] flex-1">
      <div className="mb-1 flex items-center justify-between text-[10px] text-[#9E988F]">
        <span>{label}</span>
        <span className="font-mono-code">
          {formatCompact(used)}
          {suffix ? ` ${suffix}` : ''} / {formatCompact(limit)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[#F2ECE4]">
        <div className={`h-full rounded-full ${barTone(percent)}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
};

export const GeminiApiPage: React.FC<GeminiApiPageProps> = ({ onReady }) => {
  const [config, setConfig] = useState<GeminiApiConfig>(FALLBACK_CONFIG);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [keysText, setKeysText] = useState('');
  const [busy, setBusy] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, GeminiApiTestResult>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadConfig = useCallback(async () => {
    try {
      const { data } = await api.getGeminiApiConfig();
      setConfig(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load the Gemini API configuration.');
    } finally {
      setLoading(false);
      onReady?.();
    }
  }, [onReady]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const keys = config.keys;
  const activeKeys = keys.filter((key) => key.enabled && (!key.usage.cooldownUntil || key.usage.cooldownUntil <= now));
  const totalRequests = keys.reduce((sum, key) => sum + key.usage.requestsToday, 0);
  const totalTokens = keys.reduce((sum, key) => sum + key.usage.tokensToday, 0);

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    const parsed = keysText
      .split(/\r?\n/)
      .map((key) => key.trim())
      .filter(Boolean);
    if (parsed.length === 0) {
      setError('Paste at least one AI Studio API key (one per line).');
      return;
    }

    setBusy(true);
    try {
      const data = await api.addGeminiApiKeys({
        label: label.trim() || undefined,
        keys: parsed,
      });
      setConfig(data);
      setKeysText('');
      setLabel('');
      const added = data.added ?? 0;
      const skipped = data.skipped ?? 0;
      setMessage(
        `Added ${added} key${added === 1 ? '' : 's'}${
          skipped > 0 ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''
        }.`,
      );
    } catch (err: any) {
      setError(err?.message || 'Could not add the API key.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (key: GeminiApiKey) => {
    setError(null);
    setMessage(null);
    try {
      const data = await api.updateGeminiApiKey(key.id, { enabled: !key.enabled });
      setConfig(data);
    } catch (err: any) {
      setError(err?.message || 'Could not update the key.');
    }
  };

  const handleDelete = async (key: GeminiApiKey) => {
    if (!window.confirm(`Remove ${key.label}? Its requests will fall back to the account pool.`)) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const data = await api.deleteGeminiApiKey(key.id);
      setConfig(data);
      setMessage(`Removed ${key.label}.`);
    } catch (err: any) {
      setError(err?.message || 'Could not remove the key.');
    }
  };

  const handleTest = async (key: GeminiApiKey) => {
    setTestingId(key.id);
    setError(null);
    try {
      const result = await api.testGeminiApiKey(key.id);
      setTestResults((current) => ({ ...current, [key.id]: result }));
      if (result.ok) {
        setMessage(
          `${key.label}: answered in ${result.latencyMs} ms${
            result.proxy ? ` via ${result.proxy.address} (${result.proxy.country ?? '??'})` : ' (direct)'
          }.`,
        );
      } else {
        setError(`${key.label}: ${result.error || 'test failed'}`);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not test the key.');
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleProxy = async () => {
    setProxyBusy(true);
    setError(null);
    setMessage(null);
    try {
      const data = await api.setGeminiApiProxy(!config.proxy.enabled);
      setConfig(data);
      setMessage(
        data.proxy.enabled
          ? `Key proxies enabled — ${data.proxy.assigned} key(s) assigned across ${data.proxy.available} IPs.`
          : 'Key proxies disabled; key traffic goes direct.',
      );
    } catch (err: any) {
      setError(err?.message || 'Could not change the key proxy setting.');
    } finally {
      setProxyBusy(false);
    }
  };

  const handleRouting = async (routing: GeminiApiSharedRouting) => {
    if (routing === config.sharedRouting) return;
    setRoutingBusy(true);
    setError(null);
    setMessage(null);
    try {
      const data = await api.setGeminiApiRouting(routing);
      setConfig(data);
      setMessage(
        routing === 'balanced'
          ? 'Balanced routing enabled: keys and connected accounts share these two models.'
          : routing === 'keys'
            ? 'These two models now use AI Studio keys only.'
            : 'These two models now use connected Google accounts only.',
      );
    } catch (err: any) {
      setError(err?.message || 'Could not change the routing mode.');
    } finally {
      setRoutingBusy(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#C25938]">
            <KeyRound className="h-4 w-4" />
            <span>Gemini API</span>
          </div>
          <h2 className="font-serif-editorial text-3xl font-semibold text-[#2A2723]">
            AI Studio Key Pool
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-[#706B65]">
            Add multiple Google AI Studio API keys. Requests for the two flash-lite models below
            are spread across the keys and respect each key&apos;s rate limits; every other model
            keeps using the account pool.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadConfig()}
          className="flex items-center gap-1.5 rounded-xl border border-[#EAE5DE] bg-[#FAF7F2] px-3 py-2 text-xs font-medium text-[#2A2723] transition-colors hover:bg-[#F2ECE4] hover:text-[#C25938]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh usage
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-4 shadow-soft">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[#9E988F]">
            <KeyRound className="h-3.5 w-3.5" /> Keys
          </div>
          <div className="mt-2 font-serif-editorial text-2xl text-[#2A2723]">{keys.length}</div>
          <div className="text-[11px] text-[#9E988F]">{activeKeys.length} active right now</div>
        </div>
        <div className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-4 shadow-soft">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[#9E988F]">
            <Activity className="h-3.5 w-3.5" /> In flight
          </div>
          <div className="mt-2 font-serif-editorial text-2xl text-[#2A2723]">
            {config.queue.active}
          </div>
          <div className="text-[11px] text-[#9E988F]">
            {config.queue.depth} waiting · {config.queue.maxConcurrentPerKey}/key
          </div>
        </div>
        <div className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-4 shadow-soft">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[#9E988F]">
            <Zap className="h-3.5 w-3.5" /> Requests today
          </div>
          <div className="mt-2 font-serif-editorial text-2xl text-[#2A2723]">
            {totalRequests.toLocaleString()}
          </div>
          <div className="text-[11px] text-[#9E988F]">
            per-key limit {config.limits.rpd.toLocaleString()}
          </div>
        </div>
        <div className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-4 shadow-soft">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[#9E988F]">
            <Sparkles className="h-3.5 w-3.5" /> Tokens today
          </div>
          <div className="mt-2 font-serif-editorial text-2xl text-[#2A2723]">
            {formatCompact(totalTokens)}
          </div>
          <div className="text-[11px] text-[#9E988F]">estimated across keys</div>
        </div>
        <div className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-4 shadow-soft">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[#9E988F]">
            <Gauge className="h-3.5 w-3.5" /> Per-key limits
          </div>
          <div className="mt-2 font-mono-code text-sm text-[#2A2723]">
            {config.limits.rpm} RPM · {formatCompact(config.limits.tpm)} TPM
          </div>
          <div className="text-[11px] text-[#9E988F]">
            {config.limits.rpd.toLocaleString()} RPD · waits up to{' '}
            {Math.round(config.queue.maxWaitMs / 1000)}s
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-5 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FAF2EF] text-[#C25938]">
              <Users className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-semibold text-[#2A2723]">Provider routing</div>
              <div className="text-xs text-[#706B65]">
                {config.sharedRouting === 'balanced'
                  ? 'Keys and connected accounts alternate on these two models.'
                  : config.sharedRouting === 'keys'
                    ? 'These two models use the AI Studio key pool only.'
                    : 'These two models use connected Google accounts only.'}
              </div>
              <div className="mt-1 text-[10px] text-[#9E988F]">
                Other Gemini models always use connected accounts. A key is only used
                for the exact model requested; a model is never substituted.
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ROUTING_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => void handleRouting(option.key)}
                disabled={routingBusy}
                title={option.note}
                className={`rounded-xl border px-3 py-2 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                  config.sharedRouting === option.key
                    ? 'border-[#C25938] bg-[#C25938] text-white'
                    : 'border-[#EAE5DE] bg-[#FAF7F2] text-[#706B65] hover:bg-[#F2ECE4] hover:text-[#2A2723]'
                }`}
              >
                {routingBusy && config.sharedRouting === option.key ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  option.label
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-5 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FAF2EF] text-[#C25938]">
              <Network className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-semibold text-[#2A2723]">Egress proxies</div>
              <div className="text-xs text-[#706B65]">
                {config.proxy.hasApiKey
                  ? `${config.proxy.available} Webshare proxies available · ${config.proxy.assigned} key(s) assigned · one static IP per key`
                  : 'Save a Webshare API key on the Proxy page to enable per-key proxies.'}
              </div>
              <div className="mt-1 text-[10px] text-[#9E988F]">
                Proxies change the egress IP only; they do not add rate-limit quota.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleToggleProxy()}
            disabled={proxyBusy || !config.proxy.hasApiKey}
            className={`flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
              config.proxy.enabled
                ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                : 'border-[#C25938] bg-[#C25938] text-white hover:border-[#a5462b] hover:bg-[#a5462b]'
            }`}
          >
            {proxyBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Network className="h-3.5 w-3.5" />
            )}
            {config.proxy.enabled ? 'Disable proxies' : 'Enable proxies'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div className="text-sm text-red-700">{error}</div>
          </div>
        </div>
      )}
      {message && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <div className="text-sm text-emerald-700">{message}</div>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {config.models.map((id) => {
          const meta = MODEL_META[id] ?? { name: id, note: 'Served by the AI Studio key pool.' };
          return (
            <div key={id} className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-5 shadow-soft">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#FAF2EF] text-[#C25938]">
                    <Sparkles className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-[#2A2723]">{meta.name}</div>
                    <div className="font-mono-code text-[10px] text-[#9E988F]">{id}</div>
                  </div>
                </div>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                  {keys.length > 0 ? 'key pool' : 'add a key'}
                </span>
              </div>
              <p className="mt-3 text-xs text-[#706B65]">{meta.note}</p>
              <div className="mt-3 flex flex-wrap gap-2 font-mono-code text-[10px] text-[#706B65]">
                <span className="rounded bg-[#FAF7F2] px-2 py-1">{config.limits.rpm} RPM</span>
                <span className="rounded bg-[#FAF7F2] px-2 py-1">
                  {formatCompact(config.limits.tpm)} TPM
                </span>
                <span className="rounded bg-[#FAF7F2] px-2 py-1">
                  {config.limits.rpd} RPD
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <form
        onSubmit={handleAdd}
        className="rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] p-6 shadow-soft"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-[#2A2723]">
          <Plus className="h-4 w-4 text-[#C25938]" />
          Add API keys
        </div>
        <p className="mt-1 text-xs text-[#706B65]">
          Create keys at{' '}
          <a
            href="https://aistudio.google.com/api-keys"
            target="_blank"
            rel="noreferrer"
            className="text-[#C25938] hover:underline"
          >
            aistudio.google.com/api-keys
          </a>
          . Paste one per line to add several at once; keys are stored server-side and shown
          masked.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-[240px_1fr_auto] md:items-end">
          <label className="block">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-[#706B65]">
              Label (optional)
            </span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. reaksamilk"
              className="w-full rounded-xl border border-[#EAE5DE] bg-[#FAF7F2] px-3 py-2.5 text-xs text-[#2A2723] focus:border-[#C25938] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-[#706B65]">
              API keys (one per line)
            </span>
            <textarea
              value={keysText}
              onChange={(event) => setKeysText(event.target.value)}
              rows={3}
              placeholder={'AIza...\nAQ.Ab8...'}
              spellCheck={false}
              className="w-full resize-y rounded-xl border border-[#EAE5DE] bg-[#FAF7F2] px-3 py-2.5 font-mono-code text-xs text-[#2A2723] focus:border-[#C25938] focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className={`flex items-center justify-center gap-1.5 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all ${
              busy
                ? 'cursor-not-allowed border-stone-200 bg-stone-200 text-stone-400'
                : 'border-[#C25938] bg-[#C25938] text-white hover:border-[#a5462b] hover:bg-[#a5462b]'
            }`}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {busy ? 'Adding…' : 'Add keys'}
          </button>
        </div>
      </form>

      <div className="overflow-hidden rounded-2xl border border-[#EAE5DE] bg-[#FFFFFF] shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#EAE5DE] px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-[#2A2723]">Keys</div>
            <div className="text-[11px] text-[#9E988F]">
              Rotation is least-used first. A key that returns 429 is benched for its
              Retry-After; requests wait up to {Math.round(config.queue.maxWaitMs / 1000)}s for a
              free slot, with {config.queue.maxConcurrentPerKey} concurrent calls per key.
            </div>
          </div>
          <span className="font-mono-code text-xs text-[#C25938]">{keys.length} key(s)</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-[#706B65]">
            <Loader2 className="h-4 w-4 animate-spin text-[#C25938]" />
            Loading keys…
          </div>
        ) : keys.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-[#706B65]">
            No keys yet. Add one above to start serving{' '}
            <span className="font-mono-code text-[#2A2723]">gemini-3.1-flash-lite</span> and{' '}
            <span className="font-mono-code text-[#2A2723]">gemini-3.5-flash-lite</span>.
          </div>
        ) : (
          <div className="divide-y divide-[#EAE5DE]">
            {keys.map((key) => {
              const cooling = Boolean(key.usage.cooldownUntil && key.usage.cooldownUntil > now);
              const status = !key.enabled ? 'Disabled' : cooling ? 'Cooling' : 'Active';
              const statusTone = !key.enabled
                ? 'border-stone-200 bg-stone-100 text-stone-500'
                : cooling
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700';
              const test = testResults[key.id];

              return (
                <div key={key.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-[#2A2723]">{key.label}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusTone}`}>
                          {status}
                        </span>
                      </div>
                      <div className="mt-1 font-mono-code text-[11px] text-[#706B65]">
                        {key.maskedKey}
                        <span className="ml-2 text-[#9E988F]">added {formatWhen(key.createdAt)}</span>
                        <span className="ml-2 text-[#9E988F]">
                          {key.proxy
                            ? `via ${key.proxy.address} (${key.proxy.country ?? '??'})`
                            : config.proxy.enabled
                              ? 'waiting for proxy'
                              : 'direct'}
                        </span>
                      </div>
                      {cooling && (
                        <div className="mt-1 text-[10px] text-amber-700">
                          Rate limited until {new Date(key.usage.cooldownUntil!).toLocaleTimeString()}
                        </div>
                      )}
                      {key.usage.lastUsedAt && (
                        <div className="mt-0.5 text-[10px] text-[#9E988F]">
                          last used {formatWhen(key.usage.lastUsedAt)}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleTest(key)}
                        disabled={testingId === key.id || !key.enabled}
                        className="flex items-center gap-1 rounded-lg border border-[#EAE5DE] bg-[#FAF7F2] px-2.5 py-1.5 text-[11px] text-[#2A2723] transition-colors hover:bg-[#F2ECE4] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {testingId === key.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Gauge className="h-3 w-3" />
                        )}
                        Test
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleToggle(key)}
                        title={key.enabled ? 'Disable key' : 'Enable key'}
                        className={`rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors ${
                          key.enabled
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            : 'border-stone-200 bg-stone-100 text-stone-500 hover:bg-stone-200'
                        }`}
                      >
                        <Power className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(key)}
                        title="Remove key"
                        className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-red-600 transition-colors hover:bg-red-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    {Object.entries(key.models ?? {}).map(([modelId, bucket]) => (
                      <div
                        key={modelId}
                        className="rounded-xl border border-[#F2ECE4] bg-[#FCFAF7] p-3"
                      >
                        <div className="flex items-center justify-between text-[10px] font-semibold text-[#706B65]">
                          <span>{modelId}</span>
                          <span
                            className={
                              bucket.active > 0 ? 'text-[#C25938]' : 'text-[#9E988F]'
                            }
                          >
                            {bucket.active} in flight
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-3">
                          <UsageBar label="RPM" used={bucket.rpm} limit={bucket.limitRpm} />
                          <UsageBar label="TPM" used={bucket.tpm} limit={bucket.limitTpm} />
                          <UsageBar label="RPD" used={bucket.rpd} limit={bucket.limitRpd} />
                        </div>
                        {bucket.cooldownUntil && bucket.cooldownUntil > now && (
                          <div className="mt-1 text-[10px] text-amber-700">
                            Cooling until{' '}
                            {new Date(bucket.cooldownUntil).toLocaleTimeString()}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {test && (
                    <div
                      className={`mt-2 text-[11px] ${
                        test.ok ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {test.ok
                        ? `Test passed in ${test.latencyMs} ms${test.sample ? `: “${test.sample}”` : ''}`
                        : `Test failed${test.status ? ` (HTTP ${test.status})` : ''}: ${test.error || 'unknown error'}`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px] leading-5 text-[#9E988F]">
        Keys are stored in the bridge state file (mode 0600) and never returned in full by the API.
        Each key gets its own free-tier budget; adding more keys raises the pool&apos;s total RPM,
        TPM and RPD. The account pool is still used for every other model.
      </p>
    </div>
  );
};

export default GeminiApiPage;