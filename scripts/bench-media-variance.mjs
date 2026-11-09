/**
 * Variance + worst-case runs for gemini-3.5-flash-lite media transcription.
 * Usage: node bench-media-variance.mjs <baseUrl> <apiKey> <fixturesDir>
 */
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = process.argv[3];
const dir = process.argv[4] || '/tmp/gr-bench';
const MODEL = 'gemini-3.5-flash-lite';
const PROMPT = 'Transcribe this audio and translate it to Khmer.';
const REPS = 3;

const cases = [
  { file: 'speech-60m.wav', minutes: 60, concurrency: 1, label: '60m serial (worst case)' },
  { file: 'speech-60m.wav', minutes: 60, concurrency: 4, label: '60m parallel x4' },
  { file: 'speech-30m.wav', minutes: 30, concurrency: 4, label: '30m parallel x4' },
];

async function call(file, concurrency) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), path.basename(file));
  form.append('model', MODEL);
  form.append('prompt', PROMPT);
  form.append('concurrency', String(concurrency));
  const t0 = Date.now();
  let status = 0, body = null, errText = '';
  try {
    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { errText = text.slice(0, 200); }
  } catch (e) {
    errText = `network: ${e.message}`;
  }
  return {
    status,
    wall: (Date.now() - t0) / 1000,
    model: body?.timings?.model_ms != null ? body.timings.model_ms / 1000 : null,
    transcode: body?.timings?.transcode_ms != null ? body.timings.transcode_ms / 1000 : null,
    chunks: body?.chunk_count ?? null,
    promptTokens: body?.usage?.promptTokens ?? null,
    completionTokens: body?.usage?.completionTokens ?? null,
    code: body?.error?.code ?? null,
    message: body?.error?.message ?? errText,
  };
}

const all = [];
for (const c of cases) {
  const file = path.join(dir, c.file);
  const rows = [];
  for (let i = 1; i <= REPS; i++) {
    process.stdout.write(`▶ ${c.label} run ${i}/${REPS} ... `);
    const r = await call(file, c.concurrency);
    rows.push(r);
    all.push({ label: c.label, minutes: c.minutes, concurrency: c.concurrency, run: i, ...r });
    console.log(
      `HTTP ${r.status} ${r.wall.toFixed(1)}s` +
      (r.model != null ? ` (model ${r.model.toFixed(1)}s, transcode ${r.transcode.toFixed(1)}s, ${r.chunks} chunks)` : '') +
      (r.status === 200 ? '' : ` ${r.code ?? ''} ${String(r.message).slice(0, 120)}`),
    );
  }
  const ok = rows.filter((r) => r.status === 200);
  if (ok.length) {
    const walls = ok.map((r) => r.wall);
    console.log(
      `   ${c.label}: min ${Math.min(...walls).toFixed(1)}s / max ${Math.max(...walls).toFixed(1)}s / ` +
      `avg ${(walls.reduce((a, b) => a + b, 0) / walls.length).toFixed(1)}s`,
    );
  }
  console.log('');
}

const out = path.join(dir, `variance-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(all, null, 2));
console.log(`raw: ${out}`);
