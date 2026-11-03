import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicRoute } from '../src/auth.js';

test('API proxy routes bypass the dashboard session check', () => {
  assert.equal(isPublicRoute('/v1/chat/completions'), true);
  assert.equal(
    isPublicRoute('/v1beta/models/gemini-3.8-flash-high:generateContent'),
    true,
  );
  assert.equal(isPublicRoute('/v1beta/models/claude-opus-4-6-thinking:generateContent'), true);
});

test('dashboard APIs are not public', () => {
  assert.equal(isPublicRoute('/api/status'), false);
  assert.equal(isPublicRoute('/api/accounts'), false);
});