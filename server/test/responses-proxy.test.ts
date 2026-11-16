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
const GATEWAY_KEY = 'sk-test-responses-gateway';

let fake: http.Server;
const calls: Array<{ key: string; model: string; stream: boolean; body: any }> = [];

fake = http.createServer((req, res) => {
  const requestUrl = req.url || '';
  if (req.method !== 'POST' || requestUrl !== '/v1beta/openai/chat/completions') {
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
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    calls.push({ key, model: body.model, stream: body.stream === true, body });

    if (key.endsWith('0001')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }));
      return;
    }

    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: 'from-key2' } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'from-key2' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
  });
});

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-responses-proxy-'));
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
const {
  responsesContentToChat,
  responsesInputToChat,
  responsesToChatBody,
  chatToResponsesBody,
  _resetResponseSessionsForTests,
} = await import('../src/responsesProxy.js');

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

function responses(body: Record<string, unknown>, token = GATEWAY_KEY) {
  return fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// ---------- pure translation ----------

test('content: plain text parts collapse to a string', () => {
  const mapped = responsesContentToChat([
    { type: 'input_text', text: 'Hello ' },
    { type: 'output_text', text: 'world' },
  ]);
  assert.equal(mapped.content, 'Hello world');
  assert.equal(mapped.hasImage, false);
  assert.equal(mapped.hasVideo, false);
});

test('content: images become an image_url part array', () => {
  const mapped = responsesContentToChat([
    { type: 'input_text', text: 'What is this?' },
    { type: 'input_image', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
  assert.equal(mapped.hasImage, true);
  assert.ok(Array.isArray(mapped.content));
  const parts = mapped.content as any[];
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('content: video is flagged so the request can bypass the key pool', () => {
  const mapped = responsesContentToChat([{ type: 'input_video', video_url: { url: 'data:video/mp4;base64,AAAA' } }]);
  assert.equal(mapped.hasVideo, true);
});

test('input: string input becomes a user message', () => {
  const mapped = responsesInputToChat('hi');
  assert.deepEqual(mapped.messages, [{ role: 'user', content: 'hi' }]);
});

test('input: reasoning items are skipped, function calls map to tool messages', () => {
  const mapped = responsesInputToChat([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
    { type: 'reasoning', id: 'rs_1', summary: [] },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Phnom Penh"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: '28C' },
  ]);

  assert.equal(mapped.messages.length, 3);
  assert.equal(mapped.messages[0].role, 'user');
  assert.equal(mapped.messages[1].role, 'assistant');
  assert.equal(mapped.messages[1].tool_calls[0].function.name, 'get_weather');
  assert.equal(mapped.messages[2].role, 'tool');
  assert.equal(mapped.messages[2].tool_call_id, 'call_1');
  assert.equal(mapped.messages[2].content, '28C');
});

test('body: instructions become a system message and max_output_tokens maps to max_tokens', () => {
  const translated = responsesToChatBody({
    model: 'gemini-3.5-flash-lite',
    instructions: 'Be terse.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    max_output_tokens: 64,
    temperature: 0.2,
  });
  assert.ok(translated);
  assert.equal(translated.messages[0].role, 'system');
  assert.equal(translated.messages[0].content, 'Be terse.');
  assert.equal(translated.max_tokens, 64);
  assert.equal(translated.temperature, 0.2);
  assert.equal(translated.stream, false);
});

test('body: function tools map to the OpenAI function shape', () => {
  const translated = responsesToChatBody({
    model: 'gemini-3.5-flash-lite',
    input: 'hi',
    tools: [{ type: 'function', name: 'get_weather', description: 'Weather', parameters: { type: 'object' } }],
  });
  assert.ok(translated);
  assert.equal(translated.tools?.[0].type, 'function');
  assert.equal(translated.tools?.[0].function.name, 'get_weather');
  assert.deepEqual(translated.tools?.[0].function.parameters, { type: 'object' });
});

test('response: chat completion becomes a Responses object', () => {
  const out = chatToResponsesBody(
    {
      id: 'chatcmpl-1',
      created: 123,
      model: 'gemini-3.5-flash-lite',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
    { responseId: 'resp_1', model: 'gemini-3.5-flash-lite' },
  );
  assert.equal(out.object, 'response');
  assert.equal(out.id, 'resp_1');
  assert.equal(out.status, 'completed');
  assert.equal(out.output[0].type, 'message');
  assert.equal(out.output[0].content[0].text, 'pong');
  assert.equal(out.usage.total_tokens, 7);
});

test('response: finish_reason length is reported as incomplete', () => {
  const out = chatToResponsesBody(
    {
      model: 'gemini-3.5-flash-lite',
      choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'cut' } }],
    },
    { responseId: 'resp_2', model: 'gemini-3.5-flash-lite' },
  );
  assert.equal(out.status, 'incomplete');
  assert.deepEqual(out.incomplete_details, { reason: 'max_output_tokens' });
});

test('response: tool calls become function_call output items', () => {
  const out = chatToResponsesBody(
    {
      model: 'gemini-3.5-flash-lite',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
        },
      ],
    },
    { responseId: 'resp_3', model: 'gemini-3.5-flash-lite' },
  );
  assert.equal(out.output[0].type, 'function_call');
  assert.equal(out.output[0].name, 'get_weather');
});

// ---------- through the bridge ----------

test('POST /v1/responses is served by the key pool and translated back', async () => {
  calls.length = 0;
  _resetResponseSessionsForTests();
  const res = await responses({
    model: 'gemini-3.5-flash-lite',
    instructions: 'Be terse.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'gemini-3.5-flash-lite');
  assert.equal(body.output[0].content[0].text, 'from-key2');
  assert.equal(body.usage.total_tokens, 7);

  // The key pool received a chat-completions body, not a Responses body.
  assert.equal(calls.length, 2); // key 1 rate limited, key 2 answered
  assert.equal(calls[1].model, 'gemini-3.5-flash-lite');
  assert.equal(calls[1].body.messages[0].role, 'system');
  assert.equal(calls[1].body.messages[1].role, 'user');
  assert.equal(calls[1].body.messages[1].content, 'ping');
});

test('POST /v1/responses streams Responses events from a chat stream', async () => {
  calls.length = 0;
  _resetResponseSessionsForTests();
  const res = await responses({
    model: 'gemini-3.5-flash-lite',
    input: 'ping',
    stream: true,
  });

  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /from-key2/);
  assert.match(text, /event: response\.completed/);
});

test('a Responses model outside the key pool falls through to the account pool', async () => {
  calls.length = 0;
  _resetResponseSessionsForTests();
  const res = await responses({
    model: 'gemini-3.8-flash-high',
    input: 'ping',
  });
  assert.equal(calls.length, 0, 'gemini-3.8-flash-high must bypass the key pool');
  assert.notEqual(res.status, 400);
});

test('an invalid gateway key is rejected before touching Google', async () => {
  calls.length = 0;
  _resetResponseSessionsForTests();
  const res = await responses({ model: 'gemini-3.5-flash-lite', input: 'ping' }, 'sk-wrong');
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('previous_response_id replays the stored history', async () => {
  calls.length = 0;
  _resetResponseSessionsForTests();

  const first = await responses({ model: 'gemini-3.5-flash-lite', input: 'first question' });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const responseId = firstBody.id;
  assert.ok(responseId);

  const second = await responses({
    model: 'gemini-3.5-flash-lite',
    previous_response_id: responseId,
    input: 'follow up',
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json();

  // The follow-up must carry the first user turn plus the new one.
  const lastCall = calls[calls.length - 1];
  const roles = lastCall.body.messages.map((m: any) => `${m.role}:${m.content}`);
  assert.ok(roles.includes('user:first question'), JSON.stringify(roles));
  assert.ok(roles.includes('user:follow up'), JSON.stringify(roles));

  // The new response id is stable for the next turn.
  assert.ok(secondBody.id);
  assert.notEqual(secondBody.id, responseId);
});
