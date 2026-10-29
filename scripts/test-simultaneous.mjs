import fs from 'node:fs';

const KEY = fs
  .readFileSync('D:/projectradom/geminirouter/core-profile/API_KEY.txt', 'utf8')
  .trim();

const MODEL = process.argv[2] || 'claude-sonnet-4-6-thinking';
const N = parseInt(process.argv[3] || '4', 10);

// Sample the bridge's live in-flight map while requests are running. If two
// accounts show >0 in flight at the same sample, they are serving SIMULTANEOUSLY.
const samples = [];
let sampling = true;

const sampler = (async () => {
  while (sampling) {
    try {
      const r = await fetch('http://127.0.0.1:3000/api/status');
      const s = await r.json();
      const inflight = s.inFlightPerAccount || {};
      const active = Object.entries(inflight).filter(([, v]) => v > 0);
      samples.push({
        t: Date.now(),
        active: active.map(([id, v]) => `${id.slice(0, 8)}:${v}`),
        count: active.length,
        total: s.totalInFlight || 0,
      });
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
})();

const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const started = Date.now();
    try {
      const res = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 64,
          messages: [{ role: 'user', content: `Count slowly from 1 to 5. Request ${i}.` }],
        }),
      });
      const acct = res.headers.get('x-antigravity-account-id') || 'none';
      await res.text();
      return { i, status: res.status, acct, ms: Date.now() - started };
    } catch (e) {
      return { i, status: 'ERR', acct: e.message, ms: Date.now() - started };
    }
  })
);
const wall = Date.now() - t0;
sampling = false;
await sampler;

for (const r of results) {
  console.log(`#${r.i} ${r.status} -> ${r.acct.slice(0, 8)} (${r.ms}ms)`);
}

const byAcct = {};
for (const r of results) byAcct[r.acct] = (byAcct[r.acct] || 0) + 1;

const peakConcurrentAccounts = Math.max(0, ...samples.map((s) => s.count));
const peakTotal = Math.max(0, ...samples.map((s) => s.total));
const simultaneous = samples.filter((s) => s.count >= 2);

console.log('\n--- RESULTS ---');
console.log('wall clock:', wall, 'ms for', N, 'requests');
console.log('distribution:', JSON.stringify(byAcct, null, 2));
console.log('peak accounts in flight AT THE SAME MOMENT:', peakConcurrentAccounts);
console.log('peak total in flight:', peakTotal);
console.log('samples showing 2+ accounts simultaneously:', simultaneous.length, '/', samples.length);
if (simultaneous.length > 0) {
  console.log('example sample:', JSON.stringify(simultaneous[0].active));
}
