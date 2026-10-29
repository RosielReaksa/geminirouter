import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  ShieldCheck,
  Zap,
  Layers,
  Gauge,
  Server,
  GitBranch,
  Lock,
  Terminal,
  Sparkles,
  ChevronDown,
} from 'lucide-react';
import { Link } from '../../router';
import { Reveal } from '../marketing/Chrome';
import { publicApi, type PublicStats, type PublicModel } from '../../services/publicApi';

const CodeBlock: React.FC<{ code: string; language?: string }> = ({ code }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="relative group rounded-xl bg-[#14120F] border border-[#2A2620] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#2A2620]">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#3A342C]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#3A342C]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#3A342C]" />
        </div>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 text-[11px] text-[#8A8278] hover:text-[#E8E2D8] transition-colors"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-[12.5px] leading-relaxed font-mono-code text-[#D8D2C7]">
        <code>{code}</code>
      </pre>
    </div>
  );
};

const StatChip: React.FC<{ label: string; value: string; tone?: 'live' | 'plain' }> = ({
  label,
  value,
  tone = 'plain',
}) => (
  <div className="flex items-baseline gap-2">
    {tone === 'live' && (
      <span className="w-1.5 h-1.5 rounded-full bg-[#4E7B62] animate-pulse relative top-[-2px]" />
    )}
    <span className="font-serif-editorial text-[22px] text-[#191714] leading-none">{value}</span>
    <span className="text-[12px] text-[#7A736A]">{label}</span>
  </div>
);

const FEATURES = [
  {
    icon: Layers,
    title: 'One endpoint, every account',
    body: 'Requests fan out across your whole Google account pool in parallel. No account is filled before the next one starts.',
  },
  {
    icon: GitBranch,
    title: 'Failover you can trust',
    body: 'A 429 or a verification block moves that single request to a healthy account. The request still succeeds; the bad account cools down.',
  },
  {
    icon: Gauge,
    title: 'Quota-aware routing',
    body: 'Accounts with more remaining quota carry proportionally more traffic. Limits are tracked per model, not per account.',
  },
  {
    icon: Lock,
    title: 'Your tokens stay home',
    body: 'OAuth credentials live in your SQLite file on your machine. Nothing is relayed to a third party, and no prompt is retained.',
  },
  {
    icon: Terminal,
    title: 'OpenAI-compatible',
    body: 'Point any OpenAI or Anthropic SDK at your own base URL. Streaming, tool calls and thinking blocks pass through unchanged.',
  },
  {
    icon: Server,
    title: 'Always on',
    body: 'The gateway supervises itself. If it drops, it comes back within seconds — there is no pause button to forget about.',
  },
];

const STEPS = [
  {
    n: '01',
    title: 'Connect your accounts',
    body: 'Sign in with Google once per account. Each one is stored locally with its own OAuth token.',
  },
  {
    n: '02',
    title: 'Copy your endpoint',
    body: 'The gateway exposes an OpenAI-compatible base URL and a single API key you control.',
  },
  {
    n: '03',
    title: 'Point your tools at it',
    body: 'Claude Code, Cursor, Codex CLI or a plain fetch call. Any OpenAI-compatible client works.',
  },
];

const FAQ = [
  {
    q: 'Is this a hosted service?',
    a: 'No. geminirouter is software you run on your own machine or server. This page is the public front door; the dashboard and the gateway both live on your host.',
  },
  {
    q: 'Where do my Google tokens go?',
    a: 'Into a local SQLite database next to the gateway. They are never sent anywhere except Google. The dashboard never renders a token, and the API key is never returned by any endpoint.',
  },
  {
    q: 'What happens when an account hits its limit?',
    a: 'That request is retried on another healthy account before any bytes reach your client. The exhausted account is cooled down for that specific model, so other models keep working.',
  },
  {
    q: 'Do all accounts work at the same time?',
    a: 'Yes. Requests are distributed across every healthy account concurrently, capped per account so no single one is overwhelmed.',
  },
  {
    q: 'Which clients work?',
    a: 'Anything that speaks the OpenAI chat completions API, plus the Anthropic messages API. That covers the OpenAI SDKs, Claude Code, Cursor and most agent frameworks.',
  },
];

export const LandingPage: React.FC = () => {
  const [stats, setStats] = useState<PublicStats | null>(null);
  const [models, setModels] = useState<PublicModel[]>([]);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  useEffect(() => {
    let cancelled = false;
    publicApi.getStats().then((s) => !cancelled && setStats(s));
    publicApi.getModels().then((m) => !cancelled && setModels(m.models));
    return () => {
      cancelled = true;
    };
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  const curlSample = `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer $GEMINIROUTER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;

  const pythonSample = `from openai import OpenAI

client = OpenAI(
    base_url="${origin}/v1",
    api_key="your-key",
)

resp = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`;

  const [tab, setTab] = useState<'curl' | 'python'>('curl');

  return (
    <div className="mkt-body">
      {/* ---------------- Hero ---------------- */}
      <section className="mkt-grain relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[520px] rounded-full bg-[#F5E7E0] blur-[120px] opacity-70" />
        </div>

        <div className="relative max-w-6xl mx-auto px-5 sm:px-8 pt-16 pb-20 sm:pt-24 sm:pb-28">
          <Reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/70 border border-[#E4DED4] text-[12px] text-[#4A453E]">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  stats?.online ? 'bg-[#4E7B62] animate-pulse' : 'bg-[#C97A1E]'
                }`}
              />
              {stats?.online
                ? `Gateway online · ${stats.accountsConnected} account${
                    stats.accountsConnected === 1 ? '' : 's'
                  } connected`
                : 'Self-hosted · connect an account to begin'}
            </div>
          </Reveal>

          <Reveal delay={60}>
            <h1 className="mkt-display mt-6 text-[44px] sm:text-[68px] lg:text-[82px] text-[#191714] max-w-4xl">
              One gateway for
              <br />
              <span className="italic text-[#C25938]">every</span> Google account
              <br />
              you own.
            </h1>
          </Reveal>

          <Reveal delay={120}>
            <p className="mt-6 text-[15px] sm:text-[17px] leading-relaxed text-[#4A453E] max-w-xl">
              geminirouter pools your Antigravity accounts behind a single
              OpenAI-compatible endpoint. Requests spread across every account at once, fail
              over silently, and never leave your machine.
            </p>
          </Reveal>

          <Reveal delay={180}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/app"
                className="group inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#191714] text-white text-sm font-medium hover:bg-[#332E28] transition-colors shadow-sm"
              >
                Open the dashboard
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/docs"
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white border border-[#E4DED4] text-[#191714] text-sm font-medium hover:border-[#C9C1B4] transition-colors"
              >
                Read the docs
                <ArrowUpRight className="w-3.5 h-3.5 text-[#7A736A]" />
              </Link>
            </div>
          </Reveal>

          {/* Live stats strip — real values, or honest placeholders */}
          <Reveal delay={240}>
            <div className="mt-14 grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-5 max-w-2xl">
              <StatChip
                tone={stats?.online ? 'live' : 'plain'}
                label={stats?.online ? 'online' : 'status'}
                value={stats?.online ? 'Live' : 'Idle'}
              />
              <StatChip
                label="accounts"
                value={stats ? String(stats.accountsConnected) : '—'}
              />
              <StatChip
                label="models"
                value={models.length > 0 ? String(models.length) : '—'}
              />
              <StatChip
                label="requests / 24h"
                value={stats ? stats.requestsServed.toLocaleString() : '—'}
              />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- Model marquee ---------------- */}
      {models.length > 0 && (
        <section className="border-y border-[#E4DED4] bg-[#F7F4EF] py-4 overflow-hidden mkt-marquee-wrap w-full max-w-[100vw]">
          <div className="flex items-center gap-3 max-w-6xl mx-auto px-5 sm:px-8 mb-2">
            <span className="mkt-eyebrow">Serving</span>
            <span className="text-[11px] text-[#A39C92]">
              {models.length} models live on this gateway
            </span>
          </div>
          <div className="overflow-hidden">
            <div className="flex w-max mkt-marquee">
              {[...models, ...models].map((m, i) => (
                <span
                  key={`${m.id}-${i}`}
                  className="px-4 py-1.5 mx-1.5 rounded-full bg-white border border-[#E4DED4] text-[12px] text-[#4A453E] font-mono-code whitespace-nowrap"
                >
                  {m.id}
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ---------------- Problem / promise ---------------- */}
      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <div className="grid lg:grid-cols-[1fr_1.1fr] gap-12 lg:gap-20 items-start">
          <Reveal>
            <div className="mkt-eyebrow mb-4">The problem</div>
            <h2 className="mkt-display text-[34px] sm:text-[44px] text-[#191714]">
              One account is
              <br />
              never enough.
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-[#4A453E] max-w-md">
              Every Google account has its own quota, its own rate limits and its own
              verification state. Managing that by hand means watching dashboards, copying keys
              between tools, and hitting a wall mid-task.
            </p>
          </Reveal>

          <Reveal delay={80}>
            <div className="space-y-5">
              {[
                {
                  bad: 'Switching keys by hand',
                  good: 'One key. The pool handles the rest.',
                },
                {
                  bad: 'A 429 kills your run',
                  good: 'The request retries elsewhere before a byte is sent.',
                },
                {
                  bad: 'Guessing which account has quota',
                  good: 'Per-model remaining quota, visible per account.',
                },
              ].map((row, i) => (
                <div key={i} className="grid sm:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-[#E4DED4] bg-[#F7F4EF] px-4 py-3.5">
                    <div className="text-[11px] uppercase tracking-wider text-[#A39C92] mb-1">
                      Before
                    </div>
                    <div className="text-[13.5px] text-[#7A736A] line-through decoration-[#C9C1B4]">
                      {row.bad}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#D8E3DB] bg-[#EEF5F1] px-4 py-3.5">
                    <div className="text-[11px] uppercase tracking-wider text-[#4E7B62] mb-1">
                      With geminirouter
                    </div>
                    <div className="text-[13.5px] text-[#2F5241]">{row.good}</div>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- Features ---------------- */}
      <section className="border-t border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
          <Reveal>
            <div className="mkt-eyebrow mb-4">Capabilities</div>
            <h2 className="mkt-display text-[34px] sm:text-[46px] text-[#191714] max-w-2xl">
              Built for a pool, not a single key.
            </h2>
          </Reveal>

          <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-[#E4DED4] rounded-2xl overflow-hidden border border-[#E4DED4]">
            {FEATURES.map((f, i) => {
              const Icon = f.icon;
              return (
                <Reveal key={f.title} delay={i * 50}>
                  <div className="h-full bg-[#FBF9F5] p-7 hover:bg-white transition-colors">
                    <div className="w-9 h-9 rounded-lg bg-[#F5E7E0] flex items-center justify-center mb-4">
                      <Icon className="w-4.5 h-4.5 text-[#C25938]" strokeWidth={1.75} />
                    </div>
                    <h3 className="text-[15px] font-semibold text-[#191714] mb-2">{f.title}</h3>
                    <p className="text-[13.5px] leading-relaxed text-[#7A736A]">{f.body}</p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- How it works ---------------- */}
      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <Reveal>
          <div className="mkt-eyebrow mb-4">Setup</div>
          <h2 className="mkt-display text-[34px] sm:text-[46px] text-[#191714] max-w-2xl">
            Three steps, about two minutes.
          </h2>
        </Reveal>

        <div className="mt-14 grid md:grid-cols-3 gap-10">
          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 70}>
              <div className="relative">
                <div className="font-mono-code text-[12px] text-[#C25938] mb-3">{s.n}</div>
                <div className="h-px bg-[#E4DED4] mb-5" />
                <h3 className="text-[16px] font-semibold text-[#191714] mb-2">{s.title}</h3>
                <p className="text-[13.5px] leading-relaxed text-[#7A736A]">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- Code sample ---------------- */}
      <section className="border-t border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
          <div className="grid lg:grid-cols-[1fr_1.15fr] gap-12 items-center">
            <Reveal>
              <div className="mkt-eyebrow mb-4">Drop-in</div>
              <h2 className="mkt-display text-[34px] sm:text-[44px] text-[#191714]">
                Change one line
                <br />
                of config.
              </h2>
              <p className="mt-5 text-[15px] leading-relaxed text-[#4A453E] max-w-md">
                Swap the base URL and the key. Everything else — streaming, tool calls, thinking
                blocks — behaves the way your client already expects.
              </p>
              <div className="mt-6 space-y-2">
                {[
                  'OpenAI-compatible /v1/chat/completions',
                  'Anthropic-compatible /v1/messages',
                  'Gemini-native /v1beta/models',
                  'Server-sent events streamed unbuffered',
                ].map((line) => (
                  <div key={line} className="flex items-center gap-2 text-[13px] text-[#4A453E]">
                    <Check className="w-3.5 h-3.5 text-[#4E7B62] shrink-0" />
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={80}>
              <div>
                <div className="flex items-center gap-1 mb-3">
                  {(['curl', 'python'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`px-3 py-1.5 rounded-lg text-[12px] font-mono-code transition-colors ${
                        tab === t
                          ? 'bg-[#191714] text-white'
                          : 'text-[#7A736A] hover:bg-[#EFEAE2]'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <CodeBlock code={tab === 'curl' ? curlSample : pythonSample} />
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---------------- Privacy ---------------- */}
      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <Reveal>
          <div className="rounded-3xl border border-[#E4DED4] bg-white overflow-hidden">
            <div className="grid lg:grid-cols-[1.2fr_1fr]">
              <div className="p-8 sm:p-12">
                <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#EEF5F1] border border-[#D8E3DB] text-[11px] text-[#2F5241] mb-5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Private by architecture
                </div>
                <h2 className="mkt-display text-[30px] sm:text-[40px] text-[#191714]">
                  Nothing leaves
                  <br />
                  your server.
                </h2>
                <p className="mt-4 text-[14.5px] leading-relaxed text-[#4A453E] max-w-md">
                  Prompts stream straight from your client to Google through your own process.
                  There is no middle service, no analytics pipeline, and no account list to leak.
                </p>
                <Link
                  to="/privacy"
                  className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-[#C25938] hover:text-[#A8462A]"
                >
                  How data is handled
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>

              <div className="bg-[#F7F4EF] border-t lg:border-t-0 lg:border-l border-[#E4DED4] p-8 sm:p-12">
                <div className="space-y-4">
                  {[
                    { icon: Lock, label: 'OAuth tokens', value: 'Local SQLite only' },
                    { icon: Zap, label: 'Prompt retention', value: 'None' },
                    { icon: ShieldCheck, label: 'Third-party relays', value: 'None' },
                    { icon: Server, label: 'Where it runs', value: 'Your host' },
                  ].map((row) => {
                    const Icon = row.icon;
                    return (
                      <div key={row.label} className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2.5">
                          <Icon className="w-4 h-4 text-[#7A736A]" strokeWidth={1.75} />
                          <span className="text-[13px] text-[#4A453E]">{row.label}</span>
                        </div>
                        <span className="text-[12.5px] font-mono-code text-[#2F5241]">
                          {row.value}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ---------------- FAQ ---------------- */}
      <section className="border-t border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
          <Reveal>
            <div className="mkt-eyebrow mb-4">Questions</div>
            <h2 className="mkt-display text-[32px] sm:text-[42px] text-[#191714]">
              Straight answers.
            </h2>
          </Reveal>

          <div className="mt-10 divide-y divide-[#E4DED4] border-y border-[#E4DED4]">
            {FAQ.map((item, i) => {
              const open = openFaq === i;
              return (
                <div key={item.q}>
                  <button
                    onClick={() => setOpenFaq(open ? null : i)}
                    className="w-full flex items-start justify-between gap-6 py-5 text-left group"
                    aria-expanded={open}
                  >
                    <span
                      className={`text-[15px] transition-colors ${
                        open ? 'text-[#191714] font-medium' : 'text-[#4A453E] group-hover:text-[#191714]'
                      }`}
                    >
                      {item.q}
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 shrink-0 mt-0.5 text-[#7A736A] transition-transform ${
                        open ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <div
                    className={`grid transition-all duration-300 ${
                      open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <p className="pb-5 pr-10 text-[13.5px] leading-relaxed text-[#7A736A]">
                        {item.a}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------- Final CTA ---------------- */}
      <section className="relative overflow-hidden bg-[#14120F]">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -bottom-32 left-1/2 -translate-x-1/2 w-[700px] h-[380px] rounded-full bg-[#C25938] blur-[140px] opacity-20" />
        </div>
        <div className="relative max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28 text-center">
          <Reveal>
            <Sparkles className="w-5 h-5 text-[#C25938] mx-auto mb-5" />
            <h2 className="mkt-display text-[34px] sm:text-[52px] text-white max-w-2xl mx-auto">
              Bring your accounts.
              <br />
              Keep your data.
            </h2>
            <p className="mt-5 text-[14.5px] text-[#A39C92] max-w-md mx-auto">
              The dashboard is already running on this host. Sign in and connect your first
              Google account.
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
