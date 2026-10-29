import React, { useEffect, useMemo, useState } from 'react';
import {
  Search,
  X,
  Rocket,
  Users,
  GitBranch,
  Terminal,
  LayoutDashboard,
  Wrench,
  ChevronDown,
  ArrowRight,
  ArrowUpRight,
  Copy,
  Check,
  LifeBuoy,
  ShieldCheck,
  ExternalLink,
} from 'lucide-react';
import { Link } from '../../router';
import { Reveal } from '../marketing/Chrome';

/**
 * Public help centre.
 *
 * Everything here is written against the behaviour that actually exists in this
 * repository: the routing/lease model in docs/ACCOUNT-FAILOVER.md, the endpoints
 * in server/src/index.ts, and the dashboard controls in src/components. It is
 * deliberately concrete — no invented plans, limits or features.
 */

type IconType = React.ComponentType<{ className?: string; strokeWidth?: number }>;

interface HelpLink {
  label: string;
  to: string;
}

interface HelpEntry {
  id: string;
  q: string;
  /** Plain text summary. Also the search corpus, so keep it self-contained. */
  body: string;
  bullets?: string[];
  code?: { title?: string; text: string };
  note?: { tone: 'info' | 'warn' | 'good'; text: string };
  links?: HelpLink[];
}

interface HelpCategory {
  id: string;
  label: string;
  short: string;
  icon: IconType;
  blurb: string;
  entries: HelpEntry[];
}

/** Render `inline code` spans inside a plain-text body. */
const Inline: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]"
          >
            {part}
          </code>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
};

const CodeBlock: React.FC<{ title?: string; text: string }> = ({ title, text }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="rounded-xl bg-[#14120F] border border-[#2A2620] overflow-hidden my-3">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#2A2620]">
        <span className="text-[11px] font-mono-code text-[#8A8278]">{title || 'shell'}</span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 text-[11px] text-[#8A8278] hover:text-[#E8E2D8] transition-colors"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-[12.5px] leading-relaxed font-mono-code text-[#D8D2C7]">
        <code>{text}</code>
      </pre>
    </div>
  );
};

const NOTE_TONES = {
  info: {
    wrap: 'border-[#E4DED4] bg-[#FBF9F5]',
    text: 'text-[#7A736A]',
    icon: 'text-[#7A736A]',
  },
  warn: {
    wrap: 'border-[#F2E2C4] bg-[#FFFBF2]',
    text: 'text-[#8A6A2E]',
    icon: 'text-[#C97A1E]',
  },
  good: {
    wrap: 'border-[#D8E3DB] bg-[#EEF5F1]',
    text: 'text-[#2F5241]',
    icon: 'text-[#4E7B62]',
  },
} as const;

const buildCategories = (origin: string, v1: string): HelpCategory[] => [
  {
    id: 'start',
    label: 'Getting started',
    short: 'Start',
    icon: Rocket,
    blurb: 'What this thing is, what you need, and the fastest path to a working request.',
    entries: [
      {
        id: 'what-is-it',
        q: 'What is geminirouter?',
        body:
          'It is a self-hosted gateway that pools several Google Antigravity accounts behind one OpenAI-compatible endpoint. Your clients talk to one base URL and one key; the gateway decides which account serves each request, spreads load across all of them at once, and moves a request to another account when one runs out of quota.',
        bullets: [
          'One base URL, one API key, any number of accounts',
          'OpenAI, Anthropic and Gemini-compatible request formats',
          'Runs natively on Node.js — no Docker, no third-party relay',
          'Prompts are never stored by the gateway',
        ],
      },
      {
        id: 'prerequisites',
        q: 'What do I need before I start?',
        body: 'Three things: a machine to run it on, at least one Google account with Antigravity access, and Node.js. A single account works; the pool only becomes useful when you add more.',
        bullets: [
          'A host — laptop, home server or VPS',
          'One or more Google accounts you are entitled to use',
          'Node.js 22 or newer (or the bundled start script)',
        ],
        note: {
          tone: 'warn',
          text:
            'Set GEMINIROUTER_ADMIN_PASSWORD before exposing the host to the internet. Without it the dashboard is open to anyone who can reach the port.',
        },
      },
      {
        id: 'run-it',
        q: 'How do I start the gateway?',
        body: 'From the repository root, one script starts both processes: the core that holds the OAuth tokens and the bridge that serves the dashboard and proxies the API.',
        code: {
          title: 'start',
          text: `# from the repository root
node scripts/launch-all.mjs

# dashboard  http://localhost:3000
# gateway    http://localhost:8046/v1`,
        },
        links: [{ label: 'Full self-hosting guide', to: '/docs#selfhost' }],
      },
      {
        id: 'first-request',
        q: 'What is the shortest path to a first successful request?',
        body: 'Connect an account, copy the base URL and key from the gateway page, then send one request. If that returns text, everything downstream is already working.',
        code: {
          title: 'curl',
          text: `curl ${v1}/chat/completions \\
  -H "Authorization: Bearer $GEMINIROUTER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
        },
        links: [
          { label: 'Open the dashboard', to: '/app' },
          { label: 'API reference', to: '/docs' },
        ],
      },
    ],
  },
  {
    id: 'accounts',
    label: 'Accounts & quota',
    short: 'Accounts',
    icon: Users,
    blurb: 'Connecting accounts, reading quota correctly, and what the status badges mean.',
    entries: [
      {
        id: 'connect-account',
        q: 'How do I connect a Google account?',
        body: 'Open Accounts & Quotas and choose Add Google Account. You sign in with Google once per account; the resulting OAuth token is written to a local SQLite database next to the gateway and used only to call Google on your behalf.',
        bullets: [
          'Each account is independent — its own token, its own quota',
          'Repeat for as many accounts as you want in the pool',
          'No account password is ever seen or stored',
        ],
      },
      {
        id: 'multiple-accounts',
        q: 'Can several accounts serve traffic at the same time?',
        body: 'Yes. Requests are distributed across every healthy account concurrently, not filled one account at a time. Each account has its own in-flight cap, so adding a second account roughly doubles parallel capacity.',
      },
      {
        id: 'quota-meaning',
        q: 'What do the quota percentages actually mean?',
        body: 'Every percentage is the amount REMAINING, not the amount used. Quota is tracked per model, because Google limits each model separately, and each model has both a short rolling window and a weekly window.',
        bullets: [
          '100% = untouched quota, 0% = exhausted',
          'Per-model windows: a Claude limit does not consume Gemini quota',
          'Pool Quota Left averages every model meter across every account',
        ],
        note: {
          tone: 'info',
          text:
            'A low number on one model row is not a broken account. Check which model it is before reacting.',
        },
      },
      {
        id: 'verification',
        q: 'What does “Verification Required” mean?',
        body: 'Google answered a call with a verification challenge instead of content. The account is quarantined until you complete the checkpoint: open the link shown on the account, finish the Google check, then re-test. If the checkpoint has expired, re-sign in to renew the token.',
        bullets: [
          'The dashboard surfaces a fresh validation link when it can',
          'The account stays out of rotation until a test call succeeds',
          'This is a Google-side state, not a gateway bug',
        ],
        links: [{ label: 'Fix it in Accounts', to: '/app' }],
      },
      {
        id: 'not-tested',
        q: 'Why does an account say “not tested yet”?',
        body: 'No test call has run against it since it was added. The test is a real request pinned to that single account — it never silently fails over to a different account and reports a false pass.',
      },
      {
        id: 'remove-account',
        q: 'How do I remove an account?',
        body: 'Use Remove Account on the account row. That takes it out of rotation immediately. Deleting the profile directory removes every token and log this software created.',
      },
    ],
  },
  {
    id: 'routing',
    label: 'Routing & failover',
    short: 'Routing',
    icon: GitBranch,
    blurb: 'How a request picks an account, and exactly what happens when that account is out of quota.',
    entries: [
      {
        id: 'selection',
        q: 'How does the gateway choose which account serves a request?',
        body: 'The core selects the account, because it is the only process holding the OAuth tokens and the per-model quota picture. It prefers the account with the fewest in-flight requests, breaks ties toward the most remaining quota, and keeps multi-turn conversations on the same account where it can.',
        bullets: [
          'Fewest in-flight requests first',
          'Then highest remaining quota',
          'Session affinity for multi-turn conversations',
          'Accounts cooling down for the requested model are skipped',
        ],
      },
      {
        id: 'failover',
        q: 'What happens when an account hits its limit?',
        body: 'Before any byte reaches your client, the request is retried on the next eligible account and the failing account is cooled down for that model only. Your client sees a normal response, not an error.',
        bullets: [
          '429 or a verification block → retried elsewhere',
          'Cooldown is scoped per account + model',
          'Only a fully exhausted pool returns 429, with Retry-After',
        ],
        links: [{ label: 'Rate-limit details', to: '/docs#limits' }],
      },
      {
        id: 'stream-safety',
        q: 'Can a streamed response be duplicated or cut?',
        body: 'No. Once the first byte has been streamed to your client the request is never retried, so a partial stream is never replayed against a second account. Failover only happens before streaming begins.',
      },
      {
        id: 'concurrency',
        q: 'How many requests can run at once?',
        body: 'Total capacity is the number of healthy accounts multiplied by the per-account concurrency cap (10 by default). When every account is at its cap, the capacity policy decides what happens next.',
        bullets: [
          'queue — the request waits briefly for a free slot',
          'reject_429 — the request fails immediately with Retry-After: 1',
          'Both are configurable in Settings',
        ],
      },
      {
        id: 'strategies',
        q: 'What do the rotation strategies mean?',
        body: 'The strategy sets how strongly the pool favours a single account versus spreading load.',
        bullets: [
          'Least-Used Quota — traffic follows remaining quota; the default',
          'Round-Robin — accounts take turns evenly, regardless of quota',
          'Primary First — the primary account serves until it is limited, then fallback',
        ],
      },
    ],
  },
  {
    id: 'clients',
    label: 'Clients & SDKs',
    short: 'Clients',
    icon: Terminal,
    blurb: 'Copy-paste configuration for the tools people actually point at this gateway.',
    entries: [
      {
        id: 'base-url',
        q: 'Which base URL should I use?',
        body: 'Use the base URL shown on the gateway page, with /v1 appended for OpenAI-style clients. The Anthropic messages API is also served directly. The host and port in Settings determine this value — if you changed the port, use the new one.',
        code: {
          title: 'endpoints',
          text: `OpenAI-compatible   ${origin}/v1
Anthropic messages  ${origin}/v1/messages
Gemini-native       ${origin}/v1beta/models/:model
Model list          ${origin}/v1/models`,
        },
      },
      {
        id: 'claude-code',
        q: 'How do I point Claude Code at it?',
        body: 'Set the Anthropic base URL and key through the environment, or in the Claude Code settings file.',
        code: {
          title: '~/.claude/settings.json',
          text: `{
  "env": {
    "ANTHROPIC_BASE_URL": "${v1}",
    "ANTHROPIC_API_KEY": "<your gateway key>"
  }
}`,
        },
      },
      {
        id: 'codex-cli',
        q: 'How do I configure Codex CLI?',
        body: 'Codex speaks the OpenAI-compatible API, so it needs a provider block pointing at the gateway.',
        code: {
          title: '~/.codex/config.toml',
          text: `model_provider = "geminirouter"

[model_providers.geminirouter]
base_url = "${v1}"
api_key = "<your gateway key>"`,
        },
      },
      {
        id: 'cursor',
        q: 'How do I use it from Cursor?',
        body: 'Cursor lets you override the OpenAI base URL and key in its model settings.',
        bullets: [
          'Paste the gateway key as the OpenAI API key',
          'Enable “Override OpenAI Base URL” and enter the /v1 URL',
          'Add the model ids you want to call',
        ],
      },
      {
        id: 'openai-sdk',
        q: 'How do I call it from the OpenAI Python SDK?',
        body: 'Point base_url at the gateway and use the gateway key. Nothing else changes.',
        code: {
          title: 'python',
          text: `from openai import OpenAI

client = OpenAI(
    base_url="${v1}",
    api_key="<your gateway key>",
)

resp = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`,
        },
      },
      {
        id: 'streaming',
        q: 'Does streaming, tool calling and thinking output pass through?',
        body: 'Yes. Set stream: true and the response arrives as server-sent events, relayed unbuffered. Tool calls and reasoning/thinking blocks pass through in the protocol shape your client expects.',
        links: [{ label: 'Streaming details', to: '/docs#streaming' }],
      },
    ],
  },
  {
    id: 'dashboard',
    label: 'The dashboard',
    short: 'Dashboard',
    icon: LayoutDashboard,
    blurb: 'What each page shows, and where the settings that matter actually live.',
    entries: [
      {
        id: 'pages',
        q: 'What does each page do?',
        body: 'Six pages, one job each. Every number on them comes from real traffic records or the core’s reported account state — nothing is simulated when the core is connected.',
        bullets: [
          'Overview — health, pool quota, account pool, recent activity',
          'Accounts & Quotas — connect, test, reorder and remove accounts',
          'Available Models — the live catalog and per-model test calls',
          'API Gateway & Routing — base URL, key and client snippets',
          'Traffic Monitor — every request with account attribution and latency',
          'Settings — port, key rotation, strategy and concurrency policy',
        ],
      },
      {
        id: 'always-on',
        q: 'Why is there no start or stop button?',
        body: 'The gateway is always on by design. There is no paused state to forget about: if the process drops it comes back, and the Overview page reports the truth either way.',
      },
      {
        id: 'traffic-log',
        q: 'What is recorded in the traffic log?',
        body: 'Request metadata only — timestamp, model, the account that served it, status, latency and token counts. Prompt and completion text is not persisted by the gateway.',
        note: {
          tone: 'good',
          text: 'Zero prompt retention is a property of the architecture, not a setting you have to remember to enable.',
        },
      },
      {
        id: 'settings',
        q: 'Where do I change the port, key or routing behaviour?',
        body: 'Settings holds the network binding, the master API key, the routing strategy, quota failover and the per-account concurrency cap. Changes to routing fields are written into the core’s own configuration, so the core keeps the final say.',
      },
    ],
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    short: 'Fix issues',
    icon: Wrench,
    blurb: 'Symptom first. Each entry names the cause and the smallest thing that resolves it.',
    entries: [
      {
        id: 'ts-401',
        q: '401 — missing or invalid API key',
        body: 'The request reached the gateway but the key did not match. Copy the key again from the gateway page; a trailing newline in an environment variable is the most common cause.',
        bullets: [
          'Send it as Authorization: Bearer <key>',
          'Confirm you did not paste the dashboard password instead',
        ],
      },
      {
        id: 'ts-429',
        q: '429 — pool exhausted',
        body: 'Every eligible account is either at its concurrency cap or out of quota for that model. Read the Retry-After header: it carries the earliest reset. Adding an account, or waiting for the window to roll, both clear it.',
        bullets: [
          'Check Overview → Pool Quota Left for the model in question',
          'If only one model is affected, it is a per-model limit, not the pool',
        ],
      },
      {
        id: 'ts-403',
        q: '403 — account needs Google verification',
        body: 'Google returned a verification challenge. Open the account’s validation link, complete the checkpoint in the browser, then run the account test again. The account re-enters rotation as soon as a test succeeds.',
        links: [{ label: 'Accounts & Quotas', to: '/app' }],
      },
      {
        id: 'ts-502',
        q: '502 or 503 — upstream unreachable',
        body: 'The bridge could not reach the core gateway, or the core reported a transient upstream failure. Check that both processes are running and that the gateway port matches the one in Settings.',
        bullets: [
          '502 usually means the core is not listening',
          '503 is retryable — retry before investigating further',
        ],
      },
      {
        id: 'ts-400',
        q: '400 — unknown model',
        body: 'The model id does not exist in the live catalog. Read the exact ids from Available Models or from the /v1/models endpoint rather than typing one from memory.',
        links: [{ label: 'Browse live models', to: '/models' }],
      },
      {
        id: 'ts-empty-numbers',
        q: 'The dashboard shows “—” or zero for everything',
        body: 'Those fields are null when there is no real data yet — no requests served, no quota snapshot taken, or the core is offline. The gateway never fills them with plausible-looking numbers.',
        bullets: [
          'Send one request and refresh',
          'If accounts are missing, the core is probably not connected',
        ],
      },
      {
        id: 'ts-open-dashboard',
        q: 'The dashboard never asked me for a password',
        body: 'That is expected until an admin password is configured. Set GEMINIROUTER_ADMIN_PASSWORD in the bridge environment and restart it; sign-in then becomes required and sessions are issued as tokens rather than storing the password in the browser.',
        note: {
          tone: 'warn',
          text: 'Do not expose the dashboard port publicly while it is open.',
        },
      },
      {
        id: 'ts-stream-cut',
        q: 'A long stream stops partway through',
        body: 'Once streaming has started the gateway will not retry, by design — retrying could duplicate output or tool calls. A cut stream means the upstream connection ended, so retry the request yourself; it will be routed to a healthy account.',
      },
    ],
  },
];

const QUICK_START = [
  {
    n: '01',
    title: 'Connect an account',
    body: 'Sign in with Google once per account. Each one keeps its own token and quota.',
    to: '/app',
    cta: 'Open Accounts',
  },
  {
    n: '02',
    title: 'Copy your endpoint',
    body: 'The gateway page shows the base URL and the key your clients will use.',
    to: '/app',
    cta: 'Open Gateway',
  },
  {
    n: '03',
    title: 'Point a tool at it',
    body: 'Claude Code, Cursor, Codex CLI or a plain curl call — same URL, same key.',
    to: '/help#clients',
    cta: 'Client setup',
  },
];

/** Which entry (if any) a `#hash` points at, plus the section that owns it. */
const resolveHash = (categories: HelpCategory[], hash: string) => {
  const key = hash.replace('#', '');
  if (!key) return null;
  for (const c of categories) {
    if (c.id === key) return { section: c.id, entry: null as string | null };
    if (c.entries.some((e) => e.id === key)) return { section: c.id, entry: key };
  }
  return null;
};

export const HelpPage: React.FC = () => {
  const [query, setQuery] = useState('');

  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const v1 = `${origin}/v1`;

  const categories = useMemo(() => buildCategories(origin, v1), [origin, v1]);

  // Both initial states come from the URL hash, so a deep link like
  // /help#ts-429 lands on an open answer without writing state from an effect.
  // With no hash, the first answer of each section is open so the page shows
  // what an answer looks like instead of six collapsed lists.
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    const target = resolveHash(categories, window.location.hash);
    if (target?.entry) return new Set([target.entry]);
    return new Set(categories.map((c) => c.entries[0].id));
  });

  const [activeSection, setActiveSection] = useState(() => {
    const target = resolveHash(categories, window.location.hash);
    return target?.section ?? categories[0].id;
  });

  // Scroll to a deep-linked answer once it is mounted.
  useEffect(() => {
    const target = resolveHash(categories, window.location.hash);
    if (!target?.entry) return;
    document.getElementById(target.entry)?.scrollIntoView({ block: 'center' });
  }, [categories]);

  // Same-page hash links (footer, nav chips) do not remount this page.
  useEffect(() => {
    const onHashChange = () => {
      const target = resolveHash(categories, window.location.hash);
      if (!target) return;
      setActiveSection(target.section);
      if (target.entry) setOpenIds(new Set([target.entry]));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [categories]);

  useEffect(() => {
    const onScroll = () => {
      // Activate a section once its heading reaches the upper third of the
      // viewport. Measuring against the sticky bar's bottom alone lags by a
      // whole section, because the heading sits below it while the previous
      // section is still on screen.
      const bar = document.getElementById('help-chip-bar');
      const barBottom = bar ? bar.getBoundingClientRect().bottom : 64;
      const threshold = Math.max(barBottom + 24, window.innerHeight * 0.32);

      let current = categories[0].id;
      for (const c of categories) {
        const el = document.getElementById(c.id);
        if (el && el.getBoundingClientRect().top <= threshold) current = c.id;
      }
      setActiveSection(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [categories]);

  const trimmed = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!trimmed) return categories;

    return categories
      .map((c) => ({
        ...c,
        entries: c.entries.filter((e) => {
          const haystack = [
            e.q,
            e.body,
            ...(e.bullets || []),
            e.code?.text || '',
            e.note?.text || '',
            c.label,
          ]
            .join(' ')
            .toLowerCase();
          return haystack.includes(trimmed);
        }),
      }))
      .filter((c) => c.entries.length > 0);
  }, [categories, trimmed]);

  const totalMatches = results.reduce((sum, c) => sum + c.entries.length, 0);

  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="mkt-body">
      {/* ---------------- Hero + search ---------------- */}
      <section className="border-b border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 pt-14 pb-12">
          <Reveal>
            <div className="flex items-center gap-2 mkt-eyebrow mb-3">
              <LifeBuoy className="w-3.5 h-3.5 text-[#C25938]" strokeWidth={1.75} />
              <span>Help centre</span>
            </div>
            <h1 className="mkt-display text-[40px] sm:text-[58px] text-[#191714] max-w-3xl">
              How can we help?
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-[#4A453E] max-w-xl">
              Setup, accounts, routing and the failures people actually hit. Every answer here
              describes how this gateway behaves — not how it is supposed to.
            </p>
          </Reveal>

          <Reveal delay={70}>
            <div className="mt-8 max-w-xl">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[#A39C92]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help — “429”, “quota”, “Claude Code”…"
                  aria-label="Search help articles"
                  className="w-full pl-11 pr-11 py-3.5 rounded-xl bg-white border border-[#E4DED4] text-[14px] text-[#191714] placeholder:text-[#A39C92] focus:outline-none focus:border-[#C25938] focus:ring-2 focus:ring-[#F5E7E0] transition shadow-sm"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    aria-label="Clear search"
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-[#A39C92] hover:text-[#191714] hover:bg-[#F0EBE3] transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-[#A39C92]">
                <span>Popular:</span>
                {[
                  { label: '429', q: '429' },
                  { label: 'Quota', q: 'quota' },
                  { label: 'Claude Code', q: 'claude code' },
                  { label: 'Verification', q: 'verification' },
                ].map((chip) => (
                  <button
                    key={chip.label}
                    onClick={() => setQuery(chip.q)}
                    className="px-2.5 py-1 rounded-full bg-white border border-[#E4DED4] text-[#4A453E] hover:border-[#C9C1B4] transition-colors"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- Quick start ---------------- */}
      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-12">
        <div className="grid sm:grid-cols-3 gap-4">
          {QUICK_START.map((s, i) => (
            <Reveal key={s.n} delay={i * 60}>
              <Link
                to={s.to}
                className="group h-full flex flex-col rounded-2xl border border-[#E4DED4] bg-white p-6 hover:border-[#C9C1B4] hover:shadow-sm transition-all"
              >
                <div className="font-mono-code text-[11.5px] text-[#C25938]">{s.n}</div>
                <h3 className="mt-3 text-[15px] font-semibold text-[#191714]">{s.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-[#7A736A] flex-1">
                  {s.body}
                </p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#C25938]">
                  {s.cta}
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- Category chips (mobile) ---------------- */}
      <div
        id="help-chip-bar"
        className="lg:hidden sticky top-16 z-30 bg-[#FBF9F5]/95 backdrop-blur border-y border-[#E4DED4]"
      >
        <div className="px-5 py-2.5 flex items-center gap-2 overflow-x-auto">
          {categories.map((c) => (
            <a
              key={c.id}
              href={`#${c.id}`}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-[12.5px] whitespace-nowrap transition-colors ${
                activeSection === c.id
                  ? 'bg-[#191714] text-white'
                  : 'bg-white border border-[#E4DED4] text-[#4A453E]'
              }`}
            >
              {c.short}
            </a>
          ))}
        </div>
      </div>

      {/* ---------------- Body: TOC + articles ---------------- */}
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-12">
        <div className="grid lg:grid-cols-[210px_1fr] gap-12">
          <aside className="hidden lg:block">
            <nav className="sticky top-24 space-y-0.5">
              <div className="mkt-eyebrow px-3 mb-2">Browse</div>
              {categories.map((c) => {
                const Icon = c.icon;
                return (
                  <a
                    key={c.id}
                    href={`#${c.id}`}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12.5px] transition-colors ${
                      activeSection === c.id
                        ? 'bg-[#EFEAE2] text-[#191714] font-medium'
                        : 'text-[#7A736A] hover:text-[#191714]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" strokeWidth={1.75} />
                    {c.label}
                  </a>
                );
              })}

              <div className="pt-4 mt-4 border-t border-[#E4DED4]">
                <Link
                  to="/docs"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12.5px] text-[#7A736A] hover:text-[#191714] transition-colors"
                >
                  API reference
                  <ArrowUpRight className="w-3 h-3" />
                </Link>
                <Link
                  to="/app"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12.5px] text-[#7A736A] hover:text-[#191714] transition-colors"
                >
                  Dashboard
                  <ArrowUpRight className="w-3 h-3" />
                </Link>
              </div>
            </nav>
          </aside>

          <div className="min-w-0 max-w-2xl">
            {trimmed && (
              <div className="mb-8 flex items-center justify-between gap-4 rounded-xl border border-[#E4DED4] bg-[#F7F4EF] px-4 py-3">
                <span className="text-[13px] text-[#4A453E]">
                  {totalMatches === 0
                    ? `No matches for “${query.trim()}”`
                    : `${totalMatches} answer${totalMatches === 1 ? '' : 's'} for “${query.trim()}”`}
                </span>
                <button
                  onClick={() => setQuery('')}
                  className="text-[12px] font-medium text-[#C25938] hover:text-[#A8462A]"
                >
                  Clear
                </button>
              </div>
            )}

            {trimmed && totalMatches === 0 && (
              <div className="rounded-2xl border border-[#E4DED4] bg-white p-8 text-center">
                <p className="text-[14px] text-[#4A453E]">
                  Nothing matched that search. Try a shorter phrase, or read the reference for
                  the endpoint you are calling.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                  <Link
                    to="/docs"
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#191714] text-white text-[13px] font-medium hover:bg-[#332E28] transition-colors"
                  >
                    API reference
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                  <button
                    onClick={() => setQuery('')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-[#E4DED4] text-[13px] font-medium text-[#191714] hover:border-[#C9C1B4] transition-colors"
                  >
                    Reset search
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-12">
              {results.map((category) => {
                const Icon = category.icon;
                return (
                  <section key={category.id} id={category.id} className="scroll-mt-28">
                    <div className="flex items-start gap-3 mb-1">
                      <div className="w-8 h-8 rounded-lg bg-[#F5E7E0] flex items-center justify-center shrink-0 mt-0.5">
                        <Icon className="w-4 h-4 text-[#C25938]" strokeWidth={1.75} />
                      </div>
                      <div>
                        <h2 className="mkt-display text-[26px] text-[#191714] leading-tight">
                          {category.label}
                        </h2>
                        <p className="mt-1 text-[13px] leading-relaxed text-[#7A736A]">
                          {category.blurb}
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 divide-y divide-[#E4DED4] border-y border-[#E4DED4]">
                      {category.entries.map((entry) => {
                        const isOpen = trimmed ? true : openIds.has(entry.id);
                        const panelId = `${entry.id}-panel`;

                        return (
                          <div key={entry.id} id={entry.id} className="scroll-mt-28">
                            <button
                              onClick={() => toggle(entry.id)}
                              aria-expanded={isOpen}
                              aria-controls={panelId}
                              className="w-full flex items-start justify-between gap-6 py-4 text-left group"
                            >
                              <span
                                className={`text-[14.5px] transition-colors ${
                                  isOpen
                                    ? 'text-[#191714] font-medium'
                                    : 'text-[#4A453E] group-hover:text-[#191714]'
                                }`}
                              >
                                {entry.q}
                              </span>
                              <ChevronDown
                                className={`w-4 h-4 shrink-0 mt-0.5 text-[#7A736A] transition-transform ${
                                  isOpen ? 'rotate-180' : ''
                                }`}
                              />
                            </button>

                            <div
                              id={panelId}
                              className={`grid transition-all duration-300 ${
                                isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                              }`}
                            >
                              <div className="overflow-hidden">
                                <div className="pb-5 pr-8">
                                  <p className="text-[13.5px] leading-relaxed text-[#4A453E]">
                                    <Inline text={entry.body} />
                                  </p>

                                  {entry.bullets && (
                                    <ul className="mt-3 space-y-1.5">
                                      {entry.bullets.map((b) => (
                                        <li
                                          key={b}
                                          className="flex items-start gap-2.5 text-[13px] text-[#4A453E]"
                                        >
                                          <span className="w-1 h-1 rounded-full bg-[#C9C1B4] shrink-0 mt-[7px]" />
                                          <span>
                                            <Inline text={b} />
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  )}

                                  {entry.code && (
                                    <CodeBlock title={entry.code.title} text={entry.code.text} />
                                  )}

                                  {entry.note && (
                                    <div
                                      className={`mt-3 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12.5px] leading-relaxed ${
                                        NOTE_TONES[entry.note.tone].wrap
                                      } ${NOTE_TONES[entry.note.tone].text}`}
                                    >
                                      <ShieldCheck
                                        className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                                          NOTE_TONES[entry.note.tone].icon
                                        }`}
                                        strokeWidth={1.75}
                                      />
                                      <span>
                                        <Inline text={entry.note.text} />
                                      </span>
                                    </div>
                                  )}

                                  {entry.links && (
                                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                                      {entry.links.map((l) => (
                                        <Link
                                          key={l.to + l.label}
                                          to={l.to}
                                          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[#C25938] hover:text-[#A8462A]"
                                        >
                                          {l.label}
                                          <ArrowUpRight className="w-3 h-3" />
                                        </Link>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>

            {/* ---------------- Still stuck ---------------- */}
            {!trimmed && (
              <Reveal>
                <div className="mt-14 rounded-2xl border border-[#E4DED4] bg-[#F7F4EF] p-7 sm:p-8">
                  <div className="flex items-center gap-2.5 mb-2">
                    <LifeBuoy className="w-4 h-4 text-[#C25938]" strokeWidth={1.75} />
                    <h3 className="text-[14px] font-semibold text-[#191714]">Still stuck?</h3>
                  </div>
                  <p className="text-[13px] leading-relaxed text-[#7A736A] max-w-lg">
                    The API reference covers request shapes, error codes and failover in more
                    detail. If something here is wrong, the repository issue tracker is the
                    fastest way to get it fixed.
                  </p>
                  <div className="mt-5 flex flex-wrap items-center gap-2.5">
                    <Link
                      to="/docs"
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#191714] text-white text-[13px] font-medium hover:bg-[#332E28] transition-colors"
                    >
                      Read the API reference
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                    <Link
                      to="/app"
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-[#E4DED4] text-[13px] font-medium text-[#191714] hover:border-[#C9C1B4] transition-colors"
                    >
                      Open the dashboard
                    </Link>
                    <a
                      href="https://github.com/RosielReaksa/geminirouter/issues"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-medium text-[#4A453E] hover:text-[#C25938] transition-colors"
                    >
                      Report an issue
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              </Reveal>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HelpPage;
