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
  DUBBING_COMPLETENESS_RETRY_PROMPT,
  DUBBING_CUE_RETRY_PROMPT,
  DUBBING_MAX_CUE_SECONDS,
  DUBBING_MAX_KHMER_CHARS,
  buildChunkPrompt,
  buildDubbingPrompt,
  buildDubbingResponse,
  defaultDubbingConcurrency,
  dubbingChunkSecondsForModel,
  dubbingCoverageVerdict,
  dubbingCoveredSeconds,
  dubbingMaxOutputTokens,
  dubbingSpeechSecondsFromSilences,
  enforceDubbingCueCeilings,
  estimatedDubbingMs,
  formatDubbingTimestamp,
  geminiResponseAnswer,
  isKhmerDubLine,
  isModelFailureText,
  isLiteDubbingModel,
  isReasoningDubbingModel,
  languageLabel,
  normalizeDubbingSegment,
  parseDubbingPayload,
  parseDubbingTimestamp,
  describeMediaTimeoutRisk,
  readMediaConfig,
  splitStructuredOutput,
  usesShortDubbingWindow,
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

/** Scripted generateContent answers, consumed in order before the default reply. */
interface ScriptedDubbingReply {
  text?: string;
  parts?: Array<Record<string, unknown>>;
}
const scriptedDubbingReplies: ScriptedDubbingReply[] = [];

function defaultDubbingReply(index: number): string {
  // Timestamps are intentionally chunk-local; the bridge must add the offset.
  const start = index === 1 ? '00:01.0' : '00:00.5';
  const end = index === 1 ? '00:04.5' : '00:03.0';
  // The dub line must be pure Khmer script, so the chunk number uses Khmer digits.
  const khmerIndex = '០១២៣៤៥៦៧៨៩'[index % 10];
  return JSON.stringify([
    {
      start,
      end,
      speaker_gender: 'female',
      vocal_timbre: 'young and bright',
      character_role: 'younger sister',
      original_transcript: `小梨说第 ${index} 段`,
      khmer_dubbing: `ប្អូនស្រីនិយាយភាគទី ${khmerIndex} ចាស`,
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

      const scripted = scriptedDubbingReplies.shift();
      const content = scripted?.text ?? nextDubbingReply ?? defaultDubbingReply(index);
      const parts = scripted?.parts ?? [{ text: content }];
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
              content: { role: 'model', parts },
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

/** Valid PCM WAV with a steady tone, so `silencedetect` measures real speech. */
function makeToneWav(seconds: number, frequency = 440, amplitude = 0.25): Buffer {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const samples = Math.floor(seconds * sampleRate);
  const dataSize = samples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let sample = 0; sample < samples; sample++) {
    const value = Math.sin((2 * Math.PI * frequency * sample) / sampleRate) * amplitude;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + sample * 2);
  }
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

test('media chunks default to 15 minutes with a 1-hour maximum', () => {
  const oldChunk = process.env.MEDIA_CHUNK_SECONDS;
  const oldMax = process.env.MEDIA_MAX_DURATION_SECONDS;
  const oldTotal = process.env.MEDIA_TOTAL_TIMEOUT_MS;
  delete process.env.MEDIA_CHUNK_SECONDS;
  delete process.env.MEDIA_MAX_DURATION_SECONDS;
  delete process.env.MEDIA_TOTAL_TIMEOUT_MS;
  try {
    const config = readMediaConfig();
    assert.equal(config.maxDurationSeconds, 3600);
    assert.equal(config.chunkSeconds, 900);
    // The whole-request deadline must outlive the media it accepts, otherwise a
    // valid 1-hour upload is aborted by the timer before it can finish.
    assert.ok(
      config.totalTimeoutMs > config.maxDurationSeconds * 1000,
      `total timeout ${config.totalTimeoutMs}ms must exceed ${config.maxDurationSeconds}s of media`,
    );
    assert.equal(describeMediaTimeoutRisk(config), null);
  } finally {
    if (oldChunk === undefined) delete process.env.MEDIA_CHUNK_SECONDS;
    else process.env.MEDIA_CHUNK_SECONDS = oldChunk;
    if (oldMax === undefined) delete process.env.MEDIA_MAX_DURATION_SECONDS;
    else process.env.MEDIA_MAX_DURATION_SECONDS = oldMax;
    if (oldTotal === undefined) delete process.env.MEDIA_TOTAL_TIMEOUT_MS;
    else process.env.MEDIA_TOTAL_TIMEOUT_MS = oldTotal;
  }
});

test('a total deadline shorter than the accepted duration is reported', () => {
  const oldMax = process.env.MEDIA_MAX_DURATION_SECONDS;
  const oldTotal = process.env.MEDIA_TOTAL_TIMEOUT_MS;
  process.env.MEDIA_MAX_DURATION_SECONDS = '3600';
  process.env.MEDIA_TOTAL_TIMEOUT_MS = String(30 * 60 * 1000);
  try {
    const config = readMediaConfig();
    assert.equal(config.maxDurationSeconds, 3600);
    const risk = describeMediaTimeoutRisk(config);
    assert.ok(risk, 'a 30-minute deadline for 1-hour media must be reported');
    assert.match(risk, /MEDIA_TOTAL_TIMEOUT_MS/);
    assert.match(risk, /MEDIA_MAX_DURATION_SECONDS/);
  } finally {
    if (oldMax === undefined) delete process.env.MEDIA_MAX_DURATION_SECONDS;
    else process.env.MEDIA_MAX_DURATION_SECONDS = oldMax;
    if (oldTotal === undefined) delete process.env.MEDIA_TOTAL_TIMEOUT_MS;
    else process.env.MEDIA_TOTAL_TIMEOUT_MS = oldTotal;
  }
});

test('a disabled total deadline is never reported as a risk', () => {
  const oldTotal = process.env.MEDIA_TOTAL_TIMEOUT_MS;
  process.env.MEDIA_TOTAL_TIMEOUT_MS = '0';
  try {
    const config = readMediaConfig();
    assert.equal(config.totalTimeoutMs, 0);
    assert.equal(describeMediaTimeoutRisk(config), null);
  } finally {
    if (oldTotal === undefined) delete process.env.MEDIA_TOTAL_TIMEOUT_MS;
    else process.env.MEDIA_TOTAL_TIMEOUT_MS = oldTotal;
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

test('dubbing reasoning models get a token floor and a 120-second chunk window', () => {
  assert.equal(isReasoningDubbingModel('gemini-3.8-flash-high'), true);
  assert.equal(isReasoningDubbingModel('gemini-3.8-flash-low'), true);
  assert.equal(isReasoningDubbingModel('gemini-3.5-pro'), true);
  assert.equal(isReasoningDubbingModel('gemini-3.5-flash-lite'), false);

  // Lite needs the same short window, but it is not a reasoning model.
  assert.equal(isLiteDubbingModel('gemini-3.5-flash-lite'), true);
  assert.equal(isLiteDubbingModel('gemini-3.6-flash'), false);
  assert.equal(usesShortDubbingWindow('gemini-3.5-flash-lite'), true);
  assert.equal(usesShortDubbingWindow('gemini-3.1-flash-lite'), true);
  assert.equal(usesShortDubbingWindow('gemini-3.6-flash'), false);
  assert.equal(usesShortDubbingWindow('gemini-3.8-flash-high'), true);

  assert.equal(dubbingMaxOutputTokens(120, 'gemini-3.8-flash-high'), 40960);
  assert.equal(dubbingMaxOutputTokens(300, 'gemini-3.8-flash-high'), 40960);
  assert.equal(dubbingMaxOutputTokens(601, 'gemini-3.8-flash-high'), 65535);
  assert.equal(dubbingMaxOutputTokens(300, 'gemini-3.5-flash-lite'), 40960);
  assert.equal(dubbingMaxOutputTokens(60, 'gemini-3.5-flash-lite'), 40960);
  assert.equal(dubbingMaxOutputTokens(60, 'gemini-3.6-flash'), 8192);

  assert.equal(dubbingChunkSecondsForModel('gemini-3.8-flash-high', 300), 120);
  // Lite stops at the end of the first script pass, so it gets 60 s windows.
  assert.equal(dubbingChunkSecondsForModel('gemini-3.5-flash-lite', 300), 60);
  assert.equal(dubbingChunkSecondsForModel('gemini-3.5-flash-lite', 1800), 60);
  assert.equal(dubbingChunkSecondsForModel('gemini-3.5-flash-lite', 180), 60);
  assert.equal(dubbingChunkSecondsForModel('gemini-3.5-flash-lite', 90), 60);
  assert.equal(dubbingChunkSecondsForModel('gemini-3.5-flash-lite', 10), 60);
  assert.equal(dubbingChunkSecondsForModel('gemini-3.6-flash', 1800), 1800);
});

test('short-window models default to one dubbing worker per chunk', () => {
  // A serial 300 s reasoning request spent > 1200 s in the pool; three parallel
  // 120 s chunks answered in 575 s.
  assert.equal(defaultDubbingConcurrency('gemini-3.8-flash-high', 3), 3);
  assert.equal(defaultDubbingConcurrency('gemini-3.8-flash-high', 1), 1);
  assert.equal(defaultDubbingConcurrency('gemini-3.8-flash-high', 9), 4, 'the pool caps at 4 workers');
  assert.equal(defaultDubbingConcurrency('gemini-3.5-flash-lite', 5), 4);
  assert.equal(defaultDubbingConcurrency('gemini-3.5-flash-lite', 2), 2);
  // Long-window models keep the historical single worker below 900 s windows.
  assert.equal(defaultDubbingConcurrency('gemini-3.6-flash', 3), 1);
  assert.equal(defaultDubbingConcurrency('gemini-3.5-flash', 2), 1);
  assert.equal(defaultDubbingConcurrency('gemini-3.8-flash-high', 0), 1);
});

test('dubbing wall-clock estimates follow the measured per-model throughput', () => {
  assert.equal(estimatedDubbingMs(300, 'gemini-3.8-flash-high'), 660000);
  assert.equal(estimatedDubbingMs(120, 'gemini-3.8-flash-high'), 264000);
  assert.equal(estimatedDubbingMs(300, 'gemini-3.5-flash-lite'), 90000);
  assert.equal(estimatedDubbingMs(300, 'gemini-3.6-flash'), 300000);
  assert.equal(estimatedDubbingMs(0, 'gemini-3.8-flash-high'), 0);
  assert.equal(estimatedDubbingMs(Number.NaN, 'gemini-3.5-flash-lite'), 0);
  assert.equal(estimatedDubbingMs(-15, 'gemini-3.5-flash-lite'), 0);
});

test('gemini answer extraction excludes thought parts and counts them', () => {
  const thought =
    'I should return a list.\nExample draft:\n[{"khmer_dubbing":"បាទ"}]\nNow I will answer.';
  const answer = geminiResponseAnswer({
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: thought },
            { text: '[{"khmer_dubbing":"ចាស"},{"khmer_dubbing":"បាទ"}]' },
            { thoughtSignature: 'sig', text: '' },
          ],
        },
      },
    ],
  });
  assert.equal(answer.text, '[{"khmer_dubbing":"ចាស"},{"khmer_dubbing":"បាទ"}]');
  assert.equal(answer.thoughtCharacters, thought.length);

  const thoughtOnly = geminiResponseAnswer({
    candidates: [{ content: { parts: [{ thought: true, text: 'still thinking' }] } }],
  });
  assert.equal(thoughtOnly.text, '');
  assert.equal(thoughtOnly.thoughtCharacters, 'still thinking'.length);

  const chatShape = geminiResponseAnswer({
    choices: [{ message: { content: 'plain answer' } }],
  });
  assert.equal(chatShape.text, 'plain answer');
});

test('dubbing JSON parser prefers the last complete script over an example', () => {
  const parsed = parseDubbingPayload(
    'Example: [{"khmer_dubbing":"បាទ"}]\n' +
      'Script: [{"khmer_dubbing":"ចាស"},{"khmer_dubbing":"បាទ"},{"khmer_dubbing":"សួស្តី"}]',
  );
  assert.equal(parsed?.length, 3);
  assert.equal(parsed?.[2].khmer_dubbing, 'សួស្តី');
});

test('dubbing coverage maths unions intervals and measures silence', () => {
  assert.equal(
    dubbingCoveredSeconds(
      [
        { startSeconds: 0, endSeconds: 5 },
        { startSeconds: 3, endSeconds: 8 },
      ],
      0,
      10,
    ),
    8,
  );
  assert.equal(
    dubbingCoveredSeconds(
      [
        { startSeconds: -5, endSeconds: 2 },
        { startSeconds: 9, endSeconds: 20 },
      ],
      0,
      10,
    ),
    3,
  );
  assert.equal(dubbingCoveredSeconds([], 0, 10), 0);

  assert.equal(
    dubbingSpeechSecondsFromSilences(10, 'silence_start: 0\nsilence_end: 2.5\n'),
    7.5,
  );
  assert.equal(dubbingSpeechSecondsFromSilences(10, 'silence_start: 8\n'), 8);
  assert.equal(dubbingSpeechSecondsFromSilences(10, ''), 10);
  assert.equal(dubbingSpeechSecondsFromSilences(0, 'silence_start: 0\n'), 0);
  assert.equal(
    dubbingSpeechSecondsFromSilences(3, 'silence_start: 0\nsilence_end: 99\n'),
    0,
  );
});

test('dubbing coverage verdict rejects empty, single and low-coverage scripts', () => {
  const good = dubbingCoverageVerdict({
    segmentCount: 4,
    coveredSeconds: 40,
    speechSeconds: 50,
    durationSeconds: 60,
  });
  assert.equal(good.ok, true);
  assert.equal(good.ratio, 0.8);

  assert.equal(
    dubbingCoverageVerdict({
      segmentCount: 0,
      coveredSeconds: 0,
      speechSeconds: 50,
      durationSeconds: 60,
    }).reason,
    'empty_script',
  );
  assert.equal(
    dubbingCoverageVerdict({
      segmentCount: 1,
      coveredSeconds: 2,
      speechSeconds: 50,
      durationSeconds: 60,
    }).reason,
    'single_segment',
  );
  assert.equal(
    dubbingCoverageVerdict({
      segmentCount: 2,
      coveredSeconds: 10,
      speechSeconds: 50,
      durationSeconds: 60,
    }).reason,
    'low_coverage',
  );

  // A silent chunk and an unmeasurable chunk must not be rejected.
  assert.equal(
    dubbingCoverageVerdict({
      segmentCount: 0,
      coveredSeconds: 0,
      speechSeconds: 1,
      durationSeconds: 60,
    }).ok,
    true,
  );
  assert.equal(
    dubbingCoverageVerdict({ segmentCount: 0, coveredSeconds: 0, durationSeconds: 60 }).ok,
    true,
  );
});

test('dubbing coverage verdict requires most of the audible speech', () => {
  // 0.35 was the old bar, and it let a script lose a third of the dialogue.
  assert.equal(
    dubbingCoverageVerdict({
      segmentCount: 4,
      coveredSeconds: 30,
      speechSeconds: 45,
      durationSeconds: 60,
    }).ok,
    false,
  );
  assert.equal(
    dubbingCoverageVerdict({
      segmentCount: 4,
      coveredSeconds: 40,
      speechSeconds: 45,
      durationSeconds: 60,
    }).ok,
    true,
  );
});

test('a chunk with no detected silence does not fail on the coverage ratio', () => {
  // Production case: a 60 s chunk with a continuous music bed and 25 s of
  // dialogue. silencedetect finds no silence, so ratio alone reads 41%.
  const musicBed = dubbingCoverageVerdict({
    segmentCount: 6,
    coveredSeconds: 25,
    speechSeconds: 60.01,
    durationSeconds: 60.01,
  });
  assert.equal(musicBed.ok, true, 'a music bed must not be counted as missing dialogue');
  assert.equal(musicBed.speechReliable, false);

  // Gross under-transcription is still caught, against the chunk duration.
  const nearlyEmpty = dubbingCoverageVerdict({
    segmentCount: 2,
    coveredSeconds: 3,
    speechSeconds: 60.01,
    durationSeconds: 60.01,
  });
  assert.equal(nearlyEmpty.ok, false);
  assert.equal(nearlyEmpty.reason, 'low_coverage');

  // When real silences were found, the ratio is still enforced.
  const measured = dubbingCoverageVerdict({
    segmentCount: 6,
    coveredSeconds: 15,
    speechSeconds: 31,
    durationSeconds: 60,
  });
  assert.equal(measured.ok, false);
  assert.equal(measured.reason, 'low_coverage');
  assert.notEqual(measured.speechReliable, false);
});

test('a dub line is rejected unless it is pure Khmer script', () => {
  assert.equal(isKhmerDubLine('សួស្តី លោកម្ចាស់។'), true);
  assert.equal(isKhmerDubLine('កុំកម្រើក !'), true);
  assert.equal(isKhmerDubLine(''), false);
  assert.equal(isKhmerDubLine('   '), false);
  assert.equal(isKhmerDubLine('sister_line'), false, 'a Latin line must not reach the synthesizer');
  assert.equal(isKhmerDubLine('ចាស OK'), false, 'Latin inside a Khmer line is rejected too');
  assert.equal(
    isKhmerDubLine('万恶毒体ចាស'),
    false,
    'untranslated Chinese source text must not be dubbed',
  );
  assert.equal(isKhmerDubLine('បីថ្ងៃ 3'), false, 'numbers must be spelled out in Khmer');
});

test('cues over the TTS ceiling are split without moving the timeline', () => {
  const segment = normalizeDubbingSegment(
    {
      start: '00:00.0',
      end: '00:10.0',
      speaker_gender: 'male',
      character_role: 'boss',
      original_transcript: 'a long line',
      khmer_dubbing: 'មួយ ពីរ បី បួន ប្រាំ ប្រាំមួយ',
    },
    { startSeconds: 0, endSeconds: 12 },
  );
  assert.ok(segment);

  const { segments, violations } = enforceDubbingCueCeilings([segment]);
  assert.deepEqual(violations, []);
  assert.equal(segments.length, 3, 'a 10-second cue becomes three ceiling-sized cues');
  assert.equal(segments[0].start, '00:00.0');
  assert.equal(segments[2].end, '00:10.0', 'the parent window must not move');
  for (const cue of segments) {
    assert.ok(
      cue.endSeconds - cue.startSeconds <= DUBBING_MAX_CUE_SECONDS + 0.001,
      `cue ${cue.start} is too long`,
    );
  }
  assert.equal(
    segments.map((cue) => cue.khmer_dubbing).join(' '),
    'មួយ ពីរ បី បួន ប្រាំ ប្រាំមួយ',
    'splitting must not drop or duplicate words',
  );
  assert.equal(
    new Set(segments.map((cue) => cue.speaker_id)).size,
    1,
    'the speaker must stay the same across the split',
  );
});

test('a cue over the character ceiling is split instead of rejected', () => {
  const dense = normalizeDubbingSegment(
    {
      start: '00:00.0',
      end: '00:02.0',
      khmer_dubbing: 'ក'.repeat(DUBBING_MAX_KHMER_CHARS + 1),
    },
    { startSeconds: 0, endSeconds: 2 },
  );
  assert.ok(dense);
  const result = enforceDubbingCueCeilings([dense]);
  assert.deepEqual(result.violations, [], 'a dense cue must be repaired, not failed');
  assert.ok(result.segments.length >= 2, 'the cue must be cut into ceiling-sized pieces');
  assert.equal(
    result.segments.map((cue) => cue.khmer_dubbing).join(''),
    'ក'.repeat(DUBBING_MAX_KHMER_CHARS + 1),
    'splitting must not drop characters',
  );
  for (const cue of result.segments) {
    assert.ok(
      [...cue.khmer_dubbing].length <= DUBBING_MAX_KHMER_CHARS,
      `cue ${cue.start} still exceeds the character ceiling`,
    );
  }

  const latin = normalizeDubbingSegment(
    { start: '00:00.0', end: '00:01.0', khmer_dubbing: 'sister_line' },
    { startSeconds: 0, endSeconds: 5 },
  );
  assert.ok(latin);
  assert.match(enforceDubbingCueCeilings([latin]).violations[0], /not pure Khmer/);

  // A single character cannot be divided into three cues, so the 12-second
  // window is reported instead of pretending the split worked.
  const unsplittable = normalizeDubbingSegment(
    { start: '00:00.0', end: '00:12.0', khmer_dubbing: 'ក' },
    { startSeconds: 0, endSeconds: 20 },
  );
  assert.ok(unsplittable);
  const durationResult = enforceDubbingCueCeilings([unsplittable]);
  assert.equal(durationResult.violations.length, 1);
  assert.match(durationResult.violations[0], /long/);
});

test('split timing follows text length, not equal steps', () => {
  // A phrase boundary near the balance point makes the pieces uneven: 20 vs 39
  // graphemes. Equal time would hand each half 3 s; proportional gives the short
  // phrase about 2 s.
  const text = `${'ក'.repeat(20)} ${'ខ'.repeat(39)}`;
  const segment = normalizeDubbingSegment(
    { start: '00:00.0', end: '00:06.0', khmer_dubbing: text },
    { startSeconds: 0, endSeconds: 6 },
  );
  assert.ok(segment);
  const { segments, violations } = enforceDubbingCueCeilings([segment]);
  assert.deepEqual(violations, []);
  assert.equal(segments.length, 2);
  assert.ok(
    segments[0].endSeconds < 2.5,
    `the short fragment must not receive half the window (got ${segments[0].endSeconds}s)`,
  );
  assert.equal(segments[1].endSeconds, 6, 'the parent window must not move');
});

test('splitting never breaks a Khmer grapheme cluster', () => {
  const cluster = 'ស្ត្រី'; // base + coeng + subscript + vowel
  const text = Array.from({ length: 40 }, () => cluster).join(' ');
  const segment = normalizeDubbingSegment(
    { start: '00:00.0', end: '00:08.0', khmer_dubbing: text },
    { startSeconds: 0, endSeconds: 8 },
  );
  assert.ok(segment);
  const { segments, violations } = enforceDubbingCueCeilings([segment]);
  assert.deepEqual(violations, []);
  assert.ok(segments.length >= 2);
  for (const cue of segments) {
    assert.ok(
      !cue.khmer_dubbing.endsWith('\u17D2'),
      `cue ends on a dangling coeng: ${JSON.stringify(cue.khmer_dubbing)}`,
    );
    assert.ok(
      !/^[\u17B4-\u17D3]/.test(cue.khmer_dubbing),
      `cue starts with a combining mark: ${JSON.stringify(cue.khmer_dubbing)}`,
    );
  }
  assert.equal(
    segments.map((cue) => cue.khmer_dubbing).join(' ').replace(/\s+/g, ''),
    text.replace(/\s+/g, ''),
    'no grapheme may be lost',
  );
});

test('the cue retry prompt restates the ceilings that failed', () => {
  assert.match(DUBBING_CUE_RETRY_PROMPT, /4\.0 seconds/);
  assert.match(DUBBING_CUE_RETRY_PROMPT, /70 Khmer characters/);
  assert.match(DUBBING_CUE_RETRY_PROMPT, /Khmer script/);
  assert.match(DUBBING_COMPLETENESS_RETRY_PROMPT, /INCOMPLETE ANSWER/);
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

  const clamped = normalizeDubbingSegment(
    { start: '00:50.0', end: '00:70.0', khmer_dubbing: 'បាទ' },
    { startSeconds: 0, endSeconds: 60 },
  );
  assert.ok(clamped);
  assert.equal(clamped.end, '01:00.0');
  assert.equal(clamped.speaker_gender, 'male');

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

test('dubbing response exposes stable speaker_id and numeric timings', () => {
  const segment = normalizeDubbingSegment(
    {
      start: '00:01.0',
      end: '00:04.0',
      speaker_gender: 'female',
      vocal_timbre: 'bright',
      character_role: 'Sister',
      original_transcript: 'hello',
      khmer_dubbing: 'sister_line',
    },
    { startSeconds: 0, endSeconds: 60 },
  );
  assert.ok(segment);
  assert.equal(segment.speaker_id, 'sister');

  const response = buildDubbingResponse({
    options: {
      model: 'gemini-3.5-flash-lite',
      sourceLanguage: 'zh',
      targetLanguage: 'km',
      chunkSeconds: 60,
      temperature: 0,
      concurrency: 1,
      concurrencyExplicit: true,
      responseFormat: 'json',
    } as any,
    chunks: [
      { index: 0, filePath: 'x', startSeconds: 0, endSeconds: 60, durationSeconds: 60, sizeBytes: 1 },
    ] as any,
    results: [
      {
        index: 0,
        startSeconds: 0,
        endSeconds: 60,
        segments: [segment],
        droppedSegments: 0,
        content: '',
        model: 'gemini-3.5-flash-lite',
        maxOutputTokens: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        coveredSeconds: 3,
      },
    ] as any,
    durationSeconds: 60,
    timings: { transcodeMs: 0, modelMs: 0, totalMs: 0 },
  });

  const output = response.segments[0];
  assert.equal(output.speaker_id, 'sister');
  assert.equal(output.start_seconds, 1);
  assert.equal(output.end_seconds, 4);
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
  assert.match(prompt, /If speech is present, return every utterance/);
  assert.match(prompt, /single segment for a clip that contains a conversation, is an error/);
  assert.match(DUBBING_COMPLETENESS_RETRY_PROMPT, /RETRY - INCOMPLETE ANSWER/);
  assert.match(DUBBING_COMPLETENESS_RETRY_PROMPT, /Do not summarize and do not stop early/);
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
    form.append('concurrency', '1');
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
    assert.equal(body.concurrency, 1, 'an explicit concurrency must be kept');
    assert.equal(body.segment_count, 2);
    assert.equal(body.source_language, 'Chinese');
    assert.equal(body.target_language, 'Khmer');
    assert.equal(body.chunks[0].max_output_tokens, 40960);
    assert.equal(body.chunks[1].max_output_tokens, 40960);
    assert.equal(body.usage.totalTokens, 400);
    assert.equal(modelRequests.length, 0, 'dubbing must use generateContent, not chat completions');
    assert.equal(geminiRequests.length, 2, 'one generateContent request per chunk');

    for (const geminiRequest of geminiRequests) {
      assert.equal(geminiRequest.generationConfig.maxOutputTokens, 40960);
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
        'end_seconds',
        'khmer_dubbing',
        'original_transcript',
        'speaker_gender',
        'speaker_id',
        'start',
        'start_seconds',
        'vocal_timbre',
      ].sort(),
    );
    assert.equal(first.start, '00:01.0');
    assert.equal(first.end, '00:04.5');
    assert.equal(first.speaker_gender, 'female');
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
  'dubbing caps gemini-3.5-flash-lite at 60-second chunks and keeps its token floor',
  { skip: !hasFfmpeg },
  async () => {
    geminiRequests.length = 0;

    const form = new FormData();
    form.append('file', new Blob([makeWav(130)], { type: 'audio/wav' }), 'lite-window.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('chunk_seconds', '300');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/dubbing`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.model, 'gemini-3.5-flash-lite');
    assert.equal(body.chunk_seconds, 60, 'lite must not be left with a 300-second window');
    assert.equal(body.chunk_count, 3, 'a 130-second recording splits into 60 s + 60 s + 10 s');
    assert.equal(
      body.concurrency,
      3,
      'short-window models default to one worker per chunk (max 4)',
    );
    assert.ok(body.timings.estimated_ms > 0, 'timings must carry a planning estimate');
    assert.equal(body.timings.estimated_ms, 39000, '130 s lite at 0.3x audio duration');
    assert.ok(body.chunks[0].end_seconds <= 61, JSON.stringify(body.chunks[0]));
    assert.equal(body.chunks[0].max_output_tokens, 40960);
    assert.equal(body.chunks[2].max_output_tokens, 40960);
    assert.equal(geminiRequests.length, 3);
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
    assert.equal(geminiRequests[1].generationConfig.maxOutputTokens, 40960);
  },
);

test(
  'dubbing ignores draft JSON in thought parts and returns the real script',
  { skip: !hasFfmpeg },
  async () => {
    geminiRequests.length = 0;
    scriptedDubbingReplies.length = 0;

    const draft =
      'I will return this shape:\n[{"start":"00:00.0","end":"00:01.0","khmer_dubbing":"បាទ"}]';
    const answer = [
      {
        start: '00:00.0',
        end: '00:00.5',
        speaker_gender: 'female',
        vocal_timbre: 'young',
        character_role: 'younger sister',
        original_transcript: 'answer one',
        khmer_dubbing: 'ចាស មួយ',
      },
      {
        start: '00:00.6',
        end: '00:01.0',
        speaker_gender: 'male',
        vocal_timbre: 'deep',
        character_role: 'brother',
        original_transcript: 'answer two',
        khmer_dubbing: 'បាទ ពីរ',
      },
      {
        start: '00:01.1',
        end: '00:01.8',
        speaker_gender: 'female',
        vocal_timbre: 'young',
        character_role: 'younger sister',
        original_transcript: 'answer three',
        khmer_dubbing: 'ចាស បី',
      },
    ];
    scriptedDubbingReplies.push({
      parts: [{ thought: true, text: draft }, { text: JSON.stringify(answer) }],
    });

    const form = new FormData();
    form.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'thoughts.wav');
    form.append('model', 'gemini-3.8-flash-high');
    form.append('chunk_seconds', '60');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/dubbing`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.segment_count, 3, 'the thought draft must not replace the answer');
    assert.deepEqual(
      body.segments.map((segment: any) => segment.original_transcript),
      ['answer one', 'answer two', 'answer three'],
    );
    assert.equal(body.chunks[0].thought_characters, draft.length);
    assert.equal(
      response.headers.get('x-geminirouter-segments'),
      String(body.segments.length),
    );
    assert.ok(
      geminiRequests[0].contents[0].parts[0].text?.includes('OUTPUT CONTRACT'),
      'the dubbing prompt must still reach the model',
    );
  },
);

test(
  'dubbing retries an implausible script once with the completeness prompt',
  { skip: !hasFfmpeg },
  async () => {
    geminiRequests.length = 0;
    scriptedDubbingReplies.length = 0;

    const shortReply = JSON.stringify([
      {
        start: '00:00.0',
        end: '00:00.2',
        speaker_gender: 'female',
        character_role: 'narrator',
        original_transcript: 'only the first words',
        khmer_dubbing: 'ចាស',
      },
    ]);
    const completeReply = JSON.stringify([
      {
        start: '00:00.0',
        end: '00:02.6',
        speaker_gender: 'female',
        character_role: 'narrator',
        original_transcript: 'the whole conversation',
        khmer_dubbing: 'ចាស ខ្ញុំបានលឺគ្រប់យ៉ាង',
      },
    ]);
    scriptedDubbingReplies.push({ text: shortReply }, { text: completeReply });

    const form = new FormData();
    form.append('file', new Blob([makeToneWav(3)], { type: 'audio/wav' }), 'tone.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('chunk_seconds', '60');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/dubbing`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.segment_count, 1);
    assert.equal(geminiRequests.length, 2, 'one strict retry after the incomplete answer');
    assert.match(
      geminiRequests[1].contents[0].parts[0].text || '',
      /RETRY - INCOMPLETE ANSWER/,
    );
    assert.match(
      geminiRequests[0].contents[0].parts[0].text || '',
      /OUTPUT CONTRACT/,
      'the first attempt must use the normal prompt',
    );
    assert.ok(body.coverage.speech_seconds >= 2, `speech was not measured: ${rawBody}`);
    assert.ok(body.coverage.ratio >= 0.35, `coverage was too low: ${rawBody}`);
    assert.equal(
      response.headers.get('x-geminirouter-segments'),
      String(body.segments.length),
    );
  },
);

test(
  'dubbing fails with a JSON partial_script envelope instead of dropping dialogue',
  { skip: !hasFfmpeg },
  async () => {
    geminiRequests.length = 0;
    scriptedDubbingReplies.length = 0;

    const shortReply = JSON.stringify([
      {
        start: '00:00.0',
        end: '00:00.2',
        speaker_gender: 'male',
        character_role: 'narrator',
        original_transcript: 'only one line',
        khmer_dubbing: 'បាទ',
      },
    ]);
    scriptedDubbingReplies.push({ text: shortReply }, { text: shortReply });

    const form = new FormData();
    form.append('file', new Blob([makeToneWav(3)], { type: 'audio/wav' }), 'tone.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('chunk_seconds', '60');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/dubbing`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 502, rawBody);
    assert.ok(rawBody.length > 0, 'an error response must never be empty');
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.error.code, 'partial_script');
    assert.ok(body.error.message.length > 0);
    assert.equal(body.error.type, 'media_error');
    assert.equal(body.error.details.chunkIndex, 0);
    assert.equal(body.error.details.segmentCount, 1);
    assert.ok(body.error.details.speechSeconds >= 2);
    assert.equal(geminiRequests.length, 2, 'the strict retry runs once, then the request fails');
  },
);

test(
  'dubbing fails when a cue has no Khmer line instead of returning holes',
  { skip: !hasFfmpeg },
  async () => {
    geminiRequests.length = 0;
    scriptedDubbingReplies.length = 0;

    const withEmptyCue = JSON.stringify([
      {
        start: '00:00.0',
        end: '00:01.5',
        speaker_gender: 'male',
        character_role: 'boss',
        original_transcript: '첫 번째 대사',
        khmer_dubbing: 'បាទ មកហើយ',
      },
      {
        start: '00:01.6',
        end: '00:03.0',
        speaker_gender: 'male',
        character_role: 'boss',
        original_transcript: 'second line with no dub',
        khmer_dubbing: '',
      },
    ]);
    scriptedDubbingReplies.push({ text: withEmptyCue }, { text: withEmptyCue });

    const form = new FormData();
    form.append('file', new Blob([makeToneWav(3)], { type: 'audio/wav' }), 'holes.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('chunk_seconds', '60');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/dubbing`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 502, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.error.code, 'partial_script');
    assert.match(body.error.message, /no Khmer dub line/);
    assert.equal(
      body.error.details.droppedSegments,
      1,
      'the cue without a dub line must be reported, not silently removed',
    );
    assert.equal(geminiRequests.length, 2, 'the strict retry runs once, then the request fails');
  },
);

test(
  'dubbing splits an oversized cue before the synthesizer sees it',
  { skip: !hasFfmpeg },
  async () => {
    geminiRequests.length = 0;
    scriptedDubbingReplies.length = 0;

    const oneLongCue = JSON.stringify([
      {
        start: '00:00.0',
        end: '00:10.0',
        speaker_gender: 'female',
        character_role: 'narrator',
        original_transcript: 'one very long line',
        khmer_dubbing: 'មួយ ពីរ បី បួន ប្រាំ ប្រាំមួយ',
      },
    ]);
    scriptedDubbingReplies.push({ text: oneLongCue });

    const form = new FormData();
    form.append('file', new Blob([makeToneWav(10)], { type: 'audio/wav' }), 'long-cue.wav');
    form.append('model', 'gemini-3.5-flash-lite');
    form.append('chunk_seconds', '60');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/audio/dubbing`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body: any = JSON.parse(rawBody);
    assert.equal(body.segment_count, 3, 'the 10-second cue must be split');
    assert.equal(response.headers.get('x-geminirouter-segments'), '3');
    for (const segment of body.segments) {
      assert.ok(
        segment.end_seconds - segment.start_seconds <= DUBBING_MAX_CUE_SECONDS + 0.001,
        `cue ${segment.start} to ${segment.end} is too long for the synthesizer`,
      );
      assert.ok(
        segment.khmer_dubbing.length <= DUBBING_MAX_KHMER_CHARS,
        `cue ${segment.start} has too many Khmer characters`,
      );
    }
    assert.ok(
      body.segments[0].start_seconds <= body.segments[1].start_seconds &&
        body.segments[1].start_seconds <= body.segments[2].start_seconds,
      'split cues must stay chronological',
    );
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
