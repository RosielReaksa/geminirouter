import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  derivePoolState,
  bridgeToCoreProxy,
  coreProxyToBridge,
} from '../src/pool-state.js';
import type { GoogleAccount, TrafficRecord, GatewayConfig } from '../src/store.js';

function account(partial: Partial<GoogleAccount>): GoogleAccount {
  return {
    id: partial.id || 'a1',
    email: partial.email || 'one@gmail.com',
    name: partial.name || 'One',
    status: partial.status || 'active',
    statusMessage: partial.statusMessage,
    addedAt: '2026-01-01T00:00:00Z',
    lastUsedAt: partial.lastUsedAt,
    tier: 'Google AI Studio',
    quotas: [],
    isDefaultRouting: false,
    totalRequests24h: 0,
    ...partial,
  } as GoogleAccount;
}

function record(partial: Partial<TrafficRecord>): TrafficRecord {
  return {
    id: partial.id || 't1',
    timestamp: partial.timestamp || new Date().toISOString(),
    clientName: 'Claude Code CLI',
    clientIp: '127.0.0.1',
    modelRequested: 'gemini-2.5-pro',
    modelRouted: 'gemini-2.5-pro',
    backingAccountEmail: partial.backingAccountEmail || 'one@gmail.com',
    status: partial.status ?? 200,
    latencyMs: partial.latencyMs ?? 100,
    promptTokens: 10,
    completionTokens: 10,
    totalTokens: partial.totalTokens ?? 20,
    ...partial,
  } as TrafficRecord;
}

const baseConfig: GatewayConfig = {
  port: 8045,
  host: '0.0.0.0',
  masterApiKey: 'k',
  autoStartOnBoot: true,
  autoSwitchOnQuotaLimit: true,
  quotaWarningThresholdPercent: 85,
  autoCooldownMinutes: 30,
  rotationStrategy: 'least-used-quota',
  enableStreamRelay: true,
  enableThinkingTagPassthrough: true,
  rateLimitPerMinute: 120,
  logRetentionDays: 14,
};

test('derivePoolState computes real numbers from real records only', () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  const traffic: TrafficRecord[] = [
    record({ timestamp: iso(1000), backingAccountEmail: 'a@gmail.com', status: 200, latencyMs: 100, totalTokens: 50 }),
    record({ timestamp: iso(2000), backingAccountEmail: 'a@gmail.com', status: 429, latencyMs: 20, totalTokens: 5 }),
    record({ timestamp: iso(3000), backingAccountEmail: 'b@gmail.com', status: 200, latencyMs: 300, totalTokens: 100 }),
    // Outside the 24h window — must be ignored.
    record({ timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString(), totalTokens: 9999 }),
  ];

  const state = derivePoolState([], traffic);

  assert.equal(state.requestsLast24h, 3);
  assert.equal(state.tokensLast24h, 155);
  assert.equal(state.averageLatencyMs, 140); // (100+20+300)/3
  assert.equal(state.successRate, 66.7); // 2/3
  // Chronology: b(3s ago) -> a(2s ago) -> a(1s ago). Most recent server: a.
  assert.equal(state.activeBackingAccountEmail, 'a@gmail.com');
  // Last observed switch: b -> a at 2s ago.
  assert.equal(state.lastSwitch?.fromEmail, 'b@gmail.com');
  assert.equal(state.lastSwitch?.toEmail, 'a@gmail.com');
});

test('derivePoolState returns null metrics instead of fabricating when there is no traffic', () => {
  const state = derivePoolState([account({ status: 'cooldown', email: 'x@gmail.com' })], []);
  assert.equal(state.requestsLast24h, 0);
  assert.equal(state.averageLatencyMs, null);
  assert.equal(state.successRate, null);
  assert.equal(state.activeBackingAccountEmail, null);
  assert.deepEqual(state.cooldownAccounts, [
    { id: 'a1', email: 'x@gmail.com', status: 'cooldown' },
  ]);
});

test('config mapping: bridge routing fields map onto real core scheduling settings', () => {
  const patch = bridgeToCoreProxy({
    rotationStrategy: 'least-used-quota',
    autoSwitchOnQuotaLimit: false,
  });
  assert.deepEqual(patch, {
    quota_aware_scheduling_enabled: false,
    scheduling_mode: 'balance',
    account_selection_strategy: 'balanced',
  });

  const pinned = bridgeToCoreProxy({
    rotationStrategy: 'pinned-account',
    pinnedAccountId: 'acc-42',
  });
  assert.equal(pinned.account_selection_strategy, 'account-first');
  assert.equal(pinned.preferred_account_id, 'acc-42');
});

test('config mapping: core settings reflect back into dashboard fields', () => {
  const merged = coreProxyToBridge(
    {
      quota_aware_scheduling_enabled: true,
      scheduling_mode: 'balance',
      account_selection_strategy: 'account-first',
      preferred_account_id: 'acc-7',
      circuit_breaker_backoff_steps: [60, 300, 1800, 7200],
    },
    baseConfig,
  );
  assert.equal(merged.rotationStrategy, 'pinned-account');
  assert.equal(merged.pinnedAccountId, 'acc-7');
  assert.equal(merged.autoSwitchOnQuotaLimit, true);
  assert.deepEqual(merged.coreScheduling?.circuit_breaker_backoff_steps, [60, 300, 1800, 7200]);
});

test('config mapping never carries the api key', () => {
  const merged = coreProxyToBridge(
    { api_key: 'sk-secret' } as any,
    baseConfig,
  );
  assert.equal((merged.coreScheduling as any)?.api_key, undefined);
});
