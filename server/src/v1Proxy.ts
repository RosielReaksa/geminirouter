import http from 'node:http';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ConcurrencyLeaseManager } from './leaseManager.js';
import type { LocalStateStore, GoogleAccount } from './store.js';

export interface V1ProxyOptions {
  leaseManager: ConcurrencyLeaseManager;
  store: LocalStateStore;
  getGatewayPort: () => number;
}

export async function handleV1ProxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: V1ProxyOptions
): Promise<void> {
  const { leaseManager, store, getGatewayPort } = options;
  const accounts = store.getAccounts();
  const gatewayPort = getGatewayPort();

  // Extract model name from body if available
  let requestedModel: string | undefined;
  let rawBodyBuffer: Buffer | null = null;

  if (request.body) {
    if (Buffer.isBuffer(request.body)) {
      rawBodyBuffer = request.body;
      try {
        const parsed = JSON.parse(rawBodyBuffer.toString('utf8'));
        if (parsed && typeof parsed.model === 'string') {
          requestedModel = parsed.model;
        }
      } catch {
        // ignore non-json
      }
    } else if (typeof request.body === 'object') {
      requestedModel = (request.body as any).model;
      try {
        rawBodyBuffer = Buffer.from(JSON.stringify(request.body), 'utf8');
      } catch {
        rawBodyBuffer = null;
      }
    } else if (typeof request.body === 'string') {
      rawBodyBuffer = Buffer.from(request.body, 'utf8');
      try {
        const parsed = JSON.parse(request.body);
        if (parsed && typeof parsed.model === 'string') {
          requestedModel = parsed.model;
        }
      } catch {
        // ignore
      }
    }
  }

  // Attempt to acquire lease across accounts pool
  const attemptedAccountIds = new Set<string>();
  const maxAttempts = Math.max(1, accounts.filter((a) => a.status !== 'error').length);
  let lastRetryAfter: string = '1';
  let lastErrorBody: any = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const lease = await leaseManager.acquireLease(accounts, {
      model: requestedModel,
      excludeAccountIds: attemptedAccountIds,
    });

    if (!lease) {
      // All accounts are at capacity or in cooldown
      reply.header('Retry-After', lastRetryAfter);
      return reply.code(429).send({
        error: {
          message: 'All accounts failed, at capacity, or in cooldown. Please retry shortly.',
          type: 'rate_limit_error',
          code: 429,
        },
      });
    }

    const { account, release } = lease;
    attemptedAccountIds.add(account.id);

    const startedAt = Date.now();
    let leaseReleased = false;
    const safeRelease = () => {
      if (!leaseReleased) {
        leaseReleased = true;
        release();
      }
    };

    let streamStarted = false;

    try {
      const outcome = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        streamStarted: boolean;
        retryable: boolean;
        errorBody?: any;
      }>((resolve, reject) => {
        // Build forward headers
        const forwardHeaders: http.OutgoingHttpHeaders = { ...request.headers };
        // Remove host header to avoid upstream misrouting
        delete forwardHeaders.host;
        delete forwardHeaders['content-length'];

        if (rawBodyBuffer) {
          forwardHeaders['content-length'] = rawBodyBuffer.length;
        }

        // Attach routing attribution headers for core or tracing
        forwardHeaders['x-account-id'] = account.id;
        forwardHeaders['x-account-email'] = account.email;

        const upstreamReq = http.request(
          {
            hostname: '127.0.0.1',
            port: gatewayPort,
            path: request.raw.url || request.url,
            method: request.method,
            headers: forwardHeaders,
          },
          (upstreamRes) => {
            const status = upstreamRes.statusCode || 500;

            // Check if status is a rate-limit error before streaming starts
            const isRateLimit = status === 429 || (status === 503 && upstreamRes.headers['retry-after']);

            if (isRateLimit && !streamStarted) {
              // Consume body and check if retryable
              let errData = '';
              upstreamRes.on('data', (chunk) => {
                errData += chunk;
              });
              upstreamRes.on('end', () => {
                let parsedError: any;
                try {
                  parsedError = JSON.parse(errData);
                } catch {
                  parsedError = { message: errData };
                }

                // If the upstream signals that the entire pool is exhausted, do not retry
                const isPoolExhausted =
                  parsedError?.error?.type === 'pool_exhausted' ||
                  parsedError?.type === 'pool_exhausted' ||
                  String(parsedError?.error?.message || parsedError?.message || '').includes('All accounts failed');

                resolve({
                  status,
                  headers: upstreamRes.headers,
                  streamStarted: false,
                  retryable: !isPoolExhausted,
                  errorBody: parsedError,
                });
              });
              return;
            }

            // Once we start streaming (or non-429 response):
            streamStarted = true;

            // Copy status and headers to client reply
            reply.raw.statusCode = status;
            for (const [name, val] of Object.entries(upstreamRes.headers)) {
              if (val !== undefined && name !== 'connection' && name !== 'transfer-encoding') {
                reply.raw.setHeader(name, val);
              }
            }

            // Pipe stream chunks to client
            upstreamRes.pipe(reply.raw);

            upstreamRes.on('end', () => {
              safeRelease();
              const durationMs = Date.now() - startedAt;
              store.addTrafficRecord({
                id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
                timestamp: new Date().toISOString(),
                clientName: String(request.headers['user-agent'] || 'API Client'),
                clientIp: request.ip || '127.0.0.1',
                modelRequested: requestedModel || 'unknown',
                modelRouted: requestedModel || 'unknown',
                backingAccountEmail: account.email,
                status,
                latencyMs: durationMs,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
              });
              resolve({
                status,
                headers: upstreamRes.headers,
                streamStarted: true,
                retryable: false,
              });
            });

            upstreamRes.on('error', (err) => {
              safeRelease();
              reject(err);
            });
          }
        );

        upstreamReq.on('error', (err) => {
          safeRelease();
          if (!streamStarted) {
            resolve({
              status: 502,
              headers: {},
              streamStarted: false,
              retryable: false,
              errorBody: { message: err.message },
            });
          } else {
            reject(err);
          }
        });

        // Abort the upstream only when the client truly disconnects before
        // the response finishes. Node >= 18 emits 'close' on the REQUEST
        // stream as soon as the body has been read, so listening on
        // request.raw here destroyed every upstream call before any response
        // arrived (the "502 socket hang up" bug). reply.raw closes only when
        // the connection is actually done; writableFinished distinguishes a
        // completed response from an aborted one.
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) {
            safeRelease();
            upstreamReq.destroy();
          }
        });

        // Send request body
        if (rawBodyBuffer) {
          upstreamReq.write(rawBodyBuffer);
        }
        upstreamReq.end();
      });

      if (outcome.headers['retry-after']) {
        lastRetryAfter = String(outcome.headers['retry-after']);
      }
      if (outcome.errorBody) {
        lastErrorBody = outcome.errorBody;
      }

      if (outcome.retryable && !outcome.streamStarted) {
        // Mark account in cooldown and retry on next account
        const retrySec = parseInt(lastRetryAfter, 10);
        const cooldownMs = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : undefined;
        leaseManager.markCooldown(account.id, cooldownMs);
        safeRelease();
        continue; // Try next account in loop
      }

      // If pool was exhausted (non-retryable rate limit before streaming):
      if (!outcome.retryable && !outcome.streamStarted && (outcome.status === 429 || outcome.status === 503)) {
        safeRelease();
        reply.header('Retry-After', lastRetryAfter);
        return reply.code(outcome.status).send(outcome.errorBody);
      }

      // If we finished successfully or delivered response (streamStarted is true):
      return;
    } catch (err: any) {
      safeRelease();
      if (!streamStarted && !reply.raw.headersSent) {
        return reply.code(502).send({
          error: {
            message: `Gateway proxy error: ${err?.message || String(err)}`,
            type: 'gateway_error',
            code: 502,
          },
        });
      }
      return;
    }
  }

  // If every attempt was rate-limited or exhausted:
  reply.header('Retry-After', lastRetryAfter);
  return reply.code(429).send({
    error: {
      message: lastErrorBody?.error?.message || lastErrorBody?.message || 'All accounts failed or unhealthy',
      type: 'pool_exhausted',
      code: 429,
    },
  });
}
