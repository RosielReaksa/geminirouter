/**
 * Public TTS API on the bridge.
 *
 * `POST /v1/audio/speech` and `GET /v1/audio/voices` are the public surface; the
 * actual speech is made by the internal ``tts-server`` process (Edge TTS behind
 * the Webshare proxy pool). The bridge owns authentication, metering and the
 * concurrency gate, so callers use the same `sk-gw-…` keys as every other
 * `/v1` route and usage lands on the same Traffic page.
 *
 * The TTS service is loopback-only and never sees a public key: it trusts the
 * shared internal secret the bridge sends.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TrafficRecord } from './store.js';
import { getSharedTtsGate } from './ttsGate.js';

export interface TtsRouteDeps {
  /** All keys the gateway accepts (named + master + env + core). */
  getApiKeys: () => string[];
  /**
   * Resolve the caller's named key identity. Mirrors the bridge's existing
   * `authenticateGatewayKey`: `required` is true when a key is configured and
   * the request did not present a valid one.
   */
  getKeyIdentity: (
    request: FastifyRequest,
  ) => { required: boolean; identity: { id: string; name: string } | null };
  recordTraffic: (record: TrafficRecord) => void;
}

interface SpeechBody {
  input?: unknown;
  text?: unknown;
  model?: unknown;
  voice?: unknown;
  language?: unknown;
  response_format?: unknown;
  speed?: unknown;
  timestamp_granularities?: unknown;
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

function serviceUrl(): string {
  return (process.env.TTS_URL || 'http://127.0.0.1:8077').replace(/\/$/, '');
}

function internalSecret(): string {
  return process.env.TTS_INTERNAL_SECRET || '';
}

function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.TTS_RESPONSE_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** OpenAI uses `input`; the internal service uses `text`. Accept both. */
function readText(body: SpeechBody): string {
  if (typeof body.input === 'string') return body.input.trim();
  if (typeof body.text === 'string') return body.text.trim();
  return '';
}

function readWordsRequested(body: SpeechBody): boolean {
  const value = body.timestamp_granularities;
  if (!Array.isArray(value)) return false;
  return value.some((item) => String(item).toLowerCase() === 'word');
}

function openAiError(message: string, code: number, type = 'invalid_request_error') {
  return { error: { message, type, code } };
}

/**
 * Authenticate and authorize a TTS request. Returns the identity, or writes the
 * 401 response and returns null.
 */
function authorize(request: FastifyRequest, reply: FastifyReply, deps: TtsRouteDeps) {
  const auth = deps.getKeyIdentity(request);
  if (!auth.required) return { id: 'open', name: 'Open gateway' };
  if (!auth.identity) {
    reply.code(401).send(openAiError('Invalid API key.', 401, 'auth_error'));
    return null;
  }
  return auth.identity;
}

export function registerTtsRoutes(app: FastifyInstance, deps: TtsRouteDeps): void {
  const url = serviceUrl();
  const secret = internalSecret();

  app.get('/v1/audio/voices', async (request, reply) => {
    const identity = authorize(request, reply, deps);
    if (!identity) return reply;

    try {
      const response = await fetch(`${url}/voices`, {
        headers: { 'x-geminirouter-internal': secret },
        signal: AbortSignal.timeout(timeoutMs()),
      });
      if (!response.ok) {
        return reply
          .code(response.status === 401 ? 502 : response.status)
          .send(openAiError('The TTS service could not list voices.', 502));
      }
      return reply
        .header('x-egress-provider', 'tts')
        .send(await response.json());
    } catch (error: any) {
      request.log.warn({ err: error?.message }, 'tts: voice listing failed');
      return reply.code(502).send(openAiError('The TTS service is unavailable.', 502));
    }
  });

  app.post('/v1/audio/speech', async (request, reply) => {
    const identity = authorize(request, reply, deps);
    if (!identity) return reply;

    const body = (request.body || {}) as SpeechBody;
    const text = readText(body);
    if (!text) {
      return reply.code(400).send(openAiError('A non-empty "input" field is required.', 400));
    }

    const format = asString(body.response_format || 'mp3').toLowerCase();
    if (!CONTENT_TYPES[format]) {
      return reply
        .code(400)
        .send(
          openAiError(
            `response_format must be one of ${Object.keys(CONTENT_TYPES).join(', ')}.`,
            400,
          ),
        );
    }

    const voice = asString(body.voice);
    const language = asString(body.language);
    const speed = typeof body.speed === 'number' && Number.isFinite(body.speed) ? body.speed : 1.0;
    const includeWords = readWordsRequested(body);
    const requestedModel = asString(body.model) || 'tts-1';

    const gate = getSharedTtsGate();
    const admission = await gate.acquire();
    if (!admission.ok) {
      reply.header('Retry-After', '30');
      return reply
        .code(503)
        .send(
          openAiError(
            admission.reason === 'timeout'
              ? 'The TTS queue wait timed out. Retry with the same request.'
              : 'The TTS queue is full. Try again shortly.',
            503,
            'rate_limit_error',
          ),
        );
    }

    const startedAt = Date.now();
    try {
      const upstream = await fetch(`${url}/speech`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-geminirouter-internal': secret,
        },
        body: JSON.stringify({
          text,
          voice,
          language,
          response_format: format,
          speed,
          timestamp_granularities: includeWords ? ['word'] : [],
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      });

      const contentType = String(upstream.headers.get('content-type') || '');
      const payload = Buffer.from(await upstream.arrayBuffer());

      const characters = Number(upstream.headers.get('x-tts-characters')) || text.length;
      const seconds = Number(upstream.headers.get('x-tts-seconds')) || 0;
      const servedVoice = asString(upstream.headers.get('x-tts-voice')) || voice || 'edge';

      deps.recordTraffic({
        id: `tr-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        clientName: String(request.headers['user-agent'] || 'API Client'),
        clientIp: request.ip || '127.0.0.1',
        modelRequested: requestedModel,
        modelRouted: 'edge-tts',
        backingAccountEmail: 'TTS · Edge',
        status: upstream.status,
        latencyMs: Date.now() - startedAt,
        promptTokens: characters,
        completionTokens: 0,
        totalTokens: 0,
        provider: 'tts',
        gatewayKeyId: identity.id,
        gatewayKeyName: identity.name,
        voice: servedVoice,
        inputCharacters: characters,
        outputSeconds: seconds || undefined,
      });

      if (!upstream.ok) {
        let detail = 'The TTS service rejected the request.';
        try {
          const parsed = JSON.parse(payload.toString('utf8'));
          detail = parsed?.detail || parsed?.error?.message || detail;
        } catch {
          /* keep the default */
        }
        return reply.code(upstream.status === 400 ? 400 : 502).send(openAiError(detail, 502));
      }

      const headers: Record<string, string> = {
        'x-egress-provider': 'tts',
        'x-tts-characters': String(characters),
        'x-tts-voice': servedVoice,
        'x-tts-ms': String(Date.now() - startedAt),
      };
      if (seconds) headers['x-tts-seconds'] = String(seconds);

      if (contentType.includes('application/json')) {
        return reply
          .header('content-type', 'application/json')
          .headers(headers)
          .send(payload.toString('utf8'));
      }

      return reply
        .header('content-type', CONTENT_TYPES[format])
        .headers(headers)
        .send(payload);
    } catch (error: any) {
      request.log.warn({ err: error?.message }, 'tts: speech request failed');
      return reply
        .code(502)
        .send(openAiError('The TTS service is unavailable. Try again shortly.', 502));
    } finally {
      gate.release();
    }
  });
}
