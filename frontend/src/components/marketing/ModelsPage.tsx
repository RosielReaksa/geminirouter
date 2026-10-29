import React, { useEffect, useMemo, useState } from 'react';
import { Search, ArrowUpRight, Boxes, AlertCircle } from 'lucide-react';
import { Link } from '../../router';
import { Reveal } from '../marketing/Chrome';
import { publicApi, type PublicModel, type PublicModelsResponse } from '../../services/publicApi';

const providerTone = (provider: string): { bg: string; text: string; border: string } => {
  if (provider.includes('Claude'))
    return { bg: 'bg-[#F5E7E0]', text: 'text-[#A8462A]', border: 'border-[#EBD3C7]' };
  if (provider.includes('OpenAI'))
    return { bg: 'bg-[#EEF5F1]', text: 'text-[#2F5241]', border: 'border-[#D8E3DB]' };
  return { bg: 'bg-[#EDF0F7]', text: 'text-[#3B4A6B]', border: 'border-[#DCE2EF]' };
};

const shortProvider = (p: string): string => {
  if (p.includes('Claude')) return 'Anthropic';
  if (p.includes('OpenAI')) return 'OpenAI';
  if (p.includes('Gemini')) return 'Google';
  return p;
};

const formatContext = (n: number): string => {
  if (!n) return '—';
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}K ctx`;
  return `${n} ctx`;
};

export const ModelsPage: React.FC = () => {
  const [data, setData] = useState<PublicModelsResponse | null>(null);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    publicApi.getModels().then((res) => !cancelled && setData(res));
    return () => {
      cancelled = true;
    };
  }, []);

  const models = data?.models ?? [];

  const providers = useMemo(() => {
    const set = new Set(models.map((m) => shortProvider(m.provider)));
    return ['all', ...Array.from(set).sort()];
  }, [models]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (provider !== 'all' && shortProvider(m.provider) !== provider) return false;
      if (!q) return true;
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    });
  }, [models, query, provider]);

  const grouped = useMemo(() => {
    const out: Record<string, PublicModel[]> = {};
    for (const m of filtered) {
      const key = shortProvider(m.provider);
      (out[key] ||= []).push(m);
    }
    return out;
  }, [filtered]);

  return (
    <div className="mkt-body">
      <section className="border-b border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 pt-14 pb-10">
          <Reveal>
            <div className="mkt-eyebrow mb-3">Catalog</div>
            <h1 className="mkt-display text-[40px] sm:text-[56px] text-[#191714]">
              Every model on the gateway.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-[#4A453E] max-w-xl">
              This list is read live from the running gateway, not a static page. If a model
              appears here, the gateway advertises it right now.
            </p>
          </Reveal>

          {data && (
            <Reveal delay={60}>
              <div className="mt-6 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-[#E4DED4] text-[12px]">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    data.online ? 'bg-[#4E7B62] animate-pulse' : 'bg-[#C97A1E]'
                  }`}
                />
                <span className="text-[#4A453E]">
                  {data.online
                    ? `${models.length} models live`
                    : 'Gateway offline — showing the built-in catalog'}
                </span>
              </div>
            </Reveal>
          )}
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-10">
        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between mb-8">
          <div className="relative max-w-sm w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#A39C92]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-white border border-[#E4DED4] text-[13.5px] text-[#191714] placeholder:text-[#A39C92] focus:outline-none focus:border-[#C25938] focus:ring-2 focus:ring-[#F5E7E0] transition"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {providers.map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={`px-3 py-1.5 rounded-lg text-[12.5px] transition-colors ${
                  provider === p
                    ? 'bg-[#191714] text-white'
                    : 'bg-white border border-[#E4DED4] text-[#4A453E] hover:border-[#C9C1B4]'
                }`}
              >
                {p === 'all' ? 'All' : p}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        {!data ? (
          <div className="py-20 text-center text-[13px] text-[#A39C92]">Loading the catalog…</div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center">
            <AlertCircle className="w-6 h-6 text-[#C9C1B4] mx-auto mb-3" />
            <p className="text-[13.5px] text-[#7A736A]">No models match that search.</p>
          </div>
        ) : (
          <div className="space-y-10">
            {Object.entries(grouped).map(([providerName, list]) => (
              <div key={providerName}>
                <div className="flex items-center gap-3 mb-4">
                  <h2 className="text-[13px] font-semibold text-[#191714] uppercase tracking-wider">
                    {providerName}
                  </h2>
                  <div className="flex-1 h-px bg-[#E4DED4]" />
                  <span className="text-[11px] font-mono-code text-[#A39C92]">{list.length}</span>
                </div>

                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {list.map((m, i) => {
                    const tone = providerTone(m.provider);
                    return (
                      <Reveal key={m.id} delay={Math.min(i * 25, 200)}>
                        <div className="h-full rounded-xl bg-white border border-[#E4DED4] p-4 hover:border-[#C9C1B4] hover:shadow-sm transition-all">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[13.5px] font-medium text-[#191714] truncate">
                                {m.name}
                              </div>
                              <div className="mt-1 text-[11.5px] font-mono-code text-[#7A736A] truncate">
                                {m.id}
                              </div>
                            </div>
                            <span
                              className={`shrink-0 px-2 py-0.5 rounded-md text-[10px] font-medium border ${tone.bg} ${tone.text} ${tone.border}`}
                            >
                              {shortProvider(m.provider)}
                            </span>
                          </div>
                          <div className="mt-3 pt-3 border-t border-[#F0EBE3] flex items-center justify-between text-[11px] text-[#A39C92] font-mono-code">
                            <span>{formatContext(m.contextLength)}</span>
                            <span>{m.maxOutputTokens ? `${Math.round(m.maxOutputTokens / 1000)}K out` : '—'}</span>
                          </div>
                        </div>
                      </Reveal>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* CTA */}
        <Reveal>
          <div className="mt-16 rounded-2xl border border-[#E4DED4] bg-[#F7F4EF] p-8 sm:p-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
            <div>
              <h3 className="mkt-display text-[26px] text-[#191714]">Ready to route a request?</h3>
              <p className="mt-2 text-[13.5px] text-[#7A736A]">
                Sign in to the dashboard for your endpoint and API key.
              </p>
            </div>
            <Link
              to="/app"
              className="group inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#191714] text-white text-sm font-medium hover:bg-[#332E28] transition-colors shrink-0"
            >
              Open the dashboard
              <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
          </div>
        </Reveal>

        <div className="mt-10 flex items-center gap-2 text-[11.5px] text-[#A39C92]">
          <Boxes className="w-3.5 h-3.5" />
          <span>
            Model availability depends on the connected accounts' entitlements, not on this page.
          </span>
        </div>
      </section>
    </div>
  );
};
