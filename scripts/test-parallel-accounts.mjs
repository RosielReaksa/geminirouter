import fs from 'node:fs';

const KEY = fs
  .readFileSync('D:/projectradom/geminirouter/core-profile/API_KEY.txt', 'utf8')
  .trim();

const MODEL = process.argv[2] || 'claude-sonnet-4-6-thinking';
const N = parseInt(process.argv[3] || '6', 10);

console.log(`Sending ${N} PARALLEL requests for ${MODEL}\n`);

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
          max_tokens: 8,
          messages: [{ role: 'user', content: `Reply: ok ${i}` }],
        }),
      });
      const acct = res.headers.get('x-antigravity-account-id') || 'none';
      const body = await res.text();
      return { i, status: res.status, acct, ms: Date.now() - started, len: body.length };
    } catch (e) {
      return { i, status: 'ERR', acct: e.message, ms: Date.now() - started, len: 0 };
    }
  })
);

for (const r of results) {
  console.log(`#${r.i} status=${r.status} account=${r.acct} ${r.ms}ms`);
}

const wall = Date.now() - t0;
const byAcct = {};
for (const r of results) byAcct[r.acct] = (byAcct[r.acct] || 0) + 1;

const sumLatency = results.reduce((s, r) => s + r.ms, 0);
console.log('\n---');
console.log('wall clock:', wall, 'ms');
console.log('sum of request times:', sumLatency, 'ms');
console.log('parallel speedup:', (sumLatency / wall).toFixed(2) + 'x');
console.log('accounts used:', JSON.stringify(byAcct, null, 2));
console.log('success:', results.filter((r) => r.status === 200).length, '/', N);
