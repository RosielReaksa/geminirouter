import React, { useEffect, useState } from 'react';
import { Copy, Check, ArrowUpRight, Terminal } from 'lucide-react';
import { Link } from '../../router';
import { Reveal } from '../marketing/Chrome';

const CopyLine: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1.5 text-[11px] text-[#A39C92] hover:text-[#191714] transition-colors"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};

const Code: React.FC<{ code: string; title?: string }> = ({ code, title }) => (
  <div className="rounded-xl bg-[#14120F] border border-[#2A2620] overflow-hidden my-4">
    <div className="flex items-center justify-between px-4 py-2 border-b border-[#2A2620]">
      <span className="text-[11px] font-mono-code text-[#8A8278]">{title || 'shell'}</span>
      <CopyLine text={code} />
    </div>
    <pre className="p-4 overflow-x-auto text-[12.5px] leading-relaxed font-mono-code text-[#D8D2C7]">
      <code>{code}</code>
    </pre>
  </div>
);

const SECTIONS = [
  { id: 'quickstart', label: 'Quickstart' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'media', label: 'Audio & video input' },
  { id: 'openai', label: 'OpenAI SDK' },
  { id: 'anthropic', label: 'Anthropic SDK' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'limits', label: 'Rate limits & failover' },
  { id: 'errors', label: 'Error codes' },
  { id: 'selfhost', label: 'Self-hosting' },
];

export const DocsPage: React.FC = () => {
  const [active, setActive] = useState('quickstart');

  useEffect(() => {
    const onScroll = () => {
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 120) current = s.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  return (
    <div className="mkt-body">
      <section className="border-b border-[#E4DED4] bg-[#F7F4EF]">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 pt-14 pb-10">
          <Reveal>
            <div className="mkt-eyebrow mb-3">Documentation</div>
            <h1 className="mkt-display text-[40px] sm:text-[56px] text-[#191714]">
              API reference.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-[#4A453E] max-w-xl">
              One base URL, one key, three compatible protocols. Everything below runs against
              the gateway already serving this page.
            </p>
          </Reveal>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-12">
        <div className="grid lg:grid-cols-[200px_1fr] gap-12">
          {/* Sidebar */}
          <aside className="hidden lg:block">
            <nav className="sticky top-24 space-y-0.5">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className={`block px-3 py-1.5 rounded-lg text-[12.5px] transition-colors ${
                    active === s.id
                      ? 'bg-[#EFEAE2] text-[#191714] font-medium'
                      : 'text-[#7A736A] hover:text-[#191714]'
                  }`}
                >
                  {s.label}
                </a>
              ))}
            </nav>
          </aside>

          {/* Content */}
          <article className="min-w-0 max-w-2xl">
            <section id="quickstart" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">Quickstart</h2>
              <p className="text-[14px] leading-relaxed text-[#4A453E]">
                The gateway speaks the OpenAI chat completions API. Set the base URL to{' '}
                <code className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]">
                  {origin}/v1
                </code>{' '}
                and use the API key from the dashboard.
              </p>

              <Code
                title="curl"
                code={`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer $GEMINIROUTER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`}
              />

              <div className="rounded-xl border border-[#E4DED4] bg-[#FBF9F5] p-4 text-[12.5px] text-[#7A736A]">
                The key is issued by your own gateway. Find it in the dashboard under{' '}
                <span className="text-[#4A453E] font-medium">API Gateway &amp; Routing</span>.
              </div>
            </section>

            <div className="mkt-rule my-10" />

            <section id="endpoints" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">Endpoints</h2>
              <div className="overflow-hidden rounded-xl border border-[#E4DED4]">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-[#F7F4EF] border-b border-[#E4DED4]">
                    <tr>
                      <th className="px-4 py-2.5 font-medium text-[#7A736A] text-[11px] uppercase tracking-wider">
                        Method
                      </th>
                      <th className="px-4 py-2.5 font-medium text-[#7A736A] text-[11px] uppercase tracking-wider">
                        Path
                      </th>
                      <th className="px-4 py-2.5 font-medium text-[#7A736A] text-[11px] uppercase tracking-wider">
                        Protocol
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0EBE3] bg-white">
                    {[
                      ['POST', '/v1/chat/completions', 'OpenAI'],
                      ['POST', '/v1/responses', 'OpenAI'],
                      ['POST', '/v1/messages', 'Anthropic'],
                      ['POST', '/v1beta/models/:model', 'Gemini'],
                      ['POST', '/v1/audio/transcriptions', 'Media'],
                      ['POST', '/v1/audio/dubbing', 'Media'],
                      ['GET', '/v1/models', 'OpenAI'],
                    ].map(([m, p, proto]) => (
                      <tr key={p + m}>
                        <td className="px-4 py-2.5 font-mono-code text-[12px] text-[#4E7B62]">{m}</td>
                        <td className="px-4 py-2.5 font-mono-code text-[12px] text-[#191714]">{p}</td>
                        <td className="px-4 py-2.5 text-[12px] text-[#7A736A]">{proto}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="mkt-rule my-10" />

            <section id="media" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">
                Audio &amp; video input
              </h2>
              <p className="text-[14px] leading-relaxed text-[#4A453E]">
                A separate dubbing app can upload media to its own server, then send the file to{' '}
                <code className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]">
                  /v1/chat/completions
                </code>{' '}
                as base64. Keep the gateway key on that server; browser code must never contain it.
                Select a model from{' '}
                <code className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]">
                  GET /v1/models
                </code>{' '}
                and verify it with the media type your app will send.
              </p>
              <p className="text-[14px] leading-relaxed text-[#4A453E]">
                For 10–20 minute recordings use{' '}
                <code className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]">
                  POST /v1/audio/transcriptions
                </code>
                . It streams the upload and returns the model's answer for the user's own
                prompt. The website does not need to set a task or target language. Files up
                to 2 hours are accepted; split very long files for faster responses.
              </p>
              <Code
                title="audio · server-side JavaScript"
                code={`const audioBase64 = (await fs.readFile(audioPath)).toString("base64");

const response = await fetch("${origin}/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.GEMINIROUTER_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: process.env.GEMINIROUTER_MODEL,
    stream: false,
    messages: [{ role: "user", content: [
      { type: "text", text: "Transcribe this dialogue and translate it to Japanese. Keep speakers separate." },
      { type: "input_audio", input_audio: { data: audioBase64, format: "wav" } },
    ] }],
  }),
});

const result = await response.json();
const translatedDialogue = result.choices?.[0]?.message?.content;`}
              />
              <Code
                title="audio window · 10–20 minutes"
                code={`const form = new FormData();
form.append("file", new Blob([await fs.readFile(audioPath)]), "episode.mp3");
form.append("model", process.env.GEMINIROUTER_MODEL);
// Pass the user's own prompt unchanged; no task/target_language is required.
form.append("prompt", userPrompt);

const response = await fetch("${origin}/v1/audio/transcriptions", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.GEMINIROUTER_KEY}\` },
  body: form,
});

const result = await response.json();
console.log(result.transcript, result.translation);`}
              />
              <h3 className="mkt-display text-[20px] text-[#191714] mt-8 mb-2">
                Timed dubbing · Chinese → Khmer
              </h3>
              <p className="text-[14px] leading-relaxed text-[#4A453E]">
                <code className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]">
                  POST /v1/audio/dubbing
                </code>{' '}
                splits the recording, transcribes and translates each part, and returns dialogue
                segments with absolute timestamps and a Khmer line for each one. It uses the same
                upload path as transcriptions, so keep it on your server. The alias{' '}
                <code className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]">
                  /v1/media/dubbing
                </code>{' '}
                behaves identically.
              </p>
              <Code
                title="dubbing · server-side JavaScript"
                code={`const form = new FormData();
form.append("file", new Blob([await fs.readFile(audioPath)]), "episode.mp3");
form.append("source_language", "zh");
form.append("target_language", "km");
form.append("response_format", "array"); // "json" adds chunk + usage metadata

const response = await fetch("${origin}/v1/audio/dubbing", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.GEMINIROUTER_KEY}\` },
  body: form,
});

// Bare contract array: start, end, speaker_gender, vocal_timbre,
// character_role, original_transcript, khmer_dubbing.
const segments = await response.json();
for (const line of segments) {
  schedule(line.start, line.end, line.speaker_gender, line.khmer_dubbing);
}`}
              />
              <Code
                title="response · one segment"
                code={`[
  {
    "start": "00:00.1",
    "end": "00:02.1",
    "speaker_gender": "female",
    "vocal_timbre": "clear, friendly, welcoming voice",
    "character_role": "narrator",
    "original_transcript": "Hello and welcome to Duber.",
    "khmer_dubbing": "សួស្តី និងសូមស្វាគមន៍មកកាន់ Duber។"
  }
]`}
              />
              <div className="rounded-xl border border-[#E4DED4] bg-[#FBF9F5] p-4 text-[12.5px] leading-relaxed text-[#7A736A] space-y-2">
                <p>
                  Defaults are <code>source_language=zh</code>, <code>target_language=km</code>,
                  and a 5-minute chunk. Override them with <code>chunk_seconds</code> (up to 1800)
                  and <code>model</code>; a caller <code>prompt</code> replaces the built-in
                  instructions, but the JSON timing contract is always appended. Output budget
                  follows the chunk length: 5 min → 8192 tokens, 10 min → 24576, 15 min → 65535.
                </p>
                <p>
                  Timestamps are <code>MM:SS.S</code> and already shifted to the recording start,
                  so chunk offsets can be used directly. Khmer politeness particles are kept per
                  speaker: male <span className="text-[#4A453E] font-medium">បាទ</span>, female{' '}
                  <span className="text-[#4A453E] font-medium">ចាស</span>. Use{' '}
                  <code>response_format=json</code> when you also need chunk boundaries, token
                  usage, and per-chunk timings.
                </p>
              </div>
              <Code
                title="video · server-side JavaScript"
                code={`const videoBase64 = (await fs.readFile(videoPath)).toString("base64");

const response = await fetch("${origin}/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.GEMINIROUTER_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: process.env.GEMINIROUTER_MODEL,
    stream: false,
    messages: [{ role: "user", content: [
      { type: "text", text: "Transcribe and translate the spoken dialogue. Keep speaker turns separate." },
      { type: "video_url", video_url: { url: \`data:video/mp4;base64,\${videoBase64}\` } },
    ] }],
  }),
});

const result = await response.json();
const translatedDialogue = result.choices?.[0]?.message?.content;`}
              />
              <div className="rounded-xl border border-[#E4DED4] bg-[#FBF9F5] p-4 text-[12.5px] leading-relaxed text-[#7A736A] space-y-2">
                <p>
                  Inline audio supports MP3, WAV, OGG, FLAC, AAC/M4A, and AIFF up to 15 MiB decoded.
                  Use <code>/v1/audio/transcriptions</code> for 10–20 minute windows; split longer
                  recordings before sending. Keep inline video around 20 MiB or less. The normal
                  request limit is 64 MiB.
                </p>
                <p>
                  Chat completions return text such as a transcript or translation.
                  <code> /v1/audio/dubbing</code> returns the timed Khmer lines directly. Turning
                  those lines into audible speech and muxing them back into the video still happens
                  in the dubbing app.
                </p>
              </div>
            </section>

            <div className="mkt-rule my-10" />

            <section id="openai" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">OpenAI SDK</h2>
              <Code
                title="python"
                code={`from openai import OpenAI

client = OpenAI(
    base_url="${origin}/v1",
    api_key="your-key",
)

resp = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`}
              />
              <Code
                title="typescript"
                code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${origin}/v1",
  apiKey: process.env.GEMINIROUTER_KEY,
});

const resp = await client.chat.completions.create({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello" }],
});`}
              />
            </section>

            <div className="mkt-rule my-10" />

            <section id="anthropic" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">Anthropic SDK</h2>
              <p className="text-[14px] leading-relaxed text-[#4A453E] mb-1">
                Use <code className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]">/v1/messages</code>{' '}
                with the same key.
              </p>
              <Code
                title="python"
                code={`import anthropic

client = anthropic.Anthropic(
    base_url="${origin}",
    api_key="your-key",
)

msg = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello"}],
)`}
              />
            </section>

            <div className="mkt-rule my-10" />

            <section id="streaming" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">Streaming</h2>
              <p className="text-[14px] leading-relaxed text-[#4A453E]">
                Set{' '}
                <code className="px-1.5 py-0.5 rounded bg-[#F0EBE3] text-[12.5px] font-mono-code text-[#A8462A]">
                  stream: true
                </code>{' '}
                and the response arrives as server-sent events, relayed unbuffered. Once the
                first byte reaches your client the gateway never retries that request, so a
                partial stream is never duplicated.
              </p>
            </section>

            <div className="mkt-rule my-10" />

            <section id="limits" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">
                Rate limits &amp; failover
              </h2>
              <p className="text-[14px] leading-relaxed text-[#4A453E]">
                Each request is routed to a healthy account with spare quota. If an account
                returns <span className="font-mono-code text-[12.5px]">429</span> or a
                verification block before streaming begins, the same request is retried on
                another account and the failing one is cooled down for that model only.
              </p>
              <div className="mt-4 space-y-2.5">
                {[
                  ['429 from upstream', 'Request retried on the next account; Retry-After honoured.'],
                  ['403 verification', 'Account quarantined; a fresh Google link is surfaced in the dashboard.'],
                  ['All accounts busy', 'Queued briefly, then 429 with Retry-After if nothing frees up.'],
                  ['Per-model cooldown', 'A Claude limit does not remove the account from Gemini traffic.'],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-start gap-3 text-[13px]">
                    <span className="font-mono-code text-[11.5px] text-[#A8462A] shrink-0 w-[150px]">
                      {k}
                    </span>
                    <span className="text-[#7A736A]">{v}</span>
                  </div>
                ))}
              </div>
            </section>

            <div className="mkt-rule my-10" />

            <section id="errors" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">Error codes</h2>
              <div className="overflow-hidden rounded-xl border border-[#E4DED4]">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-[#F7F4EF] border-b border-[#E4DED4]">
                    <tr>
                      <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-[#7A736A] font-medium">
                        Status
                      </th>
                      <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-[#7A736A] font-medium">
                        Meaning
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0EBE3] bg-white">
                    {[
                      ['200', 'Completed successfully'],
                      ['400', 'Malformed request body or unknown model'],
                      ['401', 'Missing or invalid API key'],
                      ['429', 'Pool exhausted — retry after the Retry-After header'],
                      ['502', 'Upstream gateway unreachable'],
                      ['503', 'Transient upstream failure, retryable'],
                    ].map(([code, meaning]) => (
                      <tr key={code}>
                        <td className="px-4 py-2.5 font-mono-code text-[12px] text-[#A8462A]">
                          {code}
                        </td>
                        <td className="px-4 py-2.5 text-[12px] text-[#7A736A]">{meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="mkt-rule my-10" />

            <section id="selfhost" className="scroll-mt-24">
              <h2 className="mkt-display text-[28px] text-[#191714] mb-3">Self-hosting</h2>
              <p className="text-[14px] leading-relaxed text-[#4A453E]">
                The bridge serves the dashboard and proxies the API. The Antigravity core holds
                the OAuth tokens and makes the upstream calls.
              </p>
              <Code
                title="start"
                code={`# from the repository root
node scripts/launch-all.mjs

# dashboard  http://localhost:3000
# gateway    http://localhost:8046/v1`}
              />
              <div className="rounded-xl border border-[#F2E2C4] bg-[#FFFBF2] p-4 text-[12.5px] text-[#8A6A2E]">
                Set <span className="font-mono-code">GEMINIROUTER_ADMIN_PASSWORD</span> before
                exposing this host to the internet. Without it the dashboard is open.
              </div>
            </section>

            <div className="mt-12 rounded-2xl border border-[#E4DED4] bg-[#F7F4EF] p-7">
              <div className="flex items-center gap-2.5 mb-2">
                <Terminal className="w-4 h-4 text-[#C25938]" />
                <h3 className="text-[14px] font-semibold text-[#191714]">Get your key</h3>
              </div>
              <p className="text-[13px] text-[#7A736A] mb-4">
                The endpoint and key are on the gateway page in the dashboard.
              </p>
              <Link
                to="/app"
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#C25938] hover:text-[#A8462A]"
              >
                Open the dashboard
                <ArrowUpRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
};
