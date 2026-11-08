import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import Busboy from 'busboy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { safeEqual } from './auth.js';
import { canonicalModelId } from './modelIds.js';
import { getSharedMediaGate } from './mediaGate.js';

/**
 * Long-audio transcription, translation and timed dubbing.
 *
 * The Antigravity core accepts at most 15 MiB of decoded audio per model
 * request, so a one- or two-hour recording cannot be sent as a single body.
 * This module accepts the upload at the bridge, streams it to a temp file,
 * transcodes it to mono 16 kHz MP3, splits it into safe chunks, and calls the
 * normal /v1/chat/completions path once per chunk. The chunks therefore use the
 * same leases, quota checks and account failover as every other model request.
 *
 * The caller's prompt is sent to every chunk, and the combined model output is
 * returned in one response.
 *
 * `/v1/audio/dubbing` uses the same split path but posts each chunk to the
 * Gemini-native generateContent endpoint with a JSON response schema and a
 * duration-based output cap, then shifts chunk-local timestamps onto the
 * absolute recording timeline.
 */

export const MEDIA_ROUTE_PATHS = [
  '/v1/audio/transcriptions',
  '/v1/audio/translations',
  '/v1/media/transcriptions',
] as const;

/**
 * Timed dubbing routes. These use the same upload/transcode/chunk pipeline as
 * transcription, but each chunk is sent to the Gemini-native generateContent
 * endpoint with a JSON response schema and a duration-based output cap, and the
 * returned timed segments are shifted onto the absolute recording timeline.
 */
export const DUBBING_ROUTE_PATHS = ['/v1/audio/dubbing', '/v1/media/dubbing'] as const;

export const MEDIA_LANGUAGES_PATH = '/v1/audio/languages';

/** Default dubbing window. Five minutes fits the 24,576-token cap. */
const DUBBING_DEFAULT_CHUNK_SECONDS = 300;
const DUBBING_MAX_CHUNK_SECONDS = 1800;

/**
 * Reasoning models (the 3.8 family) spend output tokens on thoughts and are
 * only reliable at short windows. The client-side dubber gets clean output from
 * the direct generateContent path at 120 s and drops lines at 300 s, so the
 * endpoint caps those models at 120 s per chunk and gives them a larger output
 * budget than the plain duration table.
 */
const DUBBING_REASONING_CHUNK_SECONDS = 120;
const DUBBING_LITE_CHUNK_SECONDS = 60;
const DUBBING_REASONING_TOKEN_FLOOR = 40960;

/** A chunk with less audible speech than this is allowed to return no lines. */
const DUBBING_MIN_SPEECH_SECONDS = 2;
/** Fraction of the measured speech time that the dubbing script must cover. */
const DUBBING_MIN_SPEECH_COVERAGE = 0.35;
/** A single line cannot plausibly cover this much audible speech. */
const DUBBING_SINGLE_SEGMENT_SPEECH_SECONDS = 8;

// Extra upload paths that need the streaming body parser but are not public
// API model routes. The playground uses this for large files.
const EXTRA_MEDIA_UPLOAD_PATHS = ['/api/playground/media'];

export type MediaTask = 'custom' | 'transcribe' | 'translate' | 'both';
export type MediaResponseFormat = 'json' | 'text';

export interface MediaConfig {
  maxUploadBytes: number;
  maxDurationSeconds: number;
  chunkSeconds: number;
  audioBitrate: string;
  audioBitrateKbps: number;
  jsonBodyLimitBytes: number;
  chunkTimeoutMs: number;
  transcodeTimeoutMs: number;
  totalTimeoutMs: number;
  maxRetries: number;
  ffmpegPath: string;
  ffprobePath: string;
  keepArtifacts: boolean;
}

export interface MediaRouteDeps {
  /** Keys accepted from API clients. Empty means the endpoint is open. */
  getApiKeys: () => string[];
  /** Keys tried against the core gateway for the internal chunk requests. */
  getGatewayApiKeys: () => string[];
  /** Absolute base URL of this bridge, used for the internal /v1 call. */
  getInternalBaseUrl: () => string;
  /** Loads accounts from the core if the local pool has not synced yet. */
  ensureAccounts?: () => Promise<void>;
  config?: MediaConfig;
}

export interface MediaUploadContext {
  tempDir: string;
  filePath?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  fields: Record<string, string>;
  error?: { statusCode: number; code: string; message: string };
}

interface MediaOptions {
  model: string;
  task: MediaTask;
  prompt?: string;
  targetLanguage?: string;
  sourceLanguage?: string;
  responseFormat: MediaResponseFormat;
  chunkSeconds: number;
  maxTokens: number;
  temperature: number;
  concurrency: number;
}

export interface AudioProbe {
  durationSeconds: number;
  formatName?: string;
  codec?: string;
}

export interface AudioChunk {
  index: number;
  filePath: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  sizeBytes: number;
}

interface ChunkResult {
  index: number;
  startSeconds: number;
  endSeconds: number;
  content: string;
  transcript?: string;
  translation?: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export type DubbingSpeakerGender = 'male' | 'female';

/** One timed dubbing line in the public output contract. */
export interface DubbingSegment {
  start: string;
  end: string;
  speaker_id: string;
  speaker_gender: DubbingSpeakerGender;
  vocal_timbre: string;
  character_role: string;
  original_transcript: string;
  khmer_dubbing: string;
}

export interface DubbingSegmentInternal extends DubbingSegment {
  /** Absolute seconds on the whole recording, used for sorting and merging. */
  startSeconds: number;
  endSeconds: number;
}

export interface DubbingChunkResult {
  index: number;
  startSeconds: number;
  endSeconds: number;
  segments: DubbingSegmentInternal[];
  droppedSegments: number;
  content: string;
  model: string;
  maxOutputTokens: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Audible speech measured in the chunk, when FFmpeg could measure it. */
  speechSeconds?: number;
  /** Seconds of speech covered by the returned segments. */
  coveredSeconds: number;
  /** Portion of the model answer that was thinking, for diagnostics. */
  thoughtCharacters: number;
}

export interface DubbingOptions {
  model: string;
  prompt?: string;
  glossary?: string;
  sourceLanguage: string;
  targetLanguage: string;
  chunkSeconds: number;
  maxTokens?: number;
  temperature: number;
  concurrency: number;
  /** True when the caller sent an explicit `concurrency` value. */
  concurrencyExplicit: boolean;
  responseFormat: 'json' | 'array';
}

type UsageTotals = { promptTokens: number; completionTokens: number; totalTokens: number };

export class MediaError extends Error {
  readonly statusCode: number;
  readonly code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'MediaError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const uploads = new WeakMap<FastifyRequest, MediaUploadContext>();

/**
 * Common ISO 639-1/639-2 codes and regional variants. This is a convenience
 * map, not an allow-list: any language name or code is passed through to the
 * model unchanged, so languages that are not listed here still work.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaans',
  am: 'Amharic',
  ar: 'Arabic',
  az: 'Azerbaijani',
  be: 'Belarusian',
  bg: 'Bulgarian',
  bn: 'Bengali',
  bs: 'Bosnian',
  ca: 'Catalan',
  cs: 'Czech',
  cy: 'Welsh',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  'en-gb': 'British English',
  'en-us': 'American English',
  eo: 'Esperanto',
  es: 'Spanish',
  'es-419': 'Latin American Spanish',
  'es-es': 'European Spanish',
  et: 'Estonian',
  eu: 'Basque',
  fa: 'Persian',
  fi: 'Finnish',
  fil: 'Filipino',
  fr: 'French',
  'fr-ca': 'Canadian French',
  ga: 'Irish',
  gl: 'Galician',
  gu: 'Gujarati',
  ha: 'Hausa',
  he: 'Hebrew',
  iw: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  hy: 'Armenian',
  id: 'Indonesian',
  in: 'Indonesian',
  is: 'Icelandic',
  it: 'Italian',
  ja: 'Japanese',
  jv: 'Javanese',
  ka: 'Georgian',
  kk: 'Kazakh',
  km: 'Khmer',
  kn: 'Kannada',
  ko: 'Korean',
  ku: 'Kurdish',
  ky: 'Kyrgyz',
  lo: 'Lao',
  lt: 'Lithuanian',
  lv: 'Latvian',
  mk: 'Macedonian',
  ml: 'Malayalam',
  mn: 'Mongolian',
  mr: 'Marathi',
  ms: 'Malay',
  mt: 'Maltese',
  my: 'Burmese',
  ne: 'Nepali',
  nl: 'Dutch',
  no: 'Norwegian',
  nb: 'Norwegian Bokmål',
  nn: 'Norwegian Nynorsk',
  pa: 'Punjabi',
  pl: 'Polish',
  ps: 'Pashto',
  pt: 'Portuguese',
  'pt-br': 'Brazilian Portuguese',
  'pt-pt': 'European Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  si: 'Sinhala',
  sk: 'Slovak',
  sl: 'Slovenian',
  so: 'Somali',
  sq: 'Albanian',
  sr: 'Serbian',
  sv: 'Swedish',
  sw: 'Swahili',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tl: 'Filipino',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  uz: 'Uzbek',
  vi: 'Vietnamese',
  yo: 'Yoruba',
  zh: 'Chinese',
  'zh-cn': 'Simplified Chinese',
  'zh-hans': 'Simplified Chinese',
  'zh-hant': 'Traditional Chinese',
  'zh-tw': 'Traditional Chinese',
  zu: 'Zulu',
};

/**
 * Accept either a language name ("Japanese") or an ISO code ("ja", "pt-BR").
 * Unknown values are returned unchanged; the model can still translate to a
 * language that is not in the convenience map.
 */
export function languageLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase().replace(/_/g, '-');
  return (
    LANGUAGE_NAMES[normalized] ||
    LANGUAGE_NAMES[normalized.split('-')[0]] ||
    trimmed
  );
}

/** Convenience list for clients; the endpoint itself accepts any language. */
export function knownLanguages(): Array<{ code: string; name: string }> {
  const seen = new Set<string>();
  const languages: Array<{ code: string; name: string }> = [];
  for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
    if (code.includes('-') || seen.has(name)) continue;
    seen.add(name);
    languages.push({ code, name });
  }
  return languages.sort((a, b) => a.name.localeCompare(b.name));
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseBitrateKbps(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)\s*k(?:bps)?$/i.exec(trimmed);
  const numeric = match ? Number.parseInt(match[1], 10) : Number.parseInt(trimmed, 10);
  if (!Number.isFinite(numeric)) return 48;
  const kbps = numeric >= 1000 ? numeric / 1000 : numeric;
  return Math.min(320, Math.max(16, kbps));
}

export function readMediaConfig(): MediaConfig {
  const audioBitrate = process.env.MEDIA_AUDIO_BITRATE || '48k';
  const audioBitrateKbps = parseBitrateKbps(audioBitrate);
  // Keep every chunk below the core's 15 MiB decoded-audio limit. 14 MiB
  // leaves room for container overhead regardless of the requested bitrate.
  const maxSecondsBySize = Math.floor((14 * 1024 * 1024 * 8) / (audioBitrateKbps * 1000));
  // 10-20 minute windows are the recommended unit for the website. The
  // playground's large-media path accepts up to the 1-hour media ceiling;
  // chunks default to 15 minutes so they fit the 65,535-token output budget.
  const requestedChunkSeconds = envInt('MEDIA_CHUNK_SECONDS', 15 * 60, 60, 3600);
  const chunkSeconds = Math.max(60, Math.min(requestedChunkSeconds, maxSecondsBySize));

  // The whole-request deadline must outlive the longest media the endpoint
  // accepts, otherwise a valid 1-hour upload is killed mid-way by the timer.
  // Default to 30 minutes of processing headroom on top of the media duration.
  const maxDurationSeconds = envInt('MEDIA_MAX_DURATION_SECONDS', 60 * 60, 60, 60 * 60);
  const totalTimeoutMs = envInt(
    'MEDIA_TOTAL_TIMEOUT_MS',
    maxDurationSeconds * 1000 + 30 * 60 * 1000,
    0,
    4 * 60 * 60 * 1000,
  );

  return {
    maxUploadBytes: envInt('MEDIA_MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024 * 1024),
    maxDurationSeconds,
    totalTimeoutMs,
    chunkSeconds,
    audioBitrate: `${audioBitrateKbps}k`,
    audioBitrateKbps,
    jsonBodyLimitBytes: envInt('MEDIA_JSON_BODY_LIMIT_BYTES', 96 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024),
    chunkTimeoutMs: envInt('MEDIA_CHUNK_TIMEOUT_MS', 15 * 60 * 1000, 30_000, 60 * 60 * 1000),
    transcodeTimeoutMs: envInt('MEDIA_TRANSCODE_TIMEOUT_MS', 30 * 60 * 1000, 30_000, 2 * 60 * 60 * 1000),
    maxRetries: envInt('MEDIA_MAX_RETRIES', 2, 0, 5),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    keepArtifacts: process.env.MEDIA_KEEP_ARTIFACTS === '1',
  };
}

/**
 * A total deadline shorter than the accepted media duration makes the endpoint
 * advertise a limit it can never honour. Report it once at startup instead of
 * failing a long upload halfway through.
 */
export function describeMediaTimeoutRisk(config: MediaConfig): string | null {
  if (config.totalTimeoutMs === 0) return null;
  if (config.totalTimeoutMs >= config.maxDurationSeconds * 1000) return null;
  return (
    `MEDIA_TOTAL_TIMEOUT_MS (${Math.round(config.totalTimeoutMs / 1000)}s) is shorter than ` +
    `MEDIA_MAX_DURATION_SECONDS (${config.maxDurationSeconds}s); uploads near the limit will be ` +
    `aborted before they finish. Raise MEDIA_TOTAL_TIMEOUT_MS or lower MEDIA_MAX_DURATION_SECONDS.`
  );
}

export function isMediaUploadPath(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return (
    (MEDIA_ROUTE_PATHS as readonly string[]).includes(pathname) ||
    (DUBBING_ROUTE_PATHS as readonly string[]).includes(pathname) ||
    EXTRA_MEDIA_UPLOAD_PATHS.includes(pathname)
  );
}

/** Take the streamed upload for a route that wants to process it itself. */
export function takeMediaUpload(request: FastifyRequest): MediaUploadContext | undefined {
  const upload = uploads.get(request);
  uploads.delete(request);
  return upload;
}

export function registerMediaBodyParsers(
  app: FastifyInstance,
  options: { fallbackBodyLimitBytes: number; config?: MediaConfig },
): void {
  const config = options.config ?? readMediaConfig();

  // One parser for the whole app. /v1 keeps the byte-for-byte multipart
  // passthrough it had before; only the media routes stream to disk.
  app.addContentTypeParser('multipart/form-data', (request, payload, done) => {
    const stream = payload as unknown as Readable;
    if (isMediaUploadPath(request.raw.url)) {
      parseMultipartUpload(request, stream, config, done);
      return;
    }
    bufferBody(stream, options.fallbackBodyLimitBytes, done);
  });

  // Raw uploads: Content-Type: audio/mpeg, video/mp4, application/octet-stream.
  // Metadata comes from query parameters (prompt, model, target_language, ...).
  for (const contentType of ['application/octet-stream', /^audio\//i, /^video\//i]) {
    app.addContentTypeParser(contentType, (request, payload, done) => {
      if (!isMediaUploadPath(request.raw.url)) {
        done(Object.assign(new Error(`Unsupported content type for ${request.raw.url}`), { statusCode: 415 }));
        return;
      }
      parseRawUpload(request, payload as unknown as Readable, config, done);
    });
  }
}

export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  const config = deps.config ?? readMediaConfig();
  const gate = getSharedMediaGate();
  /**
   * Bound how many media jobs run at once. Excess jobs wait in FIFO order;
   * if the queue is full or the wait times out, the caller gets a 503 with
   * Retry-After instead of a burst of 429s from the model pool.
   */
  const withMediaGate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    handler: () => Promise<unknown>,
  ) => {
    const gateResult = await gate.acquire();
    if (!gateResult.ok) {
      reply.header('Retry-After', '30');
      return reply.code(503).send({
        error: {
          message:
            gateResult.reason === 'timeout'
              ? 'Media queue wait timed out. Retry with the same upload.'
              : 'Media queue is full. Try again shortly.',
          type: 'rate_limit_error',
          code: 'media_queue_full',
        },
      });
    }
    reply.header('x-media-queue-wait-ms', String(gateResult.waitMs));
    try {
      return await handler();
    } finally {
      gate.release();
    }
  };

  // JSON/base64 bodies are buffered, so keep a lower ceiling for them.
  // Multipart and raw uploads use the streaming parsers below, which enforce
  // MEDIA_MAX_UPLOAD_BYTES without buffering the file in memory.
  const bodyLimit = config.jsonBodyLimitBytes;
  const authHook = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorize(request, reply, deps.getApiKeys())) return reply;
  };

  app.get(MEDIA_LANGUAGES_PATH, { onRequest: authHook }, async () => ({
    object: 'audio.languages',
    accepts_any: true,
    note: 'Any language name or ISO 639 code is accepted. This list is a convenience subset, not an allow-list.',
    languages: knownLanguages(),
  }));

  for (const route of MEDIA_ROUTE_PATHS) {
    const translationRoute = route === '/v1/audio/translations';
    app.post(
      route,
      { bodyLimit, onRequest: authHook },
      async (request, reply) =>
        withMediaGate(request, reply, () =>
          handleAudioTranscription(request, reply, deps, {
            forceTranslate: translationRoute,
          }),
        ),
    );
  }

  for (const route of DUBBING_ROUTE_PATHS) {
    app.post(
      route,
      { bodyLimit, onRequest: authHook },
      async (request, reply) =>
        withMediaGate(request, reply, () => handleAudioDubbing(request, reply, deps)),
    );
  }
}

function authorize(request: FastifyRequest, reply: FastifyReply, rawKeys: string[]): boolean {
  const allowed = [...new Set(rawKeys.map((key) => key.trim()).filter(Boolean))];
  if (allowed.length === 0) return true;

  const provided = extractApiKey(request);
  if (!provided) {
    reply.code(401).send({
      error: {
        message: 'Missing API key. Send Authorization: Bearer <key>.',
        type: 'authentication_error',
        code: 'missing_api_key',
      },
    });
    return false;
  }

  if (allowed.some((key) => safeEqual(provided, key))) return true;

  reply.code(401).send({
    error: {
      message: 'Invalid API key.',
      type: 'authentication_error',
      code: 'invalid_api_key',
    },
  });
  return false;
}

function extractApiKey(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match) return match[1].trim();
  }
  const xApiKey = request.headers['x-api-key'];
  return typeof xApiKey === 'string' ? xApiKey.trim() : undefined;
}

function bufferBody(
  stream: Readable,
  limit: number,
  done: (error: Error | null, body?: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;

  const finish = (error: Error | null, body?: unknown) => {
    if (settled) return;
    settled = true;
    done(error, body);
  };

  stream.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      stream.destroy();
      finish(Object.assign(new Error('Request body exceeds the bridge limit'), { statusCode: 413 }));
      return;
    }
    chunks.push(buffer);
  });
  stream.on('end', () => finish(null, Buffer.concat(chunks)));
  stream.on('error', (error) => finish(error));
}

function parseMultipartUpload(
  request: FastifyRequest,
  payload: Readable,
  config: MediaConfig,
  done: (error: Error | null, body?: unknown) => void,
): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geminirouter-media-'));
  const fields: Record<string, string> = {};
  let filePath: string | undefined;
  let filename = 'upload.bin';
  let mimeType = 'application/octet-stream';
  let sizeBytes = 0;
  let writeStream: fs.WriteStream | null = null;
  let failure: MediaError | null = null;
  let settled = false;

  let busboy: Busboy.Busboy;
  try {
    busboy = Busboy({
      headers: request.headers,
      limits: {
        fileSize: config.maxUploadBytes,
        files: 1,
        fields: 40,
        fieldSize: 1024 * 1024,
        parts: 50,
      },
    });
  } catch (error: any) {
    cleanupDir(tempDir);
    done(Object.assign(new Error(`Invalid multipart upload: ${error?.message || error}`), { statusCode: 400 }));
    return;
  }

  const finish = () => {
    if (settled) return;
    settled = true;
    const context: MediaUploadContext = {
      tempDir,
      filePath,
      filename,
      mimeType,
      sizeBytes,
      fields,
    };
    if (!filePath && !failure) {
      failure = new MediaError(400, 'file_required', 'Upload a file field named "file" (or "audio"/"video").');
    }
    if (failure) {
      context.error = {
        statusCode: failure.statusCode,
        code: failure.code,
        message: failure.message,
      };
      cleanupDir(tempDir);
    }
    uploads.set(request, context);
    done(null, { __geminirouterMediaUpload: true });
  };

  const fail = (error: MediaError) => {
    if (!failure) failure = error;
  };

  busboy.on('field', (name, value) => {
    fields[name] = value;
  });

  busboy.on('file', (name, file, info) => {
    if (filePath) {
      // Only the first file is used. Drain the rest so the parser can finish.
      file.resume();
      return;
    }
    const originalName = info.filename || 'upload.bin';
    const extension = path.extname(originalName) || extensionForMime(info.mimeType);
    filename = path.basename(originalName);
    mimeType = info.mimeType || 'application/octet-stream';
    filePath = path.join(tempDir, `upload${extension || '.bin'}`);
    writeStream = fs.createWriteStream(filePath);

    file.on('data', (chunk: Buffer | string) => {
      sizeBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    });
    file.on('limit', () => {
      fail(new MediaError(413, 'file_too_large', `Upload exceeds the ${formatBytes(config.maxUploadBytes)} limit.`));
      writeStream?.destroy();
      file.resume();
    });
    file.on('error', (error) => {
      fail(new MediaError(400, 'upload_failed', `Could not read the uploaded file: ${error.message}`));
    });
    writeStream.on('error', (error) => {
      fail(new MediaError(500, 'upload_write_failed', `Could not write the uploaded file: ${error.message}`));
    });
    file.pipe(writeStream);
  });

  busboy.on('filesLimit', () => {
    fail(new MediaError(400, 'too_many_files', 'Upload exactly one audio or video file.'));
  });
  busboy.on('fieldsLimit', () => {
    fail(new MediaError(400, 'too_many_fields', 'Too many form fields.'));
  });
  busboy.on('partsLimit', () => {
    fail(new MediaError(400, 'too_many_parts', 'Too many multipart sections.'));
  });
  busboy.on('error', (error: unknown) => {
    fail(
      new MediaError(
        400,
        'multipart_error',
        `Could not parse the multipart upload: ${(error as Error)?.message || String(error)}`,
      ),
    );
    finish();
  });
  busboy.on('close', async () => {
    if (writeStream && !writeStream.closed) {
      await new Promise<void>((resolve) => {
        writeStream!.once('close', () => resolve());
        writeStream!.once('error', () => resolve());
      });
    }
    finish();
  });

  payload.on('error', (error) => {
    fail(new MediaError(400, 'upload_aborted', `Upload stream failed: ${error.message}`));
    try {
      busboy.destroy();
    } catch {
      /* best effort */
    }
    finish();
  });
  payload.on('aborted', () => {
    fail(new MediaError(400, 'upload_aborted', 'The client disconnected before the upload completed.'));
    finish();
  });

  payload.pipe(busboy);
}

function parseRawUpload(
  request: FastifyRequest,
  payload: Readable,
  config: MediaConfig,
  done: (error: Error | null, body?: unknown) => void,
): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geminirouter-media-'));
  const contentType = String(request.headers['content-type'] || 'application/octet-stream')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const rawFilename = request.headers['x-filename'];
  let requestedName = `upload${extensionForMime(contentType)}`;
  if (typeof rawFilename === 'string' && rawFilename.trim()) {
    try {
      requestedName = decodeURIComponent(rawFilename.trim());
    } catch {
      requestedName = rawFilename.trim();
    }
  }
  const filename = path.basename(requestedName) || `upload${extensionForMime(contentType)}`;
  const filePath = path.join(tempDir, filename.includes('.') ? filename : `${filename}${extensionForMime(contentType)}`);

  let fields: Record<string, string> = {};
  try {
    const url = new URL(request.raw.url || '/', 'http://localhost');
    fields = Object.fromEntries(url.searchParams.entries());
  } catch {
    fields = {};
  }

  const writeStream = fs.createWriteStream(filePath);
  let sizeBytes = 0;
  let failure: MediaError | null = null;
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    const context: MediaUploadContext = {
      tempDir,
      filePath,
      filename,
      mimeType: contentType,
      sizeBytes,
      fields,
    };
    if (failure || sizeBytes === 0) {
      if (!failure) {
        failure = new MediaError(400, 'file_required', 'The raw upload body was empty.');
      }
      context.error = {
        statusCode: failure.statusCode,
        code: failure.code,
        message: failure.message,
      };
      cleanupDir(tempDir);
    }
    uploads.set(request, context);
    done(null, { __geminirouterMediaUpload: true });
  };

  payload.on('data', (chunk: Buffer | string) => {
    sizeBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (sizeBytes > config.maxUploadBytes) {
      failure = new MediaError(413, 'file_too_large', `Upload exceeds the ${formatBytes(config.maxUploadBytes)} limit.`);
      payload.destroy();
      writeStream.destroy();
    }
  });
  payload.on('error', (error) => {
    if (!failure) failure = new MediaError(400, 'upload_aborted', `Upload stream failed: ${error.message}`);
    writeStream.destroy();
    finish();
  });
  payload.on('aborted', () => {
    if (!failure) failure = new MediaError(400, 'upload_aborted', 'The client disconnected before the upload completed.');
    writeStream.destroy();
    finish();
  });
  writeStream.on('error', (error) => {
    if (!failure) failure = new MediaError(500, 'upload_write_failed', `Could not write the uploaded file: ${error.message}`);
    finish();
  });
  writeStream.on('close', finish);
  payload.pipe(writeStream);
}

async function handleAudioTranscription(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: MediaRouteDeps,
  routeOptions: { forceTranslate: boolean },
): Promise<void> {
  const config = deps.config ?? readMediaConfig();
  const upload = uploads.get(request);
  uploads.delete(request);
  let tempDir = upload?.tempDir;
  let clientAborted = false;
  let totalTimedOut = false;
  const startedAt = Date.now();

  const controller = new AbortController();
  const totalTimer =
    config.totalTimeoutMs > 0
      ? setTimeout(() => {
          totalTimedOut = true;
          controller.abort();
        }, config.totalTimeoutMs)
      : null;

  const onClose = () => {
    if (!reply.raw.writableFinished) {
      clientAborted = true;
      controller.abort();
    }
  };
  reply.raw.on('close', onClose);

  try {
    if (upload?.error) {
      throw new MediaError(
        upload.error.statusCode,
        upload.error.code,
        upload.error.message,
      );
    }

    const resolved = await resolveMediaInput(request, upload, config);
    tempDir = resolved.tempDir;

    const options = parseMediaOptions(resolved.fields, routeOptions, config);
    const effectiveChunkSeconds = Math.min(
      options.chunkSeconds,
      Math.max(60, Math.floor((14 * 1024 * 1024 * 8) / (config.audioBitrateKbps * 1000))),
    );

    if (deps.ensureAccounts) {
      try {
        await deps.ensureAccounts();
      } catch (error) {
        request.log.warn({ err: error }, 'media: could not refresh accounts before transcription');
      }
    }

    const probe = await probeAudio(resolved.filePath, config, controller.signal);
    if (probe.durationSeconds > config.maxDurationSeconds) {
      throw new MediaError(
        422,
        'duration_too_long',
        `Audio is ${formatDuration(probe.durationSeconds)}; the configured maximum is ${formatDuration(
          config.maxDurationSeconds,
        )}. Split the recording into 10-20 minute parts and send each part as a separate request.`,
      );
    }

    const transcodeStarted = Date.now();
    const chunks = await splitAudio(
      resolved.filePath,
      resolved.tempDir,
      probe.durationSeconds,
      effectiveChunkSeconds,
      config,
      controller.signal,
    );
    const transcodeMs = Date.now() - transcodeStarted;

    const modelStarted = Date.now();
    const results = await transcribeChunks(
      chunks,
      options,
      config,
      deps,
      controller.signal,
      request.log,
    );
    const modelMs = Date.now() - modelStarted;

    const response = buildResponse({
      options: { ...options, chunkSeconds: effectiveChunkSeconds },
      chunks,
      results,
      durationSeconds: probe.durationSeconds,
      timings: {
        transcodeMs,
        modelMs,
        totalMs: Date.now() - startedAt,
      },
    });

    request.log.info(
      {
        media: {
          durationSeconds: Number(probe.durationSeconds.toFixed(2)),
          chunkCount: chunks.length,
          uploadBytes: resolved.sizeBytes,
          model: options.model,
          task: options.task,
          transcodeMs,
          modelMs,
        },
      },
      'media: transcription completed',
    );

    reply.header('Cache-Control', 'no-store');
    reply.header('X-Geminirouter-Model', options.model);
    reply.header('X-Geminirouter-Chunks', String(chunks.length));
    reply.header('X-Geminirouter-Duration-Seconds', probe.durationSeconds.toFixed(2));

    if (options.responseFormat === 'text') {
      return reply.type('text/plain; charset=utf-8').send(response.text);
    }
    return reply.send(response);
  } catch (error) {
    if (clientAborted) return;
    const mediaError = toMediaError(error, totalTimedOut);
    request.log.warn(
      { media: { code: mediaError.code, statusCode: mediaError.statusCode }, err: mediaError.message },
      'media: transcription failed',
    );
    if (!reply.raw.headersSent) {
      return reply.code(mediaError.statusCode).send({
        error: {
          message: mediaError.message,
          type: mediaError.statusCode === 401 ? 'authentication_error' : 'media_error',
          code: mediaError.code,
          ...(mediaError.details ? { details: mediaError.details } : {}),
        },
      });
    }
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
    reply.raw.off('close', onClose);
    if (tempDir && !config.keepArtifacts) cleanupDir(tempDir);
  }
}

async function resolveMediaInput(
  request: FastifyRequest,
  upload: MediaUploadContext | undefined,
  config: MediaConfig,
): Promise<{
  filePath: string;
  tempDir: string;
  fields: Record<string, string>;
  sizeBytes: number;
}> {
  if (upload?.filePath) {
    return {
      filePath: upload.filePath,
      tempDir: upload.tempDir,
      fields: upload.fields,
      sizeBytes: upload.sizeBytes,
    };
  }

  const body = request.body;
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) {
    throw new MediaError(
      400,
      'file_required',
      'Send multipart/form-data with a "file" field, a raw audio body, or JSON with "audio_base64".',
    );
  }

  const record = body as Record<string, any>;
  const nestedAudio =
    record.audio && typeof record.audio === 'object' && !Array.isArray(record.audio)
      ? record.audio
      : undefined;
  const rawBase64 =
    record.audio_base64 ?? record.audioBase64 ?? record.audio ?? record.data ?? record.file ?? nestedAudio?.data;

  if (typeof rawBase64 !== 'string' || rawBase64.trim() === '') {
    throw new MediaError(400, 'audio_base64_required', 'JSON uploads must include "audio_base64" (base64-encoded audio).');
  }

  const base64 = rawBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new MediaError(400, 'invalid_base64', 'The "audio_base64" field is not valid base64.');
  }

  const audioBytes = Buffer.from(base64, 'base64');
  if (audioBytes.length === 0) {
    throw new MediaError(400, 'file_required', 'The decoded audio body was empty.');
  }
  if (audioBytes.length > config.maxUploadBytes) {
    throw new MediaError(413, 'file_too_large', `Decoded audio exceeds the ${formatBytes(config.maxUploadBytes)} limit.`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geminirouter-media-'));
  const requestedName =
    typeof record.filename === 'string' && record.filename.trim()
      ? record.filename.trim()
      : `upload${extensionForMime(
          typeof record.mime_type === 'string'
            ? record.mime_type
            : typeof record.mimeType === 'string'
              ? record.mimeType
              : 'application/octet-stream',
        )}`;
  const filename = path.basename(requestedName) || 'upload.bin';
  const filePath = path.join(tempDir, filename.includes('.') ? filename : `${filename}.bin`);
  await fs.promises.writeFile(filePath, audioBytes);

  const fields: Record<string, string> = {};
  const mediaKeys = new Set(['audio_base64', 'audioBase64', 'audio', 'data', 'file']);
  for (const [key, value] of Object.entries(record)) {
    if (mediaKeys.has(key)) continue;
    if (typeof value === 'string') fields[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') fields[key] = String(value);
  }
  if (typeof record.format === 'string' && !fields.filename) {
    fields.filename = `upload.${record.format.replace(/^\./, '')}`;
  }

  return { filePath, tempDir, fields, sizeBytes: audioBytes.length };
}

function parseMediaOptions(
  fields: Record<string, string>,
  routeOptions: { forceTranslate: boolean },
  config: MediaConfig,
): MediaOptions {
  const model = (fields.model || process.env.MEDIA_DEFAULT_MODEL || 'gemini-3.5-flash-lite').trim();
  if (!model) throw new MediaError(400, 'model_required', 'A non-empty "model" is required.');

  const prompt = (fields.prompt || fields.instructions || '').trim();
  if (prompt.length > 50_000) {
    throw new MediaError(400, 'prompt_too_long', 'The prompt must be 50,000 characters or fewer.');
  }

  const targetLanguage = (
    fields.target_language ||
    fields.targetLanguage ||
    fields.translate_to ||
    (routeOptions.forceTranslate ? 'English' : '')
  ).trim();
  const sourceLanguage = (fields.source_language || fields.sourceLanguage || fields.language || '').trim();

  const requestedTask = (fields.task || '').trim().toLowerCase();
  let task: MediaTask;
  if (requestedTask === 'translate' || requestedTask === 'transcribe' || requestedTask === 'both') {
    task = requestedTask;
  } else if (prompt) {
    // Prompt-first: the caller's own instruction controls the answer. The
    // website must not impose a transcript/translation result shape.
    task = 'custom';
  } else if (routeOptions.forceTranslate) {
    task = 'translate';
  } else if (targetLanguage) {
    task = 'both';
  } else {
    task = 'transcribe';
  }

  if ((task === 'translate' || task === 'both') && !targetLanguage && !prompt) {
    throw new MediaError(
      400,
      'target_language_required',
      'Set "target_language" (or send a prompt) when task is translate or both.',
    );
  }

  const responseFormat = (fields.response_format || fields.responseFormat || 'json').trim().toLowerCase();
  if (responseFormat !== 'json' && responseFormat !== 'text') {
    throw new MediaError(400, 'invalid_response_format', 'response_format must be "json" or "text".');
  }

  const requestedChunkSeconds = Number.parseInt(fields.chunk_seconds || fields.chunkSeconds || '', 10);
  const chunkSeconds = Number.isFinite(requestedChunkSeconds)
    ? Math.min(3600, Math.max(60, requestedChunkSeconds))
    : config.chunkSeconds;

  const requestedMaxTokens = Number.parseInt(fields.max_tokens || fields.maxTokens || '', 10);
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.min(65535, Math.max(256, requestedMaxTokens))
    : 65535;

  const requestedTemperature = Number.parseFloat(fields.temperature || '');
  const temperature = Number.isFinite(requestedTemperature)
    ? Math.min(2, Math.max(0, requestedTemperature))
    : 0;

  const requestedConcurrency = Number.parseInt(fields.concurrency || '', 10);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.min(4, Math.max(1, requestedConcurrency))
    : 1;

  return {
    model,
    task,
    prompt: prompt || undefined,
    targetLanguage: targetLanguage || undefined,
    sourceLanguage: sourceLanguage || undefined,
    responseFormat,
    chunkSeconds,
    maxTokens,
    temperature,
    concurrency,
  };
}

export function buildChunkPrompt(options: {
  prompt?: string;
  task: MediaTask;
  targetLanguage?: string;
  sourceLanguage?: string;
  index: number;
  count: number;
  previousText?: string;
}): string {
  const parts: string[] = [];
  const target = languageLabel(options.targetLanguage);
  const source = languageLabel(options.sourceLanguage);

  if (options.prompt?.trim()) {
    parts.push(options.prompt.trim());
  } else if (options.task === 'translate') {
    parts.push(
      `Translate the spoken dialogue${source ? ` from ${source}` : ''} into ${target}. ` +
        'Preserve speaker turns, line order and meaning. Do not summarize. Return only the translation.',
    );
  } else if (options.task === 'both') {
    parts.push(
      `Transcribe the spoken dialogue${source ? ` from ${source}` : ''} verbatim in the original language, ` +
        `then translate it into ${target}. Preserve speaker turns and line order. Do not summarize or invent words. ` +
        'Return exactly two sections:\nTRANSCRIPT:\n<verbatim transcript>\nTRANSLATION:\n<translation>',
    );
  } else {
    parts.push(
      `Transcribe every audible spoken line${source ? ` in ${source}` : ' in the original language'} verbatim. ` +
        'Keep dialogue in chronological order and separate speaker turns with line breaks. ' +
        'Do not summarize, translate, or invent inaudible words. Return only the transcript.',
    );
  }

  if (options.count > 1) {
    parts.push(
      `This is part ${options.index + 1} of ${options.count} of one continuous recording. ` +
        'Process only the speech in this part. Do not repeat text from earlier parts.',
    );
  }

  if (options.count > 1 && options.index > 0 && options.previousText?.trim()) {
    const tail = options.previousText.trim().slice(-1200);
    parts.push(
      `For continuity only, the previous part ended with:\n"""\n${tail}\n"""\n` +
        'Use it only as context. Do not repeat it.',
    );
  }

  return parts.join('\n\n');
}

export function splitStructuredOutput(text: string): { transcript?: string; translation?: string } {
  const transcriptMatch =
    /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}\s*TRANSCRIPT\s*\*{0,2}\s*:\s*\*{0,2}\s*/i.exec(text);
  const translationMatch =
    /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}\s*TRANSLATION\s*\*{0,2}\s*:\s*\*{0,2}\s*/i.exec(text);

  const transcript = transcriptMatch
    ? text
        .slice(
          transcriptMatch.index + transcriptMatch[0].length,
          translationMatch && translationMatch.index > transcriptMatch.index
            ? translationMatch.index
            : undefined,
        )
        .trim()
    : undefined;
  const translation = translationMatch
    ? text.slice(translationMatch.index + translationMatch[0].length).trim()
    : undefined;

  if (transcript && translation) return { transcript, translation };
  if (translation) return { translation };
  if (transcript && !translation) return { transcript };
  return {};
}

export async function probeAudio(filePath: string, config: MediaConfig, signal: AbortSignal): Promise<AudioProbe> {
  const output = await runCapture(
    config.ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_type,codec_name,duration',
      '-show_entries',
      'format=duration,format_name',
      '-of',
      'json',
      filePath,
    ],
    AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  );

  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new MediaError(422, 'invalid_media', 'FFprobe did not return valid JSON for the uploaded file.');
  }

  const audioStream = Array.isArray(parsed.streams)
    ? parsed.streams.find((stream: any) => stream?.codec_type === 'audio')
    : undefined;
  if (!audioStream) {
    throw new MediaError(422, 'no_audio_stream', 'The uploaded file has no audio stream.');
  }

  const durationSeconds = Number(parsed.format?.duration) || Number(audioStream.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaError(422, 'unknown_duration', 'Could not determine the duration of the uploaded media.');
  }

  return {
    durationSeconds,
    formatName: typeof parsed.format?.format_name === 'string' ? parsed.format.format_name : undefined,
    codec: typeof audioStream.codec_name === 'string' ? audioStream.codec_name : undefined,
  };
}

export async function splitAudio(
  sourcePath: string,
  tempDir: string,
  durationSeconds: number,
  chunkSeconds: number,
  config: MediaConfig,
  signal: AbortSignal,
): Promise<AudioChunk[]> {
  const chunkDir = path.join(tempDir, 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  let effectiveSeconds = chunkSeconds;
  let files: string[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    for (const existing of fs.readdirSync(chunkDir)) {
      if (/^chunk-\d+\.mp3$/i.test(existing)) {
        fs.rmSync(path.join(chunkDir, existing), { force: true });
      }
    }

    if (durationSeconds <= effectiveSeconds + 1) {
      const output = path.join(chunkDir, 'chunk-0000.mp3');
      await runProcess(
        config.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          sourcePath,
          '-vn',
          '-map',
          '0:a:0',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-b:a',
          config.audioBitrate,
          '-write_xing',
          '0',
          output,
        ],
        AbortSignal.any([signal, AbortSignal.timeout(config.transcodeTimeoutMs)]),
      );
      files = [output];
    } else {
      await runProcess(
        config.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          sourcePath,
          '-vn',
          '-map',
          '0:a:0',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-b:a',
          config.audioBitrate,
          '-write_xing',
          '0',
          '-f',
          'segment',
          '-segment_format',
          'mp3',
          '-segment_time',
          String(effectiveSeconds),
          '-reset_timestamps',
          '1',
          path.join(chunkDir, 'chunk-%04d.mp3'),
        ],
        AbortSignal.any([signal, AbortSignal.timeout(config.transcodeTimeoutMs)]),
      );
      files = fs
        .readdirSync(chunkDir)
        .filter((name) => /^chunk-\d+\.mp3$/i.test(name))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => path.join(chunkDir, name));
    }

    if (files.length > 1) {
      // The segment muxer can leave a tiny trailing file at an exact boundary
      // (a few hundred bytes). Sending it produces an empty/ghost chunk.
      files = files.filter((file) => fs.statSync(file).size >= 1024);
    }
    if (files.length === 0) {
      throw new MediaError(500, 'chunking_failed', 'FFmpeg did not produce any audio chunks.');
    }
    const tooLarge = files.some((file) => fs.statSync(file).size > 14.5 * 1024 * 1024);
    if (!tooLarge) break;
    effectiveSeconds = Math.max(60, Math.floor(effectiveSeconds / 2));
    if (attempt === 2) {
      throw new MediaError(
        500,
        'chunk_too_large',
        'The generated audio chunk still exceeds the core audio limit after three attempts.',
      );
    }
  }

  const probed: Array<{ filePath: string; durationSeconds: number; sizeBytes: number }> = [];
  for (const filePath of files) {
    probed.push({
      filePath,
      durationSeconds: await probeDuration(filePath, config, signal),
      sizeBytes: fs.statSync(filePath).size,
    });
  }

  // Drop ghost chunks (a few milliseconds at an exact segment boundary) when
  // there is real audio around them. Keep a single short import intact.
  const usable =
    probed.length > 1 ? probed.filter((chunk) => chunk.durationSeconds >= 0.5) : probed;
  if (usable.length === 0) {
    throw new MediaError(500, 'chunking_failed', 'All generated audio chunks were empty.');
  }

  const chunks: AudioChunk[] = [];
  let cursor = 0;
  for (let index = 0; index < usable.length; index++) {
    const chunk = usable[index];
    const startSeconds = cursor;
    const endSeconds =
      index === usable.length - 1 ? durationSeconds : cursor + chunk.durationSeconds;
    chunks.push({
      index,
      filePath: chunk.filePath,
      startSeconds,
      endSeconds,
      durationSeconds: chunk.durationSeconds,
      sizeBytes: chunk.sizeBytes,
    });
    cursor = startSeconds + chunk.durationSeconds;
  }
  return chunks;
}

async function probeDuration(filePath: string, config: MediaConfig, signal: AbortSignal): Promise<number> {
  const output = await runCapture(
    config.ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
    AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  );
  const duration = Number(JSON.parse(output).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MediaError(500, 'chunk_probe_failed', 'Could not determine a generated chunk duration.');
  }
  return duration;
}

async function transcribeChunks(
  chunks: AudioChunk[],
  options: MediaOptions,
  config: MediaConfig,
  deps: MediaRouteDeps,
  signal: AbortSignal,
  log: FastifyRequest['log'],
): Promise<ChunkResult[]> {
  const results: ChunkResult[] = new Array(chunks.length);
  const workerCount = Math.min(options.concurrency, chunks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      const previousText =
        options.concurrency === 1 && index > 0
          ? results
              .slice(0, index)
              .map((result) => result?.content || '')
              .join('\n\n')
          : '';
      const prompt = buildChunkPrompt({
        prompt: options.prompt,
        task: options.task,
        targetLanguage: options.targetLanguage,
        sourceLanguage: options.sourceLanguage,
        index,
        count: chunks.length,
        previousText,
      });

      log.info(
        {
          media: {
            chunk: index + 1,
            chunkCount: chunks.length,
            startSeconds: Number(chunk.startSeconds.toFixed(2)),
            endSeconds: Number(chunk.endSeconds.toFixed(2)),
            sizeBytes: chunk.sizeBytes,
          },
        },
        'media: transcribing chunk',
      );

      const result = await transcribeChunkWithRetry(
        chunk,
        prompt,
        options,
        config,
        deps,
        signal,
      );
      results[index] = result;
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } catch (error) {
    if (error instanceof MediaError) {
      const completed = results
        .filter((result): result is ChunkResult => Boolean(result))
        .sort((a, b) => a.index - b.index);
      if (completed.length > 0) {
        const partialText = completed.map((result) => result.content).join('\n\n').trim();
        error.details = {
          ...(error.details && typeof error.details === 'object' ? error.details : {}),
          completed_chunks: completed.length,
          partial_text: partialText,
        };
      }
    }
    throw error;
  }
  return results;
}

/**
 * The core may be configured with either GEMINIROUTER_GATEWAY_API_KEY, the
 * installer's GEMINIROUTER_API_KEY, the dashboard master key, or the key from
 * the core profile. Try each one until the core stops answering 401. Only auth
 * failures trigger another attempt, so large chunk bodies are not re-sent on
 * normal errors.
 */
async function fetchUpstreamWithKeys(
  url: string,
  payload: unknown,
  rawKeys: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const keys = [...new Set(rawKeys.map((key) => key.trim()).filter(Boolean))];
  const candidates = keys.length > 0 ? keys : [''];
  let lastResponse: Response | null = null;

  for (const key of candidates) {
    if (signal.aborted) throw abortError(signal);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'geminirouter-media/1.0',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });

    if (response.status === 401 && candidates.length > 1) {
      lastResponse = response;
      await response.body?.cancel();
      continue;
    }
    return response;
  }

  return lastResponse!;
}

async function transcribeChunkWithRetry(
  chunk: AudioChunk,
  prompt: string,
  options: MediaOptions,
  config: MediaConfig,
  deps: MediaRouteDeps,
  signal: AbortSignal,
): Promise<ChunkResult> {
  const audioBase64 = fs.readFileSync(chunk.filePath).toString('base64');
  const payload = {
    model: options.model,
    stream: false,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'input_audio',
            input_audio: { data: audioBase64, format: 'mp3' },
          },
        ],
      },
    ],
  };

  let lastError: MediaError | null = null;
  const attempts = config.maxRetries + 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) throw abortError(signal);

    try {
      const response = await fetchUpstreamWithKeys(
        deps.getInternalBaseUrl() + '/v1/chat/completions',
        payload,
        deps.getGatewayApiKeys(),
        signal,
        config.chunkTimeoutMs,
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const message = extractUpstreamError(errorText, response.status);

        if (response.status === 401) {
          throw new MediaError(
            401,
            'upstream_auth_failed',
            `The core rejected all configured gateway API keys: ${message}`,
          );
        }
        if ([400, 404, 413, 415, 422].includes(response.status)) {
          throw new MediaError(
            422,
            'model_rejected_media',
            `Chunk ${chunk.index + 1} was rejected by the model (HTTP ${response.status}): ${message}`,
            { chunkIndex: chunk.index, upstreamStatus: response.status },
          );
        }
        if ([403, 408, 429, 500, 502, 503, 504].includes(response.status)) {
          lastError = new MediaError(
            502,
            'upstream_unavailable',
            `Chunk ${chunk.index + 1} failed (HTTP ${response.status}): ${message}`,
            { chunkIndex: chunk.index, upstreamStatus: response.status },
          );
          if (attempt < attempts - 1) {
            await sleepWithSignal(backoffMs(attempt), signal);
            continue;
          }
          throw lastError;
        }

        throw new MediaError(
          502,
          'upstream_error',
          `Chunk ${chunk.index + 1} failed (HTTP ${response.status}): ${message}`,
          { chunkIndex: chunk.index, upstreamStatus: response.status },
        );
      }

      const data: any = await response.json().catch(() => null);
      const finishReason = completionFinishReason(data);
      if (finishReason === 'length' || finishReason === 'max_tokens') {
        // The model stopped at the output cap. The text is valid but incomplete,
        // so returning it would silently drop the rest of the chunk's dialogue.
        throw new MediaError(
          502,
          'model_output_truncated',
          `Chunk ${chunk.index + 1} hit the ${options.maxTokens}-token output cap before finishing, so its transcript would be incomplete. Lower chunk_seconds or raise max_tokens.`,
          { chunkIndex: chunk.index, finishReason, maxTokens: options.maxTokens },
        );
      }
      const content = completionText(data);
      if (!content || isModelFailureText(content)) {
        const failed = Boolean(content);
        lastError = new MediaError(
          502,
          failed ? 'model_failure_text' : 'empty_model_response',
          failed
            ? `Chunk ${chunk.index + 1} returned a model failure message instead of a transcript. Try a simpler prompt or a different model.`
            : `Chunk ${chunk.index + 1} returned an empty model response.`,
          {
            chunkIndex: chunk.index,
            ...(failed ? { model_text: content.slice(0, 1000) } : {}),
          },
        );
        // A tool-call failure text is usually deterministic. Retry it once,
        // then fail fast instead of spending the full three-attempt budget.
        const retryBudget = failed ? 2 : attempts;
        if (attempt + 1 < retryBudget) {
          await sleepWithSignal(backoffMs(attempt), signal);
          continue;
        }
        throw lastError;
      }

      const parsed = splitStructuredOutput(content);
      return {
        index: chunk.index,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        content,
        transcript: parsed.transcript,
        translation: parsed.translation,
        model: typeof data?.model === 'string' ? data.model : options.model,
        usage: {
          promptTokens: Number(data?.usage?.prompt_tokens) || 0,
          completionTokens: Number(data?.usage?.completion_tokens) || 0,
          totalTokens:
            Number(data?.usage?.total_tokens) ||
            (Number(data?.usage?.prompt_tokens) || 0) + (Number(data?.usage?.completion_tokens) || 0),
        },
      };
    } catch (error) {
      if (error instanceof MediaError) {
        if (error.code === 'upstream_auth_failed' || error.code === 'model_rejected_media' || error.code === 'model_output_truncated') throw error;
        lastError = error;
      } else if (isAbortError(error)) {
        throw abortError(signal);
      } else {
        lastError = new MediaError(
          502,
          'chunk_request_failed',
          `Chunk ${chunk.index + 1} request failed: ${(error as Error)?.message || String(error)}`,
          { chunkIndex: chunk.index },
        );
      }

      if (attempt < attempts - 1) {
        await sleepWithSignal(backoffMs(attempt), signal);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new MediaError(502, 'chunk_failed', 'The model request failed.');
}

function buildResponse(input: {
  options: MediaOptions;
  chunks: AudioChunk[];
  results: ChunkResult[];
  durationSeconds: number;
  timings: { transcodeMs: number; modelMs: number; totalMs: number };
}): Record<string, any> {
  const { options, chunks, results, durationSeconds, timings } = input;
  const ordered = [...results].sort((a, b) => a.index - b.index);
  const parsedAll = ordered.every((result) => {
    if (options.task === 'both') return Boolean(result.transcript && result.translation);
    return true;
  });

  let text: string;
  let transcript: string | undefined;
  let translation: string | undefined;

  if (options.task === 'custom') {
    // Prompt-first: return exactly the model answer for the caller's prompt.
    // Only expose transcript/translation if the model happened to use markers.
    text = ordered.map((result) => result.content).join('\n\n').trim();
    const parsed = splitStructuredOutput(text);
    transcript = parsed.transcript;
    translation = parsed.translation;
  } else if (options.task === 'both') {
    if (parsedAll) {
      transcript = ordered.map((result) => result.transcript || '').join('\n\n').trim();
      translation = ordered.map((result) => result.translation || '').join('\n\n').trim();
      text = `TRANSCRIPT:\n${transcript}\n\nTRANSLATION:\n${translation}`;
    } else {
      // The model did not consistently use the requested section markers.
      // Return the complete model output rather than silently dropping text.
      text = ordered.map((result) => result.content).join('\n\n').trim();
    }
  } else if (options.task === 'translate') {
    translation = ordered
      .map((result) => result.translation || result.content)
      .join('\n\n')
      .trim();
    text = translation;
  } else {
    transcript = ordered
      .map((result) => result.transcript || result.content)
      .join('\n\n')
      .trim();
    text = transcript;
  }

  const usage = ordered.reduce(
    (sum, result) => ({
      promptTokens: sum.promptTokens + result.usage.promptTokens,
      completionTokens: sum.completionTokens + result.usage.completionTokens,
      totalTokens: sum.totalTokens + result.usage.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );

  return {
    id: `audtr_${crypto.randomUUID()}`,
    object: 'audio.transcription',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    task: options.task,
    source_language: languageLabel(options.sourceLanguage) || null,
    target_language: languageLabel(options.targetLanguage) || null,
    duration_seconds: Number(durationSeconds.toFixed(3)),
    chunk_count: chunks.length,
    chunk_seconds: options.chunkSeconds,
    text,
    ...(transcript !== undefined ? { transcript } : {}),
    ...(translation !== undefined ? { translation } : {}),
    ...(options.task === 'both' && !parsedAll ? { structured: false } : {}),
    segments: ordered.map((result) => ({
      index: result.index,
      start_seconds: Number(result.startSeconds.toFixed(3)),
      end_seconds: Number(result.endSeconds.toFixed(3)),
      text: result.content,
      ...(result.transcript ? { transcript: result.transcript } : {}),
      ...(result.translation ? { translation: result.translation } : {}),
      model: result.model,
      usage: result.usage,
    })),
    usage,
    timings: {
      transcode_ms: timings.transcodeMs,
      model_ms: timings.modelMs,
      total_ms: timings.totalMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Timed dubbing (Chinese -> Khmer and any other pair)
// ---------------------------------------------------------------------------

const DUBBING_DEFAULT_PROMPT = `You are a professional Chinese-to-Khmer audiovisual translator and dubbing director.
Listen to the supplied audio, transcribe every spoken line in the original language, and write a timed Khmer dubbing script that a TTS engine can perform.

Translation rules:
- Translate into natural, colloquial spoken Khmer for dubbing, not literary word-for-word Khmer.
- Keep every Khmer line short enough to fit its time window.
- Match the speaker's gender particle: male speakers use បាទ where appropriate; female speakers use ចាស.
- Follow the real relationship in kinship terms: 小梨 is the younger sister (ប្អូនស្រី), never អ៊ុំស្រី.
- Render 抢钱 as កាប់ថ្លៃ or ប្លន់លុយ according to context.
- Render 桃子 as ផ្លែប៉េស.
- Render 块/元 (money) as យ័ន or រៀល as appropriate, never បាត.
- Keep personal and place names consistent across the whole recording.
- Do not add, omit, summarize or censor content.

Voice rules:
- speaker_gender must be male or female.
- character_role must stay the same for the same character across lines (for example "younger sister", "boss", "mother").
- Mention whispering, shouting or crying in vocal_timbre when audible.`;

const DUBBING_OUTPUT_CONTRACT = `OUTPUT CONTRACT
Return ONLY a JSON array. Do not wrap it in Markdown fences and do not add comments or prose.
Every element must be an object with exactly these fields:
{
  "start": "MM:SS.S",
  "end": "MM:SS.S",
  "speaker_gender": "male" or "female",
  "vocal_timbre": "short voice description",
  "character_role": "stable speaker role",
  "original_transcript": "verbatim original-language line",
  "khmer_dubbing": "natural spoken Khmer dub line"
}
Timing rules:
- Timestamps are relative to the start of the supplied audio and begin at 00:00.0.
- One element per utterance. Split on pauses and speaker changes; do not merge them.
- "end" must be greater than "start" and must not exceed the audio duration.
- Omit music, noise and stage directions.
Completeness rules:
- If speech is present, return every utterance. An empty array, or a single segment for a clip that contains a conversation, is an error.
- Do not stop after the first line. Keep going until the end of the audio.
If there is no audible speech, return [].`;

/**
 * Appended to the prompt for one retry when the model returned an empty or
 * implausibly short script. It states the failure explicitly because the model
 * tends to answer the first line and stop.
 */
export const DUBBING_COMPLETENESS_RETRY_PROMPT = `RETRY - INCOMPLETE ANSWER
Your previous answer for this audio was missing almost all of the dialogue.
The audio contains a conversation. You must return every utterance in chronological order, from the first line to the end of the audio.
An empty array or a single segment is not an acceptable answer here. Do not summarize and do not stop early.`;


const DUBBING_SEGMENT_PROPERTIES = {
  start: { type: 'STRING', description: 'Utterance start as MM:SS.S from the start of this audio part.' },
  end: { type: 'STRING', description: 'Utterance end as MM:SS.S from the start of this audio part.' },
  speaker_gender: { type: 'STRING', enum: ['male', 'female'] },
  vocal_timbre: { type: 'STRING', description: 'Short description of the voice quality.' },
  character_role: { type: 'STRING', description: 'Stable role of the speaker in the scene.' },
  original_transcript: { type: 'STRING', description: 'Verbatim original-language line.' },
  khmer_dubbing: { type: 'STRING', description: 'Natural spoken Khmer dubbing line.' },
};

export const DUBBING_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: DUBBING_SEGMENT_PROPERTIES,
    required: Object.keys(DUBBING_SEGMENT_PROPERTIES),
    propertyOrdering: Object.keys(DUBBING_SEGMENT_PROPERTIES),
  },
};

/**
 * True for models that emit a thinking pass before the JSON answer. Their
 * thoughts consume the output budget and they degrade on long audio windows.
 */
export function isReasoningDubbingModel(model: string): boolean {
  return /(^|[-_/])3\.8|(^|[-_/])(high|thinking|reasoner|pro)([-_/]|$)/i.test(model.trim());
}

/** True for the small `-lite` models, which stop at the end of a script pass. */
export function isLiteDubbingModel(model: string): boolean {
  return /(^|[-_/])lite([-_/]|$)/i.test(model.trim());
}

/**
 * True for dubbing models that need a short window. Besides the reasoning
 * models this includes the `-lite` family: on a 300 s window lite answers with
 * roughly the first minute only and then stops, so it must be chunked too.
 * This is a dubbing-only rule; `/v1/chat/completions` traffic is untouched.
 */
export function usesShortDubbingWindow(model: string): boolean {
  return isReasoningDubbingModel(model) || isLiteDubbingModel(model);
}

/**
 * Per-chunk audio window for a model. Reasoning models get 120 s. Lite models
 * get 60 s: on 120 s windows lite still stops at the end of the first complete
 * script pass (`~01:09` on the 300 s fixture) and drops the rest of the window,
 * while 60 s windows stay mid-pass and transcribe the whole chunk.
 */
export function dubbingChunkSecondsForModel(model: string, requestedSeconds: number): number {
  const cap = isLiteDubbingModel(model)
    ? DUBBING_LITE_CHUNK_SECONDS
    : isReasoningDubbingModel(model)
      ? DUBBING_REASONING_CHUNK_SECONDS
      : DUBBING_MAX_CHUNK_SECONDS;
  return Math.max(60, Math.min(requestedSeconds, cap));
}

/**
 * Default chunk concurrency for a dubbing request that did not set
 * `concurrency`. Short-window models are slow per chunk, so run every chunk in
 * parallel (up to 4): a 300 s reasoning request with concurrency 1 serialises
 * three 120 s chunks and looks hung, while three parallel chunks answered in
 * 575 s in production.
 */
export function defaultDubbingConcurrency(model: string, chunkCount: number): number {
  if (!usesShortDubbingWindow(model)) return 1;
  return Math.max(1, Math.min(4, Math.floor(chunkCount)));
}

/**
 * Wall-clock planning estimate for a dubbing request, from production
 * throughput. Reasoning models run at roughly 2.2x audio duration, lite models
 * at 0.3x, and everything else at 1x. It is a planning figure, not a deadline:
 * account-pool contention can push a request far past it.
 */
export function estimatedDubbingMs(durationSeconds: number, model: string): number {
  const safe = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const factor = isReasoningDubbingModel(model) ? 2.2 : isLiteDubbingModel(model) ? 0.3 : 1;
  return Math.round(safe * factor * 1000);
}

/**
 * Output-token budget for one dubbing chunk, from the caller's duration table.
 * A chunk is capped by the first threshold that it fits into. Short-window
 * models get a floor that leaves room for thoughts plus the JSON answer.
 */
export function dubbingMaxOutputTokens(durationSeconds: number, model?: string): number {
  const safe = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  let budget: number;
  if (safe <= 120) budget = 8192;
  else if (safe <= 240) budget = 16384;
  else if (safe <= 300) budget = 24576;
  else if (safe <= 600) budget = 40960;
  else budget = 65535;

  if (model && usesShortDubbingWindow(model)) {
    budget = Math.max(budget, DUBBING_REASONING_TOKEN_FLOOR);
  }
  return Math.min(65535, budget);
}

/** Parse "MM:SS.S", "HH:MM:SS.S", or a plain number of seconds. */
export function parseDubbingTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return Math.max(0, numeric);

  const parts = trimmed.split(':').map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === '')) return undefined;
  const seconds = Number(parts[parts.length - 1]);
  const minutes = Number(parts[parts.length - 2]);
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(minutes) || minutes < 0) {
    return undefined;
  }
  if (parts.length === 2) return minutes * 60 + seconds;

  const hours = Number(parts[0]);
  if (!Number.isFinite(hours) || hours < 0) return undefined;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Format absolute seconds as the contract's MM:SS.S (minutes may exceed 59). */
export function formatDubbingTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalTenths = Math.round(safe * 10);
  const minutes = Math.floor(totalTenths / 600);
  const secs = (totalTenths % 600) / 10;
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
}

/**
 * Yield every top-level balanced `open`/`close` span in the text. A model
 * answer can contain an example array first and the real array second, so all
 * spans are needed to pick the largest one.
 */
function* balancedJsonSlices(text: string, open: string, close: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      if (depth === 0) start = index;
      depth++;
    } else if (char === close) {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        yield text.slice(start, index + 1);
        start = -1;
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceDubbingArray(parsed: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed)) {
    // A model may return a single segment object when the clip has one line.
    if ('khmer_dubbing' in parsed || 'original_transcript' in parsed) return [parsed];
    for (const key of ['segments', 'dubbing', 'lines', 'items', 'data', 'result']) {
      const value = parsed[key];
      if (Array.isArray(value)) return value.filter(isRecord);
    }
  }
  return null;
}

/**
 * Extract the segment array from a model answer that may contain Markdown
 * fences, a short preamble, or a wrapper object. Returns null when no JSON
 * array can be recovered. When the answer contains more than one JSON array
 * (for example an example followed by the real script) the largest one wins.
 */
export function parseDubbingPayload(text: string): Record<string, unknown>[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const candidates = [withoutFence, trimmed];
  let best: Record<string, unknown>[] | null = null;
  const consider = (value: unknown) => {
    const coerced = coerceDubbingArray(value);
    if (!coerced) return;
    // Prefer the largest array; on a tie prefer the later one, because a model
    // often drafts an example first and writes the real script last.
    if (!best || coerced.length >= best.length) best = coerced;
  };

  for (const candidate of candidates) {
    try {
      // A whole-answer parse is authoritative, even when the array is empty.
      const coerced = coerceDubbingArray(JSON.parse(candidate));
      if (coerced) return coerced;
    } catch {
      /* try balanced slices below */
    }
    for (const [open, close] of [
      ['[', ']'],
      ['{', '}'],
    ] as const) {
      for (const slice of balancedJsonSlices(candidate, open, close)) {
        try {
          consider(JSON.parse(slice));
        } catch {
          /* keep trying */
        }
      }
    }
  }
  return best;
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeSpeakerGender(value: string, khmer: string): DubbingSpeakerGender {
  const normalized = value.trim().toLowerCase();
  if (['female', 'f', 'woman', 'girl', 'lady', '女', '女性', '女声'].includes(normalized)) {
    return 'female';
  }
  if (['male', 'm', 'man', 'boy', 'guy', '男', '男性', '男声'].includes(normalized)) {
    return 'male';
  }
  if (normalized.includes('female') || normalized.includes('woman') || normalized.includes('girl')) {
    return 'female';
  }
  if (normalized.includes('male') || normalized.includes('man') || normalized.includes('boy')) {
    return 'male';
  }
  if (khmer.includes('ចាស')) return 'female';
  if (khmer.includes('បាទ')) return 'male';
  return 'male';
}

/** Stable speaker id derived from the role so the same character keeps one id across chunks. */
export function speakerIdFromRole(role: string, gender: DubbingSpeakerGender): string {
  const normalized = (role || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (normalized) return normalized;
  return gender === 'male' ? 'male_speaker' : 'female_speaker';
}

/**
 * Validate one model segment, clamp its timing to the chunk, and shift it onto
 * the absolute recording timeline. Segments without a Khmer line are dropped.
 */
export function normalizeDubbingSegment(
  raw: Record<string, unknown>,
  chunk: { startSeconds: number; endSeconds: number },
  fallbackStartSeconds = 0,
): DubbingSegmentInternal | undefined {
  const original = firstString(raw, [
    'original_transcript',
    'originalTranscript',
    'original',
    'transcript',
    'source_text',
    'source',
  ]);
  const khmer = firstString(raw, [
    'khmer_dubbing',
    'khmerDubbing',
    'khmer',
    'dubbing',
    'translation',
    'translated_text',
  ]);
  if (!khmer) return undefined;

  const chunkDuration = Math.max(0.1, chunk.endSeconds - chunk.startSeconds);
  const parsedStart = parseDubbingTimestamp(
    raw.start ?? raw.start_time ?? raw.startTime ?? raw.begin,
  );
  const parsedEnd = parseDubbingTimestamp(raw.end ?? raw.end_time ?? raw.endTime ?? raw.finish);

  let localStart = parsedStart !== undefined ? parsedStart : fallbackStartSeconds;
  localStart = Math.min(Math.max(0, localStart), Math.max(0, chunkDuration - 0.1));

  let localEnd = parsedEnd !== undefined ? parsedEnd : localStart + 1;
  if (localEnd <= localStart) localEnd = localStart + 0.5;
  localEnd = Math.min(localEnd, chunkDuration);
  if (localEnd <= localStart) return undefined;

  const gender = normalizeSpeakerGender(
    firstString(raw, ['speaker_gender', 'speakerGender', 'gender', 'sex']),
    khmer,
  );
  const timbre = firstString(raw, ['vocal_timbre', 'vocalTimbre', 'timbre', 'voice', 'voice_type', 'voiceType']);
  const role = firstString(raw, ['character_role', 'characterRole', 'role', 'speaker', 'character']);

  const startSeconds = chunk.startSeconds + localStart;
  const endSeconds = chunk.startSeconds + localEnd;
  return {
    start: formatDubbingTimestamp(startSeconds),
    end: formatDubbingTimestamp(endSeconds),
    speaker_id: speakerIdFromRole(role, gender),
    speaker_gender: gender,
    vocal_timbre: timbre || (gender === 'female' ? 'female voice' : 'male voice'),
    character_role: role,
    original_transcript: original,
    khmer_dubbing: khmer,
    startSeconds,
    endSeconds,
  };
}

export interface DubbingCoverageVerdict {
  ok: boolean;
  reason?: 'empty_script' | 'single_segment' | 'low_coverage';
  coveredSeconds: number;
  speechSeconds?: number;
  ratio?: number;
}

/** Union of the segment intervals, clamped to the chunk window. */
export function dubbingCoveredSeconds(
  segments: Array<{ startSeconds: number; endSeconds: number }>,
  startSeconds: number,
  endSeconds: number,
): number {
  const ranges = segments
    .map(
      (segment) =>
        [
          Math.max(startSeconds, segment.startSeconds),
          Math.min(endSeconds, segment.endSeconds),
        ] as const,
    )
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let currentStart: number | null = null;
  let currentEnd = 0;
  for (const [start, end] of ranges) {
    if (currentStart === null) {
      currentStart = start;
      currentEnd = end;
      continue;
    }
    if (start > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else {
      currentEnd = Math.max(currentEnd, end);
    }
  }
  if (currentStart !== null) total += currentEnd - currentStart;
  return Math.max(0, total);
}

/**
 * Audible speech time from the `silencedetect` filter log.
 * Silence spans outside the file are clamped, so a fully silent chunk yields 0.
 */
export function dubbingSpeechSecondsFromSilences(
  durationSeconds: number,
  ffmpegLog: string,
): number {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  if (duration === 0) return 0;

  const events: Array<{ type: 'start' | 'end'; time: number }> = [];
  const pattern = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ffmpegLog)) !== null) {
    events.push({ type: match[1] as 'start' | 'end', time: Number(match[2]) });
  }

  let silenceSeconds = 0;
  let openStart: number | null = null;
  for (const event of events) {
    if (event.type === 'start') {
      openStart = Math.max(0, event.time);
      continue;
    }
    if (openStart === null) continue;
    silenceSeconds += Math.max(0, Math.min(duration, event.time) - openStart);
    openStart = null;
  }
  if (openStart !== null) silenceSeconds += Math.max(0, duration - openStart);

  return Math.max(0, Math.min(duration, duration - silenceSeconds));
}

/**
 * Decide whether a chunk answer is complete enough to trust. Empty or
 * single-line answers for a chunk that clearly contains a conversation are
 * rejected so the request can retry instead of returning 2% of the dialogue.
 */
export function dubbingCoverageVerdict(input: {
  segmentCount: number;
  coveredSeconds: number;
  speechSeconds?: number;
  durationSeconds: number;
}): DubbingCoverageVerdict {
  const duration = Math.max(0, input.durationSeconds);
  const coveredSeconds = Math.max(0, Math.min(duration, input.coveredSeconds));
  const speechSeconds =
    input.speechSeconds === undefined
      ? undefined
      : Math.max(0, Math.min(duration, input.speechSeconds));
  const ratio =
    speechSeconds && speechSeconds > 0 ? coveredSeconds / speechSeconds : undefined;

  const base: DubbingCoverageVerdict = {
    ok: true,
    coveredSeconds: Number(coveredSeconds.toFixed(2)),
    ...(speechSeconds === undefined ? {} : { speechSeconds: Number(speechSeconds.toFixed(2)) }),
    ...(ratio === undefined ? {} : { ratio: Number(ratio.toFixed(3)) }),
  };

  // Without a reliable speech measurement, an empty answer may be a silent
  // chunk, so only reject answers we can prove are incomplete.
  if (speechSeconds === undefined || speechSeconds < DUBBING_MIN_SPEECH_SECONDS) {
    return base;
  }
  if (input.segmentCount === 0) {
    return { ...base, ok: false, reason: 'empty_script' };
  }
  if (coveredSeconds <= 0) {
    return { ...base, ok: false, reason: 'low_coverage' };
  }
  if (
    input.segmentCount === 1 &&
    speechSeconds >= DUBBING_SINGLE_SEGMENT_SPEECH_SECONDS
  ) {
    return { ...base, ok: false, reason: 'single_segment' };
  }
  if ((ratio ?? 0) < DUBBING_MIN_SPEECH_COVERAGE) {
    return { ...base, ok: false, reason: 'low_coverage' };
  }
  return base;
}

/** Run `silencedetect` over one chunk and return the audible speech seconds. */
async function measureSpeechSeconds(
  filePath: string,
  durationSeconds: number,
  config: MediaConfig,
  signal: AbortSignal,
): Promise<number> {
  const { stderr } = await runCaptureWithStderr(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-nostats',
      '-v',
      'info',
      '-i',
      filePath,
      '-af',
      'silencedetect=noise=-30dB:d=0.7',
      '-f',
      'null',
      '-',
    ],
    AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  );
  return dubbingSpeechSecondsFromSilences(durationSeconds, stderr);
}

/** `prompt` overrides the built-in instructions; the output contract is always appended. */
export function buildDubbingPrompt(options: {  prompt?: string;
  glossary?: string;
  index: number;
  count: number;
  previousSegments?: Array<{
    original_transcript: string;
    khmer_dubbing: string;
    character_role: string;
  }>;
}): string {
  const parts: string[] = [options.prompt?.trim() || DUBBING_DEFAULT_PROMPT, DUBBING_OUTPUT_CONTRACT];

  if (options.count > 1) {
    parts.push(
      `This audio is part ${options.index + 1} of ${options.count} of one continuous recording. ` +
        'Transcribe only the speech in this part. Start timestamps at 00:00.0 for this part.',
    );
  }

  const previous =
    options.previousSegments?.filter(
      (segment) => segment.original_transcript.trim() || segment.khmer_dubbing.trim(),
    ) ?? [];
  if (options.count > 1 && options.index > 0 && previous.length > 0) {
    const tail = previous
      .slice(-3)
      .map(
        (segment) =>
          `- ${segment.character_role || 'speaker'} | ${segment.original_transcript} => ${segment.khmer_dubbing}`,
      )
      .join('\n');
    parts.push(
      `For continuity only, the previous part ended with:\n${tail}\n` +
        'Match their names, roles and terminology, but do not repeat these lines.',
    );
  }

  if (options.glossary?.trim()) {
    parts.push(`Glossary — use these translations/names exactly:\n${options.glossary.trim()}`);
  }

  return parts.join('\n\n');
}

function parseDubbingOptions(fields: Record<string, string>, config: MediaConfig): DubbingOptions {
  const requestedModel = (fields.model || process.env.MEDIA_DEFAULT_MODEL || 'gemini-3.5-flash-lite').trim();
  if (!requestedModel) throw new MediaError(400, 'model_required', 'A non-empty "model" is required.');
  // Retired aliases (for example gemini-3.8-flash-tiered) are mapped before the
  // model id reaches the core, exactly like /v1/chat/completions requests.
  const model = canonicalModelId(requestedModel);

  const prompt = (fields.prompt || fields.instructions || '').trim();
  if (prompt.length > 50_000) {
    throw new MediaError(400, 'prompt_too_long', 'The prompt must be 50,000 characters or fewer.');
  }

  const glossary = (fields.glossary || fields.terms || '').trim();
  if (glossary.length > 20_000) {
    throw new MediaError(400, 'glossary_too_long', 'The glossary must be 20,000 characters or fewer.');
  }

  const sourceLanguage =
    (fields.source_language || fields.sourceLanguage || fields.language || 'zh').trim() || 'zh';
  const targetLanguage =
    (fields.target_language || fields.targetLanguage || fields.dub_to || 'km').trim() || 'km';

  const requestedChunkSeconds = Number.parseInt(fields.chunk_seconds || fields.chunkSeconds || '', 10);
  const chunkSeconds = Number.isFinite(requestedChunkSeconds)
    ? Math.min(DUBBING_MAX_CHUNK_SECONDS, Math.max(60, requestedChunkSeconds))
    : Math.min(DUBBING_DEFAULT_CHUNK_SECONDS, DUBBING_MAX_CHUNK_SECONDS);

  const requestedMaxTokens = Number.parseInt(fields.max_tokens || fields.maxTokens || '', 10);
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.min(65535, Math.max(256, requestedMaxTokens))
    : undefined;

  const requestedTemperature = Number.parseFloat(fields.temperature || '');
  const temperature = Number.isFinite(requestedTemperature)
    ? Math.min(2, Math.max(0, requestedTemperature))
    : 0;

  const requestedConcurrency = Number.parseInt(fields.concurrency || '', 10);
  const concurrencyExplicit = Number.isFinite(requestedConcurrency);
  const concurrency = concurrencyExplicit
    ? Math.min(4, Math.max(1, requestedConcurrency))
    : 1;

  const requestedFormat = (fields.response_format || fields.responseFormat || 'json')
    .trim()
    .toLowerCase();
  if (!['json', 'array', 'segments', 'raw'].includes(requestedFormat)) {
    throw new MediaError(
      400,
      'invalid_response_format',
      'response_format must be "json" (metadata + segments) or "array" (segments only).',
    );
  }
  const responseFormat: 'json' | 'array' =
    requestedFormat === 'json' ? 'json' : 'array';

  return {
    model,
    prompt: prompt || undefined,
    glossary: glossary || undefined,
    sourceLanguage,
    targetLanguage,
    chunkSeconds,
    maxTokens,
    temperature,
    concurrency,
    concurrencyExplicit,
    responseFormat,
  };
}

async function handleAudioDubbing(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: MediaRouteDeps,
): Promise<void> {
  const config = deps.config ?? readMediaConfig();
  const upload = uploads.get(request);
  uploads.delete(request);
  let tempDir = upload?.tempDir;
  let clientAborted = false;
  let totalTimedOut = false;
  const startedAt = Date.now();

  const controller = new AbortController();
  const totalTimer =
    config.totalTimeoutMs > 0
      ? setTimeout(() => {
          totalTimedOut = true;
          controller.abort();
        }, config.totalTimeoutMs)
      : null;

  const onClose = () => {
    if (!reply.raw.writableFinished) {
      clientAborted = true;
      controller.abort();
    }
  };
  reply.raw.on('close', onClose);

  try {
    if (upload?.error) {
      throw new MediaError(upload.error.statusCode, upload.error.code, upload.error.message);
    }

    const resolved = await resolveMediaInput(request, upload, config);
    tempDir = resolved.tempDir;

    const options = parseDubbingOptions(resolved.fields, config);
    const maxSecondsBySize = Math.max(
      60,
      Math.floor((14 * 1024 * 1024 * 8) / (config.audioBitrateKbps * 1000)),
    );
    const modelChunkSeconds = dubbingChunkSecondsForModel(options.model, options.chunkSeconds);
    const effectiveChunkSeconds = Math.min(modelChunkSeconds, maxSecondsBySize);
    if (effectiveChunkSeconds < options.chunkSeconds) {
      request.log.info(
        {
          media: {
            model: options.model,
            requestedChunkSeconds: options.chunkSeconds,
            chunkSeconds: effectiveChunkSeconds,
            reason:
              modelChunkSeconds < options.chunkSeconds
                ? isReasoningDubbingModel(options.model)
                  ? 'reasoning model window'
                  : 'lite model window'
                : 'upload size limit',
          },
        },
        'media: dubbing chunk window reduced',
      );
    }

    if (deps.ensureAccounts) {
      try {
        await deps.ensureAccounts();
      } catch (error) {
        request.log.warn({ err: error }, 'media: could not refresh accounts before dubbing');
      }
    }

    const probe = await probeAudio(resolved.filePath, config, controller.signal);
    if (probe.durationSeconds > config.maxDurationSeconds) {
      throw new MediaError(
        422,
        'duration_too_long',
        `Audio is ${formatDuration(probe.durationSeconds)}; the configured maximum is ${formatDuration(
          config.maxDurationSeconds,
        )}. Split the recording into 10-20 minute parts and send each part as a separate request.`,
      );
    }

    const transcodeStarted = Date.now();
    const chunks = await splitAudio(
      resolved.filePath,
      resolved.tempDir,
      probe.durationSeconds,
      effectiveChunkSeconds,
      config,
      controller.signal,
    );
    const transcodeMs = Date.now() - transcodeStarted;

    // Short-window models need parallel chunks by default: serial 120 s 3.8
    // chunks can exceed every proxy timeout and look hung to the caller.
    if (!options.concurrencyExplicit) {
      const autoConcurrency = defaultDubbingConcurrency(options.model, chunks.length);
      if (autoConcurrency !== options.concurrency) {
        request.log.info(
          {
            media: {
              model: options.model,
              chunkCount: chunks.length,
              concurrency: autoConcurrency,
            },
          },
          'media: dubbing concurrency raised for short-window model',
        );
        options.concurrency = autoConcurrency;
      }
    }

    const modelStarted = Date.now();
    const results = await dubChunks(chunks, options, config, deps, controller.signal, request.log);
    const modelMs = Date.now() - modelStarted;

    const response = buildDubbingResponse({
      options: { ...options, chunkSeconds: effectiveChunkSeconds },
      chunks,
      results,
      durationSeconds: probe.durationSeconds,
      timings: { transcodeMs, modelMs, totalMs: Date.now() - startedAt },
    });

    request.log.info(
      {
        media: {
          durationSeconds: Number(probe.durationSeconds.toFixed(2)),
          chunkCount: chunks.length,
          chunkSeconds: effectiveChunkSeconds,
          segmentCount: response.segment_count,
          speechSeconds: response.coverage.speech_seconds,
          coveredSeconds: response.coverage.covered_seconds,
          coverageRatio: response.coverage.ratio,
          uploadBytes: resolved.sizeBytes,
          model: options.model,
          sourceLanguage: options.sourceLanguage,
          targetLanguage: options.targetLanguage,
          transcodeMs,
          modelMs,
        },
      },
      'media: dubbing completed',
    );

    reply.header('Cache-Control', 'no-store');
    reply.header('X-Geminirouter-Model', options.model);
    reply.header('X-Geminirouter-Chunks', String(chunks.length));
    reply.header('X-Geminirouter-Segments', String(response.segment_count));
    reply.header('X-Geminirouter-Duration-Seconds', probe.durationSeconds.toFixed(2));

    if (options.responseFormat === 'array') {
      return reply.send(response.segments);
    }
    return reply.send(response);
  } catch (error) {
    if (clientAborted) return;
    const mediaError = toMediaError(error, totalTimedOut);
    request.log.warn(
      { media: { code: mediaError.code, statusCode: mediaError.statusCode }, err: mediaError.message },
      'media: dubbing failed',
    );
    if (!reply.raw.headersSent) {
      return reply.code(mediaError.statusCode).send({
        error: {
          message: mediaError.message,
          type: mediaError.statusCode === 401 ? 'authentication_error' : 'media_error',
          code: mediaError.code,
          ...(mediaError.details ? { details: mediaError.details } : {}),
        },
      });
    }
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
    reply.raw.off('close', onClose);
    if (tempDir && !config.keepArtifacts) cleanupDir(tempDir);
  }
}

export async function dubChunks(
  chunks: AudioChunk[],
  options: DubbingOptions,
  config: MediaConfig,
  deps: MediaRouteDeps,
  signal: AbortSignal,
  log: FastifyRequest['log'],
): Promise<DubbingChunkResult[]> {
  const results: DubbingChunkResult[] = new Array(chunks.length);
  const workerCount = Math.min(options.concurrency, chunks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      const previousSegments =
        options.concurrency === 1 && index > 0 ? results[index - 1]?.segments ?? [] : [];
      const prompt = buildDubbingPrompt({
        prompt: options.prompt,
        glossary: options.glossary,
        index,
        count: chunks.length,
        previousSegments,
      });
      const maxOutputTokens =
        options.maxTokens ?? dubbingMaxOutputTokens(chunk.durationSeconds, options.model);

      // Measure audible speech once per chunk so an empty or single-line answer
      // can be told apart from a chunk that is genuinely silent.
      const speechSeconds = await measureSpeechSeconds(
        chunk.filePath,
        chunk.durationSeconds,
        config,
        signal,
      ).catch((error) => {
        log.warn({ err: error, media: { chunk: index + 1 } }, 'media: speech detection failed');
        return undefined;
      });

      log.info(
        {
          media: {
            chunk: index + 1,
            chunkCount: chunks.length,
            startSeconds: Number(chunk.startSeconds.toFixed(2)),
            endSeconds: Number(chunk.endSeconds.toFixed(2)),
            durationSeconds: Number(chunk.durationSeconds.toFixed(2)),
            speechSeconds:
              speechSeconds === undefined ? null : Number(speechSeconds.toFixed(2)),
            sizeBytes: chunk.sizeBytes,
            maxOutputTokens,
            model: options.model,
          },
        },
        'media: dubbing chunk',
      );

      results[index] = await dubChunkWithRetry(
        chunk,
        prompt,
        maxOutputTokens,
        options,
        config,
        deps,
        signal,
        speechSeconds,
        log,
      );
    }
  };

  const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  const failure = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
  );
  if (failure) {
    const error = failure.reason;
    if (error instanceof MediaError) {
      const completed = results
        .filter((result): result is DubbingChunkResult => Boolean(result))
        .sort((a, b) => a.index - b.index);
      if (completed.length > 0) {
        error.details = {
          ...(error.details && typeof error.details === 'object' ? error.details : {}),
          completed_chunks: completed.length,
          partial_segments: completed
            .flatMap((result) => result.segments)
            .sort((a, b) => a.startSeconds - b.startSeconds)
            .map(({ startSeconds, endSeconds, ...segment }) => segment),
        };
      }
    }
    throw error;
  }

  return results;
}

/**
 * Model answer text plus the number of characters spent on thinking. Thoughts
 * are never concatenated with the answer: reasoning models often draft an
 * example JSON array there, and mixing it in produced one-segment scripts.
 */
export function geminiResponseAnswer(data: any): { text: string; thoughtCharacters: number } {
  const parts = data?.candidates?.[0]?.content?.parts;
  let thoughtCharacters = 0;
  if (Array.isArray(parts)) {
    const answer: string[] = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        answer.push(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const text = typeof part.text === 'string' ? part.text : '';
      if (part.thought === true) {
        thoughtCharacters += text.length;
        continue;
      }
      if (text) answer.push(text);
    }
    const text = answer.join('').trim();
    if (text) return { text, thoughtCharacters };
  }
  return { text: completionText(data), thoughtCharacters };
}

function usageFromResponse(data: any): UsageTotals {
  const meta = data?.usageMetadata;
  if (meta && typeof meta === 'object') {
    const promptTokens = Number(meta.promptTokenCount) || 0;
    const completionTokens =
      (Number(meta.candidatesTokenCount) || 0) + (Number(meta.thoughtsTokenCount) || 0);
    return {
      promptTokens,
      completionTokens,
      totalTokens: Number(meta.totalTokenCount) || promptTokens + completionTokens,
    };
  }
  const promptTokens = Number(data?.usage?.prompt_tokens) || 0;
  const completionTokens = Number(data?.usage?.completion_tokens) || 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(data?.usage?.total_tokens) || promptTokens + completionTokens,
  };
}

function isSchemaRejection(status: number, message: string): boolean {
  if (status !== 400) return false;
  return /schema|response_?mime|response_?format|generation_?config/i.test(message);
}

async function dubChunkWithRetry(
  chunk: AudioChunk,
  prompt: string,
  maxOutputTokens: number,
  options: DubbingOptions,
  config: MediaConfig,
  deps: MediaRouteDeps,
  signal: AbortSignal,
  speechSeconds: number | undefined,
  log: FastifyRequest['log'],
): Promise<DubbingChunkResult> {
  const audioBase64 = fs.readFileSync(chunk.filePath).toString('base64');
  const url = `${deps.getInternalBaseUrl()}/v1beta/models/${encodeURIComponent(
    options.model,
  )}:generateContent`;

  let schemaEnabled = true;
  let lastError: MediaError | null = null;
  let activePrompt = prompt;
  let completenessRetried = false;
  const attempts = config.maxRetries + 1;
  let maxAttempts = attempts;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw abortError(signal);

    const payload = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: activePrompt },
            { inline_data: { mime_type: 'audio/mp3', data: audioBase64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: options.temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
        ...(schemaEnabled ? { responseSchema: DUBBING_RESPONSE_SCHEMA } : {}),
      },
    };

    try {
      const response = await fetchUpstreamWithKeys(
        url,
        payload,
        deps.getGatewayApiKeys(),
        signal,
        config.chunkTimeoutMs,
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const message = extractUpstreamError(errorText, response.status);

        if (response.status === 401) {
          throw new MediaError(
            401,
            'upstream_auth_failed',
            `The core rejected all configured gateway API keys: ${message}`,
          );
        }
        if (schemaEnabled && isSchemaRejection(response.status, message) && attempt < attempts - 1) {
          schemaEnabled = false;
          lastError = new MediaError(
            422,
            'schema_rejected',
            `Chunk ${chunk.index + 1} was rejected with a response schema (HTTP ${
              response.status
            }): ${message}`,
            { chunkIndex: chunk.index, upstreamStatus: response.status },
          );
          await sleepWithSignal(250, signal);
          continue;
        }
        if ([400, 404, 413, 415, 422].includes(response.status)) {
          throw new MediaError(
            422,
            'model_rejected_media',
            `Chunk ${chunk.index + 1} was rejected by the model (HTTP ${response.status}): ${message}`,
            { chunkIndex: chunk.index, upstreamStatus: response.status },
          );
        }
        if ([403, 408, 429, 500, 502, 503, 504].includes(response.status)) {
          lastError = new MediaError(
            502,
            'upstream_unavailable',
            `Chunk ${chunk.index + 1} failed (HTTP ${response.status}): ${message}`,
            { chunkIndex: chunk.index, upstreamStatus: response.status },
          );
          if (attempt < attempts - 1) {
            await sleepWithSignal(backoffMs(attempt), signal);
            continue;
          }
          throw lastError;
        }
        throw new MediaError(
          502,
          'upstream_error',
          `Chunk ${chunk.index + 1} failed (HTTP ${response.status}): ${message}`,
          { chunkIndex: chunk.index, upstreamStatus: response.status },
        );
      }

      const data: any = await response.json().catch(() => null);
      const finishReason = completionFinishReason(data);
      const usage = usageFromResponse(data);
      const { text: content, thoughtCharacters } = geminiResponseAnswer(data);

      log.info(
        {
          media: {
            chunk: chunk.index + 1,
            finishReason: finishReason ?? null,
            thoughtCharacters,
            answerCharacters: content.length,
            usage,
          },
        },
        'media: dubbing model answer',
      );

      if (finishReason === 'length' || finishReason === 'max_tokens') {
        throw new MediaError(
          502,
          'model_output_truncated',
          `Chunk ${chunk.index + 1} hit the ${maxOutputTokens}-token output cap before finishing, so its dubbing script would be incomplete. Lower chunk_seconds or raise max_tokens.`,
          {
            chunkIndex: chunk.index,
            finishReason,
            maxTokens: maxOutputTokens,
            thoughtCharacters,
          },
        );
      }

      if (!content || isModelFailureText(content)) {
        const failed = Boolean(content);
        lastError = new MediaError(
          502,
          failed ? 'model_failure_text' : 'empty_model_response',
          failed
            ? `Chunk ${chunk.index + 1} returned a model failure message instead of a dubbing script. Try a simpler prompt or a different model.`
            : `Chunk ${chunk.index + 1} returned an empty model response.`,
          {
            chunkIndex: chunk.index,
            thoughtCharacters,
            ...(failed ? { model_text: content.slice(0, 1000) } : {}),
          },
        );
        const retryBudget = failed ? 2 : attempts;
        if (attempt + 1 < retryBudget) {
          await sleepWithSignal(backoffMs(attempt), signal);
          continue;
        }
        throw lastError;
      }

      const rawSegments = parseDubbingPayload(content);
      if (!rawSegments) {
        lastError = new MediaError(
          502,
          'invalid_model_json',
          `Chunk ${chunk.index + 1} did not return a JSON array of dubbing segments. Retrying with a shorter prompt may help, or choose a model with reliable JSON output.`,
          { chunkIndex: chunk.index, model_text: content.slice(0, 2000), thoughtCharacters },
        );
        if (attempt < attempts - 1) {
          await sleepWithSignal(backoffMs(attempt), signal);
          continue;
        }
        throw lastError;
      }

      const segments: DubbingSegmentInternal[] = [];
      let droppedSegments = 0;
      let cursor = 0;
      for (const raw of rawSegments) {
        const segment = normalizeDubbingSegment(raw, chunk, cursor);
        if (!segment) {
          droppedSegments++;
          continue;
        }
        segments.push(segment);
        cursor = Math.max(cursor, segment.endSeconds - chunk.startSeconds);
      }
      segments.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);

      const coveredSeconds = dubbingCoveredSeconds(
        segments,
        chunk.startSeconds,
        chunk.endSeconds,
      );
      const verdict = dubbingCoverageVerdict({
        segmentCount: segments.length,
        coveredSeconds,
        speechSeconds,
        durationSeconds: chunk.durationSeconds,
      });

      if (!verdict.ok) {
        const details = {
          chunkIndex: chunk.index,
          segmentCount: segments.length,
          coveredSeconds: verdict.coveredSeconds,
          speechSeconds: verdict.speechSeconds ?? null,
          durationSeconds: Number(chunk.durationSeconds.toFixed(2)),
          coverageRatio: verdict.ratio ?? null,
          thoughtCharacters,
        };

        // One explicit retry with the completeness prompt. It does not consume
        // the transient-failure budget, because the transport was healthy.
        if (!completenessRetried && !signal.aborted) {
          completenessRetried = true;
          maxAttempts = Math.max(maxAttempts, attempt + 2);
          activePrompt = `${prompt}\n\n${DUBBING_COMPLETENESS_RETRY_PROMPT}`;
          log.warn(
            { media: { chunk: chunk.index + 1, ...details, reason: verdict.reason } },
            'media: dubbing answer rejected as incomplete; retrying with the completeness prompt',
          );
          await sleepWithSignal(250, signal);
          continue;
        }

        const reason = verdict.reason ?? 'low_coverage';
        lastError = new MediaError(
           502,
          reason === 'empty_script' ? 'empty_model_response' : 'partial_script',
          `Chunk ${chunk.index + 1} returned ${segments.length} segment(s) covering ${verdict.coveredSeconds}s of ${verdict.speechSeconds ?? 0}s of audible speech (${Math.round(
            (verdict.ratio ?? 0) * 100,
          )}%). The script is incomplete, so the request is failed instead of silently dropping dialogue. Try a smaller chunk_seconds or a different model.`,
          details,
        );
        throw lastError;
      }

      return {
        index: chunk.index,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        segments,
        droppedSegments,
        content,
        model: typeof data?.model === 'string' ? data.model : options.model,
        maxOutputTokens,
        usage,
        speechSeconds: verdict.speechSeconds,
        coveredSeconds: verdict.coveredSeconds,
        thoughtCharacters,
      };
    } catch (error) {
      if (error instanceof MediaError) {
        if (
          error.code === 'upstream_auth_failed' ||
          error.code === 'model_rejected_media' ||
          error.code === 'model_output_truncated' ||
          error.code === 'schema_rejected' ||
          error.code === 'partial_script'
        ) {
          throw error;
        }
        lastError = error;
      } else if (isAbortError(error)) {
        throw abortError(signal);
      } else {
        lastError = new MediaError(
          502,
          'chunk_request_failed',
          `Chunk ${chunk.index + 1} request failed: ${(error as Error)?.message || String(error)}`,
          { chunkIndex: chunk.index },
        );
      }

      if (attempt < attempts - 1) {
        await sleepWithSignal(backoffMs(attempt), signal);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new MediaError(502, 'chunk_failed', 'The model request failed.');
}

export function buildDubbingResponse(input: {
  options: DubbingOptions;
  chunks: AudioChunk[];
  results: DubbingChunkResult[];
  durationSeconds: number;
  timings: { transcodeMs: number; modelMs: number; totalMs: number };
}): Record<string, any> {
  const { options, chunks, results, durationSeconds, timings } = input;
  const ordered = [...results].sort((a, b) => a.index - b.index);
  const merged = ordered
    .flatMap((result) => result.segments)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  const segments = merged.map(({ startSeconds, endSeconds, ...segment }) => ({
    ...segment,
    start_seconds: Number(startSeconds.toFixed(3)),
    end_seconds: Number(endSeconds.toFixed(3)),
  }));

  const usage = ordered.reduce<UsageTotals>(
    (sum, result) => ({
      promptTokens: sum.promptTokens + result.usage.promptTokens,
      completionTokens: sum.completionTokens + result.usage.completionTokens,
      totalTokens: sum.totalTokens + result.usage.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
  const droppedSegments = ordered.reduce((sum, result) => sum + result.droppedSegments, 0);

  const speechSeconds = ordered.reduce<number | undefined>(
    (sum, result) =>
      result.speechSeconds === undefined
        ? sum
        : (sum ?? 0) + result.speechSeconds,
    undefined,
  );
  const coveredSeconds = ordered.reduce((sum, result) => sum + result.coveredSeconds, 0);
  const coverageRatio =
    speechSeconds && speechSeconds > 0 ? coveredSeconds / speechSeconds : undefined;

  return {
    id: `dub_${crypto.randomUUID()}`,
    object: 'audio.dubbing',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    source_language: languageLabel(options.sourceLanguage) || options.sourceLanguage,
    target_language: languageLabel(options.targetLanguage) || options.targetLanguage,
    duration_seconds: Number(durationSeconds.toFixed(3)),
    chunk_count: chunks.length,
    chunk_seconds: options.chunkSeconds,
    concurrency: options.concurrency,
    segment_count: segments.length,
    segments,
    coverage: {
      speech_seconds:
        speechSeconds === undefined ? null : Number(speechSeconds.toFixed(3)),
      covered_seconds: Number(coveredSeconds.toFixed(3)),
      ratio: coverageRatio === undefined ? null : Number(coverageRatio.toFixed(3)),
    },
    chunks: ordered.map((result) => ({
      index: result.index,
      start_seconds: Number(result.startSeconds.toFixed(3)),
      end_seconds: Number(result.endSeconds.toFixed(3)),
      segment_count: result.segments.length,
      speech_seconds:
        result.speechSeconds === undefined
          ? null
          : Number(result.speechSeconds.toFixed(3)),
      covered_seconds: Number(result.coveredSeconds.toFixed(3)),
      thought_characters: result.thoughtCharacters,
      max_output_tokens: result.maxOutputTokens,
      model: result.model,
      usage: result.usage,
    })),
    usage,
    timings: {
      estimated_ms: estimatedDubbingMs(durationSeconds, options.model),
      transcode_ms: timings.transcodeMs,
      model_ms: timings.modelMs,
      total_ms: timings.totalMs,
    },
    ...(droppedSegments > 0
      ? {
          warnings: [
            `${droppedSegments} segment(s) were removed because they had no Khmer dub line or no valid timing.`,
          ],
        }
      : {}),
  };
}


/**
 * The core occasionally converts an upstream/tool failure into a normal 200
 * completion whose content is a generic error sentence. Treat that as a failed
 * chunk so the request is retried (or the caller gets a real error) instead of
 * returning the failure text as a transcript.
 */
export function isModelFailureText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('could not complete a tool call') ||
    normalized.includes('please try again or adjust the requested tool') ||
    normalized.includes('model did not return a response') ||
    normalized.includes('model failed to return a response') ||
    normalized.includes('no response from the model')
  );
}

function completionText(data: any): string {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .join('')
      .trim();
  }
  return '';
}

function completionFinishReason(data: any): string {
  const openAiReason = data?.choices?.[0]?.finish_reason;
  if (typeof openAiReason === 'string' && openAiReason.trim()) {
    return openAiReason.trim().toLowerCase();
  }
  const geminiReason =
    data?.candidates?.[0]?.finishReason ?? data?.candidates?.[0]?.finish_reason;
  if (typeof geminiReason === 'string' && geminiReason.trim()) {
    return geminiReason.trim().toLowerCase();
  }
  return '';
}

function extractUpstreamError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 2000);
  } catch {
    /* not JSON */
  }
  return text.trim().slice(0, 2000) || `HTTP ${status}`;
}

function abortError(signal: AbortSignal): MediaError {
  const reason: any = signal.reason;
  if (reason instanceof MediaError) return reason;
  if (reason?.name === 'TimeoutError') {
    return new MediaError(504, 'timeout', 'The transcription timed out before it completed.');
  }
  return new MediaError(499, 'client_closed_request', 'The client disconnected before the transcription completed.');
}

function isAbortError(error: unknown): boolean {
  const name = (error as any)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function toMediaError(error: unknown, totalTimedOut: boolean): MediaError {
  if (error instanceof MediaError) return error;
  if (isAbortError(error)) {
    if (totalTimedOut) {
      return new MediaError(504, 'total_timeout', 'The transcription exceeded the configured total timeout.');
    }
    return new MediaError(504, 'timeout', 'The transcription timed out before it completed.');
  }
  return new MediaError(500, 'internal_error', (error as Error)?.message || String(error));
}

function backoffMs(attempt: number): number {
  return Math.min(60_000, 5000 * 2 ** attempt);
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function runProcess(command: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best effort */
      }
      finish(abortError(signal));
    };

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (error: any) => {
      if (error?.code === 'ENOENT') {
        finish(
          new MediaError(
            503,
            'ffmpeg_unavailable',
            `${command} is not installed or not on PATH. Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH.`,
          ),
        );
        return;
      }
      finish(new MediaError(500, 'media_tool_failed', `${command} could not start: ${error?.message || error}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish();
      } else {
        finish(
          new MediaError(
            422,
            'media_tool_failed',
            `${command} exited with code ${code}: ${stderr.trim().slice(0, 2000) || 'no error output'}`,
          ),
        );
      }
    });

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runCapture(command: string, args: string[], signal: AbortSignal): Promise<string> {
  const { stdout } = await runCaptureWithStderr(command, args, signal);
  return stdout;
}

function runCaptureWithStderr(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error, output?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(output || { stdout: '', stderr: '' });
    };

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best effort */
      }
      finish(abortError(signal));
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 4 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new MediaError(500, 'media_probe_output_too_large', `${command} produced too much output.`));
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-64_000);
    });
    child.on('error', (error: any) => {
      if (error?.code === 'ENOENT') {
        finish(
          new MediaError(
            503,
            'ffmpeg_unavailable',
            `${command} is not installed or not on PATH. Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH.`,
          ),
        );
        return;
      }
      finish(new MediaError(500, 'media_tool_failed', `${command} could not start: ${error?.message || error}`));
    });
    child.on('close', (code) => {
      if (code === 0) finish(undefined, { stdout, stderr });
      else {
        finish(
          new MediaError(
            422,
            'invalid_media',
            `${command} exited with code ${code}: ${stderr.trim().slice(0, 2000) || 'no error output'}`,
          ),
        );
      }
    });

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/wave': '.wav',
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/aac': '.aac',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aiff': '.aiff',
    'audio/x-aiff': '.aiff',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-matroska': '.mkv',
  };
  return map[normalized] || '.bin';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort */
  }
}
