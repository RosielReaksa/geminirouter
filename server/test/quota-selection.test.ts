import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoogleAccount } from '../src/store.js';
import {
  findQuotaExhaustion,
  quotaFamilyForModel,
  remainingQuotaPercent,
} from '../src/quota.js';
import { ConcurrencyLeaseManager } from '../src/leaseManager.js';

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

function account(overrides: Partial<GoogleAccount> & { id: string }): GoogleAccount {
  return {
    email: `${overrides.id}@example.com`,
    name: overrides.id,
    status: 'active',
    addedAt: '2026-01-01T00:00:00Z',
    tier: 'Google AI Pro',
    quotas: [],
    isDefaultRouting: false,
    totalRequests24h: 0,
    ...overrides,
  };
}

function groups(options: {
  geminiWeekly?: number;
  gemini5h?: number;
  claudeWeekly?: number;
  claude5h?: number;
  geminiReset?: string;
  claudeReset?: string;
}) {
  const {
    geminiWeekly = 1,
    gemini5h = 1,
    claudeWeekly = 1,
    claude5h = 1,
    geminiReset = FUTURE,
    claudeReset = FUTURE,
  } = options;
  return [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', remainingFraction: geminiWeekly, resetTime: geminiReset },
        { bucketId: 'gemini-5h', remainingFraction: gemini5h, resetTime: geminiReset },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: '3p-weekly', remainingFraction: claudeWeekly, resetTime: claudeReset },
        { bucketId: '3p-5h', remainingFraction: claude5h, resetTime: claudeReset },
      ],
    },
  ];
}

test('model family distinguishes Gemini from Claude/GPT models', () => {
  assert.equal(quotaFamilyForModel('gemini-3.8-flash-tiered'), 'gemini');
  assert.equal(quotaFamilyForModel('gemini-3.1-flash-image'), 'gemini');
  assert.equal(quotaFamilyForModel('claude-opus-4-6-thinking'), 'claude-gpt');
  assert.equal(quotaFamilyForModel('gpt-oss-120b-medium'), 'claude-gpt');
  assert.equal(quotaFamilyForModel(undefined), 'gemini');
});

test('an exhausted Gemini window blocks Gemini but not Claude/GPT', () => {
  const acc = account({
    id: 'acc-1',
    quotaGroups: groups({ geminiWeekly: 0 }),
  });

  const gemini = findQuotaExhaustion(acc, 'gemini-3.8-flash-tiered');
  assert.equal(gemini.exhausted, true);
  assert.equal(gemini.bucket, 'gemini-weekly');
  assert.equal(gemini.resetAt, FUTURE);

  const claude = findQuotaExhaustion(acc, 'claude-opus-4-6-thinking');
  assert.equal(claude.exhausted, false);
});

test('a zero window whose reset time has passed is available again', () => {
  const acc = account({
    id: 'acc-reset',
    quotaGroups: groups({ geminiWeekly: 0, geminiReset: PAST }),
  });

  assert.equal(findQuotaExhaustion(acc, 'gemini-3.5-flash').exhausted, false);
});

test('a zero 5h window blocks even when the weekly window is healthy', () => {
  const acc = account({
    id: 'acc-5h',
    quotaGroups: groups({ geminiWeekly: 0.7, gemini5h: 0 }),
  });
  assert.equal(findQuotaExhaustion(acc, 'gemini-3.5-flash').exhausted, true);
});

test('per-model 5h view blocks only that model', () => {
  const acc = account({
    id: 'acc-model',
    quotaGroups: groups({ geminiWeekly: 0.8 }),
    models5h: [
      { name: 'Gemini 3.5 Flash Lite', reset: FUTURE, percentage: 0 },
      { name: 'Gemini 3 Flash', reset: FUTURE, percentage: 90 },
    ],
  });

  assert.equal(findQuotaExhaustion(acc, 'gemini-3.5-flash-lite').exhausted, true);
  assert.equal(findQuotaExhaustion(acc, 'gemini-3-flash').exhausted, false);
});

test('legacy quota list is honored when the core publishes no groups', () => {
  const exhausted = account({
    id: 'legacy-1',
    quotas: [
      {
        modelId: 'gemini-2.5-pro',
        limitIn5h: 50,
        requestsIn5h: 50,
        resetTime5h: 'in 4h',
      },
    ],
  });
  assert.equal(findQuotaExhaustion(exhausted, 'gemini-2.5-pro').exhausted, true);

  const rolledOver = account({
    id: 'legacy-2',
    quotas: [
      {
        modelId: 'gemini-2.5-pro',
        limitIn5h: 50,
        requestsIn5h: 50,
        resetTime5h: PAST,
      },
    ],
  });
  assert.equal(findQuotaExhaustion(rolledOver, 'gemini-2.5-pro').exhausted, false);
});

test('remaining percent uses the limiting bucket in the model family', () => {
  const acc = account({
    id: 'acc-pct',
    quotaGroups: groups({ geminiWeekly: 0.25, gemini5h: 1 }),
  });
  assert.equal(remainingQuotaPercent(acc, 'gemini-3.8-flash-tiered'), 25);
  assert.equal(remainingQuotaPercent(acc, 'claude-opus-4-6-thinking'), 100);
});

test('lease selection skips an exhausted account and picks a healthy one', async () => {
  const exhausted = account({
    id: 'acc-exhausted',
    quotaGroups: groups({ geminiWeekly: 0 }),
  });
  const healthy = account({
    id: 'acc-healthy',
    quotaGroups: groups({ geminiWeekly: 0.6 }),
  });
  const manager = new ConcurrencyLeaseManager({ maxConcurrentRequestsPerAccount: 10 });

  const lease = await manager.acquireLease([exhausted, healthy], {
    model: 'gemini-3.8-flash-tiered',
  });
  assert.ok(lease);
  assert.equal(lease.account.id, 'acc-healthy');
  lease.release();
});

test('lease selection reuses an account once its reset time passes', async () => {
  const reset = account({
    id: 'acc-rolled-over',
    quotaGroups: groups({ geminiWeekly: 0, geminiReset: PAST }),
  });
  const manager = new ConcurrencyLeaseManager({
    capacityPolicy: 'reject_429',
    maxConcurrentRequestsPerAccount: 10,
  });

  const lease = await manager.acquireLease([reset], {
    model: 'gemini-3.8-flash-tiered',
  });
  assert.ok(lease, 'a reset window must return the account to rotation');
  assert.equal(lease.account.id, 'acc-rolled-over');
  lease.release();
});

test('lease selection refuses an exhausted pool and still allows Claude', async () => {
  const exhausted = account({
    id: 'acc-gemini-burn',
    quotaGroups: groups({ geminiWeekly: 0 }),
  });
  const manager = new ConcurrencyLeaseManager({
    capacityPolicy: 'reject_429',
    maxConcurrentRequestsPerAccount: 10,
  });

  const gemini = await manager.acquireLease([exhausted], {
    model: 'gemini-3.8-flash-tiered',
  });
  assert.equal(gemini, null, 'an exhausted pool must not be used');

  const claude = await manager.acquireLease([exhausted], {
    model: 'claude-opus-4-6-thinking',
  });
  assert.ok(claude, 'the same account is still valid for its other quota family');
  claude.release();
});

test('validation-blocked accounts are never selected', async () => {
  const accountNeedingVerification = account({
    id: 'acc-validation',
    hasValidationLink: true,
    quotaGroups: groups({ geminiWeekly: 1 }),
  });
  const manager = new ConcurrencyLeaseManager({
    capacityPolicy: 'reject_429',
    maxConcurrentRequestsPerAccount: 10,
  });

  const lease = await manager.acquireLease([accountNeedingVerification], {
    model: 'gemini-3.8-flash-tiered',
  });
  assert.equal(lease, null);
});