import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import Busboy from 'busboy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { safeEqual } from './auth.js';

/**
 * Long-audio transcription and translation.
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
 */

export const MEDIA_ROUTE_PATHS = [
  '/v1/audio/transcriptions',
  '/v1/audio/translations',
  '/v1/media/transcriptions',
] as const;

export const MEDIA_LANGUAGES_PATH = '/v1/audio/languages';

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

interface AudioProbe {
  durationSeconds: number;
  formatName?: string;
  codec?: string;
}

interface AudioChunk {
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
  // endpoint also accepts up to 2 hours for the playground's large-media path;
  // chunks are still kept at 20 minutes by default.
  const requestedChunkSeconds = envInt('MEDIA_CHUNK_SECONDS', 20 * 60, 60, 3600);
  const chunkSeconds = Math.max(60, Math.min(requestedChunkSeconds, maxSecondsBySize));

  return {
    maxUploadBytes: envInt('MEDIA_MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024 * 1024),
    maxDurationSeconds: envInt('MEDIA_MAX_DURATION_SECONDS', 2 * 60 * 60, 60, 4 * 60 * 60),
    chunkSeconds,
    audioBitrate: `${audioBitrateKbps}k`,
    audioBitrateKbps,
    jsonBodyLimitBytes: envInt('MEDIA_JSON_BODY_LIMIT_BYTES', 96 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024),
    chunkTimeoutMs: envInt('MEDIA_CHUNK_TIMEOUT_MS', 15 * 60 * 1000, 30_000, 60 * 60 * 1000),
    transcodeTimeoutMs: envInt('MEDIA_TRANSCODE_TIMEOUT_MS', 30 * 60 * 1000, 30_000, 2 * 60 * 60 * 1000),
    totalTimeoutMs: envInt('MEDIA_TOTAL_TIMEOUT_MS', 2 * 60 * 60 * 1000, 0, 4 * 60 * 60 * 1000),
    maxRetries: envInt('MEDIA_MAX_RETRIES', 2, 0, 5),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    keepArtifacts: process.env.MEDIA_KEEP_ARTIFACTS === '1',
  };
}

export function isMediaUploadPath(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return (
    (MEDIA_ROUTE_PATHS as readonly string[]).includes(pathname) ||
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
        handleAudioTranscription(request, reply, deps, {
          forceTranslate: translationRoute,
        }),
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
    : 32768;

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

async function probeAudio(filePath: string, config: MediaConfig, signal: AbortSignal): Promise<AudioProbe> {
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

async function splitAudio(
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
      const content = completionText(data);
      if (!content || isModelFailureText(content)) {
        const failed = Boolean(content);
        lastError = new MediaError(
          502,
          failed ? 'model_failure_text' : 'empty_model_response',
          failed
            ? `Chunk ${chunk.index + 1} returned a model failure message instead of a transcript.`
            : `Chunk ${chunk.index + 1} returned an empty model response.`,
          {
            chunkIndex: chunk.index,
            ...(failed ? { model_text: content.slice(0, 1000) } : {}),
          },
        );
        if (attempt < attempts - 1) {
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
        if (error.code === 'upstream_auth_failed' || error.code === 'model_rejected_media') throw error;
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

function runCapture(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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

    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(output || '');
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
      if (code === 0) finish(undefined, stdout);
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
