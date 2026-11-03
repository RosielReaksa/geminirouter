import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoogleAccount } from '../src/store.js';
import { mapCoreTrafficItems } from '../src/trafficMapping.js';

const accounts = [
  {
    id: 'acc-1',
    email: 'one@gmail.com',
    name: 'One',
    status: 'active',
    addedAt: '2026-01-01T00:00:00Z',
    tier: 'Google AI Pro',
    quotas: [],
  } as unknown as GoogleAccount,
];

test('retired model ids in the core audit become the canonical id', () => {
  const records = mapCoreTrafficItems(
    [
      {
        id: 'r1',
        timestamp: 1793705000000,
        model: 'gemini-3.8-flash-tiered',
        mappedModel: 'gemini-3.8-flash-tiered',
        attributedAccountId: 'acc-1',
        status: 200,
        durationMs: 800,
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        id: 'r2',
        timestamp: 1793705001000,
        model: 'gemini-3.8-flash-high',
        physicalModel: 'gemini-3.8-flash-low',
        attributedAccountId: 'acc-1',
        status: 200,
        durationMs: 900,
      },
    ],
    accounts,
  );

  assert.equal(records[0].modelRequested, 'gemini-3.8-flash-high');
  assert.equal(records[0].modelRouted, 'gemini-3.8-flash-high');
  assert.equal(records[0].backingAccountEmail, 'one@gmail.com');
  assert.equal(records[0].totalTokens, 15);
  assert.equal(records[1].modelRequested, 'gemini-3.8-flash-high');
  assert.equal(records[1].modelRouted, 'gemini-3.8-flash-high');
});

test('unrelated model ids and empty audits pass through unchanged', () => {
  assert.deepEqual(mapCoreTrafficItems([], accounts), []);

  const [record] = mapCoreTrafficItems(
    [
      {
        timestamp: '2026-11-03T11:00:00.000Z',
        model: 'claude-sonnet-5-5-high',
        attributedAccountId: 'missing',
        status: 200,
      },
    ],
    [],
  );

  assert.equal(record.modelRequested, 'claude-sonnet-5-5-high');
  assert.equal(record.modelRouted, 'claude-sonnet-5-5-high');
  assert.equal(record.backingAccountEmail, 'missing');
  assert.equal(record.timestamp, '2026-11-03T11:00:00.000Z');
});

test('stale in-progress audit rows are reported as aborted', () => {
  const [record] = mapCoreTrafficItems(
    [
      {
        timestamp: Date.now() - 10 * 60 * 1000,
        model: 'gemini-3.8-flash-tiered',
        outcome: 'in_progress',
        status: 200,
      },
    ],
    accounts,
    60_000,
  );

  assert.equal(record.status, 0);
  assert.equal(record.outcome, 'aborted');
  assert.equal(record.modelRouted, 'gemini-3.8-flash-high');
});
