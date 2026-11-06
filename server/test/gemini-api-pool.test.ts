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

test('requests rotate across keys with capacity', () => {
  const pool = new GeminiApiPool([key('a'), key('b')], { rpm: 1, tpm: 100_000, rpd: 10 });

  const first = pool.acquire(10);
  const second = pool.acquire(10);
  assert.equal(first?.record.id, 'a');
  assert.equal(second?.record.id, 'b');
  assert.equal(pool.acquire(10), null, 'both keys are at RPM');
});

test('a key in cooldown is skipped and the other key serves', () => {
  const pool = new GeminiApiPool([key('a'), key('b')], { rpm: 10, tpm: 100_000, rpd: 10 });

  pool.markCooldown('a', 60_000);
  const lease = pool.acquire(10);
  assert.equal(lease?.record.id, 'b');
});

test('daily request budget stops a key and the pool returns null when exhausted', () => {
  const pool = new GeminiApiPool([key('a')], { rpm: 10, tpm: 100_000, rpd: 1 });

  assert.equal(pool.acquire(10)?.record.id, 'a');
  assert.equal(pool.acquire(10), null);
});

test('token budget is enforced before the request is sent', () => {
  const pool = new GeminiApiPool([key('a'), key('b')], { rpm: 10, tpm: 100, rpd: 10 });

  assert.ok(pool.acquire(60));
  assert.ok(pool.acquire(60));
  assert.equal(pool.acquire(60), null);
});

test('actual token usage reconciles the conservative estimate', () => {
  const pool = new GeminiApiPool([key('a')], { rpm: 10, tpm: 1_000, rpd: 10 });

  const lease = pool.acquire(100);
  assert.ok(lease);
  pool.recordTokens('a', 20, lease!.estimatedTokens);

  const [snapshot] = pool.snapshot();
  assert.equal(snapshot.usage.tokensToday, 20);
  assert.equal(snapshot.usage.tpm, 20);
});

test('snapshot masks the key and never returns it in full', () => {
  const pool = new GeminiApiPool([key('a')], { rpm: 10, tpm: 1_000, rpd: 10 });

  const serialized = JSON.stringify(pool.snapshot());
  assert.equal(serialized.includes('AIzaSy'), false);
  assert.match(pool.snapshot()[0].maskedKey, /^AIza…/);
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