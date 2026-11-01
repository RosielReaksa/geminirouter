import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Gauge,
  GitBranch,
  Pause,
  Play,
  Radio,
  Server,
  ShieldCheck,
  Terminal,
  Timer,
} from 'lucide-react';
import { Link } from '../../router';
import { Reveal } from '../marketing/Chrome';
import { publicApi, type PublicStats } from '../../services/publicApi';

/* ------------------------------------------------------------------------- */
/* Trace data                                                                 */
/* ------------------------------------------------------------------------- */

type Tone = 'plain' | 'key' | 'ok' | 'warn' | 'dim' | 'accent';

interface CodeLine {
  t: string;
  tone?: Tone;
}

interface StepMetric {
  k: string;
  v: string;
  tone?: 'ok' | 'warn' | 'accent';
}

interface TraceStep {
  n: string;
  label: string;
  phase: string;
  title: string;
  body: string;
  icon: LucideIcon;
  code: CodeLine[];
  logs: string[];
  metrics: StepMetric[];
  signal: number[];
  status: string;
  time: string;
  inFlight: number;
  tone: 'ok' | 'warn' | 'accent';
}

const STEPS: TraceStep[] = [
  {
    n: '01',
    label: 'Send',
    phase: 'Ingress',
    title: 'A client sends one request',
    body: 'Any OpenAI-compatible client posts a chat completion to your bridge. Streaming or not, one bearer token is the only credential it needs to hold.',
    icon: Terminal,
    code: [
      { t: 'POST /v1/chat/completions HTTP/1.1', tone: 'accent' },
      { t: 'host: router.example.com' },
      { t: 'authorization: Bearer sk-live-••••7f2a', tone: 'key' },
      { t: 'content-type: application/json' },
      { t: 'accept: text/event-stream' },
      { t: '' },
      { t: '{ "model": "gemini-2.5-pro",', tone: 'plain' },
      { t: '  "stream": true,' },
      { t: '  "messages": [ { "role": "user", … } ] }' },
    ],
    logs: [
      '12:04:02.118  ingress  tls 1.3 · client codex-cli',
      '12:04:02.119  ingress  body 1.2 kB · stream',
      '12:04:02.122  ingress  accepted',
    ],
    metrics: [
      { k: 'Model', v: 'gemini-2.5-pro' },
      { k: 'Mode', v: 'stream' },
      { k: 'Body', v: '1.2 kB' },
      { k: 'Auth', v: 'bearer' },
    ],
    status: 'Received',
    time: '0.4 ms',
    inFlight: 1,
    tone: 'accent',
    signal: [
      10, 14, 12, 18, 16, 22, 20, 26, 24, 30, 28, 34,
      32, 38, 36, 42, 40, 44, 42, 46, 44, 48, 46, 50,
    ],
  },
  {
    n: '02',
    label: 'Admit',
    phase: 'Admission',
    title: 'The bridge checks identity and size',
    body: 'The bearer key is verified, the 64 MiB ceiling is applied to /v1, and multipart uploads are kept byte-for-byte intact so audio and video reach the core unchanged.',
    icon: ShieldCheck,
    code: [
      { t: 'authorization   → session verified', tone: 'ok' },
      { t: 'content-length   1,284,096 B  (cap 64 MiB)', tone: 'plain' },
      { t: 'content-type     multipart/form-data', tone: 'key' },
      { t: 'parser           raw buffer · boundary kept' },
      { t: 'limits           dashboard 10 MiB · /v1 64 MiB', tone: 'dim' },
    ],
    logs: [
      '12:04:02.123  auth    key 7f2a verified',
      '12:04:02.124  limit   /v1 64 MiB · dashboard 10 MiB',
      '12:04:02.126  parser  raw buffer · sha 9c41',
    ],
    metrics: [
      { k: 'Auth', v: 'verified', tone: 'ok' },
      { k: 'Limit', v: '64 MiB' },
      { k: 'Parser', v: 'raw' },
      { k: 'Key', v: '••••7f2a' },
    ],
    status: 'Admitted',
    time: '1.2 ms',
    inFlight: 1,
    tone: 'ok',
    signal: [
      20, 18, 26, 22, 30, 24, 34, 28, 38, 30, 42, 34,
      46, 36, 50, 38, 54, 40, 58, 42, 62, 44, 66, 48,
    ],
  },
  {
    n: '03',
    label: 'Lease',
    phase: 'Scheduling',
    title: 'The lease manager picks the least busy account',
    body: 'It counts in-flight work per account, breaks ties by remaining quota, and never exceeds the per-account cap. If every seat is taken, the request waits briefly — then gets a 429 with Retry-After.',
    icon: Gauge,
    code: [
      { t: 'acquireLease(model="gemini-2.5-pro")', tone: 'accent' },
      { t: '  candidates   5 healthy · 2 cooling', tone: 'plain' },
      { t: '  in-flight    1 · 2 · 0 · 3 · 1' },
      { t: '  pick         account #3  (2/6 seats)', tone: 'ok' },
      { t: '  lease        lz-8f3a · ttl 900 s' },
      { t: '  queue        0 ms', tone: 'dim' },
    ],
    logs: [
      '12:04:02.127  lease   scan 5 candidates',
      '12:04:02.128  lease   pick acct_3 · seats 2/6',
      '12:04:02.131  lease   grant lz-8f3a',
    ],
    metrics: [
      { k: 'In flight', v: '2 / 6' },
      { k: 'Healthy', v: '5', tone: 'ok' },
      { k: 'Queue', v: '0 ms' },
      { k: 'TTL', v: '900 s' },
    ],
    status: 'Leased',
    time: '2.0 ms',
    inFlight: 2,
    tone: 'ok',
    signal: [
      12, 12, 20, 20, 28, 28, 36, 36, 44, 44, 52, 52,
      60, 60, 68, 68, 60, 60, 52, 52, 44, 44, 36, 36,
    ],
  },
  {
    n: '04',
    label: 'Route',
    phase: 'Routing',
    title: 'The core owns account selection, model by model',
    body: 'The bridge forwards to the local core. The core keeps per-model cooldowns of 60–300 seconds, applies session affinity, and skips any account cooling down for this exact model — other models keep flowing.',
    icon: GitBranch,
    code: [
      { t: 'POST 127.0.0.1:8045/v1/chat/completions', tone: 'accent' },
      { t: '  route        model-scoped', tone: 'plain' },
      { t: '  cooldowns    0 active for this model', tone: 'ok' },
      { t: '  affinity     session → acct_3' },
      { t: '  selection    quota-weighted', tone: 'dim' },
    ],
    logs: [
      '12:04:02.132  route   model cooldown none',
      '12:04:02.133  route   affinity hit acct_3',
      '12:04:02.135  route   core:8045 accepted',
    ],
    metrics: [
      { k: 'Cooldown', v: 'none', tone: 'ok' },
      { k: 'Affinity', v: 'hit' },
      { k: 'Upstream', v: ':8045' },
      { k: 'Retries', v: '5 max' },
    ],
    status: 'Routed',
    time: '2.6 ms',
    inFlight: 2,
    tone: 'ok',
    signal: [
      40, 44, 38, 46, 42, 50, 44, 52, 46, 54, 48, 56,
      50, 58, 52, 60, 54, 62, 56, 64, 58, 66, 60, 62,
    ],
  },
  {
    n: '05',
    label: 'Upstream',
    phase: 'Upstream',
    title: 'One account answers; the pool absorbs the failures',
    body: 'If the account returns 429, 403, or a retryable 503 before the first byte, the bridge excludes it and tries the next healthy account. The client never sees the failed attempt. A fully exhausted pool returns a clean 429 instead of a fake success.',
    icon: Server,
    code: [
      { t: '→ acct_3   POST upstream/stream', tone: 'plain' },
      { t: '← 429      quota exhausted · retry-after 60', tone: 'warn' },
      { t: '  exclude  acct_3 · cooldown 60s (model)', tone: 'dim' },
      { t: '→ acct_2   retry attempt 2/5', tone: 'plain' },
      { t: '← 200      text/event-stream', tone: 'ok' },
    ],
    logs: [
      '12:04:02.348  core    429 quota · acct_3',
      '12:04:02.351  cooldown acct_3 · 60s · model',
      '12:04:02.352  failover attempt 2/5 · acct_2',
    ],
    metrics: [
      { k: 'Attempt', v: '2 / 5', tone: 'warn' },
      { k: 'Served by', v: 'acct_2', tone: 'ok' },
      { k: 'Cooldown', v: '60 s', tone: 'warn' },
      { k: 'Client', v: '200', tone: 'ok' },
    ],
    status: '200 OK',
    time: '214 ms',
    inFlight: 2,
    tone: 'ok',
    signal: [
      16, 12, 20, 14, 24, 18, 28, 20, 34, 22, 40, 24,
      70, 80, 86, 78, 60, 52, 44, 38, 32, 28, 22, 18,
    ],
  },
  {
    n: '06',
    label: 'Stream',
    phase: 'Streaming',
    title: 'Bytes start moving and the retries stop',
    body: 'The bridge pipes upstream chunks straight to the client. Once the first byte is emitted it will never retry the request. If the client disconnects, the upstream socket is destroyed and the lease is released immediately.',
    icon: Radio,
    code: [
      { t: 'HTTP/1.1 200 OK', tone: 'ok' },
      { t: 'x-antigravity-account-id: acct_2', tone: 'dim' },
      { t: 'content-type: text/event-stream' },
      { t: '' },
      { t: 'data: {"choices":[{"delta":{"content":"Hel"}}]}' },
      { t: 'data: {"choices":[{"delta":{"content":"lo"}}]}' },
    ],
    logs: [
      '12:04:02.564  stream  first byte 212 ms',
      '12:04:02.790  stream  47 chunks piped',
      '12:04:02.791  stream  retry locked',
    ],
    metrics: [
      { k: 'First byte', v: '212 ms' },
      { k: 'Chunks', v: '47' },
      { k: 'Retry', v: 'locked', tone: 'warn' },
      { k: 'Account', v: 'acct_2' },
    ],
    status: 'Streaming',
    time: '226 ms',
    inFlight: 2,
    tone: 'accent',
    signal: [
      10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32,
      34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56,
    ],
  },
  {
    n: '07',
    label: 'Finish',
    phase: 'Egress',
    title: 'One clean answer reaches the client',
    body: 'Response headers pass through, the SSE stream ends with [DONE], and your tool continues as if it had called OpenAI directly. The seat returns to the pool the moment the stream closes.',
    icon: CheckCircle2,
    code: [
      { t: 'data: {"choices":[{"finish_reason":"stop"}]}', tone: 'ok' },
      { t: 'data: [DONE]', tone: 'ok' },
      { t: '' },
      { t: 'client   200 OK · 1.85 s', tone: 'plain' },
      { t: 'lease    released · acct_2 free', tone: 'dim' },
    ],
    logs: [
      '12:04:03.964  egress  finish_reason stop',
      '12:04:03.966  egress  [DONE]',
      '12:04:03.967  lease   released',
    ],
    metrics: [
      { k: 'Status', v: '200', tone: 'ok' },
      { k: 'Total', v: '1.85 s' },
      { k: 'Lease', v: 'free', tone: 'ok' },
      { k: 'Events', v: 'done' },
    ],
    status: 'Complete',
    time: '438 ms',
    inFlight: 1,
    tone: 'ok',
    signal: [
      60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60,
      60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 20,
    ],
  },
  {
    n: '08',
    label: 'Ledger',
    phase: 'Accounting',
    title: 'The request becomes a row you can audit',
    body: 'When the stream ends the bridge writes one traffic record: the account that actually served it, status, latency, tokens. Requests still open are marked in progress, never guessed complete.',
    icon: Database,
    code: [
      { t: '{', tone: 'dim' },
      { t: '  "id": "tr-k2f9x",', tone: 'key' },
      { t: '  "model": "gemini-2.5-pro",' },
      { t: '  "account": "acct_2",', tone: 'ok' },
      { t: '  "status": 200, "latencyMs": 1846,', tone: 'plain' },
      { t: '  "tokens": { "prompt": 612, "completion": 874 },' },
      { t: '  "outcome": "completed"', tone: 'ok' },
      { t: '}', tone: 'dim' },
    ],
    logs: [
      '12:04:03.968  ledger  tr-k2f9x written',
      '12:04:03.969  ledger  612 / 874 tokens',
      '12:04:03.970  ledger  outcome completed',
    ],
    metrics: [
      { k: 'Row', v: 'tr-k2f9x' },
      { k: 'Latency', v: '1.85 s' },
      { k: 'Tokens', v: '1,486' },
      { k: 'Outcome', v: 'completed', tone: 'ok' },
    ],
    status: 'Recorded',
    time: '1.85 s',
    inFlight: 0,
    tone: 'ok',
    signal: [
      30, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    ],
  },
];

const STEP_MS = 5200;

/**
 * Turn the compact control points into a denser sampled profile so the
 * waveform reads as a signal, not as 24 bars.
 */
const expandSignal = (points: number[]): number[] => {
  const samples = 48;
  const out: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const position = (index / (samples - 1)) * (points.length - 1);
    const low = Math.floor(position);
    const high = Math.min(points.length - 1, low + 1);
    const mix = position - low;
    out.push(Math.round(points[low] + (points[high] - points[low]) * mix));
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Console                                                                    */
/* ------------------------------------------------------------------------- */

const codeToneClass: Record<Tone, string> = {
  plain: 'lc-t-plain',
  key: 'lc-t-key',
  ok: 'lc-t-ok',
  warn: 'lc-t-warn',
  dim: 'lc-t-dim',
  accent: 'lc-t-accent',
};

const TraceConsole: React.FC<{ stats: PublicStats | null }> = ({ stats }) => {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(
    () => (typeof document === 'undefined' ? true : !document.hidden),
  );
  const [inView, setInView] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);

  const step = STEPS[active];
  const signalBars = expandSignal(step.signal);
  const lastIndex = STEPS.length - 1;
  const railProgress = (active / lastIndex) * 100;
  const autoRunning = playing && !reduced && visible && inView;

  const goTo = (index: number) => {
    setActive((index + STEPS.length) % STEPS.length);
  };

  // Respect a visitor's motion preference: no autonomous animation.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      setReduced(mq.matches);
      if (mq.matches) setPlaying(false);
    };
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Do not burn timers while the console is scrolled out of view.
  useEffect(() => {
    const el = consoleRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setInView(Boolean(entries[0]?.isIntersecting)),
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!autoRunning) return;
    const timer = window.setTimeout(() => {
      setActive((current) => (current + 1) % STEPS.length);
    }, STEP_MS);
    return () => window.clearTimeout(timer);
  }, [autoRunning, active]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      goTo(active + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goTo(active - 1);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (!reduced) setPlaying((value) => !value);
    }
  };

  const poolValue = stats ? String(stats.accountsConnected) : '—';

  return (
    <div
      ref={consoleRef}
      className="lc-console"
      style={{ '--lc-step': `${STEP_MS}ms` } as React.CSSProperties}
      role="group"
      aria-label="Request lifecycle demonstration"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <span className="lc-scan" aria-hidden="true" />

      <div className="lc-content">
        {/* Console chrome */}
        <div className="lc-bar">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="lc-dot bg-[#3A3329]" />
            <span className="lc-dot bg-[#3A3329]" />
            <span className="lc-dot bg-[#3A3329]" />
          </div>
          <span className="lc-path">geminirouter://request/8f3a-2e</span>
          <span className="ml-auto flex items-center gap-2.5">
            <span className="lc-sim">Simulated trace</span>
            <span className="lc-step-count">
              {step.n} / 0{STEPS.length}
            </span>
          </span>
        </div>

        {/* Telemetry strip */}
        <div className="lc-stats">
          <div className="lc-stat">
            <div className="lc-stat-k">Pool</div>
            <div className="lc-stat-v">
              {poolValue}
              <span className="lc-stat-sub">connected</span>
            </div>
          </div>
          <div className="lc-stat">
            <div className="lc-stat-k">In flight</div>
            <div className="lc-stat-v">
              {step.inFlight}
              <span className="lc-stat-sub">of 6 seats</span>
            </div>
          </div>
          <div className="lc-stat">
            <div className="lc-stat-k">Model</div>
            <div className="lc-stat-v lc-stat-model">gemini-2.5-pro</div>
          </div>
          <div className="lc-stat">
            <div className="lc-stat-k">Trace</div>
            <div className="lc-stat-v">
              {step.time}
              <span className="lc-stat-sub">elapsed</span>
            </div>
          </div>
        </div>

        {/* Step rail */}
        <div className="lc-rail-wrap">
          <div className="lc-rail-inner">
            <div className="lc-rail-track" aria-hidden="true">
              <span className="lc-rail-fill" style={{ width: `${railProgress}%` }} />
              <span className="lc-rail-pulse" style={{ left: `${railProgress}%` }} />
            </div>

            <ol className="lc-rail">
              {STEPS.map((item, index) => {
                const isActive = index === active;
                const isDone = index < active;
                return (
                  <li key={item.n}>
                    <button
                      type="button"
                      onClick={() => goTo(index)}
                      className={`lc-node-btn ${isActive ? 'is-active' : ''} ${
                        isDone ? 'is-done' : ''
                      }`}
                      aria-current={isActive ? 'step' : undefined}
                      aria-label={`Step ${index + 1}: ${item.label} — ${item.phase}`}
                    >
                      <span className="lc-node">
                        {isDone ? <Check className="lc-node-check" /> : item.n}
                      </span>
                      <span className="lc-node-label">{item.label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {/* Panels */}
        <div className="lc-grid">
          <div className="lc-left">
            <div className="lc-panel lc-code-panel">
              <div className="lc-panel-head">
                <span>Packet inspector</span>
                <span className="text-[#8a8072]">stage {step.n}</span>
              </div>
              <pre key={`code-${active}`} className="lc-code">
                {step.code.map((line, index) => (
                  <div
                    key={`${active}-${index}`}
                    className="lc-line"
                    style={{ animationDelay: `${index * 34}ms` }}
                  >
                    <span className="lc-gutter" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className={codeToneClass[line.tone ?? 'plain']}>
                      {line.t || '\u00a0'}
                    </span>
                  </div>
                ))}
                <div className="lc-prompt-line" aria-hidden="true">
                  <span className="lc-gutter" />
                  <span className="lc-prompt-mark">›</span>
                  <span className="lc-code-caret" />
                </div>
              </pre>
              <div className="lc-code-foot">
                <span className={`lc-led lc-led-${step.tone}`} aria-hidden="true" />
                <span>{step.status.toLowerCase()}</span>
                <span className="ml-auto">{step.time}</span>
              </div>
            </div>

            <div className="lc-panel lc-log-panel">
              <div className="lc-panel-head">
                <span>Event log</span>
                <span className="text-[#8a8072]">{step.phase.toLowerCase()}</span>
              </div>
              <div className="lc-logs">
                {step.logs.map((line, index) => (
                  <div
                    key={`${active}-${index}`}
                    className="lc-log-line"
                    style={{ animationDelay: `${80 + index * 90}ms` }}
                  >
                    <span className="lc-log-mark" aria-hidden="true">
                      ›
                    </span>
                    <span className="lc-log-text">{line}</span>
                  </div>
                ))}
                <span className="lc-caret" aria-hidden="true" />
              </div>
            </div>
          </div>

          <div className="lc-panel lc-detail">
            <div key={`detail-${active}`} className="lc-detail-in">
              <div className="flex items-center gap-2.5">
                <span className="lc-phase">{step.phase}</span>
                <span className="lc-phase-rule" aria-hidden="true" />
                <span className="lc-phase-index">
                  step {step.n} of 0{STEPS.length}
                </span>
              </div>

              <h3 className="lc-title">{step.title}</h3>
              <p className="lc-copy">{step.body}</p>

              <div className="lc-metrics">
                {step.metrics.map((metric) => (
                  <div key={metric.k} className="lc-metric">
                    <span className="lc-metric-k">{metric.k}</span>
                    <span
                      className={`lc-metric-v ${
                        metric.tone ? `lc-metric-${metric.tone}` : ''
                      }`}
                    >
                      {metric.v}
                    </span>
                  </div>
                ))}
              </div>

              <div className="lc-scope">
                <div className="lc-scope-head">
                  <span>Signal profile</span>
                  <span className="lc-scope-v">48 samples</span>
                </div>
                <div className="lc-wave" aria-hidden="true">
                  {signalBars.map((height, index) => (
                    <i
                      key={`${active}-${index}`}
                      style={{
                        height: `${height}%`,
                        animationDelay: `${index * 22}ms`,
                      }}
                    />
                  ))}
                </div>
              </div>

              <div className="lc-next">
                <span className="lc-next-k">Next hop</span>
                <span className="lc-next-v">
                  {STEPS[(active + 1) % STEPS.length].phase}
                </span>
                <ArrowRight className="lc-next-arrow" aria-hidden="true" />
              </div>
            </div>

            <div className="lc-detail-foot" aria-live="polite">
              <step.icon className="lc-detail-icon" aria-hidden="true" />
              <span>
                Stage {step.n} · {step.status}
              </span>
              <span className={`lc-led lc-led-${step.tone}`} aria-hidden="true" />
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="lc-controls">
          <button
            type="button"
            className="lc-btn"
            onClick={() => goTo(active - 1)}
            aria-label="Previous step"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={`lc-btn ${playing && !reduced ? 'is-on' : ''}`}
            onClick={() => setPlaying((value) => !value)}
            disabled={reduced}
            title={
              reduced
                ? 'Automatic playback is off because your system requests reduced motion.'
                : undefined
            }
            aria-label={
              reduced
                ? 'Automatic playback disabled'
                : playing
                  ? 'Pause the walkthrough'
                  : 'Play the walkthrough'
            }
            aria-pressed={playing && !reduced}
          >
            {playing && !reduced ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            className="lc-btn"
            onClick={() => goTo(active + 1)}
            aria-label="Next step"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <span className="lc-auto">
            {reduced
              ? 'reduced motion · manual'
              : autoRunning
                ? 'auto-advancing'
                : playing
                  ? 'paused · off screen'
                  : 'paused'}
          </span>

          <div className="lc-segs" aria-hidden="true">
            {STEPS.map((item, index) => (
              <span
                key={`${item.n}-${active}-${autoRunning}`}
                className={`lc-seg ${index < active ? 'is-done' : ''} ${
                  index === active ? 'is-active' : ''
                }`}
              >
                <i style={{ animationPlayState: autoRunning ? 'running' : 'paused' }} />
              </span>
            ))}
          </div>

          <span className="lc-hint">← → keys · click a node</span>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------- */
/* Page                                                                       */
/* ------------------------------------------------------------------------- */

const GUARANTEES = [
  {
    icon: ShieldCheck,
    label: 'Admission',
    title: 'One seat per request, counted atomically.',
    body: 'Leases are acquired before a byte is sent and released on every exit path, including client aborts. Per-account caps keep a single account from absorbing the whole pool.',
  },
  {
    icon: GitBranch,
    label: 'Failover',
    title: 'Retries stop at the first byte.',
    body: '429, 403, and retryable 503 responses move the request to another healthy account — but only before streaming starts. After that a retry would duplicate output, so the bridge never does it.',
  },
  {
    icon: Database,
    label: 'Accounting',
    title: 'The ledger names the real account.',
    body: 'Each completed request records the account the core actually used, its status, latency and token counts. Open requests stay marked in progress instead of being guessed complete.',
  },
  {
    icon: Timer,
    label: 'Privacy',
    title: 'Counts, not conversations.',
    body: 'The traffic ledger stores routing facts: model, account, status, latency, tokens. Prompt and completion text are not written to it, and no third party receives your requests.',
  },
];

const FAILURES = [
  {
    code: '429 · POOL EXHAUSTED',
    title: 'Every account is cooling or capped',
    body: 'The bridge returns a 429 with Retry-After instead of pretending a request succeeded. Nothing is silently dropped, and the dashboard shows the refusal.',
    outcome: 'client 429 · retry-after: 60',
    tone: 'warn' as const,
  },
  {
    code: '403 · VERIFICATION',
    title: 'One account gets challenged',
    body: 'That account is excluded for this attempt and cooled down for this model. The request moves to the next healthy account before any bytes are streamed.',
    outcome: 'attempt 2/5 · acct_excluded',
    tone: 'warn' as const,
  },
  {
    code: 'ABORT · CLIENT GONE',
    title: 'The caller disconnects mid-stream',
    body: 'The upstream socket is destroyed and the lease is released immediately, so the seat returns to the pool. The traffic row stays in progress rather than being closed with a guess.',
    outcome: 'socket closed · lease released',
    tone: 'ok' as const,
  },
  {
    code: '413 · OVER LIMIT',
    title: 'A body exceeds the cap',
    body: 'The bridge refuses at 64 MiB for /v1 before the core is involved. Uploads that do pass keep their multipart boundary and bytes intact.',
    outcome: 'rejected at edge · core untouched',
    tone: 'ok' as const,
  },
];

export const HowItWorksPage: React.FC = () => {
  const [stats, setStats] = useState<PublicStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    publicApi.getStats().then((value) => {
      if (!cancelled) setStats(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const heroStats = useMemo(
    () => [
      {
        k: 'Gateway',
        v: stats ? (stats.online ? 'Online' : 'Idle') : '—',
        live: Boolean(stats?.online),
      },
      { k: 'Accounts', v: stats ? String(stats.accountsConnected) : '—' },
      {
        k: 'Requests / 24h',
        v: stats ? stats.requestsServed.toLocaleString() : '—',
      },
      {
        k: 'Avg latency',
        v:
          stats?.averageLatencyMs != null
            ? `${Math.round(stats.averageLatencyMs)} ms`
            : '—',
      },
    ],
    [stats],
  );

  return (
    <div className="mkt-body">
      {/* ---------------- Hero ---------------- */}
      <section className="mkt-grain relative overflow-hidden border-b border-[#E4DED4]">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-44 left-1/2 -translate-x-1/2 w-[880px] h-[500px] rounded-full bg-[#F5E7E0] blur-[130px] opacity-70" />
        </div>

        <div className="relative max-w-6xl mx-auto px-5 sm:px-8 pt-14 pb-12 sm:pt-20 sm:pb-14">
          <div className="grid lg:grid-cols-[1.12fr_0.88fr] gap-10 lg:gap-16 items-start">
            <div>
              <Reveal>
                <div className="mkt-eyebrow">System walkthrough</div>
              </Reveal>

              <Reveal delay={60}>
                <h1 className="mkt-display mt-5 text-[42px] sm:text-[60px] lg:text-[68px] text-[#191714]">
                  One request.
                  <br />
                  Eight steps.
                  <br />
                  <span className="italic text-[#C25938]">Nothing hidden.</span>
                </h1>
              </Reveal>

              <Reveal delay={110}>
                <p className="mt-6 text-[15px] sm:text-[16.5px] leading-relaxed text-[#4A453E] max-w-xl">
                  Follow a single chat completion through the bridge, the lease manager, your
                  account pool and back — with the same limits, cooldowns and failover rules that
                  run in production.
                </p>
              </Reveal>

              <Reveal delay={160}>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <a
                    href="#trace"
                    className="group inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#191714] text-white text-sm font-medium hover:bg-[#332E28] transition-colors shadow-sm"
                  >
                    Run the trace
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-y-0.5" />
                  </a>
                  <Link
                    to="/docs"
                    className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white border border-[#E4DED4] text-[#191714] text-sm font-medium hover:border-[#C9C1B4] transition-colors"
                  >
                    Read the API docs
                    <ArrowUpRight className="w-3.5 h-3.5 text-[#7A736A]" />
                  </Link>
                </div>
              </Reveal>
            </div>

            {/* Trace index — an editorial table of contents for the console. */}
            <Reveal delay={140} className="hidden lg:block">
              <div className="rounded-2xl border border-[#E4DED4] bg-white/70 backdrop-blur-sm overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-[#E4DED4]">
                  <span className="mkt-eyebrow">Trace index</span>
                  <span className="font-mono-code text-[10px] text-[#A39C92]">8 stages</span>
                </div>
                <ol>
                  {STEPS.map((item) => (
                    <li key={item.n}>
                      <a
                        href="#trace"
                        className="group flex items-center gap-3 px-5 py-[9px] border-b border-[#EFEAE2] last:border-b-0 hover:bg-[#F7F4EF] transition-colors"
                      >
                        <span className="font-mono-code text-[10px] text-[#A39C92] w-5">
                          {item.n}
                        </span>
                        <span className="text-[13px] text-[#4A453E] group-hover:text-[#191714] transition-colors">
                          {item.label}
                        </span>
                        <span className="flex-1 border-b border-dashed border-[#DDD5C9]" />
                        <span className="font-mono-code text-[9.5px] uppercase tracking-[0.12em] text-[#A39C92]">
                          {item.phase}
                        </span>
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            </Reveal>
          </div>

          {/* Real, aggregate figures — the same ones the landing page shows. */}
          <Reveal delay={200}>
            <div className="mt-12 grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-5 border-t border-[#E4DED4] pt-6">
              {heroStats.map((item) => (
                <div key={item.k}>
                  <div className="mkt-eyebrow mb-1.5">{item.k}</div>
                  <div className="flex items-baseline gap-2">
                    {item.live && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#4E7B62] animate-pulse" />
                    )}
                    <span className="font-serif-editorial text-[24px] leading-none text-[#191714]">
                      {item.v}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- The console ---------------- */}
      <section
        id="trace"
        className="relative scroll-mt-20 overflow-hidden bg-[#0B0A08] py-14 sm:py-20"
      >
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-40 left-1/4 w-[720px] h-[420px] rounded-full bg-[#C25938] blur-[160px] opacity-[0.10]" />
          <div className="absolute bottom-0 right-0 w-[520px] h-[320px] rounded-full bg-[#7CB896] blur-[170px] opacity-[0.05]" />
        </div>

        <div className="relative max-w-6xl mx-auto px-4 sm:px-8">
          <Reveal>
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5">
              <div>
                <div className="font-mono-code text-[10px] uppercase tracking-[0.18em] text-[#9A8F7F]">
                  The trace
                </div>
                <h2 className="mkt-display mt-3 text-[32px] sm:text-[44px] text-[#F4EEE4]">
                  Follow one completion{' '}
                  <span className="italic text-[#E07A4F]">end to end.</span>
                </h2>
              </div>
              <p className="max-w-sm text-[12.5px] leading-relaxed text-[#9A9082]">
                A simulated trace with real limits and real failure rules. Timings and account ids
                are examples; every shape in the path is how the bridge behaves.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="mt-8">
              <TraceConsole stats={stats} />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- Guarantees ---------------- */}
      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-24">
        <div className="grid lg:grid-cols-[0.82fr_1.18fr] gap-10 lg:gap-16">
          <Reveal>
            <div>
              <div className="mkt-eyebrow mb-4">Read the fine print</div>
              <h2 className="mkt-display text-[32px] sm:text-[42px] text-[#191714]">
                What the trace
                <br />
                guarantees.
              </h2>
              <p className="mt-5 text-[14px] leading-relaxed text-[#7A736A] max-w-sm">
                The animation is a simplification; these four rules are not. They hold on every
                request the bridge forwards, including the ones that fail.
              </p>
            </div>
          </Reveal>

          <div className="grid sm:grid-cols-2 gap-x-10 gap-y-9">
            {GUARANTEES.map((item, index) => (
              <Reveal key={item.label} delay={index * 60}>
                <div className="border-t border-[#E4DED4] pt-5">
                  <div className="flex items-center gap-2">
                    <item.icon className="w-3.5 h-3.5 text-[#C25938]" />
                    <span className="font-mono-code text-[9.5px] uppercase tracking-[0.16em] text-[#A39C92]">
                      {item.label}
                    </span>
                  </div>
                  <h3 className="mt-3 text-[16.5px] font-medium leading-snug text-[#191714]">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-[#7A736A]">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Failure paths ---------------- */}
      <section className="border-y border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-24">
          <Reveal>
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-10">
              <div>
                <div className="mkt-eyebrow mb-3">Failure paths</div>
                <h2 className="mkt-display text-[32px] sm:text-[44px] text-[#191714]">
                  When the path breaks.
                </h2>
              </div>
              <p className="max-w-sm text-[13.5px] leading-relaxed text-[#7A736A]">
                The routing is only as good as its worst case. Each of these is a deliberate,
                visible outcome — never a silent retry or a fabricated success.
              </p>
            </div>
          </Reveal>

          <div className="grid sm:grid-cols-2 gap-5">
            {FAILURES.map((item, index) => (
              <Reveal key={item.code} delay={index * 60}>
                <div className="h-full rounded-2xl border border-[#E4DED4] bg-[#FBF9F5] p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono-code text-[9.5px] uppercase tracking-[0.14em] text-[#A39C92]">
                      {item.code}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono-code text-[9px] uppercase tracking-[0.1em] ${
                        item.tone === 'warn'
                          ? 'border-[#EAD9B8] bg-[#FDF6EC] text-[#A9761F]'
                          : 'border-[#D3E4DB] bg-[#EEF5F1] text-[#3F6B53]'
                      }`}
                    >
                      <span
                        className={`h-1 w-1 rounded-full ${
                          item.tone === 'warn' ? 'bg-[#C97A1E]' : 'bg-[#4E7B62]'
                        }`}
                      />
                      handled
                    </span>
                  </div>

                  <h3 className="mt-4 text-[17px] font-medium leading-snug text-[#191714]">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-[#7A736A]">{item.body}</p>

                  <div className="mt-5 flex items-center gap-2 border-t border-[#E4DED4] pt-3 font-mono-code text-[10px] text-[#7A736A]">
                    <ArrowRight className="h-3 w-3 text-[#A39C92]" />
                    {item.outcome}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- CTA ---------------- */}
      <section className="relative overflow-hidden bg-[#14120F]">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -bottom-32 left-1/2 -translate-x-1/2 w-[700px] h-[380px] rounded-full bg-[#C25938] blur-[140px] opacity-20" />
        </div>
        <div className="relative max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28 text-center">
          <Reveal>
            <Radio className="w-5 h-5 text-[#C25938] mx-auto mb-5" />
            <h2 className="mkt-display text-[34px] sm:text-[50px] text-white max-w-2xl mx-auto">
              Run the trace on
              <br />
              your own accounts.
            </h2>
            <p className="mt-5 text-[14.5px] text-[#A39C92] max-w-md mx-auto">
              The dashboard is already running on this host. Connect an account and watch the same
              path happen live.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/app"
                className="group inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white text-[#191714] text-sm font-medium hover:bg-[#F2EDE6] transition-colors"
              >
                Open the dashboard
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/docs#quickstart"
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-[#3A342C] text-[#E8E2D8] text-sm font-medium hover:bg-[#1F1C18] transition-colors"
              >
                Quickstart
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </div>
  );
};