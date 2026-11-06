import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEgress } from '../src/egress.js';
import type { TrafficRecord } from '../src/store.js';

function record(overrides: Partial<TrafficRecord> = {}): TrafficRecord {
  return {
    id: 'tr-1',
    timestamp: new Date().toISOString(),
    clientName: 'Test Client',
    clientIp: '127.0.0.1',
    modelRequested: 'gemini-3.8-flash-high',
    modelRouted: 'gemini-3.8-flash-high',
    backingAccountEmail: 'user@example.com',
    accountId: 'account-1',
    status: 200,
    latencyMs: 42,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    ...overrides,
  };
}

test('proxied traffic is labelled with the proxy IP, country and source', () => {
  const [enriched] = applyEgress([record()], () => ({
    ip: '96.62.148.198',
    country: 'IT',
    via: 'proxy',
  }));

  assert.equal(enriched.egressIp, '96.62.148.198');
  assert.equal(enriched.egressCountry, 'IT');
  assert.equal(enriched.egressVia, 'proxy');
  assert.equal(enriched.id, 'tr-1', 'the original record is preserved');
});

test('direct traffic falls back to the gateway host identity', () => {
  const [enriched] = applyEgress([record({ accountId: undefined })], () => ({
    ip: '203.0.113.7',
    country: 'KH',
    via: 'direct',
  }));

  assert.equal(enriched.egressIp, '203.0.113.7');
  assert.equal(enriched.egressCountry, 'KH');
  assert.equal(enriched.egressVia, 'direct');
});

test('records without an egress identity are returned untouched', () => {
  const input = record();
  const [enriched] = applyEgress([input], () => null);

  assert.equal(enriched, input, 'same object, no partial fields');
  assert.equal('egressIp' in enriched, false);
});

test('egress enrichment does not leak proxy credentials', () => {
  const [enriched] = applyEgress([record()], () => ({
    ip: '96.62.148.198',
    country: 'IT',
    via: 'proxy',
  }));

  const serialized = JSON.stringify(enriched);
  assert.equal(serialized.includes('http://'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('@1.1.1.1'), false);
});