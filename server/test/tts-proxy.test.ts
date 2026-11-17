import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const GATEWAY_KEY = 'sk-test-tts-gateway';
const INTERNAL_SECRET = 'test-internal-secret';

const calls: Array<{ path: string; body: any; secret: string | null }> = [];
let holdSpeech = false;

// A tiny but valid MPEG audio frame header repeated; the bridge only relays it.
const FAKE_MP3 = Buffer.from('fffbf20000', 'hex');

const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    calls.push({
      path: req.url || '',
      body,
      secret: String(req.headers['x-geminirouter-internal'] || ''),
    });

    if (req.url === '/voices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 1, voices: [{ id: 'en-US-JennyNeural' }] }));
      return;
    }

    if (holdSpeech) {
      // Hold the only gate slot so a second request queues and is rejected.
      // Hold longer than the gate's queue timeout (floor 1000ms) so the second
      // request is rejected rather than waiting the first one out.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(FAKE_MP3);
      }, 1500);
      return;
    }

    if (body.timestamp_granularities?.includes('word')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          audio_base64: FAKE_MP3.toString('base64'),
          format: 'mp3',
          characters: body.text.length,
          duration_seconds: 1.5,
          voice: 'en-US-JennyNeural',
          words: [{ word: 'Hello', start: 0, end: 0.4 }],
        }),
      );
      return;
    }

    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'x-tts-characters': String(body.text.length),
      'x-tts-voice': 'en-US-JennyNeural',
      'x-tts-seconds': '1.5',
      'x-tts-egress-ip': '203.0.113.7',
      'x-tts-egress-country': 'DE',
      'x-tts-egress-via': 'proxy',
    });
    res.end(FAKE_MP3);
  });
});

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-tts-proxy-'));
process.chdir(tempHome);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.GEMINIROUTER_ADMIN_PASSWORD = '';
process.env.LOG_LEVEL = 'error';
process.env.ANTIGRAVITY_CORE_PIPE = '\\\\.\\pipe\\geminirouter-test-core-offline';
process.env.GEMINIROUTER_API_KEY = GATEWAY_KEY;
process.env.TTS_INTERNAL_SECRET = INTERNAL_SECRET;
// A small gate so the saturation test is deterministic.
process.env.TTS_MAX_CONCURRENT = '1';
process.env.TTS_QUEUE_TIMEOUT_MS = '250';

await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
process.env.TTS_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const { createServer } = await import('../src/index.js');

let app: FastifyInstance;
let bridgePort = 0;

before(async () => {
  const server = await createServer();
  app = server.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  bridgePort = (app.server.address() as AddressInfo).port;
});

after(async () => {
  app.server.closeAllConnections?.();
  await app.close();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function speech(body: Record<string, unknown>, token = GATEWAY_KEY) {
  return fetch(`http://127.0.0.1:${bridgePort}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test('a bad gateway key is rejected before reaching the TTS service', async () => {
  const before = calls.length;
  const res = await speech({ input: 'hi' }, 'sk-wrong');
  assert.equal(res.status, 401);
  assert.equal(calls.length, before, 'the TTS service must not be called');
});

test('POST /v1/audio/speech relays audio and records metered traffic', async () => {
  calls.length = 0;
  const res = await speech({
    model: 'tts-1',
    input: 'Hello from the TTS proxy test.',
    voice: 'nova',
    language: 'en',
  });

  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /audio\/mpeg/);
  assert.equal(res.headers.get('x-tts-characters'), '30');
  assert.equal(res.headers.get('x-tts-voice'), 'en-US-JennyNeural');
  assert.ok(Number(res.headers.get('x-tts-ms')) >= 0);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, FAKE_MP3);

  // The internal service was called with the shared secret, never the public key.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].secret, INTERNAL_SECRET);
  assert.equal(calls[0].body.text, 'Hello from the TTS proxy test.');

  const usage = await fetch(`http://127.0.0.1:${bridgePort}/api/tts/usage`);
  assert.equal(usage.status, 200);
  const body: any = await usage.json();
  assert.equal(body.total.calls, 1);
  assert.equal(body.total.characters, 30);
  assert.equal(body.keys[0].keyName, 'Deployment key');
});

test('word timestamps are returned as JSON with the audio embedded', async () => {
  const res = await speech({
    input: 'Hello there',
    voice: 'nova',
    language: 'en',
    timestamp_granularities: ['word'],
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /application\/json/);
  const body: any = await res.json();
  assert.equal(body.voice, 'en-US-JennyNeural');
  assert.equal(body.words[0].word, 'Hello');
  assert.ok(Buffer.from(body.audio_base64, 'base64').length > 0);
});

test('an unsupported format is rejected without calling the service', async () => {
  const before = calls.length;
  const res = await speech({ input: 'hi', response_format: 'flac-but-not' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, before);
});

test('a saturated gate returns 503 with Retry-After', async () => {
  holdSpeech = true;
  try {
    const [a, b] = await Promise.all([speech({ input: 'first' }), speech({ input: 'second' })]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 503], 'one request serves, one is rejected');
    const limited = a.status === 503 ? a : b;
    assert.equal(limited.headers.get('retry-after'), '30');
    await (a.status === 200 ? a : b).arrayBuffer();
  } finally {
    holdSpeech = false;
  }
});

test('GET /v1/audio/voices lists the catalogue', async () => {
  const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/voices`, {
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
  });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.count, 1);
  assert.equal(body.voices[0].id, 'en-US-JennyNeural');
});

test('the TTS model is advertised in the public catalog', async () => {
  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/public/models`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  const tts = body.models.find((m: any) => m.id === 'tts-1');
  assert.ok(tts, 'tts-1 should be listed');
  assert.equal(tts.kind, 'tts');
  assert.equal(tts.provider, 'Edge TTS');
});

test('TTS traffic keeps the rotating proxy egress, not the gateway host', async () => {
  const res = await speech({ input: 'egress check', voice: 'nova', language: 'en' });
  assert.equal(res.status, 200);

  const traffic = await fetch(`http://127.0.0.1:${bridgePort}/api/traffic`);
  assert.equal(traffic.status, 200);
  const rows: any[] = await traffic.json();
  const tts = rows.find((r) => r.provider === 'tts');
  assert.ok(tts, 'a TTS row must be present');
  assert.equal(tts.egressIp, '203.0.113.7');
  assert.equal(tts.egressCountry, 'DE');
  assert.equal(tts.egressVia, 'proxy');
});

test('the TTS route is served by the bridge, not the account pool', async () => {
  calls.length = 0;
  const res = await speech({ input: 'route check', voice: 'nova', language: 'en' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, 'the request must reach the internal TTS service');
});
