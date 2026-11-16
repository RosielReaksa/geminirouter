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
import { keyPoolModelFor, type GeminiApiProxyOptions } from './geminiApiProxy.js';

/**
 * `/v1/responses` (OpenAI Responses API) served from the AI Studio key pool.
 *
 * The Responses API is a different wire protocol from the key pool's
 * OpenAI-compatible `/v1beta/openai/chat/completions`: it names items
 * `input`/`output`, carries reasoning items, and streams `response.*` SSE
 * events instead of `chat.completion.chunk`. This module translates in both
 * directions so a Responses client (ZCode's `openai-responses` provider, for
 * example) can be served by the same key pool as chat, instead of falling
 * through to the quota-limited OAuth account pool.
 *
 * Everything here is best-effort with a hard fallback: the handler returns
 * false for anything it cannot translate confidently, and the caller then uses
 * the account pool exactly as before. A translation gap therefore degrades to
 * the old behaviour, never to a broken request.
 */

const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_LIMIT = 512;

interface SessionEntry {
  messages: any[];
  model: string;
  updatedAt: number;
}

/**
 * Response-id -> conversation. The Responses API is stateful: a client sends
 * `previous_response_id` instead of replaying the whole history. The key pool
 * is stateless, so the bridge remembers the last turn per response id.
 */
const sessions = new Map<string, SessionEntry>();

function pruneSessions(now: number): void {
  if (sessions.size <= SESSION_LIMIT) {
    for (const [id, entry] of sessions) {
      if (now - entry.updatedAt > SESSION_TTL_MS) sessions.delete(id);
    }
    return;
  }
  const entries = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [id] of entries.slice(0, sessions.size - SESSION_LIMIT)) sessions.delete(id);
  for (const [id, entry] of sessions) {
    if (now - entry.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function recallSession(responseId: unknown): SessionEntry | null {
  if (typeof responseId !== 'string' || !responseId.trim()) return null;
  const entry = sessions.get(responseId.trim());
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
    sessions.delete(responseId.trim());
    return null;
  }
  return entry;
}

function rememberSession(responseId: string, messages: any[], model: string): void {
  pruneSessions(Date.now());
  sessions.set(responseId, { messages, model, updatedAt: Date.now() });
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRole(role: unknown): string {
  const value = typeof role === 'string' ? role.toLowerCase() : 'user';
  if (value === 'assistant' || value === 'tool') return value;
  if (value === 'developer') return 'system';
  if (value === 'system') return 'system';
  return 'user';
}

interface ContentMapping {
  content: unknown;
  hasImage: boolean;
  hasVideo: boolean;
}

/**
 * Responses content parts -> OpenAI-compatible content.
 *
 * Text parts are concatenated into a plain string when there is no media (the
 * shape Google's endpoint likes best); with media the content becomes an array
 * of `text` / `image_url` parts. `input_file` parts are dropped: the key pool's
 * OpenAI-compatible endpoint does not accept them, and silently fabricating
 * their contents would be worse than omitting them.
 */
export function responsesContentToChat(content: unknown): ContentMapping {
  if (typeof content === 'string') return { content, hasImage: false, hasVideo: false };
  if (!Array.isArray(content)) {
    return { content: content == null ? '' : String(content), hasImage: false, hasVideo: false };
  }

  const parts: any[] = [];
  let hasImage = false;
  let hasVideo = false;
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const type = typeof (raw as any).type === 'string' ? String((raw as any).type) : '';
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      if (typeof (raw as any).text === 'string') parts.push({ type: 'text', text: (raw as any).text });
    } else if (type === 'input_image' || type === 'image_url' || type === 'image') {
      const url = (raw as any).image_url?.url ?? (raw as any).url ?? (raw as any).image_url;
      if (typeof url === 'string' && url) {
        parts.push({ type: 'image_url', image_url: { url } });
        hasImage = true;
      }
    } else if (type === 'input_video' || type === 'video') {
      hasVideo = true;
    }
    // input_file and unknown parts are intentionally dropped.
  }

  if (parts.length === 0) return { content: '', hasImage, hasVideo };
  if (!hasImage) {
    return { content: parts.map((part) => part.text).join(''), hasImage, hasVideo };
  }
  return { content: parts, hasImage, hasVideo };
}

export interface ResponsesToChat {
  model: string;
  messages: any[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: unknown;
  tools?: any[];
  tool_choice?: unknown;
  hasImage: boolean;
  hasVideo: boolean;
}

/**
 * Responses `input` (string | items) -> chat messages.
 *
 * Reasoning items are skipped: they are the model's own earlier reasoning, and
 * Google reproduces reasoning per request. Function calls map to `tool_calls`
 * and their outputs to `role: 'tool'` messages so tool loops keep working.
 */
export function responsesInputToChat(input: unknown): {
  messages: any[];
  hasImage: boolean;
  hasVideo: boolean;
} {
  const messages: any[] = [];
  let hasImage = false;
  let hasVideo = false;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return { messages, hasImage, hasVideo };
  }
  if (!Array.isArray(input)) return { messages, hasImage, hasVideo };

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as any;
    const type = typeof item.type === 'string' ? item.type : 'message';

    if (type === 'message' || type === '' || type === undefined) {
      const mapped = responsesContentToChat(item.content);
      hasImage = hasImage || mapped.hasImage;
      hasVideo = hasVideo || mapped.hasVideo;
      if (mapped.content === '' && !mapped.hasImage) continue;
      messages.push({ role: normalizeRole(item.role), content: mapped.content });
      continue;
    }

    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || randomId('call'),
            type: 'function',
            function: {
              name: typeof item.name === 'string' ? item.name : '',
              arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
            },
          },
        ],
      });
      continue;
    }

    if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.call_id || '',
        content:
          typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
      continue;
    }

    if (type === 'reasoning') continue;

    // Unknown item carrying a role: treat it as a message rather than dropping it.
    if (typeof item.role === 'string') {
      const mapped = responsesContentToChat(item.content);
      hasImage = hasImage || mapped.hasImage;
      hasVideo = hasVideo || mapped.hasVideo;
      messages.push({ role: normalizeRole(item.role), content: mapped.content });
    }
  }

  return { messages, hasImage, hasVideo };
}

function responsesToolsToChat(tools: unknown): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const mapped: any[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = raw as any;
    if (tool.type !== 'function' && !tool.function) continue;
    const fn = tool.function ?? tool;
    if (typeof fn.name !== 'string' || !fn.name) continue;
    const parameters = fn.parameters ?? fn.input_schema ?? { type: 'object', properties: {} };
    mapped.push({
      type: 'function',
      function: {
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        parameters,
      },
    });
  }
  return mapped.length ? mapped : undefined;
}

/**
 * Translate a Responses request body into a chat-completions body.
 * Returns null when the request is not translatable.
 */
export function responsesToChatBody(body: any): ResponsesToChat | null {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.model !== 'string' || !body.model.trim()) return null;

  const system: any[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    system.push({ role: 'system', content: body.instructions });
  }

  const mapped = responsesInputToChat(body.input);
  const messages = [...system, ...mapped.messages];

  const out: ResponsesToChat = {
    model: body.model,
    messages,
    stream: body.stream === true,
    hasImage: mapped.hasImage,
    hasVideo: mapped.hasVideo,
  };
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') out.max_tokens = body.max_output_tokens;
  if (body.stop !== undefined) out.stop = body.stop;
  const tools = responsesToolsToChat(body.tools);
  if (tools) out.tools = tools;
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  return out;
}

/** Chat completion -> Responses object. Mirrors the shape the core returns. */
export function chatToResponsesBody(
  data: any,
  options: { responseId: string; model: string },
): any {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  const message = choice?.message ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  const output: any[] = [];

  if (text) {
    output.push({
      type: 'message',
      id: randomId('msg'),
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: randomId('fc'),
        call_id: call?.id || '',
        name: call?.function?.name || '',
        arguments: call?.function?.arguments || '{}',
        status: 'completed',
      });
    }
  }

  if (output.length === 0) {
    output.push({
      type: 'message',
      id: randomId('msg'),
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  const incomplete = choice?.finish_reason === 'length';
  const usage = data?.usage ?? {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;

  return {
    id: options.responseId,
    object: 'response',
    created_at: typeof data?.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    model: options.model,
    output,
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      total_tokens: Number(usage.total_tokens) || promptTokens + completionTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
    },
  };
}

/**
 * Translate a chat-completions SSE stream into Responses `response.*` events.
 *
 * Emits the full lifecycle (created/in_progress/output_item.added/content_part
 * .added, per-token output_text.delta, then the done events and completed) so a
 * Responses streaming client sees the same shape it would from the real API.
 */
export function streamChatAsResponses(
  stream: NodeJS.ReadableStream,
  write: (chunk: string) => void,
  options: { responseId: string; model: string; itemId: string },
): void {
  const send = (event: string, data: any) => {
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const responseObject = (status: string, output: any[]) => ({
    id: options.responseId,
    object: 'response',
    created_at: created,
    status,
    model: upstreamModel,
    output,
  });

  let created = Math.floor(Date.now() / 1000);
  let upstreamModel = options.model;
  let fullText = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let finishReason: string | null = null;
  let settled = false;

  const item = {
    type: 'message',
    id: options.itemId,
    role: 'assistant',
    status: 'in_progress',
    content: [],
  };
  send('response.created', { type: 'response.created', response: responseObject('in_progress', []) });
  send('response.in_progress', {
    type: 'response.in_progress',
    response: responseObject('in_progress', []),
  });
  send('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item,
  });
  send('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: options.itemId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });

  const finish = () => {
    if (settled) return;
    settled = true;
    const doneItem = {
      ...item,
      status: 'completed',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    };
    send('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: options.itemId,
      output_index: 0,
      content_index: 0,
      text: fullText,
    });
    send('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: options.itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: fullText, annotations: [] },
    });
    send('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: doneItem,
    });
    const incomplete = finishReason === 'length';
    send('response.completed', {
      type: 'response.completed',
      response: {
        ...responseObject(incomplete ? 'incomplete' : 'completed', [doneItem]),
        incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      },
    });
  };

  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            finish();
            return;
          }
          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            parsed = null;
          }
          if (parsed) {
            if (typeof parsed.created === 'number') created = parsed.created;
            if (typeof parsed.model === 'string') upstreamModel = parsed.model;
            const usage = parsed.usage;
            if (usage) {
              promptTokens = Number(usage.prompt_tokens) || promptTokens;
              completionTokens = Number(usage.completion_tokens) || completionTokens;
              reasoningTokens =
                Number(usage.completion_tokens_details?.reasoning_tokens) || reasoningTokens;
            }
            const delta = parsed?.choices?.[0]?.delta;
            if (delta?.content) {
              fullText += delta.content;
              send('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: options.itemId,
                output_index: 0,
                content_index: 0,
                delta: delta.content,
              });
            }
            const reason = parsed?.choices?.[0]?.finish_reason;
            if (reason) finishReason = reason;
          }
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  stream.on('end', finish);
  stream.on('error', finish);
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
  const googKey = request.headers['x-goog-api-key'];
  if (typeof googKey === 'string' && googKey.trim()) return googKey.trim();
  return undefined;
}

function upstreamErrorBody(data: any): any {
  return Array.isArray(data) ? data[0] : data;
}

function retryAfterMs(headers: Record<string, any>, data: any): number {
  const parsedHeader = Number.parseInt(String(headers?.['retry-after'] ?? ''), 10);
  if (Number.isFinite(parsedHeader) && parsedHeader > 0) return parsedHeader * 1000;
  const body = Array.isArray(data) ? data[0] : data;
  const details = body?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const match = /^(\d+(?:\.\d+)?)s$/.exec(String(detail?.retryDelay ?? ''));
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

function responsesEnabled(): boolean {
  const flag = String(process.env.GEMINI_API_RESPONSES ?? '1').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * Serve `POST /v1/responses` from the AI Studio key pool.
 *
 * Returns false (so the caller falls back to the account pool) when the feature
 * is disabled, the model is not a key-pool model, the body is not translatable,
 * or the request carries inline video the key endpoint cannot accept.
 */
export async function handleGeminiApiResponsesRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: GeminiApiProxyOptions,
): Promise<boolean> {
  const path = (request.raw.url || request.url || '').split('?')[0];
  if (request.method !== 'POST' || path !== '/v1/responses') return false;
  if (!responsesEnabled()) return false;
  if (!options.pool.hasEnabledKeys()) return false;

  const body = parseJsonBody(request);
  if (!body || typeof body.model !== 'string' || !body.model.trim()) return false;

  const requestedModel = canonicalModelId(body.model);
  const keyPoolModel = keyPoolModelFor(requestedModel);
  if (!(GEMINI_API_MODELS as readonly string[]).includes(keyPoolModel)) return false;

  const translated = responsesToChatBody(body);
  if (!translated) return false;
  if (translated.hasVideo) return false;

  // Balanced routing: null means this turn belongs to the account pool.
  const servedModel =
    options.forceRouting === 'accounts'
      ? null
      : options.forceRouting === 'keys'
        ? keyPoolModel
        : (options.chooseKeyModel?.(keyPoolModel) ?? keyPoolModel);
  if (!servedModel) return false;

  const configuredKeys = options.getApiKeys().map((key) => key.trim()).filter(Boolean);
  if (configuredKeys.length > 0) {
    const clientKey = extractBearer(request);
    if (!clientKey || !configuredKeys.some((key) => safeEqual(key, clientKey))) {
      reply.code(401).send(openAiError('Invalid API key.', 401, 'auth_error'));
      return true;
    }
  }

  // Stateful turn: replay the stored history before this turn's input.
  const history = recallSession(body.previous_response_id);
  const systemMessages = translated.messages.filter((message) => message.role === 'system');
  const inputMessages = translated.messages.filter((message) => message.role !== 'system');
  const messages = history
    ? [...history.messages, ...inputMessages]
    : [...systemMessages, ...inputMessages];
  if (messages.length === 0) return false;

  // Every turn gets a fresh response id, like the real API. The session store
  // keeps the conversation under the NEW id so the client's next
  // `previous_response_id` resolves.
  const responseId = randomId('resp');
  const itemId = randomId('msg');

  // `translated.messages` is only this turn; `messages` carries the recalled
  // history too. The upstream body must use the latter.
  const upstreamBody = { ...translated, model: servedModel, messages };
  delete (upstreamBody as any).hasImage;
  delete (upstreamBody as any).hasVideo;

  const estimatedTokens = estimateGeminiTokens(upstreamBody);
  const stream = translated.stream === true;
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
    const recordOptions: TrafficRecord = {
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
    };
    if (options.gatewayKey) {
      recordOptions.gatewayKeyId = options.gatewayKey.id;
      recordOptions.gatewayKeyName = options.gatewayKey.name;
    }
    options.recordTraffic(recordOptions);
  };

  let lastError: any = null;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const lease = await options.pool.acquire(servedModel, estimatedTokens, clientId, abort.signal);
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
        if (proxyAgent && response.status === 429) {
          options.onProxyRateLimited?.(lease.record.id);
          response = await post(null);
        }
      } catch (error: any) {
        if (!proxyAgent) {
          options.pool.settle(lease, { cooldownMs: 15_000, reason: 'error' });
          lastError = { message: error?.message || String(error) };
          continue;
        }
        options.onProxyRateLimited?.(lease.record.id);
        try {
          response = await post(null);
        } catch (directError: any) {
          options.pool.settle(lease, { cooldownMs: 15_000, reason: 'error' });
          lastError = { message: directError?.message || String(directError) };
          continue;
        }
      }

      const status = response.status || 500;

      if (status === 200) {
        const usage = response.data?.usage ?? {};
        const promptTokens = Number(usage.prompt_tokens) || 0;
        const completionTokens = Number(usage.completion_tokens) || 0;
        const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;

        if (!stream) {
          options.pool.settle(lease, { actualTokens: totalTokens || lease.estimatedTokens });
          record(lease, status, startedAt, promptTokens, completionTokens, totalTokens);
          rememberSession(responseId, messages, servedModel);
          releaseAbort();
          reply.header('x-egress-provider', 'gemini-api');
          return reply
            .code(status)
            .send(
              chatToResponsesBody(response.data, {
                responseId,
                model: servedModel,
              }),
            ), true;
        }

        const streamData = response.data as NodeJS.ReadableStream;
        reply.hijack();
        reply.raw.statusCode = status;
        reply.raw.setHeader(
          'content-type',
          String(response.headers?.['content-type'] || 'text/event-stream'),
        );
        reply.raw.setHeader('cache-control', 'no-cache');
        reply.raw.setHeader('x-egress-provider', 'gemini-api');

        let finished = false;
        const finish = (completed: boolean) => {
          if (finished) return;
          finished = true;
          options.pool.settle(lease, {
            actualTokens: lease.estimatedTokens,
            ...(completed ? {} : { cooldownMs: 5_000 }),
          });
          record(lease, completed ? 200 : 0, startedAt, 0, 0, lease.estimatedTokens);
          if (completed) rememberSession(responseId, messages, servedModel);
          releaseAbort();
        };

        streamChatAsResponses(
          streamData,
          (chunk) => {
            try {
              reply.raw.write(chunk);
            } catch {
              // client went away; the close handler records the abort.
            }
          },
          { responseId, model: servedModel, itemId },
        );
        streamData.on('end', () => {
          try {
            reply.raw.end();
          } catch {
            // already closed
          }
          finish(true);
        });
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

    const retryAfterSec = Math.max(1, Math.ceil(options.pool.nextAvailabilityMs(servedModel) / 1000));
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

/** Exposed for tests: the session store is module-global. */
export function _resetResponseSessionsForTests(): void {
  sessions.clear();
}
