/**
 * Validation contract for POST /api/accounts/import.
 *
 * The core is not running, so a fully valid export must reach the core call and
 * fail with 503 — that proves the request passed validation, auth and staging.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-import-test-'));
process.chdir(tempHome);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.GEMINIROUTER_ADMIN_PASSWORD = '';
process.env.LOG_LEVEL = 'error';

const { createServer } = await import('../src/index.js');

let app: FastifyInstance;

const validExport = JSON.stringify({
  version: '1.0',
  exportedAt: 1_700_000_000,
  accounts: [],
});

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

function post(content: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/accounts/import',
    payload: { content },
  });
}

test('rejects a missing or empty content field', async () => {
  const missing = await post(undefined);
  assert.equal(missing.statusCode, 400);

  const empty = await post('   ');
  assert.equal(empty.statusCode, 400);
});

test('rejects an oversized file', async () => {
  const huge = 'x'.repeat(5 * 1024 * 1024 + 1);
  const res = await post(huge);
  assert.equal(res.statusCode, 413);
});

test('rejects invalid JSON', async () => {
  const res = await post('not json');
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /not valid JSON/i);
});

test('rejects a JSON document that is not an Antigravity export', async () => {
  const noVersion = await post(JSON.stringify({ exportedAt: 1, accounts: [] }));
  assert.equal(noVersion.statusCode, 400);

  const noAccounts = await post(JSON.stringify({ version: '1.0', exportedAt: 1 }));
  assert.equal(noAccounts.statusCode, 400);

  const wrongVersion = await post(JSON.stringify({ version: '2.0', exportedAt: 1, accounts: [] }));
  assert.equal(wrongVersion.statusCode, 400);
});

test('rejects an unknown strategy', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/accounts/import',
    payload: { content: validExport, strategy: 'replace-everything' },
  });
  assert.equal(res.statusCode, 400);
});

test('a valid export reaches the core and reports it as offline', async () => {
  const res = await post(validExport);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'Core is offline');
});

test('the staged import file is always removed', async () => {
  await post(validExport);
  const importsDir = path.join(tempHome, '.data', 'imports');
  const leftovers = fs.existsSync(importsDir) ? fs.readdirSync(importsDir) : [];
  assert.deepEqual(leftovers, []);
});
