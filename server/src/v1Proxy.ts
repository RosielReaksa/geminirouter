import http from 'node:http';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ConcurrencyLeaseManager } from './leaseManager.js';
import type { LocalStateStore, GoogleAccount } from './store.js';

export interface V1ProxyOptions {
  leaseManager: ConcurrencyLeaseManager;
  store: LocalStateStore;
  getGatewayPort: () => number;
}

/**
 * The core reports the account it actually routed to via this response header.
 * Returns undefined when the core did not report one.
 */
function readServedAccountId(headers: http.IncomingHttpHeaders): string | undefined {
  const raw = headers['x-antigravity-account-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the account object for the id the core reported, falling back to the
 * account we leased when the core did not tell us (connection-level failures).
 * Prefers the real pool entry so email/quota stay accurate.
 */
function resolveServedAccount(
  servedByAccountId: string | undefined,
  leasedAccount: GoogleAccount,
  accounts: GoogleAccount[]
): GoogleAccount {
  if (!servedByAccountId || servedByAccountId === leasedAccount.id) {
    return leasedAccount;
  }
  const known = accounts.find((a) => a.id === servedByAccountId);
  if (known) {
    return known;
  }
  // Core reported an id we have not synced yet; keep the id but not the wrong email.
  return { ...leasedAccount, id: servedByAccountId, email: servedByAccountId };
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
    // Which account the CORE actually used. Falls back to the leased account
    // when the core did not report one (e.g. connection error before routing).
    let servedByAccountId: string | undefined;

    try {
      const outcome = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        streamStarted: boolean;
        retryable: boolean;
        servedByAccountId?: string;
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

        // Deliberately NOT pinning x-account-id here. Pinning bypasses the
        // core's per-model rate-limit tracking, quota-weighted round-robin and
        // session affinity, and lets the core silently fall back to a different
        // account than the one we cooled down. The core owns selection; we only
        // pin on the explicit single-account test path (accountTester.ts).
        // x-account-email is dropped too because the core ignores it.
        delete forwardHeaders['x-account-id'];
        delete forwardHeaders['x-account-email'];
        delete forwardHeaders['x-single-account'];

        const upstreamTimeoutMs = Number.parseInt(
          process.env.PROXY_RESPONSE_TIMEOUT_MS || '900000',
          10
        );

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

            // Check if status is a recoverable error (429 rate-limited, 403 validation/quarantine, or 503 retryable)
            const isRecoverableError =
              status === 429 ||
              status === 403 ||
              (status === 503 && Boolean(upstreamRes.headers['retry-after']));

            if (isRecoverableError && !streamStarted) {
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
                  servedByAccountId: readServedAccountId(upstreamRes.headers),
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
              // Read the serving account from THIS response's headers; the
              // outer servedByAccountId is only assigned after this resolves.
              const recordAccount = resolveServedAccount(
                readServedAccountId(upstreamRes.headers),
                account,
                accounts
              );
              store.addTrafficRecord({
                id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
                timestamp: new Date().toISOString(),
                clientName: String(request.headers['user-agent'] || 'API Client'),
                clientIp: request.ip || '127.0.0.1',
                modelRequested: requestedModel || 'unknown',
                modelRouted: requestedModel || 'unknown',
                backingAccountEmail: recordAccount.email,
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
                servedByAccountId: recordAccount.id,
              });
            });

            upstreamRes.on('error', (err) => {
              safeRelease();
              reject(err);
            });
          }
        );

        // Idle-socket guard: a hung upstream (no bytes moving) is aborted after
        // PROXY_RESPONSE_TIMEOUT_MS (default 15 min). Long generations keep
        // resetting this because data keeps flowing.
        if (Number.isFinite(upstreamTimeoutMs) && upstreamTimeoutMs > 0) {
          upstreamReq.setTimeout(upstreamTimeoutMs, () => {
            upstreamReq.destroy(new Error(`upstream idle for ${upstreamTimeoutMs}ms`));
          });
        }

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

      if (outcome.servedByAccountId) {
        servedByAccountId = outcome.servedByAccountId;
      }
      if (outcome.headers['retry-after']) {
        lastRetryAfter = String(outcome.headers['retry-after']);
      }
      if (outcome.errorBody) {
        lastErrorBody = outcome.errorBody;
      }

      if (outcome.retryable && !outcome.streamStarted) {
        // Cooldown and the verification flag must land on the account that
        // ACTUALLY failed, which is not necessarily the one we leased — the
        // core may fall back to another account when our choice is ineligible.
        const failedAccount = resolveServedAccount(servedByAccountId, account, accounts);

        // Mark account in cooldown and retry on next account
        let cooldownMs = 2 * 60 * 1000;
        if (outcome.status === 403) {
          cooldownMs = 10 * 60 * 1000; // 10 minutes quarantine for 403 verification
          let freshLink: string | undefined;
          const details = outcome.errorBody?.error?.details || outcome.errorBody?.details;
          if (Array.isArray(details)) {
            for (const item of details) {
              if (item?.metadata?.validation_url) {
                freshLink = item.metadata.validation_url;
                break;
              }
              if (Array.isArray(item?.links)) {
                for (const l of item.links) {
                  if (l?.url && typeof l.url === 'string' && l.url.includes('continue')) {
                    freshLink = l.url;
                    break;
                  }
                }
              }
            }
          }
          if (!freshLink) {
            const raw = JSON.stringify(outcome.errorBody || {});
            const m = raw.match(/https:\/\/accounts\.google\.com\/[^\s"'\\]+/);
            if (m) freshLink = m[0];
          }
          if (freshLink) {
            failedAccount.hasValidationLink = true;
            failedAccount.validationUrl = freshLink;
          }
        } else {
          const retrySec = parseInt(lastRetryAfter, 10);
          if (Number.isFinite(retrySec) && retrySec > 0) {
            cooldownMs = retrySec * 1000;
          }
        }
        // Scoped to the model, so a quota burn on one model leaves the account
        // usable for the rest of the pool.
        leaseManager.markCooldown(failedAccount.id, cooldownMs, requestedModel);
        // Never lease either account again for this request.
        attemptedAccountIds.add(failedAccount.id);
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
