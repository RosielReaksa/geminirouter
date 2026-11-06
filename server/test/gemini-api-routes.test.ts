import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-gemini-routes-'));
process.chdir(tempHome);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.GEMINIROUTER_ADMIN_PASSWORD = '';
process.env.LOG_LEVEL = 'error';
process.env.ANTIGRAVITY_CORE_PIPE = '\\\\.\\pipe\\geminirouter-test-core-offline';

const { createServer } = await import('../src/index.js');

let app: FastifyInstance;

const KEY_A = 'AIzaSyTESTKEY0000000000000000000001';
const KEY_B = 'AIzaSyTESTKEY0000000000000000000002';

before(async () => {
  const server = await createServer();
  app = server.app;
});

after(async () => {
  app.server.closeAllConnections?.();
  await app.close();
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function postKeys(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/gemini/keys', payload });
}

test('config starts empty with the two Gemini models', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/gemini/config' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.models, ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
  assert.equal(body.limits.rpm, 15);
  assert.equal(body.limits.tpm, 250000);
  assert.equal(body.limits.rpd, 500);
  assert.equal(body.proxy.enabled, false);
  assert.equal(body.proxy.available, 0);
  assert.equal(body.sharedRouting, 'balanced');
  assert.deepEqual(body.keys, []);
});

test('enabling key proxies without a Webshare key is refused', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/gemini/proxy',
    payload: { enabled: true },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /Webshare/i);
});

test('shared-model routing defaults to balanced and can be pinned', async () => {
  const bad = await app.inject({
    method: 'POST',
    url: '/api/gemini/routing',
    payload: { routing: 'nope' },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /balanced, keys or accounts/);

  for (const routing of ['keys', 'accounts', 'balanced'] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/gemini/routing',
      payload: { routing },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().sharedRouting, routing);
  }

  const config = await app.inject({ method: 'GET', url: '/api/gemini/config' });
  assert.equal(config.json().sharedRouting, 'balanced');
});

test('adds several keys at once and only returns them masked', async () => {
  const res = await postKeys({ label: 'studio', keys: [KEY_A, KEY_B] });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.added, 2);
  assert.equal(body.skipped, 0);
  assert.equal(body.keys.length, 2);
  assert.equal(res.payload.includes(KEY_A), false);
  assert.equal(res.payload.includes(KEY_B), false);
  assert.match(body.keys[0].maskedKey, /^AIza…0001$/);
  assert.match(body.keys[1].maskedKey, /^AIza…0002$/);
  assert.equal(body.keys[0].label, 'studio 1');
  assert.equal(body.keys[1].label, 'studio 2');
});

test('duplicates are skipped and short keys are rejected', async () => {
  const duplicate = await postKeys({ keys: [KEY_A] });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().added, 0);
  assert.equal(duplicate.json().skipped, 1);

  const invalid = await postKeys({ key: 'too-short' });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json().error, /20\+ characters/);
});

test('a key can be disabled, tested and deleted without leaking its value', async () => {
  const config = await app.inject({ method: 'GET', url: '/api/gemini/config' });
  const key = config.json().keys.find((entry: any) => entry.label === 'studio 1');
  assert.ok(key);

  const disabled = await app.inject({
    method: 'PATCH',
    url: `/api/gemini/keys/${key.id}`,
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().keys.find((entry: any) => entry.id === key.id).enabled, false);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/gemini/keys/${key.id}`,
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().keys.some((entry: any) => entry.id === key.id), false);
  assert.equal(removed.payload.includes(KEY_A), false);
});