/**
 * Integration tests for the bridge's /v1 proxy contract with the core's
 * account-failover behavior. A fake HTTP upstream stands in for the core
 * gateway (account rotation itself is core-owned and not testable from the
 * bridge — see docs/ACCOUNT-FAILOVER.md). What IS testable here:
 *
 *  1. A 429 (all accounts exhausted) passes through unchanged with its
 *     Retry-After header, is never converted into a fake success, and the
 *     bridge does not retry it (exactly one upstream hit).
 *  2. A 200 upstream answer passes through (the core's "failed over to
 *     account B" outcome).
 *  3. Once a streamed response has started, the bridge never re-issues the
 *     request (single upstream hit even after the stream breaks).
 *  4. /api/oauth/complete errors instead of fabricating an account when the
 *     core is offline.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UPSTREAM_PORT = 3891;
const BRIDGE_PORT = 3892;

let upstreamHits = 0;
let upstreamMode = 'exhausted'; // 'exhausted' | 'ok' | 'stream-break'

const upstream = http.createServer((req, res) => {
  upstreamHits++;
  if (upstreamMode === 'exhausted') {
    // What the core emits when the whole pool is exhausted.
    res.writeHead(429, { 'Retry-After': '60', 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'All accounts failed or unhealthy', type: 'pool_exhausted' },
      }),
    );
    return;
  }
  if (upstreamMode === 'ok') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'cmpl-1',
        choices: [{ message: { role: 'assistant', content: 'pong from account B' } }],
      }),
    );
    return;
  }
  // stream-break: start an SSE response, emit one event, then kill the socket.
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: {"delta":"partial"}\n\n');
  setTimeout(() => {
    res.destroy();
  }, 150);
});

let bridge: ReturnType<typeof spawn>;
let bridgeReady = false;
let tempHome = '';

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function request(port: number, reqPath: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${reqPath}`, init);
}

before(async () => {
  await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

  // Isolated HOME so the bridge cannot read the real core profile or hit the
  // real gateway; everything is pinned to the fake upstream via env.
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-test-home-'));
  bridge = spawn(process.execPath, ['dist/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(BRIDGE_PORT),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      USERPROFILE: tempHome,
      HOME: tempHome,
      GEMINIROUTER_GATEWAY_PORT: String(UPSTREAM_PORT),
      GEMINIROUTER_GATEWAY_API_KEY: 'test-key',
      GEMINIROUTER_ADMIN_PASSWORD: '',
    },
  });
  bridge.stderr.on('data', () => {}); // swallow logs

  // Wait until the bridge answers.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await request(BRIDGE_PORT, '/api/status');
      if (res.ok || res.status === 500) {
        bridgeReady = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await wait(200);
  }
  assert.ok(bridgeReady, 'bridge did not become ready');
});

after(async () => {
  bridge?.kill();
  upstream.close();
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  await wait(200);
});

test('pool-exhausted 429 passes through with Retry-After, no fake success, no retry', async () => {
  upstreamMode = 'exhausted';
  upstreamHits = 0;

  const res = await request(BRIDGE_PORT, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(res.status, 429, 'client must see the real 429, never a fake success');
  assert.equal(res.headers.get('retry-after'), '60', 'Retry-After must be preserved');
  const body = await res.json();
  assert.match(body.error.message, /All accounts failed or unhealthy/);
  assert.equal(upstreamHits, 1, 'bridge must not retry a pool-exhausted response');
});

test('successful (failed-over) response passes through', async () => {
  upstreamMode = 'ok';
  upstreamHits = 0;

  const res = await request(BRIDGE_PORT, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'pong from account B');
  assert.equal(upstreamHits, 1);
});

test('no retry after a streamed response has started', async () => {
  upstreamMode = 'stream-break';
  upstreamHits = 0;

  const res = await request(BRIDGE_PORT, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: 'gemini-2.5-pro',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  assert.equal(res.status, 200, 'stream must have started (headers received)');
  const raw = net.connect({ port: BRIDGE_PORT, host: '127.0.0.1' });
  raw.destroy();

  // Give any hypothetical retry logic time to fire, then assert it never did.
  await wait(1500);
  assert.equal(upstreamHits, 1, 'once streaming started, the request must never be replayed');
});

test('core offline: /api/oauth/complete errors instead of fabricating an account', async () => {
  // The bridge runs with an isolated HOME, so the core pipe does not exist.
  const accountsBefore = await (await request(BRIDGE_PORT, '/api/accounts')).json();

  const res = await request(BRIDGE_PORT, '/api/oauth/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-1', code: '4/0Ax4XbkTestCode' }),
  });

  assert.equal(res.status, 503, 'offline core must produce an error, not a mock account');
  const body = await res.json();
  assert.match(body.error, /Core is offline/);

  const accountsAfter = await (await request(BRIDGE_PORT, '/api/accounts')).json();
  assert.equal(accountsAfter.length, accountsBefore.length, 'no account may be invented');
});

test('core offline: /api/oauth/start errors instead of returning a fake URL', async () => {
  const res = await request(BRIDGE_PORT, '/api/oauth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /Core is offline/);
  assert.ok(!body.authorizationUrl, 'no fake authorization URL may be returned');
});
