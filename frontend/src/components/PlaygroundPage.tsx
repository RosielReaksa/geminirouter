import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  CircleAlert,
  FlaskConical,
  Loader2,
  Music,
  Paperclip,
  Play,
  RotateCcw,
  Sparkles,
  Timer,
  Video,
  X,
} from 'lucide-react';
import { api } from '../services/api';
import { ModelInfo, PlaygroundMedia, PlaygroundResult } from '../types';

const STARTER_PROMPTS = [
  'Explain how a reverse proxy works in three simple sentences.',
  'Write a short TypeScript function that retries a request twice.',
  'Give me five practical ways to reduce API latency.',
];

const formatTokens = (value?: number) =>
  typeof value === 'number' ? value.toLocaleString() : '—';

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

const formatBytes = (value: number): string => {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
};

const isVideoFile = (file: File): boolean =>
  file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name);

const isAudioFile = (file: File): boolean =>
  file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|aac|m4a|aiff|aif|opus)$/i.test(file.name);

const attachmentFormat = (file: File, video: boolean): string => {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension && /^[a-z0-9]{1,10}$/.test(extension)) return extension;
  const byMime: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aiff': 'aiff',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
  };
  return byMime[file.type] || (video ? 'mp4' : 'mp3');
};

const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(new Error('Could not read the attachment.'));
    reader.readAsDataURL(file);
  });

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
      <div className="flex flex-wrap items-center gap-4 px-5 py-3 border-t border-[#F0ECE6] text-[11px] text-[#8D867D]">
        <span className="inline-flex items-center gap-1"><Timer className="w-3.5 h-3.5" /> {result.latencyMs} ms</span>
        <span>{formatTokens(result.usage?.prompt_tokens)} input tokens</span>
        <span>{formatTokens(result.usage?.completion_tokens)} output tokens</span>
        {result.media && (
          <span className="inline-flex min-w-0 items-center gap-1">
            {result.media.kind === 'video' ? <Video className="w-3.5 h-3.5" /> : <Music className="w-3.5 h-3.5" />}
            <span className="truncate max-w-40" title={result.media.filename}>{result.media.filename}</span>
          </span>
        )}
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
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => () => {
    if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
  }, [mediaPreviewUrl]);

  const compareOptions = useMemo(() => models.filter((item) => item.id !== model), [models, model]);
  const mediaIsVideo = mediaFile ? isVideoFile(mediaFile) : false;

  const handleMediaChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const video = isVideoFile(file);
    const audio = isAudioFile(file);
    if (!video && !audio) {
      setMediaError('Choose an audio or video file.');
      return;
    }
    const maxBytes = video ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
    if (file.size > maxBytes) {
      setMediaError(
        `${video ? 'Video' : 'Audio'} is too large for inline chat (${formatBytes(maxBytes)} max). ` +
          (video ? 'Trim or compress it first.' : 'Use compressed 10–20 minute audio.'),
      );
      return;
    }

    setMediaError(null);
    setMediaFile(file);
    setMediaPreviewUrl(URL.createObjectURL(file));
  };

  const removeMedia = () => {
    setMediaFile(null);
    setMediaPreviewUrl(null);
    setMediaError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const runPrompt = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!model || running) return;
    if (!prompt.trim() && !mediaFile) return;

    let media: PlaygroundMedia | undefined;
    if (mediaFile) {
      const video = isVideoFile(mediaFile);
      const maxBytes = video ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
      if (mediaFile.size > maxBytes) {
        setMediaError(`${video ? 'Video' : 'Audio'} is too large for inline chat (${formatBytes(maxBytes)} max).`);
        return;
      }
      try {
        media = {
          kind: video ? 'video' : 'audio',
          mimeType: mediaFile.type || (video ? 'video/mp4' : 'audio/mpeg'),
          format: attachmentFormat(mediaFile, video),
          dataBase64: await readFileAsBase64(mediaFile),
          filename: mediaFile.name,
          sizeBytes: mediaFile.size,
        };
      } catch (error) {
        setMediaError(error instanceof Error ? error.message : 'Could not read the attachment.');
        return;
      }
    }

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
          media,
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
    setMediaError(null);
    removeMedia();
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
          <p className="text-sm text-[#706B65] mt-1 max-w-2xl">Send a prompt or attach audio/video through your gateway, then compare how different models respond.</p>
        </div>
        <div className="inline-flex items-center gap-2 text-xs text-[#706B65] bg-white border border-[#EAE5DE] rounded-xl px-3 py-2">
          <Sparkles className="w-3.5 h-3.5 text-[#C25938]" /> Requests run through your local gateway
        </div>
      </div>

      <form onSubmit={runPrompt} className="rounded-2xl border border-[#EAE5DE] bg-white shadow-soft overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4 mb-2">
              <label htmlFor="playground-prompt" className="text-sm font-semibold text-[#2A2723]">Your prompt / question</label>
              <span className="text-[11px] text-[#9E988F]">{prompt.length.toLocaleString()} characters</span>
            </div>
            <textarea
              id="playground-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={20000}
              rows={7}
              placeholder="Ask a question, test an instruction, or attach audio/video and ask what is in it…"
              className="w-full resize-y min-h-40 rounded-xl border border-[#EAE5DE] bg-[#FDFCF9] px-4 py-3 text-sm leading-6 text-[#2A2723] placeholder:text-[#AAA399] focus:outline-none focus:border-[#C25938] focus:ring-2 focus:ring-[#C25938]/10"
            />

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/*"
                className="hidden"
                aria-label="Attach audio or video"
                onChange={handleMediaChange}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-xl border border-[#EAE5DE] bg-white px-3 py-2 text-xs font-medium text-[#504C46] hover:border-[#C25938]/40 hover:text-[#C25938] transition-colors"
              >
                <Paperclip className="w-3.5 h-3.5" />
                Attach audio / video
              </button>
              <span className="text-[11px] text-[#9E988F]">Audio ≤15 MB · Video ≤20 MB</span>
            </div>

            {mediaFile && (
              <div className="mt-3 rounded-xl border border-[#EAE5DE] bg-[#FDFCF9] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {mediaIsVideo ? (
                      <Video className="w-4 h-4 shrink-0 text-[#C25938]" />
                    ) : (
                      <Music className="w-4 h-4 shrink-0 text-[#C25938]" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-[#2A2723]" title={mediaFile.name}>
                        {mediaFile.name}
                      </div>
                      <div className="text-[11px] text-[#9E988F]">
                        {formatBytes(mediaFile.size)} · {mediaIsVideo ? 'Video' : 'Audio'}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={removeMedia}
                    aria-label="Remove attachment"
                    className="rounded-lg p-1.5 text-[#9E988F] hover:bg-[#F2ECE4] hover:text-[#A8462A]"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {mediaPreviewUrl && (
                  <div className="mt-3">
                    {mediaIsVideo ? (
                      <video
                        src={mediaPreviewUrl}
                        controls
                        preload="metadata"
                        className="max-h-48 w-full rounded-lg bg-black"
                      />
                    ) : (
                      <audio src={mediaPreviewUrl} controls preload="metadata" className="w-full" />
                    )}
                  </div>
                )}
              </div>
            )}

            {mediaError && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-[#A8462A]">
                <CircleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{mediaError}</span>
              </p>
            )}
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
              <button type="submit" disabled={(!prompt.trim() && !mediaFile) || !model || running || modelsLoading} className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-[#C25938] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#B24E2E] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
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
