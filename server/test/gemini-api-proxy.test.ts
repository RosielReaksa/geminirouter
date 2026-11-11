import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const KEY_1 = 'AIzaSyTESTKEY0000000000000000000001';
const KEY_2 = 'AIzaSyTESTKEY0000000000000000000002';
const GATEWAY_KEY = 'sk-test-gemini-gateway';

let fake: http.Server;
const calls: Array<{ key: string; model: string; stream: boolean; native?: boolean }> = [];
// Models the fake Google reports as daily-quota exhausted.
const exhaustedModels = new Set<string>();

// The fake Gemini API: key 1 is rate limited, key 2 answers (JSON or SSE).
fake = http.createServer((req, res) => {
  const requestUrl = req.url || '';
  const native = /^\/v1beta\/models\/([^/:?]+):generateContent$/.exec(requestUrl);
  if (
    req.method !== 'POST' ||
    (requestUrl !== '/v1beta/openai/chat/completions' && !native)
  ) {
    res.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    let body: any = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      /* ignore */
    }

    // Gemini-native generateContent: the key travels in x-goog-api-key and the
    // response is a native candidate object, not OpenAI choices.
    if (native) {
      const nativeKey = String(req.headers['x-goog-api-key'] || '').trim();
      calls.push({ key: nativeKey, model: native[1], stream: false, native: true });
      if (nativeKey.endsWith('0001')) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(
          JSON.stringify({
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'quota exceeded',
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'native-from-key2' }] } }],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 3,
            totalTokenCount: 14,
          },
        }),
      );
      return;
    }

    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    calls.push({ key, model: body.model, stream: body.stream === true });

    if (exhaustedModels.has(String(body.model)) && key.endsWith('0001')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'You exceeded your current quota.',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                  retryDelay: '64800s',
                },
              ],
            },
          },
        ]),
      );
      return;
    }

    if (key.endsWith('0001')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { message: 'quota exceeded', code: 429 } }));
      return;
    }

    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'from-key2' } }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'from-key2' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
  });
});

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-gemini-proxy-'));
process.chdir(tempHome);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.GEMINIROUTER_ADMIN_PASSWORD = '';
process.env.LOG_LEVEL = 'error';
process.env.ANTIGRAVITY_CORE_PIPE = '\\\\.\\pipe\\geminirouter-test-core-offline';
process.env.GEMINIROUTER_API_KEY = GATEWAY_KEY;

await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const { createServer } = await import('../src/index.js');

let app: FastifyInstance;
let bridgePort = 0;

before(async () => {
  const server = await createServer();
  app = server.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  bridgePort = (app.server.address() as AddressInfo).port;

  const added = await fetch(`http://127.0.0.1:${bridgePort}/api/gemini/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: [KEY_1, KEY_2] }),
  });
  assert.equal(added.status, 200);
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

function chat(body: Record<string, unknown>, token = GATEWAY_KEY) {
  return fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

test('a rate-limited key fails over to the next key', async () => {
  calls.length = 0;
  const res = await chat({
    model: 'gemini-3.1-flash-lite',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'from-key2');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, KEY_1);
  assert.equal(calls[1].key, KEY_2);
  assert.equal(calls[0].model, 'gemini-3.1-flash-lite');
});

test('inline video is never sent to the OpenAI-compatible key pool', async () => {
  // The key pool speaks /v1beta/openai/chat/completions, which rejects a
  // video_url part with "Invalid content part type". Balanced routing used to
  // send video there on every other turn, so identical video requests failed
  // about half the time. Video must go to the account pool instead.
  calls.length = 0;
  const res = await chat({
    model: 'gemini-3.5-flash-lite',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this clip.' },
          { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
        ],
      },
    ],
  });

  // No keys are reachable in the account pool here, so the exact status is not
  // the point: the point is that Google's key pool was never called.
  assert.equal(calls.length, 0, 'inline video must bypass the key pool entirely');
  assert.notEqual(res.status, 400);
});

test('an invalid gateway key is rejected before touching Google', async () => {
  calls.length = 0;
  const res = await chat(
    { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'ping' }] },
    'sk-wrong',
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('streaming responses are piped through', async () => {
  calls.length = 0;
  const res = await chat({
    model: 'gemini-3.5-flash-lite',
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /from-key2/);
  assert.match(text, /\[DONE\]/);
  assert.ok(calls.every((call) => call.stream === true));
});

test('one exhausted key is cooled and the next key serves the same model', async () => {
  exhaustedModels.add('gemini-3.5-flash-lite');
  try {
    // The first test in this file cooled key 1 for one second.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    calls.length = 0;
    const first = await chat({
      model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(first.status, 200, 'the second key still has 3.5 quota');
    const body = await first.json();
    assert.equal(body.model, 'gemini-3.5-flash-lite', 'the model is never substituted');
    assert.deepEqual(
      calls.map((call) => call.key),
      [KEY_1, KEY_2],
      'key 1 fails, key 2 serves the same model',
    );

    // Key 1 is now parked for its daily reset; key 2 answers directly.
    calls.length = 0;
    const second = await chat({
      model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(second.status, 200);
    assert.deepEqual(calls.map((call) => call.key), [KEY_2]);
  } finally {
    exhaustedModels.delete('gemini-3.5-flash-lite');
  }
});

test('other Gemini models still go to the account pool, not the key pool', async () => {
  calls.length = 0;
  const res = await chat({
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.notEqual(res.status, 200);
  assert.equal(calls.length, 0);
});

test('accounts routing bypasses the key pool for the shared models', async () => {
  const setRouting = await fetch(`http://127.0.0.1:${bridgePort}/api/gemini/routing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routing: 'accounts' }),
  });
  assert.equal(setRouting.status, 200);

  calls.length = 0;
  const res = await chat({
    model: 'gemini-3.5-flash-lite',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.notEqual(res.status, 200, 'no accounts are configured in this sandbox');
  assert.equal(calls.length, 0, 'the key pool must not be touched');

  await fetch(`http://127.0.0.1:${bridgePort}/api/gemini/routing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routing: 'balanced' }),
  });
});

test('key-pool traffic records the named gateway key', async () => {
  calls.length = 0;
  const res = await chat({
    model: 'gemini-3.1-flash-lite',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(res.status, 200);

  const traffic = (await (
    await fetch(`http://127.0.0.1:${bridgePort}/api/traffic`)
  ).json()) as Array<{ provider?: string; gatewayKeyName?: string }>;
  const record = traffic.find((row) => row.provider === 'gemini-api');
  assert.ok(record, 'a key-pool traffic record exists');
  assert.equal(record!.gatewayKeyName, 'Deployment key');
});

test('per-key usage is visible without exposing the key', async () => {
  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/gemini/config`);
  const body = await res.json();
  const used = body.keys.find((key: any) => key.maskedKey.endsWith('0002'));
  assert.ok(used.usage.requestsToday >= 1);
  assert.equal(JSON.stringify(body).includes(KEY_1), false);
  assert.equal(JSON.stringify(body).includes(KEY_2), false);
});

function nativeGenerate(token = GATEWAY_KEY, model = 'gemini-3.5-flash-lite') {
  return fetch(
    `http://127.0.0.1:${bridgePort}/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': token,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'transcribe this audio' }] }],
        generationConfig: { maxOutputTokens: 64, temperature: 0.1 },
      }),
    },
  );
}

test('native generateContent is served by the API key pool', async () => {
  // The dubbing pipeline calls this route, not /v1/chat/completions. Before the
  // native handler existed it could never reach the AI Studio keys at all.
  calls.length = 0;
  const res = await nativeGenerate();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.candidates[0].content.parts[0].text, 'native-from-key2');

  assert.ok(calls.length >= 1, 'the key pool served the native call');
  assert.ok(calls.every((call) => call.native === true));
  assert.ok(
    calls[0].key.startsWith('AIzaSy'),
    'the native request must carry an AI Studio key',
  );
  assert.equal(calls[0].model, 'gemini-3.5-flash-lite');
  assert.equal(res.headers.get('x-egress-provider'), 'gemini-api');
});

test('native requests are authenticated with x-goog-api-key', async () => {
  calls.length = 0;
  const res = await nativeGenerate('sk-wrong');
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0, 'an invalid key must never reach Google');
});

test('native key traffic records token usage', async () => {
  calls.length = 0;
  const res = await nativeGenerate();
  assert.equal(res.status, 200);

  const traffic = (await (
    await fetch(`http://127.0.0.1:${bridgePort}/api/traffic`)
  ).json()) as Array<{
    provider?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }>;
  const record = traffic.find(
    (row) => row.provider === 'gemini-api' && (row.totalTokens ?? 0) > 0,
  );
  assert.ok(record, 'the native call produced a traffic record with usage');
  assert.equal(record!.totalTokens, 14);
  assert.equal(record!.promptTokens, 11);
  assert.equal(record!.completionTokens, 3);
});
