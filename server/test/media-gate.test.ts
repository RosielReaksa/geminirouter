import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaGate } from '../src/mediaGate.js';

test('admits up to the limit and queues the rest in FIFO order', async () => {
  const gate = new MediaGate({ limit: 2, queueLimit: 5, timeoutMs: 5_000 });

  const first = await gate.acquire();
  const second = await gate.acquire();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const third = gate.acquire();
  const fourth = gate.acquire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.stats().queued, 2);

  gate.release();
  assert.equal((await third).ok, true);
  gate.release();
  assert.equal((await fourth).ok, true);
  gate.release();
  gate.release();
});

test('rejects when the queue is full', async () => {
  const gate = new MediaGate({ limit: 1, queueLimit: 1, timeoutMs: 5_000 });

  await gate.acquire();
  const queued = gate.acquire();
  await new Promise((resolve) => setImmediate(resolve));

  const overflow = await gate.acquire();
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'queue_full');

  gate.release();
  await queued;
  gate.release();
});

test('queued jobs fail cleanly when the wait times out', async () => {
  const gate = new MediaGate({ limit: 1, queueLimit: 5, timeoutMs: 50 });

  await gate.acquire();
  const result = await gate.acquire();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.ok(result.waitMs >= 40);
  gate.release();
});
