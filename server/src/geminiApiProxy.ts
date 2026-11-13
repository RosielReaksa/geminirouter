import axios from 'axios';
import type { HttpsProxyAgent } from 'https-proxy-agent';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { safeEqual } from './auth.js';
import { canonicalModelId } from './modelIds.js';
import {
  GEMINI_API_MODELS,
  estimateGeminiTokens,
  geminiApiBaseUrl,
  type GeminiApiLease,
  type GeminiApiPool,
} from './geminiApiPool.js';
import type { TrafficRecord } from './store.js';

export interface GeminiApiProxyOptions {
  pool: GeminiApiPool;
  getApiKeys: () => string[];
  recordTraffic: (record: TrafficRecord) => void;
  /** Optional per-key proxy agent (Webshare). Null means direct. */
  getProxyAgent?: (keyId: string) => HttpsProxyAgent<string> | null;
  /** Called when a key's proxy gets a 429/timeout; the key is retried direct. */
  onProxyRateLimited?: (keyId: string) => void;
  /** Named gateway/client key that authenticated this request. */
  gatewayKey?: { id: string; name: string } | null;
  /**
   * Choose the shared model the key pool should serve for this request. Return
   * null to send the request to the OAuth account pool instead.
   */
  chooseKeyModel?: (model: string) => string | null;
  /**
   * Per-request override of the shared-model routing. `keys` forces the key
   * pool, `accounts` forces the OAuth pool. Used by the dubbing pipeline to
   * retry on the key pool when every account is unavailable.
   */
  forceRouting?: 'keys' | 'accounts';
}

function servedModelFor(
  requestedModel: string,
  options: GeminiApiProxyOptions,
): string | null {
  if (options.forceRouting === 'keys') return requestedModel;
  if (options.forceRouting === 'accounts') return null;
  return options.chooseKeyModel
    ? options.chooseKeyModel(requestedModel)
    : requestedModel;
}

function parseJsonBody(request: FastifyRequest): any | null {
  const body = request.body as any;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers['authorization'];
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  // Gemini-native clients (the dubbing pipeline) authenticate with
  // x-goog-api-key, not Bearer. Without this the key pool would reject every
  // native request as unauthenticated.
  const googKey = request.headers['x-goog-api-key'];
  if (typeof googKey === 'string' && googKey.trim()) return googKey.trim();
  return undefined;
}

function upstreamErrorBody(data: any): any {
  return Array.isArray(data) ? data[0] : data;
}

/**
 * True when the chat body carries inline video.
 *
 * The Gemini API key pool calls Google's OpenAI-compatible endpoint
 * (`/v1beta/openai/chat/completions`), which does not accept a `video_url`
 * content part and answers
 *   400 INVALID_ARGUMENT: Invalid content part type: video_url
 * The OAuth account pool accepts the same body through the native API.
 *
 * Balanced routing alternated between the two backends, so an identical video
 * request returned 200 on account turns and 400 on key turns - roughly half of
 * all video calls failed at random. Detecting video here and declining the
 * request sends it to the account pool, which can serve it.
 */
function hasInlineVideo(body: any): boolean {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const type = typeof part?.type === 'string' ? part.type : '';
      if (type === 'video_url' || type === 'input_video' || type === 'video') return true;
      if (part?.video_url || part?.inline_data?.mime_type?.startsWith?.('video/')) return true;
    }
  }
  return false;
}

function retryAfterMs(headers: Record<string, any>, data: any): number {
  const headerValue = headers?.['retry-after'];
  const parsedHeader = Number.parseInt(String(headerValue ?? ''), 10);
  if (Number.isFinite(parsedHeader) && parsedHeader > 0) return parsedHeader * 1000;

  // The OpenAI-compatible endpoint can return the Google error as a one-item
  // array. Look inside it for the RetryInfo delay (daily quota resets use an
  // hours-long delay that must not be truncated to one minute).
  const body = Array.isArray(data) ? data[0] : data;
  const details = body?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const delay = String(detail?.retryDelay ?? '');
      const match = /^(\d+(?:\.\d+)?)s$/.exec(delay);
      if (match) return Math.ceil(Number(match[1]) * 1000);
    }
  }
  return 60_000;
}

function openAiError(message: string, code: number, type = 'gateway_error') {
  return { error: { message, type, code } };
}

function clientIdentity(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.ip || 'unknown';
}

/**
 * Serves the two AI Studio models with a pool of Google API keys.
 *
 * Returns false when the request is for another model or no keys are configured,
 * so the caller can fall back to the account pool. When it handles the request it
 * writes the response itself and returns true.
 */
export async function handleGeminiApiRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: GeminiApiProxyOptions,
): Promise<boolean> {
  const path = (request.raw.url || request.url || '').split('?')[0];
  if (request.method !== 'POST' || path !== '/v1/chat/completions') return false;
  if (!options.pool.hasEnabledKeys()) return false;

  const body = parseJsonBody(request);
  if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) return false;

  const requestedModel = canonicalModelId(body.model);
  if (!(GEMINI_API_MODELS as readonly string[]).includes(requestedModel)) return false;

  // The key pool speaks Google's OpenAI-compatible protocol, which rejects
  // inline video. Hand video to the account pool instead of failing half the
  // calls on a coin flip of routing.
  if (hasInlineVideo(body)) return false;

  // The two shared models can also be served by the OAuth account pool. Balanced
  // routing returns null here for account turns; the requested model is always
  // preserved.
  const servedModel = servedModelFor(requestedModel, options);
  if (!servedModel) return false;
  const model = (GEMINI_API_MODELS as readonly string[]).includes(servedModel)
    ? servedModel
    : requestedModel;

  // /v1 is public at the bridge; without this check the key pool would be an
  // unauthenticated gateway. An empty configuration keeps local dev open.
  const configuredKeys = options.getApiKeys().map((key) => key.trim()).filter(Boolean);
  if (configuredKeys.length > 0) {
    const clientKey = extractBearer(request);
    if (!clientKey || !configuredKeys.some((key) => safeEqual(key, clientKey))) {
      reply.code(401).send(openAiError('Invalid API key.', 401, 'auth_error'));
      return true;
    }
  }

  const stream = body.stream === true;
  const upstreamBody = { ...body, model };
  const estimatedTokens = estimateGeminiTokens(upstreamBody);
  const timeoutMs = Math.max(
    5_000,
    Number.parseInt(process.env.GEMINI_API_TIMEOUT_MS || '300000', 10) || 300000,
  );
  const url = `${geminiApiBaseUrl()}/v1beta/openai/chat/completions`;
  const clientId = clientIdentity(request);
  const maxAttempts = Math.max(1, options.pool.snapshot().filter((key) => key.enabled).length);

  const abort = new AbortController();
  const onAborted = () => abort.abort();
  request.raw.on('aborted', onAborted);
  const releaseAbort = () => {
    try {
      request.raw.off('aborted', onAborted);
    } catch {
      // best effort
    }
  };

  const record = (
    lease: GeminiApiLease,
    status: number,
    startedAt: number,
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
  ) => {
    options.recordTraffic({
      id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      clientName: String(request.headers['user-agent'] || 'API Client'),
      clientIp: request.ip || '127.0.0.1',
      modelRequested: requestedModel,
      modelRouted: model,
      backingAccountEmail: `Gemini API · ${lease.record.label}`,
      accountId: `gemini-api:${lease.record.id}`,
      status,
      latencyMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
      totalTokens,
      provider: 'gemini-api',
      ...(options.gatewayKey
        ? { gatewayKeyId: options.gatewayKey.id, gatewayKeyName: options.gatewayKey.name }
        : {}),
    });
  };

  let lastError: any = null;
  let lastStatus = 0;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const lease = await options.pool.acquire(
        model,
        estimatedTokens,
        clientId,
        abort.signal,
      );
      if (!lease) break;

      const startedAt = Date.now();
      const proxyAgent = options.getProxyAgent?.(lease.record.id) ?? null;
      const post = (agent: HttpsProxyAgent<string> | null) =>
        axios.post(url, upstreamBody, {
          headers: {
            Authorization: `Bearer ${lease.record.key}`,
            'Content-Type': 'application/json',
            Accept: stream ? 'text/event-stream' : 'application/json',
          },
          responseType: stream ? 'stream' : 'json',
          validateStatus: () => true,
          timeout: timeoutMs,
          ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
          proxy: false,
        });

      let response: any;
      try {
        response = await post(proxyAgent);
        // A proxy IP can be throttled by Google while the key itself is fine.
        // Skip that proxy and retry the same key directly before benching it.
        if (proxyAgent && response.status === 429) {
          options.onProxyRateLimited?.(lease.record.id);
          response = await post(null);
        }
      } catch (error: any) {
        if (!proxyAgent) {
          options.pool.settle(lease, { cooldownMs: 15_000, reason: 'error' });
          lastError = { message: error?.message || String(error) };
          lastStatus = 0;
          continue;
        }
        options.onProxyRateLimited?.(lease.record.id);
        try {
          response = await post(null);
        } catch (directError: any) {
          options.pool.settle(lease, { cooldownMs: 15_000, reason: 'error' });
          lastError = { message: directError?.message || String(directError) };
          lastStatus = 0;
          continue;
        }
      }

      const status = response.status || 500;
      lastStatus = status;

      if (status === 200) {
        const usage = response.data?.usage;
        const promptTokens = Number(usage?.prompt_tokens) || 0;
        const completionTokens = Number(usage?.completion_tokens) || 0;
        const totalTokens = Number(usage?.total_tokens) || promptTokens + completionTokens;

        if (!stream) {
          options.pool.settle(lease, { actualTokens: totalTokens || lease.estimatedTokens });
          record(lease, status, startedAt, promptTokens, completionTokens, totalTokens);
          releaseAbort();
          reply.header('x-egress-provider', 'gemini-api');
          return reply.code(status).send(response.data), true;
        }

        const streamData = response.data as NodeJS.ReadableStream;
        const headers = response.headers as Record<string, any>;
        // Take over the raw response: Fastify must not finalize it before the
        // upstream SSE stream ends.
        reply.hijack();
        reply.raw.statusCode = status;
        reply.raw.setHeader(
          'content-type',
          String(headers['content-type'] || 'text/event-stream'),
        );
        reply.raw.setHeader('cache-control', 'no-cache');
        reply.raw.setHeader('x-egress-provider', 'gemini-api');
        streamData.pipe(reply.raw);

        let finished = false;
        const finish = (completed: boolean) => {
          if (finished) return;
          finished = true;
          options.pool.settle(lease, {
            actualTokens: lease.estimatedTokens,
            ...(completed ? {} : { cooldownMs: 5_000 }),
          });
          record(lease, completed ? 200 : 0, startedAt, 0, 0, lease.estimatedTokens);
          releaseAbort();
        };
        streamData.on('end', () => finish(true));
        streamData.on('error', () => finish(false));
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) {
            try {
              (streamData as any).destroy?.();
            } catch {
              // best effort
            }
            finish(false);
          }
        });
        return true;
      }

      // Per-key limits: bench this key/model and try the next key. A 429 is usually
  // per project, so another key may still have quota for the same model.
      if (status === 429) {
        const cooldown = retryAfterMs(response.headers as Record<string, any>, response.data);
        options.pool.settle(lease, {
          cooldownMs: cooldown,
          reason: cooldown >= 5 * 60 * 1000 ? 'daily' : 'rate',
        });
        lastError = upstreamErrorBody(response.data);
        continue;
      }
      if (status === 401 || status === 403) {
        options.pool.settle(lease, { cooldownMs: 5 * 60 * 1000, keyWide: true, reason: 'error' });
        lastError = upstreamErrorBody(response.data);
        continue;
      }
      if (status >= 500) {
        options.pool.settle(lease, { cooldownMs: 30_000, reason: 'error' });
        lastError = upstreamErrorBody(response.data);
        continue;
      }

      // A request-shaped error (400/404/…) will not be fixed by another key.
      // The exception is a media capability rejection: Google's OpenAI-compatible
      // endpoint says the content type is invalid, which tells us about this
      // egress path, not about the request. Try the remaining keys before
      // giving up, then let the caller see the real reason.
      const capabilityRejected =
        status === 400 &&
        /invalid content part type|invalid content type|unsupported content type|not supported/i.test(
          String(
            upstreamErrorBody(response.data)?.error?.message ||
              upstreamErrorBody(response.data)?.message ||
              '',
          ),
        );
      if (capabilityRejected) {
        options.pool.settle(lease, { cooldownMs: 60_000, reason: 'error' });
        lastError = upstreamErrorBody(response.data);
        continue;
      }

      options.pool.settle(lease, { actualTokens: 0 });
      record(lease, status, startedAt, 0, 0, 0);
      releaseAbort();
      return reply.code(status).send(response.data), true;
    }

    const retryAfterSec = Math.max(1, Math.ceil(options.pool.nextAvailabilityMs(model) / 1000));
    reply.header('Retry-After', String(retryAfterSec));
    reply
      .code(429)
      .send(
        openAiError(
          lastError?.error?.message ||
            lastError?.message ||
            'All Gemini API keys are at their rate limit or unavailable. Try again shortly.',
          429,
          'rate_limit_error',
        ),
      );
    return true;
  } finally {
    releaseAbort();
  }
}

/** `/v1beta/models/<model>:generateContent` — the Gemini-native path the
 *  dubbing pipeline uses. */
const NATIVE_GENERATE_RE = /^\/v1beta\/models\/([^/:?]+):generateContent$/;

function googleErrorBody(message: string, code: number, status: string) {
  return { error: { code, message, status } };
}

/**
 * Rough prompt-token estimate for a native Gemini body, used only for key
 * admission control. Audio is charged at ~32 tokens per second (16 kHz mono PCM
 * is ~32 kB/s, i.e. one token per kilobyte of decoded media).
 */
export function estimateNativeGeminiTokens(body: any): number {
  let characters = 0;
  let mediaBytes = 0;
  for (const content of Array.isArray(body?.contents) ? body.contents : []) {
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      if (typeof part?.text === 'string') characters += part.text.length;
      const inline = part?.inline_data || part?.inlineData;
      const data = inline?.data;
      if (typeof data === 'string') mediaBytes += Math.floor((data.length * 3) / 4);
      if (part?.file_data || part?.fileData) mediaBytes += 2 * 1024 * 1024;
    }
  }
  const maxOut = Number(body?.generationConfig?.maxOutputTokens) || 8192;
  return Math.max(
    1,
    Math.ceil(characters / 4 + mediaBytes / 1000) +
      Math.min(Math.max(maxOut, 1), 65_536),
  );
}

function nativeUsage(body: any) {
  const usage = body?.usageMetadata || {};
  const promptTokens = Number(usage.promptTokenCount) || 0;
  const completionTokens = Number(usage.candidatesTokenCount) || 0;
  const totalTokens = Number(usage.totalTokenCount) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Serve `/v1beta/models/<flash-lite>:generateContent` from the AI Studio key
 * pool when routing selects keys.
 *
 * Before this, only `/v1/chat/completions` could reach the key pool: the native
 * path always fell through to the OAuth account pool. The dubbing pipeline uses
 * the native path, so the keys bought for it were never used and every
 * transcription consumed account quota instead.
 *
 * The body is forwarded unchanged (contents, generationConfig, responseSchema,
 * inline audio), so the response is equivalent to a direct AI Studio call.
 */
export async function handleGeminiApiNativeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: GeminiApiProxyOptions,
): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const path = (request.raw.url || request.url || '').split('?')[0];
  const match = NATIVE_GENERATE_RE.exec(path);
  if (!match) return false;
  if (!options.pool.hasEnabledKeys()) return false;

  let requestedModel = match[1];
  try {
    requestedModel = decodeURIComponent(match[1]);
  } catch {
    /* keep the raw id */
  }
  requestedModel = canonicalModelId(requestedModel);
  if (!(GEMINI_API_MODELS as readonly string[]).includes(requestedModel)) return false;

  // Balanced routing: null means this turn belongs to the account pool.
  const servedModel = servedModelFor(requestedModel, options);
  if (!servedModel) return false;

  const configuredKeys = options.getApiKeys().map((key) => key.trim()).filter(Boolean);
  if (configuredKeys.length > 0) {
    const clientKey = extractBearer(request);
    if (!clientKey || !configuredKeys.some((key) => safeEqual(key, clientKey))) {
      reply
        .code(401)
        .send(googleErrorBody('API key validation failed', 401, 'UNAUTHENTICATED'));
      return true;
    }
  }

  const body = parseJsonBody(request);
  if (!body) return false;
  const estimatedTokens = estimateNativeGeminiTokens(body);
  const timeoutMs = Math.max(
    5_000,
    Number.parseInt(process.env.GEMINI_API_TIMEOUT_MS || '300000', 10) || 300000,
  );
  const url = `${geminiApiBaseUrl()}/v1beta/models/${encodeURIComponent(
    servedModel,
  )}:generateContent`;
  const clientId = clientIdentity(request);
  const maxAttempts = Math.max(
    1,
    options.pool.snapshot().filter((key) => key.enabled).length,
  );

  const abort = new AbortController();
  const onAborted = () => abort.abort();
  request.raw.on('aborted', onAborted);
  const releaseAbort = () => {
    try {
      request.raw.off('aborted', onAborted);
    } catch {
      /* best effort */
    }
  };

  const record = (
    lease: GeminiApiLease,
    status: number,
    startedAt: number,
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
  ) => {
    options.recordTraffic({
      id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      clientName: String(request.headers['user-agent'] || 'API Client'),
      clientIp: request.ip || '127.0.0.1',
      modelRequested: requestedModel,
      modelRouted: servedModel,
      backingAccountEmail: `Gemini API · ${lease.record.label}`,
      accountId: `gemini-api:${lease.record.id}`,
      status,
      latencyMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
      totalTokens,
      provider: 'gemini-api',
      ...(options.gatewayKey
        ? { gatewayKeyId: options.gatewayKey.id, gatewayKeyName: options.gatewayKey.name }
        : {}),
    });
  };

  let lastError: any = null;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const lease = await options.pool.acquire(
        servedModel,
        estimatedTokens,
        clientId,
        abort.signal,
      );
      if (!lease) break;

      const startedAt = Date.now();
      const proxyAgent = options.getProxyAgent?.(lease.record.id) ?? null;
      const post = (agent: HttpsProxyAgent<string> | null) =>
        axios.post(url, body, {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-goog-api-key': lease.record.key,
          },
          validateStatus: () => true,
          timeout: timeoutMs,
          ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
          proxy: false,
        });

      let response: any;
      try {
        response = await post(proxyAgent);
        if (proxyAgent && response.status === 429) {
          options.onProxyRateLimited?.(lease.record.id);
          response = await post(null);
        }
      } catch (error: any) {
        if (proxyAgent) {
          options.onProxyRateLimited?.(lease.record.id);
          try {
            response = await post(null);
          } catch (directError: any) {
            options.pool.settle(lease, { cooldownMs: 15_000, reason: 'error' });
            lastError = { message: directError?.message || String(directError) };
            continue;
          }
        } else {
          options.pool.settle(lease, { cooldownMs: 15_000, reason: 'error' });
          lastError = { message: error?.message || String(error) };
          continue;
        }
      }

      const status = response.status || 500;
      if (status === 200) {
        const usage = nativeUsage(response.data);
        options.pool.settle(lease, {
          actualTokens: usage.totalTokens || lease.estimatedTokens,
        });
        record(
          lease,
          status,
          startedAt,
          usage.promptTokens,
          usage.completionTokens,
          usage.totalTokens,
        );
        releaseAbort();
        reply.header('x-egress-provider', 'gemini-api');
        return reply.code(status).send(response.data), true;
      }

      if (status === 429) {
        const cooldown = retryAfterMs(response.headers as Record<string, any>, response.data);
        options.pool.settle(lease, {
          cooldownMs: cooldown,
          reason: cooldown >= 5 * 60 * 1000 ? 'daily' : 'rate',
        });
        lastError = upstreamErrorBody(response.data);
        continue;
      }
      if (status === 401 || status === 403) {
        options.pool.settle(lease, {
          cooldownMs: 5 * 60 * 1000,
          keyWide: true,
          reason: 'error',
        });
        lastError = upstreamErrorBody(response.data);
        continue;
      }
      if (status >= 500) {
        options.pool.settle(lease, { cooldownMs: 30_000, reason: 'error' });
        lastError = upstreamErrorBody(response.data);
        continue;
      }

      // Any other 4xx is about the request itself; another key will not fix it.
      options.pool.settle(lease, { actualTokens: 0 });
      record(lease, status, startedAt, 0, 0, 0);
      releaseAbort();
      return reply.code(status).send(response.data), true;
    }

    const retryAfterSec = Math.max(
      1,
      Math.ceil(options.pool.nextAvailabilityMs(servedModel) / 1000),
    );
    reply.header('Retry-After', String(retryAfterSec));
    reply
      .code(429)
      .send(
        googleErrorBody(
          lastError?.error?.message ||
            lastError?.message ||
            'All Gemini API keys are at their rate limit or unavailable. Try again shortly.',
          429,
          'RESOURCE_EXHAUSTED',
        ),
      );
    return true;
  } finally {
    releaseAbort();
  }
}