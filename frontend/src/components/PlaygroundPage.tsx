import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  CircleAlert,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Timer,
} from 'lucide-react';
import { api } from '../services/api';
import { ModelInfo, PlaygroundResult } from '../types';

const STARTER_PROMPTS = [
  'Explain how a reverse proxy works in three simple sentences.',
  'Write a short TypeScript function that retries a request twice.',
  'Give me five practical ways to reduce API latency.',
];

const formatTokens = (value?: number) =>
  typeof value === 'number' ? value.toLocaleString() : '—';

const ResultCard: React.FC<{
  model: string;
  result?: PlaygroundResult;
  loading: boolean;
}> = ({ model, result, loading }) => (
  <section className="min-h-72 rounded-2xl border border-[#EAE5DE] bg-white shadow-soft overflow-hidden">
    <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-[#F0ECE6]">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-[0.16em] text-[#9E988F] font-semibold">Response</div>
        <div className="mt-1 text-sm font-semibold truncate" title={model}>{model || 'Choose a model'}</div>
      </div>
      {loading ? (
        <span className="flex items-center gap-1.5 text-xs text-[#C25938]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running</span>
      ) : result?.ok ? (
        <span className="flex items-center gap-1.5 text-xs text-[#4E7B62]"><Check className="w-3.5 h-3.5" /> Complete</span>
      ) : null}
    </div>

    <div className="p-5">
      {loading ? (
        <div className="space-y-2.5 animate-pulse" aria-label="Waiting for model response">
          <div className="h-3 rounded bg-[#F2ECE4] w-full" />
          <div className="h-3 rounded bg-[#F2ECE4] w-11/12" />
          <div className="h-3 rounded bg-[#F2ECE4] w-4/5" />
        </div>
      ) : result?.response ? (
        <pre className="whitespace-pre-wrap break-words font-sans-ui text-sm leading-6 text-[#504C46]">{result.response}</pre>
      ) : result?.error ? (
        <div className="flex gap-2 text-sm leading-6 text-[#A8462A]"><CircleAlert className="w-4 h-4 mt-1 shrink-0" /><span>{result.error}</span></div>
      ) : (
        <p className="text-sm text-[#9E988F]">Your model response will appear here.</p>
      )}
    </div>

    {result && !loading && (
      <div className="flex items-center gap-4 px-5 py-3 border-t border-[#F0ECE6] text-[11px] text-[#8D867D]">
        <span className="inline-flex items-center gap-1"><Timer className="w-3.5 h-3.5" /> {result.latencyMs} ms</span>
        <span>{formatTokens(result.usage?.prompt_tokens)} input tokens</span>
        <span>{formatTokens(result.usage?.completion_tokens)} output tokens</span>
      </div>
    )}
  </section>
);

export const PlaygroundPage: React.FC<{ onReady: () => void }> = ({ onReady }) => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [model, setModel] = useState('');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareModel, setCompareModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [results, setResults] = useState<Record<string, PlaygroundResult>>({});
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let active = true;
    api.getModels().then(({ data }) => {
      if (!active) return;
      const available = (data.models || []).filter((item) => item.availability?.ok !== false);
      setModels(available);
      const first = available.find((item) => item.id.includes('gemini')) || available[0];
      const second = available.find((item) => item.id !== first?.id);
      setModel(first?.id || '');
      setCompareModel(second?.id || '');
    }).catch(() => {
      if (active) setModels([]);
    }).finally(() => {
      if (active) {
        setModelsLoading(false);
        onReady();
      }
    });
    return () => { active = false; };
  }, []);

  const compareOptions = useMemo(() => models.filter((item) => item.id !== model), [models, model]);

  const runPrompt = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!model || !prompt.trim() || running) return;

    const selected = compareEnabled && compareModel && compareModel !== model
      ? [model, compareModel]
      : [model];
    setRunning(true);
    setResults({});

    await Promise.all(selected.map(async (selectedModel) => {
      const startedAt = Date.now();
      try {
        const result = await api.playgroundRequest({
          model: selectedModel,
          prompt: prompt.trim(),
          systemPrompt: systemPrompt.trim() || undefined,
          temperature,
          maxTokens,
        });
        setResults((current) => ({ ...current, [selectedModel]: result }));
      } catch (error) {
        setResults((current) => ({
          ...current,
          [selectedModel]: {
            ok: false,
            model: selectedModel,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : 'The request failed.',
          },
        }));
      }
    }));
    setRunning(false);
  };

  const clearPrompt = () => {
    setPrompt('');
    setResults({});
  };

  return (
    <div className="space-y-7 animate-in fade-in duration-200">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#C25938] mb-1.5">
            <FlaskConical className="w-4 h-4" />
            <span>Try it live</span>
          </div>
          <h2 className="font-serif-editorial text-3xl font-semibold text-[#2A2723]">Playground</h2>
          <p className="text-sm text-[#706B65] mt-1 max-w-2xl">Send a prompt through your gateway, then compare how different models respond.</p>
        </div>
        <div className="inline-flex items-center gap-2 text-xs text-[#706B65] bg-white border border-[#EAE5DE] rounded-xl px-3 py-2">
          <Sparkles className="w-3.5 h-3.5 text-[#C25938]" /> Requests run through your local gateway
        </div>
      </div>

      <form onSubmit={runPrompt} className="rounded-2xl border border-[#EAE5DE] bg-white shadow-soft overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4 mb-2">
              <label htmlFor="playground-prompt" className="text-sm font-semibold text-[#2A2723]">Your prompt</label>
              <span className="text-[11px] text-[#9E988F]">{prompt.length.toLocaleString()} characters</span>
            </div>
            <textarea
              id="playground-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={20000}
              rows={7}
              placeholder="Ask a question, test an instruction, or paste a small piece of code…"
              className="w-full resize-y min-h-40 rounded-xl border border-[#EAE5DE] bg-[#FDFCF9] px-4 py-3 text-sm leading-6 text-[#2A2723] placeholder:text-[#AAA399] focus:outline-none focus:border-[#C25938] focus:ring-2 focus:ring-[#C25938]/10"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {STARTER_PROMPTS.map((starter) => (
                <button key={starter} type="button" onClick={() => setPrompt(starter)} className="rounded-full border border-[#EAE5DE] px-3 py-1.5 text-[11px] text-[#706B65] hover:border-[#C25938]/40 hover:text-[#C25938] transition-colors">
                  {starter.length > 42 ? `${starter.slice(0, 42)}…` : starter}
                </button>
              ))}
            </div>

            <button type="button" onClick={() => setShowSystemPrompt((value) => !value)} className="mt-5 text-xs font-medium text-[#706B65] hover:text-[#C25938]">
              {showSystemPrompt ? '− Hide system instruction' : '+ Add system instruction'}
            </button>
            {showSystemPrompt && (
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                maxLength={5000}
                rows={3}
                aria-label="System instruction"
                placeholder="Give the model a role or response style…"
                className="mt-2 w-full resize-y rounded-xl border border-[#EAE5DE] bg-white px-4 py-3 text-sm leading-6 focus:outline-none focus:border-[#C25938]"
              />
            )}
          </div>

          <aside className="border-t lg:border-t-0 lg:border-l border-[#F0ECE6] bg-[#FDFCF9] p-5 sm:p-6 space-y-5">
            <div>
              <label htmlFor="playground-model" className="block text-xs font-semibold text-[#504C46] mb-2">Model</label>
              <select id="playground-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={modelsLoading || models.length === 0} className="w-full rounded-xl border border-[#EAE5DE] bg-white px-3 py-2.5 text-sm focus:outline-none focus:border-[#C25938]">
                {modelsLoading && <option value="">Loading models…</option>}
                {!modelsLoading && models.length === 0 && <option value="">No models available</option>}
                {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>

            <button type="button" onClick={() => setCompareEnabled((value) => !value)} aria-pressed={compareEnabled} className={`w-full flex items-center justify-between rounded-xl border px-3 py-2.5 text-sm transition-colors ${compareEnabled ? 'border-[#C25938]/40 bg-[#FAF2EF] text-[#A8462A]' : 'border-[#EAE5DE] bg-white text-[#504C46] hover:bg-[#F8F5F0]'}`}>
              <span className="flex items-center gap-2"><ArrowRightLeft className="w-4 h-4" /> Compare models</span>
              <span className={`w-8 h-[18px] rounded-full p-0.5 transition-colors ${compareEnabled ? 'bg-[#C25938]' : 'bg-[#D8D2C9]'}`}><span className={`block w-3.5 h-3.5 bg-white rounded-full transition-transform ${compareEnabled ? 'translate-x-3.5' : ''}`} /></span>
            </button>

            {compareEnabled && (
              <div>
                <label htmlFor="playground-compare-model" className="block text-xs font-semibold text-[#504C46] mb-2">Compare with</label>
                <select id="playground-compare-model" value={compareModel} onChange={(event) => setCompareModel(event.target.value)} className="w-full rounded-xl border border-[#EAE5DE] bg-white px-3 py-2.5 text-sm focus:outline-none focus:border-[#C25938]">
                  {compareOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="playground-temperature" className="block text-xs font-semibold text-[#504C46] mb-2">Temperature</label>
                <input id="playground-temperature" type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} className="w-full rounded-xl border border-[#EAE5DE] bg-white px-3 py-2.5 text-sm focus:outline-none focus:border-[#C25938]" />
              </div>
              <div>
                <label htmlFor="playground-max-tokens" className="block text-xs font-semibold text-[#504C46] mb-2">Max tokens</label>
                <input id="playground-max-tokens" type="number" min="1" max="8192" step="1" value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} className="w-full rounded-xl border border-[#EAE5DE] bg-white px-3 py-2.5 text-sm focus:outline-none focus:border-[#C25938]" />
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={!prompt.trim() || !model || running || modelsLoading} className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-[#C25938] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#B24E2E] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                {running ? 'Running…' : compareEnabled ? 'Run comparison' : 'Run prompt'}
              </button>
              <button type="button" onClick={clearPrompt} title="Clear prompt and results" className="rounded-xl border border-[#EAE5DE] bg-white px-3 text-[#706B65] hover:text-[#C25938] hover:bg-[#F8F5F0]" aria-label="Clear prompt and results"><RotateCcw className="w-4 h-4" /></button>
            </div>
          </aside>
        </div>
      </form>

      <div>
        <div className="flex items-center gap-2 mb-3 text-xs font-semibold uppercase tracking-wider text-[#9E988F]"><ArrowRightLeft className="w-3.5 h-3.5" /> Model output</div>
        <div className={`grid grid-cols-1 ${compareEnabled ? 'xl:grid-cols-2' : ''} gap-4`}>
          <ResultCard model={model} result={results[model]} loading={running && !results[model]} />
          {compareEnabled && <ResultCard model={compareModel} result={results[compareModel]} loading={running && !results[compareModel]} />}
        </div>
      </div>
    </div>
  );
};
