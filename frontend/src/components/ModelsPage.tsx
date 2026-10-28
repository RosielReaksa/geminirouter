import React, { useState, useEffect } from 'react';
import {
  Boxes,
  Search,
  Copy,
  Check,
  Zap,
  Loader2,
  XCircle,
  CheckCircle2,
  Cpu,
} from 'lucide-react';
import { api } from '../services/api';
import { ModelInfo, ModelTestResult } from '../types';

interface ModelsPageProps {
  gatewayOnline: boolean;
  onNavigateToGateway: () => void;
}

const PROVIDER_BADGE: Record<string, string> = {
  'Google Gemini': 'bg-[#EEF5F1] text-[#4E7B62] border-[#D3E4DB]',
  'Anthropic Claude': 'bg-[#FAF2EF] text-[#C25938] border-[#F2DDD5]',
  'OpenAI-compatible': 'bg-[#FDF6EC] text-[#C97A1E] border-[#EAD9B8]',
};

export const ModelsPage: React.FC<ModelsPageProps> = ({
  gatewayOnline,
  onNavigateToGateway,
}) => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [source, setSource] = useState<'gateway' | 'catalog'>('catalog');
  const [isLiveApi, setIsLiveApi] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  // Per-model test state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ModelTestResult>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadModels = async () => {
    setLoading(true);
    try {
      const res = await api.getModels();
      setModels(res.data.models || []);
      setSource(res.data.source);
      setIsLiveApi(res.isLiveApi);
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const handleTest = async (modelId: string) => {
    setTestingId(modelId);
    try {
      const result = await api.testModel(modelId);
      setResults((prev) => ({ ...prev, [modelId]: result }));
    } catch (err: any) {
      setResults((prev) => ({
        ...prev,
        [modelId]: {
          ok: false,
          model: modelId,
          latencyMs: 0,
          error: err?.message || 'Request failed',
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleCopy = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const providers = ['all', ...Array.from(new Set(models.map((m) => m.provider)))];

  const filteredModels = models.filter((m) => {
    const matchesSearch =
      m.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      m.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesProvider = providerFilter === 'all' || m.provider === providerFilter;
    return matchesSearch && matchesProvider;
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Title & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#C25938] mb-1.5">
            <Boxes className="w-4 h-4" />
            <span>Model Availability</span>
          </div>
          <h2 className="font-serif-editorial text-3xl font-semibold text-[#2A2723]">
            Available Models
          </h2>
          <p className="text-sm text-[#706B65] mt-1 max-w-xl">
            Real models served through your account pool. Run a live test call to verify a model
            works before pointing <code className="bg-[#F2ECE4] px-1 rounded">agy</code>, Claude Code or Codex at it.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Source badge */}
          <span
            className={`text-[11px] font-medium px-2.5 py-1 rounded-full border ${
              source === 'gateway'
                ? 'bg-[#EEF5F1] text-[#4E7B62] border-[#D3E4DB]'
                : 'bg-[#FDF6EC] text-[#C97A1E] border-[#EAD9B8]'
            }`}
            title={
              source === 'gateway'
                ? 'Model list fetched live from the running gateway'
                : 'Gateway offline — showing the known account model catalog'
            }
          >
            {source === 'gateway' ? 'Live from gateway' : 'Catalog (gateway offline)'}
          </span>
        </div>
      </div>

      {/* Gateway notice when offline */}
      {source !== 'gateway' && (
        <div className="bg-[#FDF6EC] border border-[#EAD9B8] rounded-xl px-4 py-3 text-xs text-[#C97A1E] flex items-center justify-between">
          <span>
            The gateway is not running, so these are the known models for your accounts. Test
            calls need the gateway online.
          </span>
          <button
            onClick={onNavigateToGateway}
            className="ml-4 shrink-0 underline underline-offset-2 hover:text-[#2A2723]"
          >
            Open Gateway page
          </button>
        </div>
      )}

      {/* Search & Provider filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9E988F]" />
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by model name or id..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[#EAE5DE] bg-white text-sm text-[#2A2723] placeholder-[#9E988F] focus:outline-none focus:border-[#C25938] transition-colors"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {providers.map((p) => (
            <button
              key={p}
              onClick={() => setProviderFilter(p)}
              className={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
                providerFilter === p
                  ? 'bg-[#C25938] text-white border-[#C25938]'
                  : 'bg-white text-[#504C46] border-[#EAE5DE] hover:bg-[#FAF7F2]'
              }`}
            >
              {p === 'all' ? 'All providers' : p}
            </button>
          ))}
        </div>
      </div>

      {/* Model Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-[#9E988F] text-sm gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Loading models...</span>
        </div>
      ) : filteredModels.length === 0 ? (
        <div className="text-center py-16 text-sm text-[#9E988F]">
          No models match your search.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredModels.map((m) => {
            const result = results[m.id];
            const isTesting = testingId === m.id;

            return (
              <div
                key={m.id}
                className="bg-white border border-[#EAE5DE] rounded-2xl p-4 shadow-soft hover:border-[#DDD7CE] transition-all flex flex-col gap-3"
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-[#2A2723]">{m.name}</span>
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                          PROVIDER_BADGE[m.provider] || 'bg-[#F2ECE4] text-[#706B65] border-[#DDD7CE]'
                        }`}
                      >
                        {m.provider}
                      </span>
                    </div>

                    <button
                      onClick={() => handleCopy(m.id)}
                      title="Copy model id"
                      className="mt-1.5 flex items-center gap-1.5 font-mono-code text-[11px] text-[#706B65] hover:text-[#C25938] transition-colors"
                    >
                      <span className="truncate">{m.id}</span>
                      {copiedId === m.id ? (
                        <Check className="w-3 h-3 text-[#4E7B62]" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>

                  {/* Live dot */}
                  <div className="flex items-center gap-1.5 shrink-0" title={m.live ? 'Listed by the live gateway' : 'From catalog'}>
                    <span
                      className={`w-2 h-2 rounded-full ${
                        m.live ? 'bg-emerald-500' : 'bg-stone-300'
                      }`}
                    />
                    <span className="text-[10px] text-[#9E988F]">{m.live ? 'live' : 'catalog'}</span>
                  </div>
                </div>

                {/* Specs */}
                <div className="flex items-center gap-4 text-[11px] text-[#706B65]">
                  <span className="flex items-center gap-1">
                    <Cpu className="w-3 h-3 text-[#9E988F]" />
                    context: <span className="font-mono-code">{(m.contextLength / 1000).toFixed(0)}k</span>
                  </span>
                  <span>
                    max out: <span className="font-mono-code">{(m.maxOutputTokens / 1000).toFixed(0)}k</span>
                  </span>
                </div>

                {/* Test action + result */}
                <div className="border-t border-[#EAE5DE] pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => handleTest(m.id)}
                      disabled={isTesting}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#F2ECE4] hover:bg-[#EAE1D5] border border-[#DDD7CE] text-xs font-semibold text-[#2A2723] transition-colors disabled:opacity-60"
                    >
                      {isTesting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Zap className="w-3.5 h-3.5 text-[#C97A1E]" />
                      )}
                      <span>{isTesting ? 'Testing...' : 'Test call'}</span>
                    </button>

                    {result && (
                      <span
                        className={`text-[11px] font-medium flex items-center gap-1 ${
                          result.ok ? 'text-[#4E7B62]' : 'text-red-600'
                        }`}
                      >
                        {result.ok ? (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5" />
                        )}
                        {result.ok ? `Works · ${result.latencyMs}ms` : 'Failed'}
                      </span>
                    )}
                  </div>

                  {result && (
                    <div
                      className={`mt-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed break-words ${
                        result.ok
                          ? 'bg-[#EEF5F1] text-[#4E7B62] border border-[#D3E4DB]'
                          : 'bg-[#FAF2EF] text-[#C25938] border border-[#F2DDD5]'
                      }`}
                    >
                      {result.ok ? (
                        <>
                          <span className="font-semibold">Reply:</span>{' '}
                          <span className="font-mono-code">{result.sample}</span>
                        </>
                      ) : (
                        result.error
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
