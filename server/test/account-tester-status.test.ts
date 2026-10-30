import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeModelAccountTests, type AccountTestResult } from '../src/accountTester.js';

const result = (overrides: Partial<AccountTestResult> = {}): AccountTestResult => ({
  accountId: 'account-1',
  email: 'test@example.com',
  ok: false,
  requiresValidation: false,
  model: 'gemini-test',
  latencyMs: 100,
  timestamp: new Date(0).toISOString(),
  ...overrides,
});

test('a model is working if any connected account succeeds', () => {
  const summary = summarizeModelAccountTests('gemini-test', [
    result({ httpStatus: 503, error: 'temporarily unavailable' }),
    result({ accountId: 'account-2', ok: true, httpStatus: 200 }),
  ]);

  assert.equal(summary.status, 'working');
  assert.equal(summary.workingAccounts, 1);
  assert.equal(summary.checkedAccounts, 2);
});

test('a model is expired only when every account reports an unknown model', () => {
  const summary = summarizeModelAccountTests('gemini-test', [
    result({ httpStatus: 404, error: 'HTTP 404: model not found' }),
    result({ accountId: 'account-2', httpStatus: 410, error: 'HTTP 410: model expired' }),
  ]);

  assert.equal(summary.status, 'expired');
  assert.equal(summary.ok, false);
});

test('temporary upstream errors never mark a model expired', () => {
  const summary = summarizeModelAccountTests('gemini-test', [
    result({ httpStatus: 503, error: 'All accounts failed or unhealthy' }),
  ]);

  assert.equal(summary.status, 'temporarily_unavailable');
});

test('verification is reported only when every account needs verification', () => {
  const summary = summarizeModelAccountTests('gemini-test', [
    result({ requiresValidation: true, httpStatus: 403 }),
    result({ accountId: 'account-2', requiresValidation: true, httpStatus: 403 }),
  ]);

  assert.equal(summary.status, 'needs_verification');
});
