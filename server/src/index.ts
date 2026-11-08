import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyHttpProxy from '@fastify/http-proxy';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import axios from 'axios';
import dotenv from 'dotenv';

import { CoreClient } from './coreClient.js';
import { CoreProcessManager } from './coreProcess.js';
import { LocalStateStore, type GoogleAccount, type TrafficRecord } from './store.js';
import { createAuthMiddleware, SessionStore, safeEqual } from './auth.js';
import { DeviceTokenStore } from './deviceAuth.js';
import { derivePoolState, bridgeToCoreProxy, coreProxyToBridge } from './pool-state.js';
import { readCoreProxyConfig, applyCoreProxyConfig } from './coreConfig.js';
import { ConcurrencyLeaseManager } from './leaseManager.js';
import { handleV1ProxyRequest } from './v1Proxy.js';
import { GeminiApiPool, GEMINI_API_MODELS, geminiApiBaseUrl } from './geminiApiPool.js';
import { handleGeminiApiRequest } from './geminiApiProxy.js';
import {
  canonicalModelId,
  canonicalizeModelEntries,
  includeVerifiedWebsiteModels,
  isGeminiModelId,
  isUnavailableWebsiteModel,
} from './modelIds.js';
import { mapCoreTrafficItems as mapCoreTrafficItemsFromCore, mergeTrafficRecords } from './trafficMapping.js';
import { getSharedCoreAuditDb } from './coreAuditDb.js';
import { getSharedProxyManager } from './proxyManager.js';
import { syncProxyAssignments as syncProxyRouting } from './proxySync.js';
import { applyEgress } from './egress.js';
import { getDirectEgressInfo } from './egressInfo.js';
import { AccountTester, type AccountTestResult } from './accountTester.js';
import {
  describeMediaTimeoutRisk,
  isModelFailureText,
  readMediaConfig,
  registerMediaBodyParsers,
  registerMediaRoutes,
  takeMediaUpload,
} from './mediaTranscription.js';
import { getSharedMediaGate, readMediaGateOptions } from './mediaGate.js';
import { resolveHelperBinaryCandidates, resolveWebPort } from './listen.js';

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const BRIDGE_VERSION =
  (require_('../package.json') as { version?: string })?.version || 'unknown';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = resolveWebPort();
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.GEMINIROUTER_ADMIN_PASSWORD || '';
const INTERNAL_GATEWAY_PORT = parseInt(process.env.INTERNAL_GATEWAY_PORT || '8045', 10);
// Match the core's 64 MiB JSON model-route limit. This leaves enough room for
// base64 media plus prompt text without making every dashboard route accept
// large request bodies.
const V1_REQUEST_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const WEBSITE_OAUTH_CALLBACK_URI =
  process.env.OAUTH_CALLBACK_URL || 'https://framecall.site/oauth/callback';
const LOCAL_OAUTH_RELAY_REDIRECT_URI = 'http://127.0.0.1:41209/oauth-callback';

interface CoreCredentialState {
  checkedAt?: string;
  drift?: boolean;
  deployedFingerprint?: string;
  upstreamFingerprint?: string;
  error?: string;
}

function dataDirPath(): string {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(process.cwd(), '.data');
}

interface CoreClientHealth {
  checkedAt?: string;
  state?: 'ok' | 'blocked' | 'unknown';
  detail?: string;
  httpStatus?: number;
  errorCode?: string;
}

function readJsonState<T>(fileName: string): T | null {
  try {
    const file = path.join(dataDirPath(), fileName);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readCoreCredentialState(): (CoreCredentialState & { clientHealth?: CoreClientHealth }) | null {
  const credentials = readJsonState<CoreCredentialState>('core-credentials.json');
  const clientHealth = readJsonState<CoreClientHealth>('core-client-health.json');
  if (!credentials && !clientHealth) return null;
  return { ...(credentials ?? {}), ...(clientHealth ? { clientHealth } : {}) };
}

export async function createServer(): Promise<{
  app: FastifyInstance;
  coreClient: CoreClient;
  store: LocalStateStore;
  leaseManager: ConcurrencyLeaseManager;
  accountTester: AccountTester;
}> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    bodyLimit: 10 * 1024 * 1024, // 10MB
    // "idle" closes keep-alive sockets on shutdown but lets in-flight requests
    // (including multi-minute dubbing jobs) finish. `true` would destroy them
    // and Caddy would answer the client with an empty 502.
    forceCloseConnections: 'idle',
  });

  const coreClient = new CoreClient();
  let hostedOAuthSession: { sessionId: string; state: string; expiresAt: number } | null = null;
  // The core's /v1/oauth/complete answers ok as soon as it receives the code;
  // the token exchange is asynchronous. Track the account set at start so a
  // completion can be confirmed by an account that actually appeared.
  const oauthBaselines = new Map<string, { emails: Set<string>; expiresAt: number }>();
  const processManager = new CoreProcessManager();
  const store = new LocalStateStore();
  // AI Studio keys serve the two flash-lite models; everything else keeps using
  // the OAuth account pool through the core.
  const geminiApiPool = new GeminiApiPool(store.getGeminiApiKeys());
  // Restore today's per-key counters and cooldowns so the dashboard does not
  // reset to zero on every bridge restart.
  geminiApiPool.hydrateUsageState(store.getGeminiApiUsageState());

  // Persist usage every few seconds, only when it actually changed.
  let lastUsageSnapshot = '';
  const geminiUsageSaveTimer = setInterval(() => {
    const state = geminiApiPool.exportUsageState();
    const serialized = JSON.stringify(state.keys);
    if (serialized === lastUsageSnapshot) return;
    lastUsageSnapshot = serialized;
    store.setGeminiApiUsageState(state);
  }, 5_000);
  geminiUsageSaveTimer.unref();
  const gatewayApiKeys = (): string[] => gatewayKeyCandidates().map((entry) => entry.key);

  /** Every key accepted by the gateway, with the label shown on Traffic. */
  const gatewayKeyCandidates = (): Array<{ id: string; name: string; key: string; stored: boolean }> => {
    const candidates: Array<{ id: string; name: string; key: string; stored: boolean }> = [];
    for (const record of store.getGatewayApiKeys()) {
      candidates.push({ id: record.id, name: record.name, key: record.key, stored: true });
    }
    const add = (id: string, name: string, value: string | undefined) => {
      const key = (value || '').trim();
      if (key) candidates.push({ id, name, key, stored: false });
    };
    add('master', 'Master key', store.getConfig().masterApiKey);
    add('env', 'Deployment key', process.env.GEMINIROUTER_API_KEY);
    add('env-gateway', 'Gateway key', process.env.GEMINIROUTER_GATEWAY_API_KEY);
    add('core', 'Core key', resolveGateway().apiKey);

    const seen = new Set<string>();
    return candidates.filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    });
  };

  const extractClientKey = (request: FastifyRequest): string | undefined => {
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (match) return match[1].trim();
    }
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
    return undefined;
  };

  /**
   * Authenticate the client key at the bridge. The core only knows its own key,
   * so named dashboard keys must be validated here and swapped for the core key
   * before the account path forwards the request.
   */
  const authenticateGatewayKey = (
    request: FastifyRequest,
  ): { required: boolean; identity: { id: string; name: string } | null } => {
    const candidates = gatewayKeyCandidates();
    if (candidates.length === 0) return { required: false, identity: null };

    const token = extractClientKey(request);
    if (!token) return { required: true, identity: null };
    const match = candidates.find((entry) => safeEqual(entry.key, token));
    if (!match) return { required: true, identity: null };
    if (match.stored) store.touchGatewayApiKey(match.id);
    return { required: true, identity: { id: match.id, name: match.name } };
  };
  const geminiApiConfig = () => ({
    models: [...GEMINI_API_MODELS],
    limits: geminiApiPool.getLimits(),
    queue: geminiApiPool.getQueueStats(),
    keys: geminiApiPool.snapshot(),
    // How the two shared flash-lite models choose between the key pool and the
    // connected Google accounts.
    sharedRouting: store.getGeminiApiSharedRouting(),
  });
  // Webshare proxy routing. The bridge only decides which proxy each account
  // should use; the core performs the proxying (accounts.proxy_url) so its
  // quota accounting, cooldown and failover keep seeing the traffic. The key
  // is persisted server-side and never returned to the browser.
  const proxyManager = getSharedProxyManager();
  const persistedProxyKey = store.getWebshareApiKey();
  const envProxyKey = (process.env.WEBSHARE_API_KEY || '').trim();
  if (envProxyKey && envProxyKey !== persistedProxyKey) {
    // An explicit deployment key wins over whatever the dashboard last saved.
    store.setWebshareApiKey(envProxyKey);
  }
  const effectiveProxyKey = envProxyKey || persistedProxyKey;
  if (effectiveProxyKey) {
    proxyManager.setApiKey(effectiveProxyKey);
    // Restore the last account -> proxy mapping so a restart keeps the same IP.
    proxyManager.hydrateAssignments(store.getProxyAssignments());
    proxyManager.hydrateApiKeyAssignments(store.getGeminiApiProxyAssignments());
    proxyManager.hydrateHealthState(
      store.getProxyQuarantines(),
      store.getRetiredProxies(),
    );
    // Key proxies are always on once a Webshare key exists; there is no
    // dashboard switch to turn them off.
    proxyManager.setApiKeyProxyEnabled(true);
    store.setGeminiApiProxyEnabled(true);
    // A key alone does not mean routing is wanted: honour the dashboard's last
    // choice. With no saved choice yet (fresh install plus env key), enabling is
    // the sensible default.
    const wantRouting = store.getProxyRoutingEnabled() ?? Boolean(envProxyKey);
    if (wantRouting) proxyManager.setEnabled(true);
  }

  /** Assign a stable proxy to every AI Studio key and persist the mapping. */
  const syncApiKeyProxyAssignments = (rebalance = false): void => {
    const keyIds = store.getGeminiApiKeys().map((key) => key.id);
    if (rebalance) proxyManager.rebalanceApiKeyAssignments(keyIds);
    else proxyManager.reconcileApiKeyAssignments(keyIds);
    store.setGeminiApiProxyAssignments(
      proxyManager.isApiKeyProxyEnabled() ? proxyManager.getApiKeyAssignmentKeys() : {},
    );
  };

  const geminiConfig = () => ({
    ...geminiApiConfig(),
    proxy: proxyManager.getApiKeyProxyState(),
    keys: geminiApiPool.snapshot().map((key) => ({
      ...key,
      proxy: proxyManager.getApiKeyProxySummary(key.id),
    })),
  });

  /** Inventory plus the account emails pinned to each proxy and its health. */
  const proxyListResponse = () => {
    const emailById = new Map(store.getAccounts().map((account) => [account.id, account.email]));
    const proxies = proxyManager.getProxyListSummary().map((entry) => {
      const { assignedAccountIds, ...rest } = entry;
      const emails = assignedAccountIds
        .map((id) => emailById.get(id) ?? id)
        .sort((a, b) => a.localeCompare(b));
      return {
        ...rest,
        assignedTo: emails.length > 0 ? emails.join(', ') : null,
      };
    });
    return { enabled: proxyManager.isEnabled(), proxies };
  };

  const persistProxyHealth = () => {
    const health = proxyManager.getHealthState();
    store.setProxyQuarantines(health.quarantines);
    store.setRetiredProxies(health.retired);
  };

  /**
   * Compute the desired per-account proxy state and push the changes to the
   * core. Pushes `proxyUrl: null` for every account when routing is disabled,
   * which is how a previously configured proxy gets cleared. Only changed
   * accounts are written, and the core reloads its account cache afterwards.
   */
  const runProxySync = async () => {
    const result = await syncProxyRouting(
      proxyManager,
      store.getAccounts().map((account) => account.id),
      (procedure, input) => coreClient.callRpc(procedure, input),
    );
    // Persist the chosen mapping (address:port only) so the next process keeps
    // accounts on the same IPs instead of re-dealing the inventory.
    store.setProxyAssignments(
      proxyManager.isEnabled() ? proxyManager.getAssignmentKeys() : {},
    );
    return result;
  };

  /**
   * Attach the egress IP and country to each traffic record.
   *
   * Proxied accounts get the static Webshare IP they are pinned to. Anything
   * else (no proxy, or the core has not routed through one) is labelled with
   * the gateway host's public IP, looked up once per 30 minutes.
   */
  const withTrafficEgress = async (records: TrafficRecord[]): Promise<TrafficRecord[]> => {
    if (records.length === 0) return records;

    const idByEmail = new Map(
      store.getAccounts().map((account) => [account.email.toLowerCase(), account.id]),
    );
    const resolveProxy = (record: TrafficRecord) => {
      // AI Studio key calls are not tied to a core account; use the key's own
      // egress proxy so the Traffic page can show where the call left from.
      if (record.provider === 'gemini-api') {
        const keyId = record.accountId?.startsWith('gemini-api:')
          ? record.accountId.slice('gemini-api:'.length)
          : '';
        const keyEgress = keyId ? proxyManager.getEgressForKey(keyId) : null;
        if (keyEgress) return keyEgress;
      }
      const accountId =
        record.accountId ?? idByEmail.get((record.backingAccountEmail || '').toLowerCase());
      return accountId ? proxyManager.getEgressForAccount(accountId) : null;
    };

    const needsDirect = records.some((record) => !resolveProxy(record));
    const direct = needsDirect ? await getDirectEgressInfo() : null;

    return applyEgress(records, (record) => {
      const proxy = resolveProxy(record);
      if (proxy) return { ip: proxy.address, country: proxy.country, via: 'proxy' };
      if (direct) return { ip: direct.ip, country: direct.country, via: 'direct' };
      return null;
    });
  };

  // Scheduled Webshare inventory refresh so proxy IPs stay current. The
  // interval is configurable via WEBSHARE_REFRESH_INTERVAL_MS (min 60s).
  const proxyRefreshIntervalMs = Math.max(
    60_000,
    Number.parseInt(process.env.WEBSHARE_REFRESH_INTERVAL_MS || String(proxyManager.getRefreshIntervalMs()), 10) ||
      proxyManager.getRefreshIntervalMs(),
  );
  const proxyRefreshTimer = setInterval(() => {
    if (!proxyManager.isProxyInventoryActive()) return;
    void (async () => {
      const refresh = await proxyManager.refreshProxies();
      if (!refresh.ok) {
        console.warn('[ProxyManager] Scheduled refresh failed:', refresh.error);
        return;
      }
      // Pick up accounts added since the last cycle before assigning proxies.
      if (proxyManager.isEnabled()) {
        try {
          await loadCoreAccounts();
        } catch {
          // Keep the last known pool; sync still runs against the store.
        }
        const sync = await runProxySync();
        if (sync.failed > 0) {
          console.warn('[ProxyManager] Could not apply some proxy assignments:', sync.errors.join('; '));
        }
      }
      if (proxyManager.isApiKeyProxyEnabled()) syncApiKeyProxyAssignments();
    })();
  }, proxyRefreshIntervalMs);
  proxyRefreshTimer.unref();

  // Initial inventory + assignment pass. Deferred so server startup is never
  // blocked by the Webshare API; skipped entirely when routing is off.
  if (proxyManager.isProxyInventoryActive()) {
    void (async () => {
      const refresh = await proxyManager.refreshProxies();
      if (!refresh.ok) {
        console.warn('[ProxyManager] Initial refresh failed:', refresh.error);
        return;
      }
      if (proxyManager.isEnabled()) {
        const sync = await runProxySync();
        if (sync.failed > 0) {
          console.warn('[ProxyManager] Could not apply some proxy assignments:', sync.errors.join('; '));
        }
      }
      if (proxyManager.isApiKeyProxyEnabled()) syncApiKeyProxyAssignments(true);
    })();
  }
  const initialCfg = store.getConfig();
  const leaseManager = new ConcurrencyLeaseManager({
    maxConcurrentRequestsPerAccount: initialCfg.maxConcurrentRequestsPerAccount,
    capacityPolicy: initialCfg.capacityPolicy,
    queueTimeoutMs: initialCfg.queueTimeoutMs,
  });
  const accountTester = new AccountTester(coreClient, store, () => resolveGateway());
  const autoTestIntervalHours = Math.max(
    1,
    Math.min(168, Number.parseInt(process.env.MODEL_ACCOUNT_TEST_INTERVAL_HOURS || '24', 10) || 24),
  );
  accountTester.startAutoTestScheduler(autoTestIntervalHours);

  /**
   * The gateway is always-on: the router is useless without it, so there is no
   * "pause" state. This (re)asserts the running gateway and is used by both the
   * startup path and the supervisor below.
   */
  const ensureGatewayRunning = async (): Promise<boolean> => {
    // Use resolveGateway(), not the stored port: the store default can be a
    // stale 8045 while the real core gateway runs on the env/profile port.
    const { port: targetPort } = resolveGateway();
    if (!(await coreClient.isCoreAlive())) {
      return false;
    }
    try {
      await coreClient.callRpc('gatewayStart', { port: targetPort });
      store.setGatewayRunning(true, targetPort);
      return true;
    } catch {
      return false;
    }
  };

  // Enable CORS
  await app.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Multipart API bodies are preserved byte-for-byte for /v1 passthrough.
  // The media transcription routes are the only exception: they stream the
  // upload to a temp file so a multi-hour recording never sits in memory.
  const mediaConfig = readMediaConfig();
  const mediaTimeoutRisk = describeMediaTimeoutRisk(mediaConfig);
  if (mediaTimeoutRisk) app.log.warn(mediaTimeoutRisk);
  registerMediaBodyParsers(app, {
    fallbackBodyLimitBytes: V1_REQUEST_BODY_LIMIT_BYTES,
    config: mediaConfig,
  });

  // Admin authentication hook. Paired desktop helpers may only reach the
  // import endpoint with their scoped token.
  const sessions = new SessionStore();
  const deviceTokens = new DeviceTokenStore(dataDirPath());
  const DEVICE_ROUTES = new Set(['/api/accounts/import']);
  app.addHook(
    'onRequest',
    createAuthMiddleware(
      ADMIN_PASSWORD,
      sessions,
      { verify: (token: string) => deviceTokens.verify(token) },
      DEVICE_ROUTES,
    ),
  );

  // Determine frontend build directory (check relative to __dirname and cwd)
  const candidateFrontendDirs = [
    path.resolve(__dirname, '../../frontend/dist'),
    path.resolve(__dirname, '../frontend/dist'),
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'frontend/dist'),
    ...(process.env.FRONTEND_DIST ? [path.resolve(process.env.FRONTEND_DIST)] : []),
  ];
  let frontendDistPath = '';
  for (const dir of candidateFrontendDirs) {
    if (fs.existsSync(dir)) {
      frontendDistPath = dir;
      break;
    }
  }
  const hasFrontendDist = Boolean(frontendDistPath);

  if (hasFrontendDist) {
    app.log.info(`Serving static files from ${frontendDistPath}`);
    await app.register(fastifyStatic, {
      root: frontendDistPath,
      prefix: '/',
    });
  } else {
    app.log.warn(`Frontend build not found at ${frontendDistPath}. Run pnpm build in frontend/`);
  }

  // Reverse proxy for API clients on /v1/*, including media-bearing requests
  // used by a separate audio/video dubbing application.
  // Dispatches requests across N accounts using ConcurrencyLeaseManager:
  // - Picks healthy account with fewest in-flight leases (min in-flight)
  // - Breaks ties by least quota used
  // - Enforces maxConcurrentRequestsPerAccount cap
  // - If at capacity: queues briefly or returns 429 Retry-After
  // - Transparently retries on next account if upstream 429 before streaming
  // - Never retries once first streamed byte is emitted
  //
  // /v1beta is the Gemini-native path used by the dubbing app
  // (/v1beta/models/<model>:generateContent). It goes through the same leases,
  // quota checks and failover as /v1, and the path is forwarded unchanged.
  // Round-robin turn for the two shared flash-lite models under balanced routing.
  let sharedModelTurn = 0;
  /**
   * Pick the model the key pool should serve, or null for an account turn.
   *
   * The exact requested model is always preserved: a key is only used when that
   * model has key capacity. Otherwise balanced routing sends the request to an
   * account, which can serve the same model. When no account can take the call,
   * keys get it (and may return Google's 429 until the quota resets).
   */
  const sharedModelProvider = (requestedModel: string): string | null => {
    const routing = store.getGeminiApiSharedRouting();
    const keyReady = geminiApiPool.hasImmediateCapacity(requestedModel);

    if (routing === 'accounts') return null;
    if (routing === 'keys') return requestedModel;

    const usableAccounts = store
      .getAccounts()
      .filter(
        (account) =>
          account.status !== 'error' &&
          !leaseManager.isAccountModelInCooldown(account.id, requestedModel),
      );
    if (usableAccounts.length === 0) return requestedModel;
    if (!keyReady) return null;

    const preferAccounts = sharedModelTurn % 2 === 0;
    sharedModelTurn += 1;
    return preferAccounts ? null : requestedModel;
  };

  const gatewayKeyLabel = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    if (id === 'master') return 'Master key';
    if (id === 'env') return 'Deployment key';
    if (id === 'env-gateway') return 'Gateway key';
    if (id === 'core') return 'Core key';
    return store.getGatewayApiKeys().find((key) => key.id === id)?.name;
  };

  const proxyApiRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const auth = authenticateGatewayKey(request);
    // Unknown/missing keys are left for the core (account path) or the key-pool
    // auth check to reject. A matched key is swapped for the core key below so
    // named dashboard keys work without teaching the core about them.

    const handledByApiKeys = await handleGeminiApiRequest(request, reply, {
      pool: geminiApiPool,
      getApiKeys: gatewayApiKeys,
      recordTraffic: (record) => store.addTrafficRecord(record),
      getProxyAgent: (keyId) => proxyManager.getApiKeyProxyAgent(keyId),
      onProxyRateLimited: (keyId) => {
        // Proxy IPs occasionally get throttled by Google; keep the key working
        // direct for 24 hours instead of failing every call.
        proxyManager.markApiKeyProxyRateLimited(keyId);
      },
      chooseKeyModel: (model) => sharedModelProvider(model),
      gatewayKey: auth.identity,
    });
    if (handledByApiKeys) return;

    await handleV1ProxyRequest(request, reply, {
      leaseManager,
      store,
      getGatewayPort: () => resolveGateway().port,
      coreApiKey: auth.identity ? resolveGateway().apiKey : undefined,
      gatewayKeyId: auth.identity?.id,
    });
  };

  // GET /v1/models is answered by the bridge, not proxied verbatim, because the
  // core still advertises retired aliases (for example
  // gemini-3.8-flash-tiered). The list exposes only canonical IDs.
  app.get('/v1/models', async (request, reply) => {
    const { port } = resolveGateway();
    // Forward only the caller's own credentials. The core decides whether the
    // caller may list models; the bridge must never mint access with its own
    // gateway key (that would make an authenticated endpoint public).
    const headers: Record<string, string> = { Accept: 'application/json' };
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && authorization) {
      headers.Authorization = authorization;
    }
    const apiKeyHeader = request.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader) {
      headers['x-api-key'] = apiKeyHeader;
    }

    try {
      const upstream = await axios.get(`http://127.0.0.1:${port}/v1/models`, {
        headers,
        timeout: 5000,
        validateStatus: () => true,
      });
      const data = upstream.data;
      if (data && Array.isArray(data.data)) {
        const models: any[] = canonicalizeModelEntries(data.data).filter(
          (model: any) => typeof model?.id === 'string' && isGeminiModelId(model.id),
        );
        // The two AI Studio models are served by the key pool, not the core.
        if (geminiApiPool.hasEnabledKeys()) {
          for (const id of GEMINI_API_MODELS) {
            if (!models.some((model: any) => model?.id === id)) {
              models.push({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'google',
              });
            }
          }
        }
        return reply.code(upstream.status).send({
          ...data,
          data: models,
        });
      }
      // Non-standard upstream shape: pass it through unchanged.
      return reply.code(upstream.status).send(data);
    } catch (error: any) {
      request.log.warn({ err: error?.message }, 'models: core listing unavailable');
      return reply.code(503).send({
        error: {
          message: 'The model list is temporarily unavailable.',
          type: 'upstream_unavailable',
          code: 'model_list_unavailable',
        },
      });
    }
  });

  app.all('/v1/*', { bodyLimit: V1_REQUEST_BODY_LIMIT_BYTES }, proxyApiRequest);
  app.all('/v1beta/*', { bodyLimit: V1_REQUEST_BODY_LIMIT_BYTES }, proxyApiRequest);

  // REST API Routes

  // ---- Authentication (public) ----

  // POST /api/auth/login — exchange the admin password for a session token.
  app.post<{ Body?: { password?: string } }>('/api/auth/login', async (request, reply) => {
    // Open mode (no admin password): issue a session with no credential at all,
    // so signing out and back in still works.
    if (!ADMIN_PASSWORD) {
      const session = sessions.create();
      return { ok: true, token: session.token, expiresAt: session.expiresAt, open: true };
    }

    const password = request.body?.password;
    if (typeof password !== 'string' || password.length === 0) {
      return reply.code(400).send({ ok: false, error: 'Password is required.' });
    }

    if (!safeEqual(password, ADMIN_PASSWORD)) {
      app.log.warn('Failed dashboard login attempt');
      return reply.code(401).send({ ok: false, error: 'Incorrect password.' });
    }

    const session = sessions.create();
    return { ok: true, token: session.token, expiresAt: session.expiresAt, open: false };
  });

  // GET /api/auth/session — is the current token still valid?
  app.get('/api/auth/session', async (request, reply) => {
    if (!ADMIN_PASSWORD) {
      return { authenticated: true, open: true, requiresPassword: false };
    }
    const header = request.headers['authorization'];
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const valid = sessions.isValid(token) || (token ? safeEqual(token, ADMIN_PASSWORD) : false);
    if (!valid) {
      return reply.code(401).send({ authenticated: false, requiresPassword: true });
    }
    return { authenticated: true, open: false, requiresPassword: true };
  });

  // POST /api/auth/logout — drop the session token.
  app.post('/api/auth/logout', async (request) => {
    const header = request.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      sessions.revoke(header.slice(7));
    }
    return { ok: true };
  });

  // ---- Public aggregates (safe for an unauthenticated marketing site) ----
  // These expose counts and model ids only: never account emails, quota
  // detail, traffic contents or the API key.

  app.get('/api/public/stats', async () => {
    const accounts = (await loadCoreAccounts()) ?? store.getAccounts();
    const traffic = store.getTraffic();
    const pool = derivePoolState(accounts, traffic);
    const activeAccounts = accounts.filter((a) => a.status === 'active');
    const { port: gatewayPort } = resolveGateway();

    let gatewayResponding = false;
    try {
      const r = await axios.get(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        timeout: 2500,
        validateStatus: () => true,
      });
      gatewayResponding = r.status >= 200 && r.status < 500;
    } catch {
      gatewayResponding = false;
    }

    return {
      online: gatewayResponding,
      uptimeSeconds: store.getUptimeSeconds(),
      accountsConnected: activeAccounts.length,
      accountsTotal: accounts.length,
      requestsServed: pool.requestsLast24h,
      tokensServed: pool.tokensLast24h,
      averageLatencyMs: pool.averageLatencyMs,
      successRate: pool.successRate,
      version: BRIDGE_VERSION,
    };
  });

  app.get('/api/public/models', async () => {
    // The public site exposes only the two AI Studio models for now. The
    // dashboard still lists the rest of the Gemini catalog for the account pool.
    const models = GEMINI_API_MODELS.map((id) => {
      const meta = MODEL_CATALOG.find((entry) => entry.id === id);
      return {
        id,
        name: meta?.name || id,
        provider: 'Google Gemini',
        contextLength: meta?.contextLength || 1048576,
        maxOutputTokens: meta?.maxOutputTokens || 65535,
      };
    });
    return {
      source: 'gemini-api',
      online: geminiApiPool.hasEnabledKeys(),
      models,
    };
  });

  /**
   * Read the live account pool from the core and map it to the dashboard shape.
   * Shared by /api/status and /api/accounts so both always agree.
   * Returns null when the core is unreachable or returns nothing usable.
   */
  const snapshotAccountEmails = async (): Promise<Set<string>> => {
    const current = (await loadCoreAccounts()) ?? store.getAccounts();
    return new Set(current.map((account) => account.email.toLowerCase()));
  };

  const rememberOAuthBaseline = async (sessionId: string): Promise<void> => {
    const now = Date.now();
    for (const [key, value] of oauthBaselines) {
      if (value.expiresAt <= now) oauthBaselines.delete(key);
    }
    oauthBaselines.set(sessionId, {
      emails: await snapshotAccountEmails(),
      expiresAt: now + 10 * 60 * 1000,
    });
  };

  const isDuplicateOAuth = (value: unknown): boolean => {
    try {
      return /duplicate|already exists|already connected/i.test(JSON.stringify(value || {}));
    } catch {
      return false;
    }
  };

  const emailFromOAuthStatus = (value: unknown): string | undefined => {
    try {
      const match = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(JSON.stringify(value || {}));
      return match?.[0];
    } catch {
      return undefined;
    }
  };

  /**
   * Polls for either a new account or the core's duplicate-account diagnostic.
   * The core acknowledges the code before the asynchronous token exchange, so
   * a duplicate is only visible through the OAuth status/diagnostic.
   */
  const waitForOAuthAccount = async (
    sessionId: string,
    timeoutMs = 15_000,
  ): Promise<{ email?: string; duplicate?: boolean; status?: any }> => {
    const baseline = oauthBaselines.get(sessionId)?.emails;
    const deadline = Date.now() + timeoutMs;
    let lastStatus: any = null;
    let tick = 0;
    while (Date.now() < deadline) {
      const current = (await loadCoreAccounts()) ?? store.getAccounts();
      const fresh = current.find((account) => !baseline || !baseline.has(account.email.toLowerCase()));
      if (fresh) return { email: fresh.email, status: lastStatus };

      if (tick++ % 2 === 0) {
        try {
          lastStatus = await coreClient.getOAuthStatus(sessionId);
        } catch {
          lastStatus = null;
        }
        if (isDuplicateOAuth(lastStatus)) {
          return { duplicate: true, status: lastStatus, email: emailFromOAuthStatus(lastStatus) };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return { status: lastStatus };
  };

  const loadCoreAccounts = async (): Promise<GoogleAccount[] | null> => {
    if (!(await coreClient.isCoreAlive())) return null;
    try {
      const coreViews = await coreClient.callRpc<any[]>('accountViews');
      if (!Array.isArray(coreViews)) return null;

      const mapped: GoogleAccount[] = coreViews.map((cv: any) => {
        const quotas = cv.quota?.models
          ? Object.entries(cv.quota.models).map(([modelId, q]: [string, any]) => ({
              modelId: canonicalModelId(modelId),
              modelName: canonicalModelId(q.display_name || modelId),
              requestsIn5h: Math.round((1 - (q.percentage || 0) / 100) * 50),
              limitIn5h: 50,
              resetTime5h: q.resetTime || 'in 3h',
              tokensIn7d: 100000,
              limitIn7d: 2000000,
              resetTime7d: 'in 4 days',
              isThrottled: (q.percentage || 0) <= 0,
            }))
          : [];

        const quotaGroups = Array.isArray(cv.quota?.quota_groups)
          ? cv.quota.quota_groups.map((g: any) => ({
              displayName: g.display_name,
              description: g.description,
              buckets: Array.isArray(g.buckets)
                ? g.buckets.map((b: any) => ({
                    bucketId: b.bucket_id,
                    window: b.window,
                    remainingFraction: b.remaining_fraction,
                    resetTime: b.reset_time,
                    displayName: b.display_name,
                  }))
                : [],
            }))
          : undefined;

        const clientTarget = cv.is_active_ide
          ? 'IDE'
          : cv.is_active_agy
          ? 'CLI'
          : cv.is_active_classic
          ? 'Classic'
          : 'Not in use';

        const testRes = accountTester.getLastResult(cv.id);

        // Compact per-model quota lists for the overview. The core reports
        // `percentage` as REMAINING quota (0 = exhausted, 100 = untouched),
        // so it is surfaced as-is under a "remaining" label.
        const coreModels: Record<string, any> = cv.quota?.models || {};
        const models5h = Object.entries(coreModels)
          .filter(([, q]: [string, any]) => typeof q?.percentage === 'number')
          .map(([id, q]: [string, any]) => ({
            name: canonicalModelId(q.display_name || id),
            reset: q.resetTime || '',
            percentage: Math.round(q.percentage),
          }))
          .sort((a, b) => b.percentage - a.percentage)
          .slice(0, 6);

        // If the account recently passed a live test call (200 OK), it is operational and does NOT require verification
        const requiresVerification =
          testRes?.ok === true
            ? false
            : Boolean(cv.health?.validation?.has_verification_link) ||
              accountTester.isValidationRequired(cv.id) ||
              Boolean(testRes?.requiresValidation);

        const status = requiresVerification ? 'error' : cv.status === 'active' ? 'active' : 'standby';
        const coreStatus = typeof cv.status === 'string' ? cv.status : undefined;
        const refreshBlocked = Boolean(cv.health?.oauth?.refresh_blocked);

        return {
          id: cv.id,
          email: cv.email,
          name: cv.name || cv.email.split('@')[0],
          avatarUrl: cv.avatar_url,
          status,
          addedAt: cv.created_at || new Date().toISOString(),
          lastUsedAt: cv.last_used,
          tier: (cv.quota?.subscription_tier as any) || 'Unknown',
          clientTarget,
          quotas,
          quotaGroups,
          models5h,
          isDefaultRouting: cv.is_active || false,
          totalRequests24h: 0,
          hasValidationLink: requiresVerification,
          statusReason: requiresVerification
            ? 'Google requires account verification'
            : cv.status_reason || undefined,
          coreStatus,
          refreshBlocked,
          lastTestResult: testRes,
        };
      });

      // Stable sort: Primary account first, then by creation date ascending, then email.
      // Never re-orders by lastUsedAt so accounts NEVER jump up or down on test or refresh!
      mapped.sort((a, b) => {
        if (a.isDefaultRouting && !b.isDefaultRouting) return -1;
        if (!a.isDefaultRouting && b.isDefaultRouting) return 1;
        const tA = Number(a.addedAt) || new Date(a.addedAt).getTime() || 0;
        const tB = Number(b.addedAt) || new Date(b.addedAt).getTime() || 0;
        if (tA !== tB) return tA - tB;
        return a.email.localeCompare(b.email);
      });

      store.setAccounts(mapped);
      return mapped;
    } catch (err) {
      app.log.warn('Could not read core accounts, falling back to local store');
      return null;
    }
  };

  // Quota snapshots in the core are cached. Without a refresh the dashboard
  // keeps showing the values from the last test/refresh, which can be days old
  // while traffic is still being served. Refresh all active accounts on a
  // timer and expose a manual endpoint for an immediate update.
  let quotaRefreshedAt: string | null = null;
  let quotaRefreshInFlight = false;

  const refreshAllQuotas = async (): Promise<void> => {
    if (quotaRefreshInFlight) return;
    if (!(await coreClient.isCoreAlive())) return;
    quotaRefreshInFlight = true;
    try {
      const accounts = (await loadCoreAccounts()) ?? store.getAccounts();
      for (const account of accounts) {
        if (account.status === 'error') continue;
        try {
          await coreClient.callRpc('accountRefreshQuota', { accountId: account.id });
        } catch {
          // One account failing must not stop the others.
        }
      }
      await loadCoreAccounts();
      quotaRefreshedAt = new Date().toISOString();
    } catch (err: any) {
      app.log.warn({ err: err?.message }, 'Automatic quota refresh failed');
    } finally {
      quotaRefreshInFlight = false;
    }
  };

  const quotaRefreshMs = Math.max(
    60_000,
    Number.parseInt(process.env.QUOTA_REFRESH_INTERVAL_MS || '300000', 10) || 300_000,
  );
  const quotaRefreshTimer = setInterval(() => {
    void refreshAllQuotas();
  }, quotaRefreshMs);
  quotaRefreshTimer.unref();
  setTimeout(() => {
    void refreshAllQuotas();
  }, 5_000).unref();

  app.post('/api/accounts/refresh-quotas', async () => {
    await refreshAllQuotas();
    return (await loadCoreAccounts()) ?? store.getAccounts();
  });

  // Long-audio transcription/translation. These routes live on the bridge,
  // not the core, because a 1-2 hour recording must be split into <15 MiB
  // chunks. Each chunk is sent back through the normal /v1 proxy so leases,
  // quota checks and account failover still apply. Deployments must route
  // /v1/audio/* to the bridge (port 3000) rather than the core (port 8045).
  const mediaRouteDeps = {
    config: mediaConfig,
    getApiKeys: gatewayApiKeys,
    getGatewayApiKeys: gatewayApiKeys,
    getInternalBaseUrl: () => {
      const address = app.server.address();
      if (address && typeof address === 'object' && 'port' in address && address.port) {
        return `http://127.0.0.1:${address.port}`;
      }
      return `http://127.0.0.1:${PORT}`;
    },
    ensureAccounts: async () => {
      if (!store.getAccounts().some((account) => account.status !== 'error')) {
        await loadCoreAccounts();
      }
    },
  };
  registerMediaRoutes(app, mediaRouteDeps);

  // The core leaves request_logs at outcome=in_progress when the calling
  // client disconnects mid-request. Those rows never receive a finish event,
  // so after this window the dashboard reports them as aborted instead of an
  // endless "in progress" spinner. Override with STALE_IN_PROGRESS_MS.
  const STALE_IN_PROGRESS_MS = Math.max(
    60_000,
    Number.parseInt(process.env.STALE_IN_PROGRESS_MS || '300000', 10) || 300_000,
  );

  const mapCoreTrafficItems = (items: any[], accounts: GoogleAccount[]): TrafficRecord[] =>
    mapCoreTrafficItemsFromCore(items, accounts, STALE_IN_PROGRESS_MS);

  // The core's audit/list RPC can become very slow when the audit database
  // grows (the payload tables are ~1 GB). Its HTTP audit endpoint is indexed
  // and paginated, so prefer it and keep the RPC as a compatibility fallback.
  const fetchCoreAuditPage = async (query: {
    from?: number;
    to?: number;
    trafficClass: string;
    limit: number;
    offset: number;
  }): Promise<any | null> => {
    try {
      const { port, apiKey } = resolveGateway();
      const params: Record<string, string | number> = {
        trafficClass: query.trafficClass,
        limit: query.limit,
        offset: query.offset,
      };
      if (Number.isFinite(query.from)) params.from = query.from as number;
      if (Number.isFinite(query.to)) params.to = query.to as number;

      const response = await axios.get(`http://127.0.0.1:${port}/internal/audit/requests`, {
        timeout: Math.max(
          2000,
          Number.parseInt(process.env.CORE_AUDIT_TIMEOUT_MS || '', 10) || 8000,
        ),
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        params,
        validateStatus: () => true,
      });
      if (response.status === 200 && Array.isArray(response.data?.items)) {
        return response.data;
      }
    } catch {
      // Fall back to the RPC below for older cores without the HTTP endpoint.
    }
    return null;
  };

  let trafficCache: {
    key: string;
    expiresAt: number;
    value: { total: number; records: TrafficRecord[] };
  } | null = null;

  const loadCoreModelTraffic = async (options: {
    from?: number;
    to?: number;
    allPages?: boolean;
    accounts?: GoogleAccount[];
  } = {}): Promise<{ total: number; records: TrafficRecord[] } | null> => {
    if (!(await coreClient.isCoreAlive())) return null;

    const cacheKey = [
      options.allPages ? 'all' : 'first',
      Math.floor((options.from ?? 0) / 60_000),
      Math.floor((options.to ?? 0) / 60_000),
    ].join(':');
    if (trafficCache && trafficCache.key === cacheKey && trafficCache.expiresAt > Date.now()) {
      return trafficCache.value;
    }

    try {
      const limit = 200;
      let query: { from?: number; to?: number; trafficClass: string; limit: number; offset: number } = {
        from: options.from,
        to: options.to,
        trafficClass: 'model',
        limit,
        offset: 0,
      };
      let firstPage = await fetchCoreAuditPage(query);
      if (!firstPage) {
        firstPage = await coreClient.callRpc<any>('audit/list', query);
      }
      // Older core builds may not accept an upper time bound. Retry with the
      // supported lower bound and apply `to` after mapping the returned rows.
      if (!firstPage && options.to !== undefined) {
        query = { from: options.from, trafficClass: 'model', limit, offset: 0 };
        firstPage =
          (await fetchCoreAuditPage(query)) ??
          (await coreClient.callRpc<any>('audit/list', query));
      }
      if (!firstPage || !Array.isArray(firstPage.items)) return null;

      const items = [...firstPage.items];
      if (options.allPages) {
        const total = Number(firstPage.total) || items.length;
        for (let offset = limit; offset < total; offset += limit) {
          const page =
            (await fetchCoreAuditPage({ ...query, offset })) ??
            (await coreClient.callRpc<any>('audit/list', { ...query, offset }));
          if (!page || !Array.isArray(page.items) || page.items.length === 0) break;
          items.push(...page.items);
        }
      }

      const accounts = options.accounts ?? (await loadCoreAccounts()) ?? store.getAccounts();
      const records = mapCoreTrafficItems(items, accounts);
      // The bridge tags forwarded account calls with x-geminirouter-key-id; the
      // core stores request headers, so join them back for Traffic attribution.
      const taggedKeys = getSharedCoreAuditDb().getGatewayKeyIds(records.map((record) => record.id));
      if (taggedKeys.size > 0) {
        for (const record of records) {
          const keyId = taggedKeys.get(record.id);
          if (!keyId) continue;
          record.gatewayKeyId = keyId;
          record.gatewayKeyName = gatewayKeyLabel(keyId);
        }
      }
      const value = {
        total: Number(firstPage.total) || items.length,
        records,
      };
      trafficCache = { key: cacheKey, expiresAt: Date.now() + 15_000, value };
      return value;
    } catch {
      return null;
    }
  };

  const getAccountUsage24h = async (
    accounts: GoogleAccount[],
  ): Promise<Map<string, { requests: number; tokens: number }>> => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const live = await loadCoreModelTraffic({ from: since, allPages: true, accounts });
    const records = live?.records ?? store.getTraffic();
    const usage = new Map<string, { requests: number; tokens: number }>();
    for (const record of records) {
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < since) continue;
      const key = record.backingAccountEmail;
      if (!key) continue;
      const current = usage.get(key) ?? { requests: 0, tokens: 0 };
      current.requests += 1;
      current.tokens += record.totalTokens || 0;
      usage.set(key, current);
    }
    return usage;
  };

  type AvailabilityBucketState = 'ok' | 'partial' | 'error' | 'empty';
  type ModelAvailabilityHistory = {
    windowStart: string;
    windowEnd: string;
    bucketMs: number;
    buckets: Array<{
      state: AvailabilityBucketState;
      requests: number;
      successes: number;
      failures: number;
    }>;
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    availabilityPercent: number | null;
  };

  let modelHistoryCache: {
    expiresAt: number;
    histories: Record<string, ModelAvailabilityHistory>;
  } | null = null;

  const loadModelAvailabilityHistory = async (): Promise<Record<string, ModelAvailabilityHistory>> => {
    const now = Date.now();
    if (modelHistoryCache && modelHistoryCache.expiresAt > now) {
      return modelHistoryCache.histories;
    }

    const bucketMs = 60 * 60 * 1000;
    const bucketCount = 72;
    const windowStart = now - bucketMs * bucketCount;
    const liveTraffic = await loadCoreModelTraffic({ from: windowStart, allPages: true, accounts: [] });
    if (!liveTraffic) return {};

    const mutable = new Map<string, Array<{ requests: number; successes: number; failures: number }>>();
    for (const record of liveTraffic.records) {
      const model = record.modelRequested;
      const timestamp = Date.parse(record.timestamp);
      if (!model || model === 'unknown' || !Number.isFinite(timestamp)) continue;
      const index = Math.floor((timestamp - windowStart) / bucketMs);
      if (index < 0 || index >= bucketCount) continue;

      let buckets = mutable.get(model);
      if (!buckets) {
        buckets = Array.from({ length: bucketCount }, () => ({ requests: 0, successes: 0, failures: 0 }));
        mutable.set(model, buckets);
      }
      const bucket = buckets[index];
      bucket.requests += 1;
      if (record.status >= 200 && record.status < 400) bucket.successes += 1;
      else if (record.status >= 400) bucket.failures += 1;
    }

    const histories: Record<string, ModelAvailabilityHistory> = {};
    for (const [model, counts] of mutable) {
      const successfulRequests = counts.reduce((sum, bucket) => sum + bucket.successes, 0);
      const failedRequests = counts.reduce((sum, bucket) => sum + bucket.failures, 0);
      const completedRequests = successfulRequests + failedRequests;
      histories[model] = {
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(now).toISOString(),
        bucketMs,
        buckets: counts.map((bucket) => ({
          ...bucket,
          state:
            bucket.requests === 0 || (bucket.successes === 0 && bucket.failures === 0)
              ? 'empty'
              : bucket.failures === 0
              ? 'ok'
              : bucket.successes === 0
              ? 'error'
              : 'partial',
        })),
        totalRequests: counts.reduce((sum, bucket) => sum + bucket.requests, 0),
        successfulRequests,
        failedRequests,
        availabilityPercent:
          completedRequests > 0
            ? Math.round((successfulRequests / completedRequests) * 10000) / 100
            : null,
      };
    }

    modelHistoryCache = { expiresAt: now + 30_000, histories };
    return histories;
  };

  const emptyModelAvailabilityHistory = (): ModelAvailabilityHistory => {
    const windowEnd = Date.now();
    const bucketMs = 60 * 60 * 1000;
    const bucketCount = 72;
    return {
      windowStart: new Date(windowEnd - bucketMs * bucketCount).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      bucketMs,
      buckets: Array.from({ length: bucketCount }, () => ({
        state: 'empty' as const,
        requests: 0,
        successes: 0,
        failures: 0,
      })),
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      availabilityPercent: null,
    };
  };

  // 1. GET /api/status — real state only. Numbers are derived from real
  // traffic records; nothing here is fabricated. Per-request failover and
  // cooldowns are owned by the core (docs/ACCOUNT-FAILOVER.md); the bridge
  // reports what it can observe.
  // The media concurrency gate is documented in docs/MEDIA_API.md.
  app.get('/api/media/queue', async () => ({
    ...getSharedMediaGate().stats(),
    queueTimeoutMs: readMediaGateOptions().timeoutMs,
  }));

  // Shallow liveness probe for reverse proxies and uptime monitors. It is in
  // auth.ts PUBLIC_EXACT, so it must stay free of account, quota and traffic
  // detail: only proof that this process is serving requests.
  app.get('/api/health', async () => ({
    ok: true,
    service: 'geminirouter-bridge',
    version: BRIDGE_VERSION,
    uptimeSeconds: store.getUptimeSeconds(),
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/status', async () => {
    if (!quotaRefreshedAt || Date.now() - Date.parse(quotaRefreshedAt) > quotaRefreshMs) {
      void refreshAllQuotas();
    }
    const isCoreAlive = await coreClient.isCoreAlive();
    let coreStatus = null;
    if (isCoreAlive) {
      coreStatus = await coreClient.getStatus();
      if (coreStatus?.gateway) {
        store.setGatewayRunning(coreStatus.gateway.running, coreStatus.gateway.port || undefined);
      }
    }

    // Probe the real gateway port instead of trusting stored flags.
    const { port: gatewayPort, apiKey } = resolveGateway();
    let gatewayResponding = false;
    try {
      await axios.get(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        timeout: 2500,
        // Any HTTP answer (200 or 401) proves the gateway is up.
        validateStatus: () => true,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      }).then((r) => {
        gatewayResponding = r.status >= 200 && r.status < 500;
      });
    } catch {
      gatewayResponding = false;
    }
    if (gatewayResponding !== store.isGatewayRunning()) {
      store.setGatewayRunning(gatewayResponding, gatewayPort);
    }

    // Live pool from the core so the overview always has quota detail.
    const accounts = (await loadCoreAccounts()) ?? store.getAccounts();
    const liveTraffic = isCoreAlive
      ? await loadCoreModelTraffic({ from: Date.now() - 24 * 60 * 60 * 1000, allPages: true, accounts })
      : null;
    const traffic = liveTraffic?.records ?? store.getTraffic();
    const pool = derivePoolState(accounts, traffic);
    const now = Date.now();
    const requestVolume12h = Array.from({ length: 12 }, () => 0);
    let requestsLast12h = 0;
    let errorsLast12h = 0;
    let errorsLast24h = 0;
    for (const record of traffic) {
      const ageMs = now - Date.parse(record.timestamp);
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= 24 * 60 * 60 * 1000) continue;
      if (record.status >= 400) errorsLast24h += 1;
      if (ageMs < 12 * 60 * 60 * 1000) {
        if (record.status >= 400) errorsLast12h += 1;
        const hoursAgo = Math.floor(ageMs / (60 * 60 * 1000));
        requestVolume12h[11 - hoursAgo] += 1;
        requestsLast12h += 1;
      }
    }
    const activeAccounts = accounts.filter((a) => a.status === 'active');

    return {
      isRunning: gatewayResponding,
      // The gateway is always-on by design; `isRunning` above is the observed
      // probe result, `alwaysOn` tells the UI not to offer a pause control.
      alwaysOn: true,
      port: gatewayPort,
      host: store.getConfig().host,
      uptimeSeconds: store.getUptimeSeconds(),
      activeAccountsCount: activeAccounts.length,
      totalAccountsCount: accounts.length,
      requestsLast24h: pool.requestsLast24h,
      tokensLast24h: pool.tokensLast24h,
      requestsLast12h,
      errorsLast12h,
      errorsLast24h,
      requestVolume12h,
      requestVolume12hWindowEnd: new Date(now).toISOString(),
      averageLatencyMs: pool.averageLatencyMs,
      successRate: pool.successRate,
      activeBackingAccountEmail: pool.activeBackingAccountEmail,
      cooldownAccounts: pool.cooldownAccounts,
      lastSwitch: pool.lastSwitch,
      inFlightPerAccount: leaseManager.getAllInFlight(),
      totalInFlight: leaseManager.getTotalInFlight(),
      totalCapacity: leaseManager.getTotalCapacity(activeAccounts.length),
      maxConcurrentRequestsPerAccount: leaseManager.getMaxConcurrentRequestsPerAccount(),
      capacityPolicy: leaseManager.getCapacityPolicy(),
      queueTimeoutMs: leaseManager.getQueueTimeoutMs(),
      // Real health: gateway answering AND at least one usable account,
      // or a reachable core that can still serve its own error states.
      healthy: gatewayResponding && (activeAccounts.length > 0 || isCoreAlive),
      // Accounts whose OAuth refresh is blocked need reauthorization; a jump
      // here is the first sign the Antigravity client was rotated or revoked.
      accountsNeedingReauth: accounts.filter(
        (a) => a.refreshBlocked || a.coreStatus === 'expired',
      ).length,
      coreCredentials: readCoreCredentialState(),
      coreConnected: isCoreAlive,
      quotaRefreshedAt,
      coreEndpoint: coreClient.getEndpoint(),
      corePid: coreStatus?.pid,
      version: BRIDGE_VERSION,
      // Extra overview surface: everything the dashboard needs in one call.
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        avatarUrl: a.avatarUrl,
        status: a.status,
        tier: a.tier,
        isDefaultRouting: a.isDefaultRouting,
        hasValidationLink: Boolean(a.hasValidationLink),
        statusReason: a.statusReason,
        coreStatus: a.coreStatus,
        refreshBlocked: Boolean(a.refreshBlocked),
        lastTestResult: accountTester.getLastResult(a.id) ?? undefined,
        models5h: a.models5h ?? [],
        modelsWeekly: a.modelsWeekly ?? [],
        quotaGroups: a.quotaGroups ?? [],
      })),
      config: {        rotationStrategy: store.getConfig().rotationStrategy,
        autoSwitchOnQuotaLimit: store.getConfig().autoSwitchOnQuotaLimit,
        enableStreamRelay: store.getConfig().enableStreamRelay,
        quotaWarningThresholdPercent: store.getConfig().quotaWarningThresholdPercent,
      },
    };
  });

  // 1f. Desktop helper binary. Served only to an authenticated admin session:
  // it is an operator tool, not a public download, so it is never exposed by
  // the static frontend and needs no code-signing certificate.
  // helper/build.ps1 writes into helper/dist/, so that is checked first; the
  // repository root of helper/ is kept for hand-placed builds.
  const HELPER_BINARY_CANDIDATES = resolveHelperBinaryCandidates(
    process.cwd(),
    process.env.HELPER_BINARY_PATH,
  );
  const HELPER_BINARY_PATH =
    HELPER_BINARY_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ??
    HELPER_BINARY_CANDIDATES[0];

  app.get('/api/helper/download', async (_request, reply) => {
    try {
      if (!HELPER_BINARY_PATH || !fs.existsSync(HELPER_BINARY_PATH)) {
        return reply.code(404).send({
          error: 'Helper binary is not installed on this server',
          message: `Build it with helper/build.ps1 and set HELPER_BINARY_PATH. Looked at: ${HELPER_BINARY_CANDIDATES.join(', ')}.`,
        });
      }
      const stat = fs.statSync(HELPER_BINARY_PATH);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', 'attachment; filename="FramecallHelper.exe"');
      reply.header('Content-Length', String(stat.size));
      return reply.send(fs.createReadStream(HELPER_BINARY_PATH));
    } catch (error: any) {
      return reply.code(500).send({ error: 'Could not read the helper binary', message: error?.message });
    }
  });

  // 1g. Desktop helper pairing. The code is minted by the authenticated
  // dashboard and exchanged for a scoped token that only reaches /api/accounts/import.
  app.post('/api/device/pair-code', async () => deviceTokens.createPairingCode());

  app.post<{ Body?: { code?: string; label?: string } }>('/api/device/pair', async (request, reply) => {
    const code = (request.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return reply.code(400).send({ error: 'A 6-digit pairing code is required' });
    }
    const paired = deviceTokens.pair(code, request.body?.label || 'Desktop helper');
    if (!paired) {
      return reply.code(401).send({ error: 'Invalid or expired pairing code' });
    }
    return {
      token: paired.token,
      device: {
        id: paired.device.id,
        label: paired.device.label,
        createdAt: paired.device.createdAt,
      },
    };
  });

  app.get('/api/devices', async () => ({ devices: deviceTokens.list() }));

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) => {
    const removed = deviceTokens.revoke(request.params.id);
    return reply.code(removed ? 200 : 404).send({ success: removed });
  });

  // 1c. Named gateway API keys. The master key stays available; these add
  // per-client keys so Traffic can show which app made each call.
  const maskGatewayKey = (key: string): string =>
    key.length <= 10 ? '••••••' : `${key.slice(0, 7)}…${key.slice(-4)}`;
  const publicGatewayKeys = () =>
    store.getGatewayApiKeys().map((key) => ({
      id: key.id,
      name: key.name,
      maskedKey: maskGatewayKey(key.key),
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
    }));

  app.get('/api/gateway/keys', async () => ({
    masterKey: store.getConfig().masterApiKey,
    keys: publicGatewayKeys(),
  }));

  app.post<{ Body?: { name?: string } }>('/api/gateway/keys', async (request, reply) => {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'A key name is required.' });
    if (name.length > 60) {
      return reply.code(400).send({ error: 'Key name must be 60 characters or fewer.' });
    }
    if (store.getGatewayApiKeys().length >= 50) {
      return reply.code(400).send({ error: 'At most 50 named gateway keys are allowed.' });
    }

    const record = {
      id: `gwk-${randomUUID()}`,
      name,
      key: `sk-gw-${randomBytes(24).toString('base64url')}`,
      createdAt: new Date().toISOString(),
    };
    store.addGatewayApiKey(record);
    return { key: record.key, keys: publicGatewayKeys() };
  });

  app.delete<{ Params: { id: string } }>('/api/gateway/keys/:id', async (request, reply) => {
    const removed = store.removeGatewayApiKey(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'Gateway key not found.' });
    return { success: true, keys: publicGatewayKeys() };
  });

  // 2. GET /api/accounts
  app.get('/api/accounts', async () => {
    // Real core accounts whenever the core is reachable - including an empty
    // pool. The demo fallback is ONLY for core-offline demo mode; it must
    // never mask the real pool state.
    const accounts = (await loadCoreAccounts()) ?? store.getAccounts();
    const usage = await getAccountUsage24h(accounts);
    return accounts.map((account) => ({
      ...account,
      usage24h: usage.get(account.email) ?? { requests: 0, tokens: 0 },
    }));
  });

  // 2b. GET /api/accounts/:id/validation-url — resolves fresh, live Google account checkpoint URL
  app.get<{ Params: { id: string } }>('/api/accounts/:id/validation-url', async (request, reply) => {
    const { id } = request.params;
    let acc: GoogleAccount | undefined = store.getAccounts().find((a) => a.id === id);

    if (!acc && (await coreClient.isCoreAlive())) {
      try {
        const views = await coreClient.callRpc<any[]>('accountViews');
        const v = views?.find((x: any) => x.id === id);
        if (v) {
          acc = {
            id: v.id,
            email: v.email,
            name: v.name || v.email,
            status: v.status === 'active' ? 'active' : 'standby',
            addedAt: v.created_at || new Date().toISOString(),
            tier: v.quota?.subscription_tier || 'Unknown',
            quotas: [],
            isDefaultRouting: false,
            totalRequests24h: 0,
          };
        }
      } catch {
        // ignore
      }
    }

    if (acc) {
      const freshUrl = await accountTester.getOrFetchFreshValidationUrl(acc);
      if (freshUrl) {
        let finalUrl = freshUrl;
        if (acc.email) {
          finalUrl = freshUrl + '&Email=' + encodeURIComponent(acc.email) + '&login_hint=' + encodeURIComponent(acc.email);
        }
        return { ok: true, url: finalUrl };
      }
    }

    if (await coreClient.isCoreAlive()) {
      try {
        const res = await coreClient.callRpc<any>('accountValidationUrl', { accountId: id });
        if (res && res.url) {
          let email = acc?.email;
          let finalUrl = res.url;
          if (email) {
            finalUrl = res.url + '&Email=' + encodeURIComponent(email) + '&login_hint=' + encodeURIComponent(email);
          }
          return { ok: true, url: finalUrl };
        }
      } catch (err) {
        app.log.warn(`accountValidationUrl RPC failed for account ${id}`);
      }
    }
    return reply.code(404).send({ ok: false, error: 'No validation URL available for this account' });
  });

  // 2c. POST /api/accounts/:id/switch — switch client target (Classic, IDE, CLI)
  app.post<{ Params: { id: string }; Body: { appTarget?: 'ide' | 'agy' | 'classic' } }>(
    '/api/accounts/:id/switch',
    async (request, reply) => {
      const { id } = request.params;
      const { appTarget } = request.body || {};
      if (await coreClient.isCoreAlive()) {
        try {
          const target = appTarget === 'classic' ? undefined : appTarget;
          await coreClient.callRpc('accountSwitch', { accountId: id, appTarget: target });
          return { success: true };
        } catch (err: any) {
          return reply.code(400).send({ success: false, error: err.message || 'Failed to switch account' });
        }
      }
      return reply.code(503).send({ success: false, error: 'Core offline' });
    }
  );

  // 2d. POST /api/accounts/:id/test — test model call specifically targeting this account & refresh quotas
  app.post<{ Params: { id: string }; Body?: { model?: string } }>(
    '/api/accounts/:id/test',
    async (request, reply) => {
      const { id } = request.params;
      const model = request.body?.model || 'gemini-3.1-flash-lite';
      const list = (await loadCoreAccounts()) ?? store.getAccounts();
      const acc = list.find((a) => a.id === id);

      if (!acc) {
        return reply.code(404).send({ ok: false, error: 'Account not found' });
      }

      const result = await accountTester.testAndRefreshAccount(acc, model);
      return result;
    }
  );

  // 2e. POST /api/accounts/test-all — test all accounts in pool & refresh all quotas
  app.post<{ Body?: { model?: string } }>('/api/accounts/test-all', async (request) => {
    const model = request.body?.model || 'gemini-3.1-flash-lite';
    const results = await accountTester.testAndRefreshAll(model);
    return { success: true, count: results.length, results };
  });

  // 2f. GET /api/accounts/test-results — get last test results
  app.get('/api/accounts/test-results', async () => {
    return accountTester.getAllLastResults();
  });

  // 2g. POST /api/accounts/import — import an Antigravity account export file.
  // The core's RPC reads from a path on the core machine, so the JSON is staged
  // in .data/imports (same host/user) and removed immediately afterwards.
  const ACCOUNT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
  const IMPORT_STRATEGIES = new Set(['merge', 'overwrite', 'skip-existing']);
  app.post<{
    Body?: { content?: string; strategy?: 'merge' | 'overwrite' | 'skip-existing' };
  }>('/api/accounts/import', async (request, reply) => {
    const { content, strategy } = request.body || {};
    if (typeof content !== 'string' || content.trim() === '') {
      return reply.code(400).send({ success: false, error: 'content is required' });
    }
    if (Buffer.byteLength(content, 'utf8') > ACCOUNT_IMPORT_MAX_BYTES) {
      return reply.code(413).send({ success: false, error: 'Import file is larger than 5 MB' });
    }
    const importStrategy = strategy ?? 'merge';
    if (!IMPORT_STRATEGIES.has(importStrategy)) {
      return reply.code(400).send({ success: false, error: 'Invalid import strategy' });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return reply.code(400).send({ success: false, error: 'Import file is not valid JSON' });
    }
    const candidate = parsed as {
      version?: unknown;
      exportedAt?: unknown;
      accounts?: unknown;
    } | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      candidate.version !== '1.0' ||
      typeof candidate.exportedAt !== 'number' ||
      !Array.isArray(candidate.accounts)
    ) {
      return reply.code(400).send({
        success: false,
        error:
          'Not an Antigravity account export: expected version "1.0", a numeric exportedAt and an accounts array.',
      });
    }

    if (!(await coreClient.isCoreAlive())) {
      return reply.code(503).send({
        success: false,
        error: 'Core is offline',
        message: 'Account import requires the AntigravityManager core.',
      });
    }

    const importsDir = path.join(dataDirPath(), 'imports');
    const importFile = path.join(importsDir, `import-${Date.now()}-${randomUUID()}.json`);
    try {
      fs.mkdirSync(importsDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(importFile, content, { encoding: 'utf8', mode: 0o600 });
      const result = await coreClient.callRpc('accountFileImport', {
        filePath: importFile,
        strategy: importStrategy,
      });
      if (!result) {
        return reply.code(502).send({
          success: false,
          error: 'Core rejected the import',
          message: 'Check the core logs for the exact reason.',
        });
      }
      return { success: true, strategy: importStrategy, result };
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: 'Import failed',
        message: error?.message || String(error),
      });
    } finally {
      try {
        fs.unlinkSync(importFile);
      } catch {
        /* best effort */
      }
    }
  });

  // 3. POST /api/accounts/refresh — test all accounts and refresh quotas from core
  app.post('/api/accounts/refresh', async () => {
    if (await coreClient.isCoreAlive()) {
      try {
        await accountTester.testAndRefreshAll();
      } catch {
        app.log.warn('testAndRefreshAll failed; returning last known accounts');
      }
      return (await loadCoreAccounts()) ?? store.getAccounts();
    }

    // Core offline: keep last known data untouched. Do not invent numbers.
    return store.getAccounts();
  });

  // 4. DELETE /api/accounts/:id
  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params;
    const proxyKey = proxyManager.getAccountProxyKey(id);

    // Resolve the account against the core first. The local store can be empty
    // or stale (accounts live in the core), and deleting only the local copy
    // lets the account reappear on the next GET /api/accounts.
    const before = await loadCoreAccounts();
    const coreAlive = before !== null;
    const knownInCore = before?.some((account) => account.id === id) ?? false;
    const knownLocally = store.getAccounts().some((account) => account.id === id);

    if (!coreAlive && !knownLocally) {
      return reply.code(404).send({ success: false, error: 'Account not found in the pool.' });
    }
    if (coreAlive && !knownInCore && !knownLocally) {
      return reply.code(404).send({ success: false, error: 'Account not found in the pool.' });
    }

    if (coreAlive && knownInCore) {
      let result: any = null;
      try {
        result = await coreClient.callRpc('accountDelete', { accountId: id });
      } catch (error: any) {
        return reply.code(502).send({
          success: false,
          error: `Core could not remove the account: ${error?.message || String(error)}`,
        });
      }
      if (!result || result.success !== true) {
        return reply.code(502).send({
          success: false,
          error: `Core refused the removal: ${result?.message || 'unknown error'}`,
        });
      }

      // Confirm the core actually dropped it; otherwise report an honest failure
      // instead of returning success and letting the account reappear.
      const after = await loadCoreAccounts();
      if (after?.some((account) => account.id === id)) {
        return reply.code(502).send({
          success: false,
          error: 'The core still reports this account after the delete; nothing was changed.',
        });
      }

      // The core caches account tokens in memory. Without this reload it keeps
      // selecting the deleted account and answers 503 "All accounts failed".
      try {
        await coreClient.callRpc('accountLeaseReload');
      } catch {
        // Older core without the reload RPC; it will pick up the change on restart.
      }
    }

    const removed = store.removeAccount(id) || knownInCore;
    if (!removed) {
      return reply.code(404).send({ success: false, error: 'Account not found in the pool.' });
    }

    if (proxyKey) {
      // A freed IP from a removed (possibly banned) account cools down before it
      // can be assigned to another account or API key.
      proxyManager.quarantineProxy(proxyKey, 24 * 60 * 60 * 1000);
      persistProxyHealth();
      await runProxySync();
      syncApiKeyProxyAssignments();
    }

    return {
      success: true,
      accounts: store.getAccounts(),
    };
  });

  // 5. POST /api/oauth/start — requires the core; no fake authorization URLs.
  app.post<{ Body: { oauthClientKey?: string; callbackMode?: 'local-relay' | 'hosted' } }>(
    '/api/oauth/start',
    async (request, reply) => {
    const { oauthClientKey, callbackMode } = request.body || {};
    if (callbackMode && callbackMode !== 'local-relay' && callbackMode !== 'hosted') {
      return reply.code(400).send({ error: 'Unsupported OAuth callback mode' });
    }
    if (callbackMode === 'local-relay' && oauthClientKey !== 'antigravity_enterprise') {
      return reply.code(400).send({ error: 'The local relay requires Antigravity sign-in' });
    }
    if (!(await coreClient.isCoreAlive())) {
      return reply.code(503).send({
        error: 'Core is offline',
        message:
          'Google OAuth requires the AntigravityManager core. Start the core (POST /api/core/start) and try again.',
      });
    }

    hostedOAuthSession = null;
    const useHostedCallback =
      callbackMode === 'hosted' || (callbackMode !== 'local-relay' && oauthClientKey === 'framecall_web');
    const redirectUri = callbackMode === 'local-relay'
      ? LOCAL_OAUTH_RELAY_REDIRECT_URI
      : useHostedCallback
        ? WEBSITE_OAUTH_CALLBACK_URI
        : undefined;
    const coreOAuth = await coreClient.startOAuth(oauthClientKey, redirectUri);
    if (!coreOAuth.ok) {
      return reply.code(coreOAuth.status === 409 ? 409 : 502).send({
        error: coreOAuth.error,
        message:
          coreOAuth.status === 409
            ? 'Another login is already in progress. It was cancelled — try again now.'
            : 'The OAuth session could not be started. Check the core logs and retry.',
      });
    }

    await rememberOAuthBaseline(coreOAuth.sessionId);

    if (redirectUri) {
      const state = new URL(coreOAuth.authorizationUrl).searchParams.get('state');
      if (!state) {
        await coreClient.cancelOAuth(coreOAuth.sessionId);
        return reply.code(502).send({
          error: 'Invalid OAuth session',
          message: 'The Google sign-in session did not provide a state token. Please retry.',
        });
      }
      hostedOAuthSession = {
        sessionId: coreOAuth.sessionId,
        state,
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
    }

    return {
      authorizationUrl: coreOAuth.authorizationUrl,
      sessionId: coreOAuth.sessionId,
      expiresInSeconds: 600,
    };
  });

  // Google redirects here for hosted web OAuth. The random state binds this
  // public callback to the authenticated dashboard session that started it.
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    '/oauth/callback',
    { logLevel: 'silent' },
    async (request, reply) => {
      const pending = hostedOAuthSession;
      const { state, code, error } = request.query;
      if (!pending || !state || !safeEqual(state, pending.state)) {
        return reply.code(400).type('text/html; charset=utf-8').send(
          '<!doctype html><html><body><h1>Sign-in session not found</h1><p>Return to geminirouter and start a new Google sign-in.</p></body></html>',
        );
      }
      if (Date.now() > pending.expiresAt) {
        hostedOAuthSession = null;
        return reply.code(410).type('text/html; charset=utf-8').send(
          '<!doctype html><html><body><h1>Sign-in expired</h1><p>Return to geminirouter and start a new Google sign-in.</p></body></html>',
        );
      }
      if (error || !code) {
        hostedOAuthSession = null;
        await coreClient.cancelOAuth(pending.sessionId);
        return reply.code(400).type('text/html; charset=utf-8').send(
          '<!doctype html><html><body><h1>Sign-in cancelled</h1><p>Return to geminirouter to try again.</p></body></html>',
        );
      }

      const completion = await coreClient.completeOAuth(pending.sessionId, code);
      if (!completion.ok) {
        hostedOAuthSession = null;
        oauthBaselines.delete(pending.sessionId);
        if (isDuplicateOAuth(completion.data)) {
          return reply.code(409).type('text/html; charset=utf-8').send(
            '<!doctype html><html><body><h1>Google account already connected</h1><p>This account is already in the gateway. Return to geminirouter and check the Accounts list.</p></body></html>',
          );
        }
        return reply.code(400).type('text/html; charset=utf-8').send(
          '<!doctype html><html><body><h1>Sign-in could not be completed</h1><p>Return to geminirouter and start a new Google sign-in.</p></body></html>',
        );
      }

      // "accepted" only means the core received the code. Confirm an account
      // actually appeared, or detect the core's duplicate-account diagnostic.
      const result = await waitForOAuthAccount(pending.sessionId);
      hostedOAuthSession = null;
      oauthBaselines.delete(pending.sessionId);
      if (result.duplicate) {
        return reply.code(409).type('text/html; charset=utf-8').send(
          `<!doctype html><html><body><h1>Google account already connected</h1><p>${
            result.email
              ? `${result.email
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')} is already connected.`
              : 'This account is already in the gateway.'
          }</p><p>Return to geminirouter and check the Accounts list.</p></body></html>`,
        );
      }
      if (!result.email) {
        return reply.code(400).type('text/html; charset=utf-8').send(
          '<!doctype html><html><body><h1>Google sign-in did not complete</h1><p>No account was added. The account may already be connected, or the authorization code is invalid/expired — return to geminirouter and check the Accounts list.</p></body></html>',
        );
      }

      return reply.type('text/html; charset=utf-8').send(
        `<!doctype html><html><body><h1>Google sign-in complete</h1><p>${result.email
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')} is now connected.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`,
      );
    },
  );

  // 6. POST /api/oauth/complete — requires the core; never fabricates an account.
  app.post<{ Body: { sessionId: string; codeOrUrl?: string; code?: string } }>(
    '/api/oauth/complete',
    async (request, reply) => {
      const { sessionId, codeOrUrl, code } = request.body || {};
      const actualCode = code || codeOrUrl || '';

      if (!sessionId || !actualCode) {
        return reply.code(400).send({
          error: 'sessionId and code are required',
        });
      }

      if (!(await coreClient.isCoreAlive())) {
        return reply.code(503).send({
          error: 'Core is offline',
          message:
            'Google OAuth cannot be completed without the AntigravityManager core. Start the core and restart the flow.',
        });
      }

      const completion = await coreClient.completeOAuth(sessionId, actualCode);
      if (!completion.ok) {
        if (isDuplicateOAuth(completion.data)) {
          const email = emailFromOAuthStatus(completion.data);
          oauthBaselines.delete(sessionId);
          return reply.code(409).send({
            success: false,
            alreadyConnected: true,
            code: 'account_already_connected',
            email,
            error: 'Google account already exists',
            message: `This Google account${
              email ? ` (${email})` : ''
            } is already connected to the gateway. No new account was added; you can close this dialog.`,
          });
        }
        return reply.code(400).send({
          success: false,
          error: 'The core rejected the authorization code',
          message:
            'Verify the code was copied from the OAuth redirect for this session, then retry.',
        });
      }

      // The core acknowledges the code before exchanging it, so wait for the
      // account to appear — or for its duplicate-account diagnostic.
      const result = await waitForOAuthAccount(sessionId);
      oauthBaselines.delete(sessionId);
      if (result.duplicate) {
        return reply.code(409).send({
          success: false,
          alreadyConnected: true,
          code: 'account_already_connected',
          email: result.email,
          error: 'Google account already exists',
          message: `This Google account${
            result.email ? ` (${result.email})` : ''
          } is already connected to the gateway. No new account was added; you can close this dialog.`,
        });
      }
      if (!result.email) {
        return reply.code(409).send({
          success: false,
          alreadyConnected: false,
          code: 'account_not_added',
          error: 'No new account was added',
          message:
            'No new account was added. If this Google account is already in the Accounts list, it is already connected. Otherwise, the code expired or was copied incorrectly — start the sign-in again with a fresh callback URL.',
        });
      }

      return { success: true, email: result.email };
    },
  );

  // 7. POST /api/gateway/start
  app.post<{ Body?: { port?: number } }>('/api/gateway/start', async (request) => {
    const targetPort = request.body?.port || resolveGateway().port || INTERNAL_GATEWAY_PORT;
    if (await coreClient.isCoreAlive()) {
      try {
        await coreClient.callRpc('gatewayStart', { port: targetPort });
      } catch (e) {
        app.log.warn('Could not invoke gatewayStart via core RPC');
      }
    }

    store.setGatewayRunning(true, targetPort);
    return {
      success: true,
      isRunning: true,
      port: targetPort,
    };
  });

  // 8. POST /api/gateway/stop
  // The gateway is always-on by design: stopping it would take the whole router
  // offline. The endpoint is kept for API compatibility but refuses and
  // re-asserts the running state instead of pausing.
  app.post('/api/gateway/stop', async () => {
    app.log.warn('gatewayStop refused: the gateway is always-on by design');
    await ensureGatewayRunning();
    return {
      success: false,
      refused: true,
      isRunning: true,
      port: resolveGateway().port,
      message: 'The gateway is always-on and cannot be paused.',
    };
  });

  // 9. GET /api/config — bridge config merged with the core's real scheduling
  // settings (read from the core profile; the API key is never included).
  app.get('/api/config', async () => {
    const coreProxy = readCoreProxyConfig();
    return coreProxyToBridge(coreProxy, store.getConfig());
  });

  // 10. POST /api/config — saves bridge fields AND applies the routing fields
  // to the core's scheduling config (quota-aware switching, strategy, pinned
  // account). Per-request failover itself is core-owned; these are its knobs.
  app.post<{ Body: Partial<ReturnType<typeof store.getConfig>> }>('/api/config', async (request) => {
    const updated = store.updateConfig(request.body || {});
    if (updated.maxConcurrentRequestsPerAccount) {
      leaseManager.setMaxConcurrentRequestsPerAccount(updated.maxConcurrentRequestsPerAccount);
    }
    if (updated.capacityPolicy) {
      leaseManager.setCapacityPolicy(updated.capacityPolicy);
    }
    if (updated.queueTimeoutMs) {
      leaseManager.setQueueTimeoutMs(updated.queueTimeoutMs);
    }
    const corePatch = bridgeToCoreProxy(request.body || {});
    let coreApply = null;
    if (Object.keys(corePatch).length > 0) {
      coreApply = applyCoreProxyConfig(corePatch);
      app.log.info(
        `Core scheduling config ${coreApply.appliedToFile ? 'written to profile' : 'NOT written'}: ${Object.keys(corePatch).join(', ')}`,
      );
    }
    const coreProxy = readCoreProxyConfig();
    return {
      ...coreProxyToBridge(coreProxy, updated),
      coreApply,
    };
  });

  // 10a. GET /api/proxy/config — proxy configuration (API key redacted).
  app.get('/api/proxy/config', async () => proxyManager.getConfigSnapshot());

  // 10b. POST /api/proxy/config — set the Webshare API key and/or enable routing.
  // The key is write-only: an omitted/blank key leaves the stored one untouched.
  // Every save re-fetches the inventory and pushes the resulting per-account
  // proxy URLs to the core. Always answers 200; failures are reported in
  // `error` / `sync.failed` so the dashboard can show them.
  app.post<{ Body?: { enabled?: boolean; webshareApiKey?: string } }>(
    '/api/proxy/config',
    async (request) => {
      const { enabled, webshareApiKey } = request.body || {};
      let error: string | undefined;
      let refreshed = false;

      if (typeof webshareApiKey === 'string' && webshareApiKey.trim().length > 0) {
        const key = webshareApiKey.trim();
        store.setWebshareApiKey(key);
        proxyManager.setApiKey(key);

        const refresh = await proxyManager.refreshProxies();
        refreshed = true;
        if (!refresh.ok) {
          error = refresh.error || 'Could not fetch the Webshare proxy list.';
        }
      }

      if (typeof enabled === 'boolean' && (enabled === false || !error)) {
        if (enabled && !proxyManager.hasApiKey()) {
          error = 'A Webshare API key is required before proxy routing can be enabled.';
        } else {
          proxyManager.setEnabled(enabled);
          store.setProxyRoutingEnabled(enabled);
          // First enable (or a recovered key) with no inventory yet: fetch it
          // now instead of waiting for the next scheduled refresh.
          if (enabled && !refreshed && proxyManager.getConfigSnapshot().proxyCount === 0) {
            const refresh = await proxyManager.refreshProxies();
            if (!refresh.ok) {
              error = refresh.error || 'Could not fetch the Webshare proxy list.';
            }
          }
        }
      }

      // Pick up accounts added since the last cycle before pushing assignments.
      try {
        await loadCoreAccounts();
      } catch {
        // Keep the last known pool; sync still runs against the store.
      }

      const sync = await runProxySync();
      // A saved Webshare key immediately turns key proxies on and assigns them.
      if (proxyManager.hasApiKey()) {
        proxyManager.setApiKeyProxyEnabled(true);
        syncApiKeyProxyAssignments(true);
      }
      return {
        ...proxyManager.getConfigSnapshot(),
        sync,
        ...(error ? { error } : {}),
      };
    },
  );

  // 10b-i. POST /api/proxy/refresh — re-fetch the Webshare inventory,
  // re-assign proxies and apply them to the core. HTTP 200 even on upstream
  // failure; check `ok`.
  app.post('/api/proxy/refresh', async () => {
    if (!proxyManager.hasApiKey()) {
      return {
        ok: false,
        proxyCount: proxyManager.getConfigSnapshot().proxyCount,
        error: 'No Webshare API key configured.',
      };
    }

    const refresh = await proxyManager.refreshProxies();
    if (!refresh.ok) return { ...refresh, applied: 0, failed: 0, errors: [] as string[] };

    try {
      await loadCoreAccounts();
    } catch {
      // Keep the last known pool; sync still runs against the store.
    }

    const sync = await runProxySync();
    if (proxyManager.hasApiKey()) {
      proxyManager.setApiKeyProxyEnabled(true);
      syncApiKeyProxyAssignments(true);
    }
    return { ...refresh, ...sync };
  });

  // 10c. GET /api/proxy/list — inventory plus the accounts pinned to each proxy.
  // Account ids are joined to emails so the dashboard never shows opaque ids.
  app.get('/api/proxy/list', async () => proxyListResponse());

  // 10c-i. POST /api/proxy/status — quarantine, retire or restore an IP.
  app.post<{
    Body?: {
      address?: string;
      port?: number;
      action?: 'quarantine' | 'retire' | 'restore';
      hours?: number;
    };
  }>('/api/proxy/status', async (request, reply) => {
    const body = request.body || {};
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const port = Number(body.port);
    const action = body.action;
    if (!address || !Number.isFinite(port) || port <= 0) {
      return reply.code(400).send({ error: 'address and port are required' });
    }
    if (action !== 'quarantine' && action !== 'retire' && action !== 'restore') {
      return reply.code(400).send({ error: 'action must be quarantine, retire or restore' });
    }

    const key = proxyManager.proxyKeyFor(address, port);
    const changed =
      action === 'retire'
        ? proxyManager.retireProxy(key)
        : action === 'restore'
          ? proxyManager.restoreProxy(key)
          : proxyManager.quarantineProxy(
              key,
              Math.max(1, Math.min(24 * 30, Number(body.hours) || 24)) * 60 * 60 * 1000,
            );

    if (!changed) return reply.code(404).send({ error: 'Proxy not found' });

    persistProxyHealth();
    // Move any account/key still pinned to this proxy onto a healthy one.
    await runProxySync();
    syncApiKeyProxyAssignments();
    return proxyListResponse();
  });

  // 10d. Gemini API keys (AI Studio). These serve gemini-3.1-flash-lite and
  // gemini-3.5-flash-lite while the rest of the catalog stays on the account pool.
  app.get('/api/gemini/config', async () => geminiConfig());

  app.post<{ Body?: { label?: string; key?: string; keys?: string[] } }>(
    '/api/gemini/keys',
    async (request, reply) => {
      const body = request.body || {};
      const raw = Array.isArray(body.keys)
        ? body.keys
        : typeof body.key === 'string'
          ? [body.key]
          : [];
      const cleaned = Array.from(
        new Set(raw.map((key) => String(key ?? '').trim()).filter((key) => key.length >= 20)),
      );
      if (cleaned.length === 0) {
        return reply
          .code(400)
          .send({ error: 'Provide at least one API key (20+ characters).' });
      }

      const current = store.getGeminiApiKeys();
      const existing = new Set(current.map((key) => key.key));
      const baseLabel = typeof body.label === 'string' ? body.label.trim() : '';
      let added = 0;
      let skipped = 0;

      for (const key of cleaned) {
        if (existing.has(key)) {
          skipped += 1;
          continue;
        }
        const label = baseLabel
          ? cleaned.length > 1
            ? `${baseLabel} ${added + 1}`
            : baseLabel
          : `Key ${current.length + 1}`;
        current.push({
          id: `gk-${randomUUID()}`,
          label,
          key,
          enabled: true,
          createdAt: new Date().toISOString(),
        });
        existing.add(key);
        added += 1;
      }

      store.setGeminiApiKeys(current);
      geminiApiPool.setKeys(current);
      // Proxies are automatic: make sure a key added on a fresh install gets an
      // egress proxy as soon as the inventory is available.
      if (proxyManager.hasApiKey()) {
        proxyManager.setApiKeyProxyEnabled(true);
        if (proxyManager.getConfigSnapshot().proxyCount === 0) {
          const refresh = await proxyManager.refreshProxies();
          if (!refresh.ok) app.log.warn({ err: refresh.error }, 'key proxies: inventory unavailable');
        }
      }
      syncApiKeyProxyAssignments();
      return { added, skipped, ...geminiConfig() };
    },
  );

  app.patch<{ Params: { id: string }; Body?: { enabled?: boolean; label?: string } }>(
    '/api/gemini/keys/:id',
    async (request, reply) => {
      const keys = store.getGeminiApiKeys();
      const key = keys.find((entry) => entry.id === request.params.id);
      if (!key) return reply.code(404).send({ error: 'API key not found' });

      if (typeof request.body?.enabled === 'boolean') {
        key.enabled = request.body.enabled;
      }
      if (typeof request.body?.label === 'string' && request.body.label.trim()) {
        key.label = request.body.label.trim();
      }

      store.setGeminiApiKeys(keys);
      geminiApiPool.setKeys(keys);
      return geminiConfig();
    },
  );

  app.delete<{ Params: { id: string } }>('/api/gemini/keys/:id', async (request, reply) => {
    const keys = store.getGeminiApiKeys();
    const next = keys.filter((key) => key.id !== request.params.id);
    if (next.length === keys.length) {
      return reply.code(404).send({ error: 'API key not found' });
    }
    store.setGeminiApiKeys(next);
    geminiApiPool.setKeys(next);
    syncApiKeyProxyAssignments();
    return geminiConfig();
  });

  // Key proxies are automatic. This endpoint keeps the old callers working: it
// ensures the inventory is loaded and reports the current assignment state.
  app.post('/api/gemini/proxy', async (request, reply) => {
    if (!proxyManager.hasApiKey()) {
      return reply
        .code(400)
        .send({ error: 'Save a Webshare API key on the Proxy page first.' });
    }
    if (proxyManager.getConfigSnapshot().proxyCount === 0) {
      const refresh = await proxyManager.refreshProxies();
      if (!refresh.ok) {
        return reply
          .code(502)
          .send({ error: refresh.error || 'Could not load the proxy inventory.' });
      }
    }
    if (proxyManager.getConfigSnapshot().proxyCount === 0) {
      return reply.code(400).send({ error: 'No Webshare proxies are available.' });
    }
    if (!proxyManager.setApiKeyProxyEnabled(true)) {
      return reply.code(400).send({ error: 'Could not enable key proxies.' });
    }
    store.setGeminiApiProxyEnabled(true);
    syncApiKeyProxyAssignments(true);
    return geminiConfig();
  });

  // Balanced: alternate between the key pool and the account pool. `keys` and
  // `accounts` pin the two shared flash-lite models to one side.
  app.post<{ Body?: { routing?: string } }>('/api/gemini/routing', async (request, reply) => {
    const routing = request.body?.routing;
    if (routing !== 'balanced' && routing !== 'keys' && routing !== 'accounts') {
      return reply.code(400).send({ error: 'routing must be balanced, keys or accounts' });
    }
    store.setGeminiApiSharedRouting(routing);
    return geminiConfig();
  });

  app.post<{ Params: { id: string } }>('/api/gemini/keys/:id/test', async (request, reply) => {
    const key = store.getGeminiApiKeys().find((entry) => entry.id === request.params.id);
    if (!key) return reply.code(404).send({ ok: false, error: 'API key not found' });

    const startedAt = Date.now();
    const proxyAgent = proxyManager.getApiKeyProxyAgent(key.id);
    const proxySummary = proxyManager.getApiKeyProxySummary(key.id);
    try {
      const response = await axios.post(
        `${geminiApiBaseUrl()}/v1beta/openai/chat/completions`,
        {
          model: GEMINI_API_MODELS[0],
          messages: [{ role: 'user', content: 'Reply: ok' }],
          max_tokens: 16,
        },
        {
          headers: {
            Authorization: `Bearer ${key.key}`,
            'Content-Type': 'application/json',
          },
          timeout: 30_000,
          validateStatus: () => true,
          ...(proxyAgent ? { httpAgent: proxyAgent, httpsAgent: proxyAgent } : {}),
          proxy: false,
        },
      );
      const ok = response.status === 200;
      return {
        ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        sample: response.data?.choices?.[0]?.message?.content ?? null,
        proxy: proxySummary,
        error: ok
          ? undefined
          : response.data?.error?.message || `HTTP ${response.status}`,
      };
    } catch (error: any) {
      return {
        ok: false,
        status: 0,
        latencyMs: Date.now() - startedAt,
        proxy: proxySummary,
        error: error?.message || String(error),
      };
    }
  });

  // 11. GET /api/traffic
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/traffic', async (request) => {
    const from = request.query.from ? Number(request.query.from) : undefined;
    const to = request.query.to ? Number(request.query.to) : undefined;
    const hasValidRange = Number.isFinite(from) && Number.isFinite(to) && (to as number) > (from as number);
    const liveTraffic = await loadCoreModelTraffic({
      ...(hasValidRange ? { from, to, allPages: true } : {}),
    });
    // AI Studio key calls are recorded by the bridge, not the core audit DB, so
    // merge them in explicitly. Without this they never appear while the core
    // is reachable. Newest first, de-duplicated by record id.
    const records = mergeTrafficRecords(liveTraffic?.records ?? null, store.getTraffic());
    if (hasValidRange) {
      const filtered = records.filter((record) => {
        const timestamp = Date.parse(record.timestamp);
        return timestamp >= (from as number) && timestamp < (to as number);
      });
      return withTrafficEgress(filtered);
    }
    return withTrafficEgress(records.slice(0, 50));
  });

  // 11b. GET /api/usage/cache — prompt-token cache savings from the core audit SQLite DB.
  // Reads request_logs directly via node:sqlite (read-only) so cached-token data that the
  // core RPC omits is still surfaced on the Usage page. Never throws; returns zeros when
  // the DB is missing or unreadable.
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/usage/cache', async (request) => {
    const from = request.query.from ? Number(request.query.from) : undefined;
    const to = request.query.to ? Number(request.query.to) : undefined;
    const auditDb = getSharedCoreAuditDb();
    const stats = auditDb.getCacheStats(
      Number.isFinite(from) ? from : undefined,
      Number.isFinite(to) ? to : undefined,
    );
    if (!stats) {
      return {
        available: false,
        totalRequests: 0,
        totalInputTokens: 0,
        totalCachedTokens: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0,
        requestsWithCache: 0,
        overallHitRate: 0,
        byModel: [],
        byFamily: [],
      };
    }
    return { available: true, ...stats };
  });

  // 11a. GET /api/traffic/volume — aggregated live request counts for the Overview graph.
  type TrafficVolumeRange = '12h' | '24h' | '7d';
  const trafficVolumeCache = new Map<string, { expiresAt: number; value: any }>();
  app.get<{ Querystring: { range?: string } }>('/api/traffic/volume', async (request) => {
    const range: TrafficVolumeRange = request.query.range === '24h' || request.query.range === '7d'
      ? request.query.range
      : '12h';
    const cached = trafficVolumeCache.get(range);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const durationMs = range === '7d' ? 7 * 24 * 60 * 60 * 1000 : range === '24h' ? 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    const bucketMs = range === '7d' ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000;
    const bucketCount = durationMs / bucketMs;
    const windowEnd = Date.now();
    const windowStart = windowEnd - durationMs;
    const liveTraffic = await loadCoreModelTraffic({ from: windowStart, to: windowEnd, allPages: true, accounts: [] });
    const localGemini = store.getTraffic().filter((record) => record.provider === 'gemini-api');
    const volumeRecords = [...(liveTraffic?.records ?? []), ...localGemini];
    const available = Boolean(liveTraffic) || localGemini.length > 0;
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
      from: new Date(windowStart + index * bucketMs).toISOString(),
      to: new Date(Math.min(windowStart + (index + 1) * bucketMs, windowEnd)).toISOString(),
      requests: 0,
      errors: 0,
    }));

    for (const record of volumeRecords) {
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < windowStart || timestamp >= windowEnd) continue;
      const index = Math.floor((timestamp - windowStart) / bucketMs);
      const bucket = buckets[index];
      if (!bucket) continue;
      bucket.requests += 1;
      if (record.status >= 400) bucket.errors += 1;
    }

    const value = {
      range,
      available,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      bucketMs,
      buckets: available ? buckets : [],
      totalRequests: buckets.reduce((total, bucket) => total + bucket.requests, 0),
      totalErrors: buckets.reduce((total, bucket) => total + bucket.errors, 0),
    };
    trafficVolumeCache.set(range, { expiresAt: Date.now() + 15_000, value });
    return value;
  });

  // 12. GET /api/models — real model catalog merged with live gateway listing
  // Resolves the real gateway port + API key from the AntigravityManager profile
  // (~/.antigravity-agent/gui_config.json), with env override support.
  function resolveGateway(): { port: number; apiKey: string; source: string } {
    let port = parseInt(process.env.GEMINIROUTER_GATEWAY_PORT || '', 10);
    if (!Number.isFinite(port) || port <= 0) {
      port = store.getGatewayPort() || INTERNAL_GATEWAY_PORT;
    }
    let apiKey = process.env.GEMINIROUTER_GATEWAY_API_KEY || '';
    let source = apiKey ? 'env' : 'none';
    try {
      const homeDir = process.env.USERPROFILE || process.env.HOME || '';
      const guiConfigPath = path.join(homeDir, '.antigravity-agent', 'gui_config.json');
      if (fs.existsSync(guiConfigPath)) {
        const gui = JSON.parse(fs.readFileSync(guiConfigPath, 'utf8'));
        if (typeof gui?.proxy?.port === 'number' && gui.proxy.port > 0) {
          port = gui.proxy.port;
        }
        if (!apiKey && typeof gui?.proxy?.api_key === 'string' && gui.proxy.api_key) {
          apiKey = gui.proxy.api_key;
          source = 'profile';
        }
      }
    } catch {
      // Profile config unreadable — keep defaults
    }
    return { port, apiKey, source };
  }

  const MODEL_CATALOG: Array<{
    id: string;
    name: string;
    provider: 'Google Gemini' | 'Anthropic Claude' | 'OpenAI-compatible';
    family: string;
    contextLength: number;
    maxOutputTokens: number;
  }> = [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash (Image)', provider: 'Google Gemini', family: 'gemini-image', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image', provider: 'Google Gemini', family: 'gemini-image', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', provider: 'Google Gemini', family: 'gemini', contextLength: 1048576, maxOutputTokens: 65535 },
  ];

  app.get('/api/models', async () => {
    const { port: gatewayPort, apiKey, source: keySource } = resolveGateway();
    const availabilityHistory = await loadModelAvailabilityHistory();
    app.log.info(`resolveGateway: port=${gatewayPort} keySource=${keySource} hasKey=${Boolean(apiKey)}`);
    const baseUrl = `http://127.0.0.1:${gatewayPort}`;

    // Try the live gateway's OpenAI-compatible listing first
    try {
      const res = await axios.get(`${baseUrl}/v1/models`, {
        timeout: 4000,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const liveIds: Array<string> = (res.data?.data || []).map((m: any) => m.id).filter(Boolean);
      if (liveIds.length > 0) {
        const websiteIds = includeVerifiedWebsiteModels(liveIds).filter(isGeminiModelId);
        const models = websiteIds.map((id) => {
          const meta = MODEL_CATALOG.find((c) => c.id === id);
          return {
            id,
            name: meta?.name || id,
            provider: 'Google Gemini',
            family: meta?.family || 'gemini',
            contextLength: meta?.contextLength || 1048576,
            maxOutputTokens: meta?.maxOutputTokens || 65535,
            live: liveIds.includes(id),
            availability: store.getModelTest(id),
            availabilityHistory: availabilityHistory[id] ?? emptyModelAvailabilityHistory(),
          };
        });
        return { source: 'gateway', gatewayOnline: true, gatewayPort, models };
      }
    } catch {
      // Gateway unreachable — fall through to catalog
    }

    return {
      source: 'catalog',
      gatewayOnline: false,
      gatewayPort,
      models: MODEL_CATALOG
        .filter((m) => isGeminiModelId(m.id) && !isUnavailableWebsiteModel(m.id))
        .map((m) => ({
          ...m,
          live: false,
          availability: store.getModelTest(m.id),
          availabilityHistory: availabilityHistory[m.id] ?? emptyModelAvailabilityHistory(),
        })),
    };
  });

  app.post('/api/models/test-all-accounts', async (_request, reply) => {
    try {
      const counts = await accountTester.testAllModelsAcrossAccounts();
      return { ok: true, ...counts };
    } catch (err: any) {
      app.log.warn({ err: err?.message }, 'Full model/account check failed');
      return reply.code(503).send({ ok: false, error: 'Could not run the full model check. Verify the gateway is online.' });
    }
  });

  // 13. POST /api/models/test — send a tiny real request through the gateway to verify a model works
  app.post<{ Body: { model?: string } }>('/api/models/test', async (request, reply) => {
    const model = request.body?.model;
    if (!model || typeof model !== 'string') {
      return reply.code(400).send({ ok: false, error: 'A "model" field is required' });
    }

    const { port: gatewayPort, apiKey } = resolveGateway();
    const startedAt = Date.now();

    try {
      const res = await axios.post(
        `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
        {
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
        },
      );

      const sample =
        res.data?.choices?.[0]?.message?.content?.toString().slice(0, 200) || '(empty response)';
      const result = {
        ok: true,
        status: 'working' as const,
        model,
        latencyMs: Date.now() - startedAt,
        sample,
        checkedAt: new Date().toISOString(),
      };
      store.setModelTest(result);
      return result;
    } catch (err: any) {
      const status = err?.response?.status;
      const detail =
        err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.code ||
        err?.message ||
        'Unknown error';
      const result = {
        ok: false,
        status: status === 404 || status === 410 ? 'expired' as const : 'temporarily_unavailable' as const,
        model,
        latencyMs: Date.now() - startedAt,
        httpStatus: status ?? null,
        error: status
          ? `Gateway returned HTTP ${status}: ${detail}`
          : `Gateway unreachable on port ${gatewayPort}. Start the gateway first (${detail})`,
        checkedAt: new Date().toISOString(),
      };
      store.setModelTest(result);
      return result;
    }
  });

  // 13a. POST /api/playground — run a user-provided prompt through the local gateway
  app.post<{
    Body: {
      model?: unknown;
      prompt?: unknown;
      systemPrompt?: unknown;
      temperature?: unknown;
      maxTokens?: unknown;
      media?: {
        kind?: unknown;
        mimeType?: unknown;
        format?: unknown;
        dataBase64?: unknown;
        filename?: unknown;
        sizeBytes?: unknown;
      };
    };
  }>('/api/playground', { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    const { model, prompt, systemPrompt, temperature, maxTokens, media: rawMedia } = request.body || {};
    if (typeof model !== 'string' || !model.trim()) {
      return reply.code(400).send({ ok: false, error: 'Choose a model to run.' });
    }

    let media: {
      kind: 'audio' | 'video';
      mimeType: string;
      format: string;
      dataBase64: string;
      filename: string;
      sizeBytes: number;
    } | null = null;

    if (rawMedia && typeof rawMedia === 'object') {
      const kind = rawMedia.kind === 'video' ? 'video' : rawMedia.kind === 'audio' ? 'audio' : null;
      if (!kind) {
        return reply.code(400).send({ ok: false, error: 'Attachment kind must be audio or video.' });
      }
      const dataBase64 =
        typeof rawMedia.dataBase64 === 'string'
          ? rawMedia.dataBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '')
          : '';
      if (!dataBase64) {
        return reply.code(400).send({ ok: false, error: 'The attached file is empty.' });
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) {
        return reply.code(400).send({ ok: false, error: 'The attached file is not valid base64.' });
      }
      const decoded = Buffer.from(dataBase64, 'base64');
      const maxBytes = kind === 'audio' ? 15 * 1024 * 1024 : 20 * 1024 * 1024;
      if (decoded.length > maxBytes) {
        return reply.code(413).send({
          ok: false,
          error:
            kind === 'audio'
              ? 'Audio is too large for inline playground chat (15 MB decoded max). Use compressed 10–20 minute audio or the /v1/audio/transcriptions endpoint.'
              : 'Video is too large for inline playground chat (20 MB max). Trim or compress it first.',
        });
      }
      const mimeType =
        typeof rawMedia.mimeType === 'string' && rawMedia.mimeType.trim()
          ? rawMedia.mimeType.trim()
          : kind === 'audio'
            ? 'audio/mpeg'
            : 'video/mp4';
      const format =
        typeof rawMedia.format === 'string' && rawMedia.format.trim()
          ? rawMedia.format.trim().replace(/^\./, '').toLowerCase()
          : kind === 'audio'
            ? 'mp3'
            : 'mp4';
      if (!/^[a-z0-9]{1,10}$/.test(format)) {
        return reply.code(400).send({ ok: false, error: 'Unsupported attachment format.' });
      }
      const filename =
        typeof rawMedia.filename === 'string' && rawMedia.filename.trim()
          ? rawMedia.filename.trim().slice(0, 200)
          : `upload.${format}`;
      media = { kind, mimeType, format, dataBase64, filename, sizeBytes: decoded.length };
    }

    const promptText = typeof prompt === 'string' ? prompt.trim() : '';
    if (!promptText && !media) {
      return reply.code(400).send({ ok: false, error: 'Enter a prompt or attach audio/video.' });
    }
    if (promptText.length > 20000 || (typeof systemPrompt === 'string' && systemPrompt.length > 5000)) {
      return reply.code(413).send({ ok: false, error: 'Prompt is too long.' });
    }

    const safeTemperature = typeof temperature === 'number' && Number.isFinite(temperature)
      ? Math.max(0, Math.min(2, temperature))
      : 0.7;
    const safeMaxTokens = typeof maxTokens === 'number' && Number.isFinite(maxTokens)
      ? Math.max(1, Math.min(65535, Math.floor(maxTokens)))
      : 8192;
    const { port: gatewayPort, apiKey } = resolveGateway();
    const startedAt = Date.now();
    const isImageModel = /image/i.test(model.trim());
    const effectivePrompt =
      promptText ||
      (media?.kind === 'video'
        ? 'Describe this video in detail. Include the spoken dialogue, the key events, and any on-screen text.'
        : 'Describe this audio in detail. If there is speech, transcribe it and summarize the key points.');

    const userContent = media
      ? [
          { type: 'text', text: effectivePrompt },
          ...(media.kind === 'audio'
            ? [
                {
                  type: 'input_audio',
                  input_audio: { data: media.dataBase64, format: media.format },
                },
              ]
            : [
                {
                  type: 'video_url',
                  video_url: {
                    url: `data:${media.mimeType};base64,${media.dataBase64}`,
                  },
                },
              ]),
        ]
      : effectivePrompt;

    const messages = [
      ...(typeof systemPrompt === 'string' && systemPrompt.trim()
        ? [{ role: 'system', content: systemPrompt.trim() }]
        : []),
      { role: 'user', content: userContent },
    ];

    try {
      const response = await axios.post(
        `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
        isImageModel
          ? { model: model.trim(), messages }
          : { model: model.trim(), messages, temperature: safeTemperature, max_tokens: safeMaxTokens },
        {
          timeout: 180000,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
        },
      );
      const content = response.data?.choices?.[0]?.message?.content;
      const resultText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('')
          : '';
      if (isModelFailureText(resultText)) {
        return reply.code(502).send({
          ok: false,
          model: model.trim(),
          latencyMs: Date.now() - startedAt,
          httpStatus: 502,
          error: 'The model returned a failure message instead of an answer. Try again or adjust the prompt.',
        });
      }
      return {
        ok: true,
        model: model.trim(),
        response: resultText || '(empty response)',
        latencyMs: Date.now() - startedAt,
        usage: response.data?.usage || undefined,
        ...(media
          ? { media: { kind: media.kind, filename: media.filename, sizeBytes: media.sizeBytes } }
          : {}),
      };
    } catch (error: any) {
      const status = error?.response?.status;
      const detail = error?.response?.data?.error?.message || error?.response?.data?.message || error?.code || error?.message;
      return reply.code(status ? 502 : 503).send({
        ok: false,
        model: model.trim(),
        latencyMs: Date.now() - startedAt,
        httpStatus: status ?? null,
        error: status
          ? `Gateway returned HTTP ${status}: ${detail}`
          : `Gateway unreachable on port ${gatewayPort}. Start the gateway first (${detail})`,
      });
    }
  });

  // 13b. POST /api/playground/media - large audio/video attachment.
  // The inline chat path is limited by the core's 15 MiB audio / ~20 MiB video
  // validators. Large files are streamed to disk and sent through the chunked
  // transcription pipeline instead. Large video uses its audio track.
  app.post(
    '/api/playground/media',
    { bodyLimit: 2 * 1024 * 1024 * 1024 },
    async (request, reply) => {
      const upload = takeMediaUpload(request);
      const startedAt = Date.now();
      if (!upload) {
        return reply.code(400).send({ ok: false, error: 'Attach an audio or video file.' });
      }
      try {
        if (upload.error) {
          return reply.code(upload.error.statusCode).send({ ok: false, error: upload.error.message });
        }
        if (!upload.filePath) {
          return reply.code(400).send({ ok: false, error: 'Attach an audio or video file.' });
        }

        const fields = upload.fields || {};
        const model = (fields.model || process.env.MEDIA_DEFAULT_MODEL || 'gemini-3.5-flash-lite').trim();
        const userPrompt = (fields.prompt || '').trim();
        const systemPrompt = (fields.systemPrompt || '').trim();
        const video = String(upload.mimeType || '').toLowerCase().startsWith('video/');
        const prompt =
          [systemPrompt, userPrompt].filter(Boolean).join('\n\n') ||
          (video
            ? 'Describe this video in detail. Include the spoken dialogue, the key events, and any on-screen text.'
            : 'Describe this audio in detail. If there is speech, transcribe it and summarize the key points.');

        const requestedTemperature = Number.parseFloat(fields.temperature || '');
        const requestedMaxTokens = Number.parseInt(fields.maxTokens || '', 10);
        const address = app.server.address();
        const mediaPort =
          address && typeof address === 'object' && 'port' in address && address.port
            ? address.port
            : PORT;
        const { apiKey } = resolveGateway();

        const form = new FormData();
        const blob = await fs.openAsBlob(upload.filePath, {
          type: upload.mimeType || 'application/octet-stream',
        });
        form.append('file', blob, upload.filename);
        form.append('prompt', prompt);
        form.append('model', model);
        if (Number.isFinite(requestedTemperature)) {
          form.append('temperature', String(Math.max(0, Math.min(2, requestedTemperature))));
        }
        if (Number.isFinite(requestedMaxTokens)) {
          form.append('max_tokens', String(Math.max(1, Math.min(65535, requestedMaxTokens))));
        }

        const response = await fetch(`http://127.0.0.1:${mediaPort}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          body: form,
          signal: AbortSignal.timeout(2 * 60 * 60 * 1000),
        });
        const data: any = await response.json().catch(() => null);
        if (!response.ok || !data) {
          return reply.code(response.status >= 400 ? response.status : 502).send({
            ok: false,
            model,
            latencyMs: Date.now() - startedAt,
            error:
              data?.error?.message ||
              data?.message ||
              `Large-media processing failed (HTTP ${response.status}).`,
          });
        }

        const usage = data.usage
          ? {
              prompt_tokens: data.usage.promptTokens,
              completion_tokens: data.usage.completionTokens,
              total_tokens: data.usage.totalTokens,
            }
          : undefined;

        return {
          ok: true,
          model,
          response: data.text || '(empty response)',
          latencyMs: Date.now() - startedAt,
          usage,
          media: {
            kind: video ? 'video' : 'audio',
            filename: upload.filename,
            sizeBytes: upload.sizeBytes,
          },
          chunks: data.chunk_count,
          timings: data.timings,
          note: video
            ? 'Large video is analyzed from its audio track; visual frames are not included.'
            : undefined,
        };
      } catch (error: any) {
        return reply.code(503).send({
          ok: false,
          error: `Large-media processing failed: ${error?.message || String(error)}`,
        });
      } finally {
        try {
          fs.rmSync(upload.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          /* best effort */
        }
      }
    },
  );

  // 14. Core process control endpoints
  app.post('/api/core/start', async () => {
    const res = processManager.startCore();
    return res;
  });

  app.post('/api/core/stop', async () => {
    const res = processManager.stopCore();
    return res;
  });

  app.get('/api/core/info', async () => {
    const isAlive = await coreClient.isCoreAlive();
    return {
      endpoint: coreClient.getEndpoint(),
      connected: isAlive,
      processAlive: processManager.isProcessAlive(),
      scriptPath: processManager.getCoreScriptPath(),
    };
  });

  // Every uncaught route error must leave as the documented JSON envelope.
  // Media routes return their own envelope; this catches anything else instead
  // of letting Fastify close the socket without a body.
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof (error as any)?.statusCode === 'number' && (error as any).statusCode >= 400
        ? (error as any).statusCode
        : 500;
    const message =
      statusCode >= 500 ? 'Internal server error.' : (error as Error)?.message || 'Request failed.';
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled route error');
    } else {
      request.log.warn({ err: error }, 'route rejected the request');
    }
    if (reply.raw.headersSent) return;
    return reply.code(statusCode).send({
      error: {
        message,
        type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
        code: statusCode >= 500 ? 'internal_error' : 'invalid_request',
        ...(statusCode >= 500 ? {} : { details: { reason: (error as Error)?.message } }),
      },
    });
  });

  // Fallback for SPA routing if dist index.html exists
  if (hasFrontendDist) {
    app.setNotFoundHandler(async (request, reply) => {
      const url = request.raw.url || '';
      const pathname = url.split('?')[0];
      // Never answer a missing file with the SPA shell: /FramecallHelper.exe
      // must 404, not return HTML (which looks like a 200 download).
      const looksLikeFile = /\.[a-z0-9]{2,8}$/i.test(pathname);
      if (url.startsWith('/api') || url.startsWith('/assets') || looksLikeFile) {
        return reply.code(404).send({ error: 'Endpoint or asset not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // Always-on gateway: assert it at boot, then re-assert if it ever drops.
  // The router cannot serve traffic without the gateway, so there is no pause
  // state to preserve.
  void ensureGatewayRunning();
  const gatewaySupervisor = setInterval(() => {
    void (async () => {
      if (!(await coreClient.isCoreAlive())) return;
      const { port: gatewayPort, apiKey } = resolveGateway();
      let responding = false;
      try {
        const r = await axios.get(`http://127.0.0.1:${gatewayPort}/v1/models`, {
          timeout: 2500,
          validateStatus: () => true,
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
        responding = r.status >= 200 && r.status < 500;
      } catch {
        responding = false;
      }
      if (!responding) {
        app.log.warn('Gateway not responding; re-asserting always-on gateway');
        await ensureGatewayRunning();
      }
    })();
  }, 30_000);
  // Do not hold the event loop open on shutdown.
  gatewaySupervisor.unref?.();
  app.addHook('onClose', async () => {
    clearInterval(gatewaySupervisor);
  });

  return { app, coreClient, store, leaseManager, accountTester };
}

async function main() {
  const { app } = await createServer();
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[geminirouter server] Listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdownGraceMs = Math.max(
    5_000,
    Math.min(60 * 60 * 1000, Number.parseInt(process.env.SHUTDOWN_GRACE_MS || '240000', 10) || 240_000),
  );
  let closing = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (closing) return;
    closing = true;
    app.log.warn({ signal, shutdownGraceMs }, 'shutting down: draining in-flight requests');
    // Drain: stop accepting, close idle keep-alive sockets, and let running
    // requests (long media jobs included) write their real response.
    const forceExit = setTimeout(() => {
      app.log.warn({ signal }, 'shutdown grace period expired; exiting now');
      process.exit(exitCode);
    }, shutdownGraceMs);
    forceExit.unref?.();
    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'error while closing the server');
    }
    clearTimeout(forceExit);
    process.exit(exitCode);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection (request kept alive)');
  });
  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'uncaught exception; draining before restart');
    void shutdown('uncaughtException', 1);
  });
}

if (process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))) {
  void main();
}
