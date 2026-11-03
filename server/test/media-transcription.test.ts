/**
 * End-to-end tests for the long-audio transcription route.
 *
 * A real FFmpeg binary is used to transcode and split a generated WAV file.
 * The fake core upstream records each model request, so the test verifies that
 * every chunk is sent as MP3, that the caller's prompt reaches the model, and
 * that the combined transcript/translation comes back in one response.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { GoogleAccount, LocalStateStore } from '../src/store.js';
import {
  buildChunkPrompt,
  buildDubbingPrompt,
  dubbingMaxOutputTokens,
  formatDubbingTimestamp,
  isModelFailureText,
  languageLabel,
  normalizeDubbingSegment,
  parseDubbingPayload,
  parseDubbingTimestamp,
  readMediaConfig,
  splitStructuredOutput,
} from '../src/mediaTranscription.js';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-media-test-'));
process.chdir(tempHome);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.GEMINIROUTER_ADMIN_PASSWORD = '';
process.env.GEMINIROUTER_API_KEY = 'sk-media-test';
process.env.GEMINIROUTER_GATEWAY_API_KEY = 'sk-media-test';
process.env.LOG_LEVEL = 'warn';
process.env.MEDIA_CHUNK_SECONDS = '60';
process.env.MEDIA_MAX_UPLOAD_BYTES = String(32 * 1024 * 1024);

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

const { createServer } = await import('../src/index.js');

interface ModelRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{
    role: string;
    content: Array<{ type: string; text?: string; input_audio?: { data: string; format: string } }>;
  }>;
}

interface GeminiRequest {
  contents: Array<{
    role: string;
    parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>;
  }>;
  generationConfig: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
    responseSchema?: { type?: string; items?: { type?: string } };
  };
}

let bridgePort = 0;
let store: LocalStateStore;
let appInstance: Awaited<ReturnType<typeof createServer>>['app'];
const modelRequests: ModelRequest[] = [];
const geminiRequests: GeminiRequest[] = [];
const modelAuthHeaders: Array<string | undefined> = [];
let failNextModelRequest = false;
let failNextDubbingSchema = false;
let nextCustomReply: string | null = null;
let nextDubbingReply: string | null = null;
let nextFinishReason: string | null = null;

function defaultDubbingReply(index: number): string {
  // Timestamps are intentionally chunk-local; the bridge must add the offset.
  const start = index === 1 ? '00:01.0' : '00:00.5';
  const end = index === 1 ? '00:04.5' : '00:03.0';
  return JSON.stringify([
    {
      start,
      end,
      speaker_gender: 'female',
      pitch: 'high',
      vocal_timbre: 'young and bright',
      character_role: 'younger sister',
      original_transcript: `小梨说第 ${index} 段`,
      khmer_dubbing: `ប្អូនស្រីនិយាយភាគទី ${index} ចាស`,
    },
  ]);
}

const upstream = http.createServer((request, response) => {
  modelAuthHeaders.push(typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined);
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const isGenerateContent = /:generateContent(?:\?|$)/.test(request.url || '');
    let parsed: any = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }

    if (isGenerateContent) {
      geminiRequests.push(parsed as GeminiRequest);
      const index = geminiRequests.length;

      if (failNextDubbingSchema) {
        failNextDubbingSchema = false;
        response.writeHead(400, {
          'Content-Type': 'application/json',
          'x-antigravity-account-id': 'media-acc-1',
        });
        response.end(
          JSON.stringify({
            error: { message: 'responseSchema is not supported for this model' },
          }),
        );
        return;
      }

      const content = nextDubbingReply ?? defaultDubbingReply(index);
      nextDubbingReply = null;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'x-antigravity-account-id': 'media-acc-1',
      });
      response.end(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: content }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 120,
            candidatesTokenCount: 80,
            totalTokenCount: 200,
          },
        }),
      );
      return;
    }

    const parsedModel = parsed as ModelRequest | null;
    if (parsedModel) modelRequests.push(parsedModel);
    const index = modelRequests.length;

    if (failNextModelRequest) {
      failNextModelRequest = false;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'x-antigravity-account-id': 'media-acc-1',
      });
      response.end(
        JSON.stringify({
          id: `cmpl-media-failure-${index}`,
          model: parsedModel?.model || 'gemini-3.5-flash-lite',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'The model could not complete a tool call. Please try again or adjust the requested tool.',
              },
            },
          ],
        }),
      );
      return;
    }

    const content =
      nextCustomReply ?? `TRANSCRIPT:\nspoken line ${index}\nTRANSLATION:\ntranslated line ${index}`;
    nextCustomReply = null;
    const finishReason = nextFinishReason ?? 'stop';
    nextFinishReason = null;

    response.writeHead(200, {
      'Content-Type': 'application/json',
      'x-antigravity-account-id': 'media-acc-1',
    });
    response.end(
      JSON.stringify({
        id: `cmpl-media-${index}`,
        model: parsedModel?.model || 'gemini-3.5-flash-lite',
        choices: [
          {
            finish_reason: finishReason,
            message: {
              role: 'assistant',
              content,
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  });
});

function makeAccounts(): GoogleAccount[] {
  return [
    {
      id: 'media-acc-1',
      email: 'media1@gmail.com',
      name: 'Media 1',
      status: 'active',
      addedAt: '2026-01-01T00:00:00Z',
      tier: 'Google AI Studio',
      quotas: [],
      isDefaultRouting: true,
      totalRequests24h: 0,
    },
  ];
}

/** Minimal valid PCM WAV: 16 kHz, mono, 16-bit silence. */
function makeWav(seconds: number): Buffer {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = seconds * sampleRate * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer sk-media-test', ...extra };
}

before(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  process.env.GEMINIROUTER_GATEWAY_PORT = String(upstreamPort);

  const server = await createServer();
  appInstance = server.app;
  store = server.store;
  store.setAccounts(makeAccounts());

  await appInstance.listen({ port: 0, host: '127.0.0.1' });
  bridgePort = (appInstance.server.address() as net.AddressInfo).port;
});

after(async () => {
  appInstance.server.closeAllConnections?.();
  await appInstance.close();
  upstream.closeAllConnections?.();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('media chunks default to 15 minutes with a 2-hour maximum', () => {
  const oldChunk = process.env.MEDIA_CHUNK_SECONDS;
  const oldMax = process.env.MEDIA_MAX_DURATION_SECONDS;
  delete process.env.MEDIA_CHUNK_SECONDS;
  delete process.env.MEDIA_MAX_DURATION_SECONDS;
  try {
    const config = readMediaConfig();
    assert.equal(config.maxDurationSeconds, 7200);
    assert.equal(config.chunkSeconds, 900);
  } finally {
    if (oldChunk === undefined) delete process.env.MEDIA_CHUNK_SECONDS;
    else process.env.MEDIA_CHUNK_SECONDS = oldChunk;
    if (oldMax === undefined) delete process.env.MEDIA_MAX_DURATION_SECONDS;
    else process.env.MEDIA_MAX_DURATION_SECONDS = oldMax;
  }
});

test('detects model tool-call failure text so it can be retried', () => {
  assert.equal(
    isModelFailureText(
      'The model could not complete a tool call. Please try again or adjust the requested tool.',
    ),
    true,
  );
  assert.equal(isModelFailureText('SILENCE'), false);
  assert.equal(isModelFailureText('spoken line 1'), false);
  assert.equal(isModelFailureText(''), false);
});

test('language names and ISO codes are normalized, unknown languages pass through', () => {
  assert.equal(languageLabel('ja'), 'Japanese');
  assert.equal(languageLabel('pt-BR'), 'Brazilian Portuguese');
  assert.equal(languageLabel('zh_TW'), 'Traditional Chinese');
  assert.equal(languageLabel('Klingon'), 'Klingon');
  assert.equal(languageLabel('xx'), 'xx');
  assert.equal(languageLabel('  '), undefined);
});

test('prompt builder keeps the caller prompt, chunk position and context', () => {
  const prompt = buildChunkPrompt({
    prompt: 'Transcribe this and translate it to Spanish.',
    task: 'both',
    targetLanguage: 'es',
    index: 1,
    count: 3,
    previousText: 'línea anterior',
  });
  assert.match(prompt, /Transcribe this and translate it to Spanish\./);
  assert.match(prompt, /part 2 of 3/);
  assert.match(prompt, /línea anterior/);
  assert.match(prompt, /Do not repeat it/);
});

test('default both-language prompt uses the normalized target language', () => {
  const prompt = buildChunkPrompt({
    task: 'both',
    targetLanguage: 'ja',
    index: 0,
    count: 1,
  });
  assert.match(prompt, /translate it into Japanese/);
});

test('structured output parser extracts transcript and translation', () => {
  const parsed = splitStructuredOutput('TRANSCRIPT:\nhello\nTRANSLATION:\nhola');
  assert.equal(parsed.transcript, 'hello');
  assert.equal(parsed.translation, 'hola');

  const markdown = splitStructuredOutput('## TRANSCRIPT:\nhello\n\n**TRANSLATION:**\nhola');
  assert.equal(markdown.transcript, 'hello');
  assert.equal(markdown.translation, 'hola');
});

test('languages endpoint advertises many languages and an open allow-list', async () => {
  const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/languages`, {
    headers: authHeaders(),
  });
  const body: any = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.accepts_any, true);
  const names = new Set(body.languages.map((language: any) => language.name));
  for (const expected of ['English', 'Japanese', 'Thai', 'Khmer', 'Spanish', 'Arabic']) {
    assert.equal(names.has(expected), true, `${expected} should be listed`);
  }
  assert.ok(body.languages.length > 40);
});

test('rejects a request without an API key before reading the upload', async () => {
  const before = modelRequests.length;
  const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: makeWav(1),
  });
  assert.equal(response.status, 401);
  assert.equal(modelRequests.length, before);
});

test(
  'multipart 65-second audio is split into two chunks and returned together',
  { skip: !hasFfmpeg },
  async () => {
    modelRequests.length = 0;
    modelAuthHeaders.length = 0;
    const form = new FormData();
    form.append('file', new Blob([makeWav(65)], { type: 'audio/wav' }), 'sample.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('task', 'both');
    form.append('target_language', 'ja');
    form.append('prompt', 'Transcribe this recording and translate it into Japanese.');
    form.append('temperature', '0');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);

    assert.equal(body.object, 'audio.transcription');
    assert.equal(body.chunk_count, 2, 'a 65-second recording must be split at 60 seconds');
    assert.equal(modelRequests.length, 2, 'one model request per chunk');
    assert.deepEqual(modelAuthHeaders, ['Bearer sk-media-test', 'Bearer sk-media-test']);
    assert.match(body.text, /TRANSCRIPT:/);
    assert.match(body.text, /TRANSLATION:/);
    assert.match(body.transcript, /spoken line 1/);
    assert.match(body.transcript, /spoken line 2/);
    assert.match(body.translation, /translated line 1/);
    assert.match(body.translation, /translated line 2/);
    assert.equal(body.target_language, 'Japanese');

    for (const modelRequest of modelRequests) {
      const content = modelRequest.messages[0].content;
      const audioBlock = content.find((block) => block.type === 'input_audio');
      assert.ok(audioBlock?.input_audio?.data, 'each chunk must contain base64 audio');
      assert.equal(audioBlock?.input_audio?.format, 'mp3');
      assert.ok(Buffer.from(audioBlock!.input_audio!.data, 'base64').length > 0);
      const textBlock = content.find((block) => block.type === 'text');
      assert.match(textBlock?.text || '', /Transcribe this recording and translate it into Japanese\./);
      assert.equal(modelRequest.model, 'gemini-3.5-flash-lite');
      assert.equal(modelRequest.temperature, 0);
    }
  },
);

test(
  'retries when the model returns a tool-call failure string',
  { skip: !hasFfmpeg },
  async () => {
    modelRequests.length = 0;
    modelAuthHeaders.length = 0;
    failNextModelRequest = true;

    const form = new FormData();
    form.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'retry.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('task', 'transcribe');
    form.append('prompt', 'Transcribe this clip.');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(modelRequests.length, 2, 'the failure text must trigger one retry');
    assert.match(body.text, /spoken line 2/);
    assert.doesNotMatch(body.text, /could not complete a tool call/);
    failNextModelRequest = false;
  },
);

test(
  'a chunk that hits the output cap fails instead of returning a shortened transcript',
  { skip: !hasFfmpeg },
  async () => {
    modelRequests.length = 0;
    modelAuthHeaders.length = 0;
    nextCustomReply = 'TRANSCRIPT:\npartial line that would be silently short';
    nextFinishReason = 'length';

    const form = new FormData();
    form.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'truncated.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('prompt', 'Transcribe this clip.');
    form.append('max_tokens', '65535');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 502, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.error.code, 'model_output_truncated');
    assert.match(body.error.message, /output cap/);
    assert.equal(modelRequests.length, 1, 'truncation must fail fast, not retry');
    assert.doesNotMatch(rawBody, /partial line/);
    assert.equal(modelRequests[0].max_tokens, 65535);
  },
);

test(
  'prompt-first request returns the raw model answer without task semantics',
  { skip: !hasFfmpeg },
  async () => {
    modelRequests.length = 0;
    modelAuthHeaders.length = 0;
    nextCustomReply = 'BANANA';

    const form = new FormData();
    form.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'prompt-first.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('prompt', 'Answer with the single word BANANA.');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.task, 'custom');
    assert.equal(body.text, 'BANANA');
    assert.equal(body.transcript, undefined);
    assert.equal(body.translation, undefined);
    assert.equal(modelRequests.length, 1);
    const textBlock = modelRequests[0].messages[0].content.find((block) => block.type === 'text');
    assert.equal(textBlock?.text, 'Answer with the single word BANANA.');
  },
);

test(
  'raw audio upload accepts query metadata and returns plain text',
  { skip: !hasFfmpeg },
  async () => {
    modelRequests.length = 0;
    const query = new URLSearchParams({
      model: 'gemini-3.5-flash-lite',
      prompt: 'Return only a short transcript and a Thai translation.',
      task: 'both',
      target_language: 'th',
      response_format: 'text',
    });
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/audio/transcriptions?${query.toString()}`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'audio/wav' }),
        body: makeWav(2),
      },
    );

    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /TRANSCRIPT:/);
    assert.equal(modelRequests.length, 1);
    assert.equal(
      modelRequests[0].messages[0].content[0].text,
      'Return only a short transcript and a Thai translation.',
    );
  },
);

test(
  'JSON base64 upload is accepted for smaller files',
  { skip: !hasFfmpeg },
  async () => {
    modelRequests.length = 0;
    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: 'gemini-3.5-flash-lite',
        audio_base64: makeWav(1).toString('base64'),
        filename: 'clip.wav',
        task: 'translate',
        target_language: 'fr',
      }),
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.task, 'translate');
    assert.equal(body.target_language, 'French');
    assert.equal(body.chunk_count, 1);
    assert.match(body.text, /translated line 1/);
  },
);

test(
  'the OpenAI-style translations route defaults to English',
  { skip: !hasFfmpeg },
  async () => {
    modelRequests.length = 0;
    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/translations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'audio/wav' }),
      body: makeWav(1),
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.task, 'translate');
    assert.equal(body.target_language, 'English');
    assert.match(body.text, /translated line 1/);
  },
);

test('a multipart request without a file returns a clear 400', async () => {
  const form = new FormData();
  form.append('prompt', 'No file here');
  const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  assert.equal(response.status, 400);
  const body: any = await response.json();
  assert.equal(body.error.code, 'file_required');
});

test('dubbing output caps follow the duration table', () => {
  assert.equal(dubbingMaxOutputTokens(30), 8192);
  assert.equal(dubbingMaxOutputTokens(55), 8192);
  assert.equal(dubbingMaxOutputTokens(56), 8192);
  assert.equal(dubbingMaxOutputTokens(120), 8192);
  assert.equal(dubbingMaxOutputTokens(121), 16384);
  assert.equal(dubbingMaxOutputTokens(240), 16384);
  assert.equal(dubbingMaxOutputTokens(241), 24576);
  assert.equal(dubbingMaxOutputTokens(300), 24576);
  assert.equal(dubbingMaxOutputTokens(301), 40960);
  assert.equal(dubbingMaxOutputTokens(600), 40960);
  assert.equal(dubbingMaxOutputTokens(601), 65535);
  assert.equal(dubbingMaxOutputTokens(1800), 65535);
});

test('dubbing timestamps parse and format on the MM:SS.S contract', () => {
  assert.equal(parseDubbingTimestamp('01:02.5'), 62.5);
  assert.equal(parseDubbingTimestamp('1:02:03.4'), 3723.4);
  assert.equal(parseDubbingTimestamp('12.5'), 12.5);
  assert.equal(parseDubbingTimestamp(7), 7);
  assert.equal(parseDubbingTimestamp('nope'), undefined);
  assert.equal(parseDubbingTimestamp(''), undefined);
  assert.equal(formatDubbingTimestamp(62.5), '01:02.5');
  assert.equal(formatDubbingTimestamp(5), '00:05.0');
  assert.equal(formatDubbingTimestamp(3723.4), '62:03.4');
});

test('dubbing JSON parser recovers arrays from fences and wrapper objects', () => {
  const fenced = parseDubbingPayload('```json\n[{"khmer_dubbing":"សួស្តី"}]\n```');
  assert.equal(fenced?.length, 1);
  assert.equal(fenced?.[0].khmer_dubbing, 'សួស្តី');

  const wrapped = parseDubbingPayload('Here you go: {"segments":[{"khmer_dubbing":"បាទ"}]}');
  assert.equal(wrapped?.length, 1);
  assert.equal(wrapped?.[0].khmer_dubbing, 'បាទ');

  const commentary = parseDubbingPayload('The audio contains one line.\n[{"khmer_dubbing":"ចាស"}]\nDone.');
  assert.equal(commentary?.length, 1);

  const single = parseDubbingPayload('{"khmer_dubbing":"បាទ"}');
  assert.equal(single?.length, 1);

  assert.equal(parseDubbingPayload('not json'), null);
});

test('dubbing segments are clamped, defaulted and shifted to absolute time', () => {
  const shifted = normalizeDubbingSegment(
    {
      start: '00:01.0',
      end: '00:04.0',
      speaker_gender: '女',
      pitch: '高',
      vocal_timbre: 'bright',
      character_role: '小梨',
      original_transcript: '你来了',
      khmer_dubbing: 'អ្នកមកហើយ ចាស',
    },
    { startSeconds: 60, endSeconds: 120 },
    0,
  );
  assert.ok(shifted);
  assert.equal(shifted.start, '01:01.0');
  assert.equal(shifted.end, '01:04.0');
  assert.equal(shifted.startSeconds, 61);
  assert.equal(shifted.endSeconds, 64);
  assert.equal(shifted.speaker_gender, 'female');
  assert.equal(shifted.pitch, 'high');

  const clamped = normalizeDubbingSegment(
    { start: '00:50.0', end: '00:70.0', khmer_dubbing: 'បាទ' },
    { startSeconds: 0, endSeconds: 60 },
  );
  assert.ok(clamped);
  assert.equal(clamped.end, '01:00.0');
  assert.equal(clamped.speaker_gender, 'male');
  assert.equal(clamped.pitch, 'low');

  const inferredFemale = normalizeDubbingSegment(
    { start: '00:00.0', end: '00:01.0', khmer_dubbing: 'ចាស ខ្ញុំទៅហើយ' },
    { startSeconds: 0, endSeconds: 10 },
  );
  assert.equal(inferredFemale?.speaker_gender, 'female');

  assert.equal(
    normalizeDubbingSegment(
      { start: '00:00.0', end: '00:01.0' },
      { startSeconds: 0, endSeconds: 10 },
    ),
    undefined,
    'a segment without a Khmer line must be dropped',
  );
});

test('dubbing prompt keeps the caller prompt, contract and chunk context', () => {
  const prompt = buildDubbingPrompt({
    prompt: 'Custom dubbing rules.',
    index: 1,
    count: 2,
    previousSegments: [
      { original_transcript: '你好', khmer_dubbing: 'សួស្តី', character_role: 'sister' },
    ],
  });
  assert.match(prompt, /Custom dubbing rules\./);
  assert.match(prompt, /OUTPUT CONTRACT/);
  assert.match(prompt, /part 2 of 2/);
  assert.match(prompt, /សួស្តី/);
  assert.match(prompt, /do not repeat these lines/i);
  assert.match(prompt, /MM:SS\.S/);
});

test(
  'dubbing route chunks audio, applies token caps and offsets timestamps',
  { skip: !hasFfmpeg },
  async () => {
    geminiRequests.length = 0;
    modelRequests.length = 0;
    modelAuthHeaders.length = 0;

    const form = new FormData();
    form.append('file', new Blob([makeWav(65)], { type: 'audio/wav' }), 'dubbing.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('chunk_seconds', '60');
    form.append('source_language', 'zh');
    form.append('target_language', 'km');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/dubbing`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);

    assert.equal(body.object, 'audio.dubbing');
    assert.equal(body.chunk_count, 2, 'a 65-second recording must be split at 60 seconds');
    assert.equal(body.segment_count, 2);
    assert.equal(body.source_language, 'Chinese');
    assert.equal(body.target_language, 'Khmer');
    assert.equal(body.chunks[0].max_output_tokens, 8192);
    assert.equal(body.chunks[1].max_output_tokens, 8192);
    assert.equal(body.usage.totalTokens, 400);
    assert.equal(modelRequests.length, 0, 'dubbing must use generateContent, not chat completions');
    assert.equal(geminiRequests.length, 2, 'one generateContent request per chunk');

    for (const geminiRequest of geminiRequests) {
      assert.equal(geminiRequest.generationConfig.maxOutputTokens, 8192);
      assert.equal(geminiRequest.generationConfig.responseMimeType, 'application/json');
      assert.equal(geminiRequest.generationConfig.responseSchema?.type, 'ARRAY');
      const parts = geminiRequest.contents[0].parts;
      assert.match(parts[0].text || '', /OUTPUT CONTRACT/);
      assert.equal(parts[1].inline_data?.mime_type, 'audio/mp3');
      assert.ok(Buffer.from(parts[1].inline_data!.data, 'base64').length > 0);
    }

    const first = body.segments[0];
    const second = body.segments[1];
    assert.deepEqual(
      Object.keys(first).sort(),
      [
        'character_role',
        'end',
        'khmer_dubbing',
        'original_transcript',
        'pitch',
        'speaker_gender',
        'start',
        'vocal_timbre',
      ].sort(),
    );
    assert.equal(first.start, '00:01.0');
    assert.equal(first.end, '00:04.5');
    assert.equal(first.speaker_gender, 'female');
    assert.equal(first.pitch, 'high');
    assert.equal(first.character_role, 'younger sister');
    assert.match(first.khmer_dubbing, /ប្អូនស្រី/);

    const secondStart = parseDubbingTimestamp(second.start);
    const secondEnd = parseDubbingTimestamp(second.end);
    assert.ok(secondStart !== undefined && secondStart >= 59, `second segment must be offset, got ${second.start}`);
    assert.ok(secondStart !== undefined && secondStart < 62, `second segment offset is too large: ${second.start}`);
    assert.ok(secondEnd !== undefined && secondStart !== undefined && secondEnd > secondStart);
  },
);

test(
  'dubbing array format returns bare segments and retries without a rejected schema',
  { skip: !hasFfmpeg },
  async () => {
    geminiRequests.length = 0;
    failNextDubbingSchema = true;

    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/audio/dubbing?model=gemini-3.5-flash-lite&response_format=array`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'audio/wav' }),
        body: makeWav(2),
      },
    );

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.ok(Array.isArray(body), 'response_format=array must return only the segment array');
    assert.equal(body.length, 1);
    assert.match(body[0].khmer_dubbing, /ប្អូនស្រី/);
    assert.equal(body[0].speaker_gender, 'female');

    assert.equal(geminiRequests.length, 2, 'the schema rejection must trigger one fallback retry');
    assert.ok(geminiRequests[0].generationConfig.responseSchema);
    assert.equal(geminiRequests[1].generationConfig.responseSchema, undefined);
    assert.equal(geminiRequests[1].generationConfig.maxOutputTokens, 8192);
  },
);

test('dubbing requires an API key', async () => {
  const before = geminiRequests.length;
  const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/dubbing`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: makeWav(1),
  });
  assert.equal(response.status, 401);
  assert.equal(geminiRequests.length, before);
});
