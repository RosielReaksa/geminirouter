/**
 * Measures /v1/audio/transcriptions latency for gemini-3.5-flash-lite against
 * the live gateway, at several audio durations and concurrency settings.
 *
 * The server returns a `timings` block (transcode_ms / model_ms / total_ms) and
 * chunk_count, so we can separate FFmpeg cost from model cost.
 *
 * Usage:
 *   node scripts/bench-media.mjs <baseUrl> <apiKey> [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = process.argv[3];
const outDir = process.argv[4] || 'C:\\Users\\Asus TUF F15\\AppData\\Local\\Temp\\opencode\\bench';
const MODEL = 'gemini-3.5-flash-lite';

if (!apiKey) {
  console.error('usage: node bench-media.mjs <baseUrl> <apiKey> [outDir]');
  process.exit(2);
}

const PROMPT = 'Transcribe this audio and translate it to Khmer.';

const cases = [
  { minutes: 5, concurrency: 1 },
  { minutes: 5, concurrency: 4 },
  { minutes: 15, concurrency: 1 },
  { minutes: 15, concurrency: 4 },
  { minutes: 30, concurrency: 4 },
  { minutes: 60, concurrency: 4 },
];

const results = [];

async function call(file, minutes, concurrency) {
  const form = new FormData();
  const buf = fs.readFileSync(file);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(file));
  form.append('model', MODEL);
  form.append('prompt', PROMPT);
  form.append('concurrency', String(concurrency));

  const started = Date.now();
  let status = 0;
  let body = null;
  let errorText = '';
  try {
    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { errorText = text.slice(0, 400); }
  } catch (err) {
    errorText = `network: ${err.message}`;
  }
  const wallMs = Date.now() - started;

  const text = body?.text ?? body?.transcript ?? '';
  return {
    minutes,
    concurrency,
    status,
    wallMs,
    transcodeMs: body?.timings?.transcode_ms ?? null,
    modelMs: body?.timings?.model_ms ?? null,
    serverTotalMs: body?.timings?.total_ms ?? null,
    chunks: body?.chunk_count ?? null,
    chunkSeconds: body?.chunk_seconds ?? null,
    chars: typeof text === 'string' ? text.length : 0,
    usage: body?.usage ?? null,
    code: body?.error?.code ?? null,
    message: body?.error?.message ?? errorText ?? null,
    sample: typeof text === 'string' ? text.slice(0, 160).replace(/\s+/g, ' ') : '',
  };
}

fs.mkdirSync(outDir, { recursive: true });

for (const c of cases) {
  const file = path.join(outDir, `speech-${c.minutes}m.wav`);
  if (!fs.existsSync(file)) {
    console.log(`missing ${file} — run the generator first`);
    process.exit(1);
  }
  const sizeMiB = (fs.statSync(file).size / 1048576).toFixed(1);
  process.stdout.write(
    `\n▶ ${c.minutes} min (${sizeMiB} MiB) concurrency=${c.concurrency} ... `,
  );
  const r = await call(file, c.minutes, c.concurrency);
  results.push(r);
  if (r.status === 200) {
    console.log(
      `HTTP ${r.status} in ${(r.wallMs / 1000).toFixed(1)}s ` +
      `(model ${((r.modelMs ?? 0) / 1000).toFixed(1)}s, ` +
      `transcode ${((r.transcodeMs ?? 0) / 1000).toFixed(1)}s, ` +
      `chunks ${r.chunks}, ${r.chars} chars)`,
    );
  } else {
    console.log(`HTTP ${r.status} ${r.code ?? ''} ${String(r.message ?? '').slice(0, 160)}`);
  }
}

const outFile = path.join(outDir, `bench-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`\nraw results: ${outFile}`);

// Summary table
console.log('\n| audio | conc | HTTP | wall (s) | model (s) | transcode (s) | chunks | out chars |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(
    `| ${r.minutes} min | ${r.concurrency} | ${r.status} | ` +
    `${(r.wallMs / 1000).toFixed(1)} | ` +
    `${r.modelMs === null ? '-' : (r.modelMs / 1000).toFixed(1)} | ` +
    `${r.transcodeMs === null ? '-' : (r.transcodeMs / 1000).toFixed(1)} | ` +
    `${r.chunks ?? '-'} | ${r.chars} |`,
  );
}
