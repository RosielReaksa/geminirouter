/**
 * Integration tests for /v1 dispatch using the REAL createServer() from
 * server/src/index.ts and real HTTP requests to /v1/chat/completions.
 *
 * Covers:
 *  - Regression for the request.raw 'close' bug (Node >= 18 emits 'close' on
 *    the request stream once the body is read — old code destroyed every
 *    upstream call, returning 502 "socket hang up").
 *  - 200 after 300 ms reaches the client.
 *  - Account A 429 -> failover to account B (client 200 from B, A cooldown).
 *  - Client abort mid-stream aborts the upstream socket and releases the lease.
 *  - No retry after the first streamed byte.
 *  - 30 concurrent non-streaming requests across 3 and 10 accounts: all 200.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GoogleAccount, LocalStateStore } from '../src/store.js';
import type { ConcurrencyLeaseManager } from '../src/leaseManager.js';

// ---- Isolated environment BEFORE importing the real server module ----
// cwd/.data (store persistence) and the core profile lookups (HOME) must not
// touch the developer's real state.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-v1-test-'));
process.chdir(tempHome);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.GEMINIROUTER_ADMIN_PASSWORD = '';
process.env.GEMINIROUTER_GATEWAY_API_KEY = 'test-key';
process.env.LOG_LEVEL = 'warn';

const { createServer } = await import('../src/index.js');

// ---- Fake upstream (stands in for the core gateway) ----
type Mode = 'slow' | 'failover' | 'stream-break';
let mode: Mode = 'slow';
let hits: Record<string, number> = {};
let upstreamSocketsClosed = 0;
const totalHits = () => Object.values(hits).reduce((a, b) => a + b, 0);

const upstream = http.createServer((req, res) => {
  const accountId = String(req.headers['x-account-id'] || 'unknown');
  hits[accountId] = (hits[accountId] || 0) + 1;

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (mode === 'failover' && accountId === 'fail-acc-a') {
      res.writeHead(429, { 'Retry-After': '2', 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'account A rate limited', type: 'rate_limit_error' } }),
      );
      return;
    }
    if (mode === 'stream-break') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"delta":"first"}\n\n');
      setTimeout(() => res.destroy(), 120);
      return;
    }
    // slow / ok: reply 200 after 300 ms
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-1',
          choices: [{ message: { role: 'assistant', content: 'pong' } }],
          served_by: accountId,
        }),
      );
    }, 300);
  });
});

upstream.on('connection', (socket) => {
  socket.on('close', () => {
    upstreamSocketsClosed++;
  });
});

// ---- Real bridge ----
let bridgePort = 0;
let store: LocalStateStore;
let leaseManager: ConcurrencyLeaseManager;
let appInstance: Awaited<ReturnType<typeof createServer>>['app'];

function makeAccounts(prefix: string, count: number): GoogleAccount[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    email: `${prefix}${i + 1}@gmail.com`,
    name: `${prefix} ${i + 1}`,
    status: 'active' as const,
    addedAt: '2026-01-01T00:00:00Z',
    tier: 'Google AI Studio' as const,
    quotas: [],
    isDefaultRouting: i === 0,
    totalRequests24h: 0,
  }));
}

function chatInit(): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  };
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

before(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  // resolveGateway() reads this env at request time.
  process.env.GEMINIROUTER_GATEWAY_PORT = String(upstreamPort);

  const server = await createServer();
  appInstance = server.app;
  store = server.store;
  leaseManager = server.leaseManager;

  await appInstance.listen({ port: 0, host: '127.0.0.1' });
  bridgePort = (appInstance.server.address() as net.AddressInfo).port;
});

after(async () => {
  await appInstance.close();
  upstream.close();
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('regression: 200 after 300 ms reaches the client (request.raw close bug)', async () => {
  mode = 'slow';
  store.setAccounts(makeAccounts('basic', 1));
  hits = {};

  const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, chatInit());

  assert.equal(res.status, 200, 'client must receive the upstream 200, not a 502 hang-up');
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'pong');
  assert.ok(body.served_by, 'upstream must have received the request');
  assert.equal(leaseManager.getTotalInFlight(), 0, 'lease must be released after completion');
});

test('account A 429 -> client gets 200 from account B; A enters cooldown', async () => {
  mode = 'failover';
  store.setAccounts(makeAccounts('fail', 2).map((a, i) => ({ ...a, id: i === 0 ? 'fail-acc-a' : 'fail-acc-b' })));
  hits = {};

  const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, chatInit());

  assert.equal(res.status, 200, 'failover must deliver a 200 from account B');
  const body = await res.json();
  assert.equal(body.served_by, 'fail-acc-b', 'request must have been served by account B');
  assert.equal(hits['fail-acc-a'], 1, 'account A was tried first');
  assert.equal(hits['fail-acc-b'], 1, 'account B served the retry');
  assert.equal(leaseManager.isAccountInCooldown('fail-acc-a'), true, 'A must be cooling down');
  assert.equal(leaseManager.isAccountInCooldown('fail-acc-b'), false, 'B is healthy');
  assert.equal(leaseManager.getTotalInFlight(), 0);

  leaseManager.clearCooldown('fail-acc-a');
});

test('client abort mid-stream aborts the upstream socket and releases the lease', async () => {
  mode = 'stream-break';
  store.setAccounts(makeAccounts('abort', 1));
  hits = {};
  upstreamSocketsClosed = 0;

  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    ...chatInit(),
    headers: { ...chatInit().headers, Accept: 'text/event-stream' },
    signal: ac.signal,
  });
  assert.equal(res.status, 200, 'stream must have started');

  const reader = res.body!.getReader();
  const firstChunk = await reader.read();
  assert.ok(firstChunk.value, 'first SSE chunk must arrive');

  // Abort the client mid-stream.
  ac.abort();
  await wait(400);

  assert.ok(
    upstreamSocketsClosed >= 1,
    'fake upstream must have seen its socket close after the client aborted',
  );
  assert.equal(
    leaseManager.getTotalInFlight(),
    0,
    'lease must be released after client abort',
  );
});

test('no retry after the first streamed byte', async () => {
  mode = 'stream-break';
  store.setAccounts(makeAccounts('stream', 2));
  hits = {};

  const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    ...chatInit(),
    headers: { ...chatInit().headers, Accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200, 'stream must have started');

  const reader = res.body!.getReader();
  const firstChunk = await reader.read();
  assert.ok(firstChunk.value, 'first chunk received');

  // Upstream destroys the socket 120 ms after the first chunk. Wait long
  // enough for any hypothetical retry to fire, then assert it never did.
  await wait(500);
  assert.equal(totalHits(), 1, 'the request must never be replayed after streaming started');
  assert.equal(leaseManager.getTotalInFlight(), 0);
});

test('30 concurrent non-streaming requests across 3 accounts: all 200, spread max-min <= 1', async () => {
  mode = 'slow';
  store.setAccounts(makeAccounts('three', 3));
  hits = {};

  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, chatInit()).then(async (r) => ({
        status: r.status,
        body: await r.json(),
      })),
    ),
  );

  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(r.body.choices[0].message.content, 'pong');
  }

  const counts = Object.values(hits);
  assert.equal(counts.reduce((a, b) => a + b, 0), 30);
  assert.equal(Math.max(...counts) - Math.min(...counts) <= 1, true, `spread must be <= 1, got ${counts.join(',')}`);
  assert.equal(leaseManager.getTotalInFlight(), 0, 'all leases released');
});

test('30 concurrent non-streaming requests across 10 accounts: all 200, spread max-min <= 1', async () => {
  mode = 'slow';
  store.setAccounts(makeAccounts('ten', 10));
  hits = {};

  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, chatInit()).then(async (r) => ({
        status: r.status,
        body: await r.json(),
      })),
    ),
  );

  for (const r of results) {
    assert.equal(r.status, 200);
  }

  const counts = Object.values(hits);
  assert.equal(counts.reduce((a, b) => a + b, 0), 30);
  assert.equal(Math.max(...counts) - Math.min(...counts) <= 1, true, `spread must be <= 1, got ${counts.join(',')}`);
  assert.equal(leaseManager.getTotalInFlight(), 0, 'all leases released');
});
