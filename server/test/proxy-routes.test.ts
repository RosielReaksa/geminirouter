/**
 * Route-level contract for the proxy endpoints.
 *
 * No Webshare key and no core are present: the routes must stay honest, keep
 * the key out of every response, and never claim routing is active when it is
 * not.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-proxy-routes-'));
process.chdir(tempHome);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.GEMINIROUTER_ADMIN_PASSWORD = '';
process.env.LOG_LEVEL = 'error';
process.env.ANTIGRAVITY_CORE_PIPE = '\\\\.\\pipe\\geminirouter-test-core-offline';
delete process.env.WEBSHARE_API_KEY;

const { createServer } = await import('../src/index.js');

let app: FastifyInstance;

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

test('GET /api/proxy/config is disabled and redacted by default', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/proxy/config' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.enabled, false);
  assert.equal(body.hasApiKey, false);
  assert.equal(body.proxyCount, 0);
  assert.equal(body.accountCount, 0);
  assert.equal(body.lastError, null);

  const serialized = res.payload;
  assert.equal(serialized.includes('webshareApiKey'), false);
  assert.equal(serialized.includes('password'), false);
});

test('enabling routing without a key is refused, not silently applied', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/proxy/config',
    payload: { enabled: true },
  });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.enabled, false);
  assert.match(body.error, /API key is required/i);
  // No accounts exist in this sandbox, so nothing was pushed to the core.
  assert.deepEqual(body.sync, {
    ok: true,
    changed: 0,
    applied: 0,
    failed: 0,
    errors: [],
    reloaded: null,
  });

  const config = await app.inject({ method: 'GET', url: '/api/proxy/config' });
  assert.equal(config.json().enabled, false);
});

test('refreshing without a key reports a clear error', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/proxy/refresh' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /No Webshare API key configured/i);
});

test('GET /api/proxy/list is empty and does not expose credentials', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/proxy/list' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { enabled: false, proxies: [] });
});