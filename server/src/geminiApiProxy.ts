import axios from 'axios';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { safeEqual } from './auth.js';
import { canonicalModelId } from './modelIds.js';
import {
  GEMINI_API_MODELS,
  estimateGeminiTokens,
  geminiApiBaseUrl,
  type GeminiApiPool,
} from './geminiApiPool.js';
import type { TrafficRecord } from './store.js';

export interface GeminiApiProxyOptions {
  pool: GeminiApiPool;
  getApiKeys: () => string[];
  recordTraffic: (record: TrafficRecord) => void;
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
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

function retryAfterMs(headers: Record<string, any>, data: any): number {
  const headerValue = headers?.['retry-after'];
  const parsedHeader = Number.parseInt(String(headerValue ?? ''), 10);
  if (Number.isFinite(parsedHeader) && parsedHeader > 0) return parsedHeader * 1000;

  const details = data?.error?.details;
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

  const model = canonicalModelId(body.model);
  if (!(GEMINI_API_MODELS as readonly string[]).includes(model)) return false;

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
  const maxAttempts = Math.max(1, options.pool.snapshot().filter((key) => key.enabled).length);

  let lastError: any = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const lease = options.pool.acquire(estimatedTokens);
    if (!lease) break;

    const startedAt = Date.now();
    let response: any;
    try {
      response = await axios.post(url, upstreamBody, {
        headers: {
          Authorization: `Bearer ${lease.record.key}`,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        responseType: stream ? 'stream' : 'json',
        validateStatus: () => true,
        timeout: timeoutMs,
      });
    } catch (error: any) {
      options.pool.markCooldown(lease.record.id, 15_000);
      lastError = { message: error?.message || String(error) };
      lastStatus = 0;
      continue;
    }

    const status = response.status || 500;
    lastStatus = status;

    if (status === 200) {
      const usage = response.data?.usage;
      const promptTokens = Number(usage?.prompt_tokens) || 0;
      const completionTokens = Number(usage?.completion_tokens) || 0;
      const totalTokens = Number(usage?.total_tokens) || promptTokens + completionTokens;

      if (!stream) {
        options.pool.recordTokens(
          lease.record.id,
          totalTokens || lease.estimatedTokens,
          lease.estimatedTokens,
        );
        options.recordTraffic({
          id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          clientName: String(request.headers['user-agent'] || 'API Client'),
          clientIp: request.ip || '127.0.0.1',
          modelRequested: model,
          modelRouted: model,
          backingAccountEmail: `Gemini API · ${lease.record.label}`,
          accountId: `gemini-api:${lease.record.id}`,
          status,
          latencyMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
          totalTokens,
          provider: 'gemini-api',
        });
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

      const finish = (completed: boolean) => {
        options.pool.recordTokens(
          lease.record.id,
          lease.estimatedTokens,
          lease.estimatedTokens,
        );
        options.recordTraffic({
          id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          clientName: String(request.headers['user-agent'] || 'API Client'),
          clientIp: request.ip || '127.0.0.1',
          modelRequested: model,
          modelRouted: model,
          backingAccountEmail: `Gemini API · ${lease.record.label}`,
          accountId: `gemini-api:${lease.record.id}`,
          status: completed ? 200 : 0,
          latencyMs: Date.now() - startedAt,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: lease.estimatedTokens,
          provider: 'gemini-api',
        });
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
        }
      });
      return true;
    }

    // Per-key limits: bench and try the next key.
    if (status === 429) {
      options.pool.markCooldown(
        lease.record.id,
        retryAfterMs(response.headers as Record<string, any>, response.data),
      );
      lastError = response.data;
      continue;
    }
    if (status === 401 || status === 403) {
      options.pool.markCooldown(lease.record.id, 5 * 60 * 1000);
      lastError = response.data;
      continue;
    }
    if (status >= 500) {
      options.pool.markCooldown(lease.record.id, 30_000);
      lastError = response.data;
      continue;
    }

    // A request-shaped error (400/404/…) will not be fixed by another key.
    options.recordTraffic({
      id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      clientName: String(request.headers['user-agent'] || 'API Client'),
      clientIp: request.ip || '127.0.0.1',
      modelRequested: model,
      modelRouted: model,
      backingAccountEmail: `Gemini API · ${lease.record.label}`,
      accountId: `gemini-api:${lease.record.id}`,
      status,
      latencyMs: Date.now() - startedAt,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      provider: 'gemini-api',
    });
    return reply.code(status).send(response.data), true;
  }

  reply
    .code(lastStatus === 0 ? 503 : 429)
    .send(
      openAiError(
        lastError?.error?.message ||
          lastError?.message ||
          'All Gemini API keys are at their rate limit or unavailable. Try again shortly.',
        lastStatus === 0 ? 503 : 429,
        'rate_limit_error',
      ),
    );
  return true;
}