/**
 * Failure-rate probe: repeats the 60-minute, 4-chunk transcription to measure
 * how often a chunk hits the output cap.
 * Usage: node bench-media-flake.mjs <baseUrl> <apiKey> <fixturesDir> [reps]
 */
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = process.argv[3];
const dir = process.argv[4] || '/tmp/gr-bench';
const reps = Number(process.argv[5] || 8);
const file = path.join(dir, 'speech-60m.wav');

const rows = [];
for (let i = 1; i <= reps; i++) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'speech-60m.wav');
  form.append('model', 'gemini-3.5-flash-lite');
  form.append('prompt', 'Transcribe this audio and translate it to Khmer.');
  form.append('concurrency', '4');

  const t0 = Date.now();
  let status = 0, body = null, msg = '';
  try {
    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { msg = text.slice(0, 150); }
  } catch (e) {
    msg = e.message;
  }
  const wall = (Date.now() - t0) / 1000;
  const row = {
    run: i,
    status,
    wall,
    chunks: body?.chunk_count ?? null,
    completionTokens: body?.usage?.completionTokens ?? null,
    code: body?.error?.code ?? null,
    message: body?.error?.message ?? msg,
  };
  rows.push(row);
  console.log(
    `run ${i}/${reps}: HTTP ${status} ${wall.toFixed(1)}s` +
    (row.code ? `  << ${row.code}: ${String(row.message).slice(0, 110)}` : ''),
  );
}

const ok = rows.filter((r) => r.status === 200);
const truncated = rows.filter((r) => r.code === 'model_output_truncated');
console.log(`\nsummary: ${ok.length}/${reps} ok, ${truncated.length}/${reps} truncated, ` +
  `${rows.length - ok.length - truncated.length} other`);
if (ok.length) {
  const w = ok.map((r) => r.wall);
  console.log(`wall (success only): min ${Math.min(...w).toFixed(1)}s / max ${Math.max(...w).toFixed(1)}s`);
}
const out = path.join(dir, `flake-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(rows, null, 2));
console.log(`raw: ${out}`);
