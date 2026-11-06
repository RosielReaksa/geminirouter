import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiApiPool,
  estimateGeminiTokens,
  maskApiKey,
  type GeminiApiKeyRecord,
} from '../src/geminiApiPool.js';

function key(id: string): GeminiApiKeyRecord {
  return {
    id,
    label: id,
    key: `AIzaSy${id.padEnd(30, 'x')}`,
    enabled: true,
    createdAt: new Date(0).toISOString(),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('requests use the least-loaded key and can be settled', async () => {
  const pool = new GeminiApiPool([key('a'), key('b')], {
    limits: { rpm: 10, tpm: 100_000, rpd: 10 },
  });

  const first = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  const second = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.equal(first?.keyId, 'a');
  assert.equal(second?.keyId, 'b');

  pool.settle(first!);
  pool.settle(second!);
  const [snapshot] = pool.snapshot();
  assert.equal(snapshot.usage.active, 0);
});

test('each model has its own bucket for the same key', async () => {
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 1, tpm: 100_000, rpd: 10 },
    maxWaitMs: 200,
    pumpIntervalMs: 5,
  });

  const lite31 = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.ok(lite31);

  const lite35 = await pool.acquire('gemini-3.5-flash-lite', 10, 'client');
  assert.ok(lite35, 'the other model has a separate RPM bucket');

  pool.settle(lite31!);
  pool.settle(lite35!);
});

test('a per-key concurrency cap queues the next request', async () => {
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 10, tpm: 100_000, rpd: 10 },
    maxConcurrentPerKey: 1,
    maxWaitMs: 500,
    pumpIntervalMs: 5,
  });

  const first = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.ok(first);

  let secondResolved = false;
  const secondPromise = pool.acquire('gemini-3.1-flash-lite', 10, 'client').then((lease) => {
    secondResolved = true;
    return lease;
  });
  await sleep(20);
  assert.equal(secondResolved, false, 'the second request waits for the concurrency slot');

  pool.settle(first!);
  const second = await secondPromise;
  assert.ok(second);
  pool.settle(second!);
});

test('the RPM bucket refills continuously instead of at the minute boundary', async () => {
  let now = 1_000_000;
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 1, tpm: 100_000, rpd: 10 },
    now: () => now,
    maxWaitMs: 90_000,
    pumpIntervalMs: 5,
  });

  const first = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.ok(first);

  const queued = pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  now += 60_000;
  pool.pump();
  const admitted = await queued;
  assert.ok(admitted, 'after a minute the bucket has refilled');
  pool.settle(first!);
  pool.settle(admitted!);
});

test('the daily budget stops the key and reports the earliest availability', async () => {
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 10, tpm: 100_000, rpd: 1 },
    maxWaitMs: 20,
    pumpIntervalMs: 5,
  });

  const first = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.ok(first);
  pool.settle(first!);

  const blocked = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.equal(blocked, null);
  assert.ok(pool.nextAvailabilityMs('gemini-3.1-flash-lite') > 0);
});

test('a 429 cooldown benches the key for the next request', async () => {
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 10, tpm: 100_000, rpd: 10 },
    maxWaitMs: 20,
    pumpIntervalMs: 5,
  });

  const lease = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.ok(lease);
  pool.settle(lease!, { cooldownMs: 60_000 });

  const blocked = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.equal(blocked, null);
  const [snapshot] = pool.snapshot();
  assert.ok(snapshot.models['gemini-3.1-flash-lite'].cooldownUntil !== null);
});

test('actual token usage reconciles the conservative estimate', async () => {
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 10, tpm: 1_000, rpd: 10 },
  });

  const lease = await pool.acquire('gemini-3.1-flash-lite', 100, 'client');
  assert.ok(lease);
  pool.settle(lease!, { actualTokens: 20 });

  const [snapshot] = pool.snapshot();
  assert.equal(snapshot.usage.tokensToday, 20);
  assert.equal(snapshot.models['gemini-3.1-flash-lite'].tpm, 20);
});

test('snapshot masks keys and exposes per-model budgets', async () => {
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 15, tpm: 250_000, rpd: 500 },
  });

  const serialized = JSON.stringify(pool.snapshot());
  assert.equal(serialized.includes('AIzaSy'), false);
  assert.match(pool.snapshot()[0].maskedKey, /^AIza…/);
  assert.deepEqual(Object.keys(pool.snapshot()[0].models).sort(), [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
  ]);
  assert.equal(pool.getQueueStats().maxConcurrentPerKey, 4);
});

test('estimateGeminiTokens grows with prompt size and max tokens', () => {
  const small = estimateGeminiTokens({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
  });
  const large = estimateGeminiTokens({
    messages: [{ role: 'user', content: 'x'.repeat(4_000) }],
    max_tokens: 16,
  });

  assert.ok(large > small);
  assert.ok(small >= 16);
});

test('maskApiKey hides short secrets completely', () => {
  assert.equal(maskApiKey('short'), '••••');
  assert.equal(maskApiKey('AIzaSy0123456789abcd'), 'AIza…abcd');
});

test('acquire fails fast when the next slot is beyond the client wait', async () => {
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 15, tpm: 100_000, rpd: 10 },
    maxWaitMs: 1_000,
  });

  const lease = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.ok(lease);
  pool.settle(lease!, { cooldownMs: 60 * 60 * 1000 });

  const started = Date.now();
  const next = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.equal(next, null);
  assert.ok(Date.now() - started < 500, 'did not wait for the hourly reset');
});

test('hasImmediateCapacity is false once the key bucket is saturated', async () => {
  const pool = new GeminiApiPool([key('a')], {
    limits: { rpm: 1, tpm: 100_000, rpd: 10 },
  });

  assert.equal(pool.hasImmediateCapacity('gemini-3.1-flash-lite'), true);
  const lease = await pool.acquire('gemini-3.1-flash-lite', 10, 'client');
  assert.ok(lease);
  assert.equal(
    pool.hasImmediateCapacity('gemini-3.1-flash-lite'),
    false,
    'the RPM token was consumed',
  );
  pool.settle(lease!);
  assert.equal(
    pool.hasImmediateCapacity('gemini-3.1-flash-lite'),
    false,
    'settling does not refill RPM instantly',
  );
});