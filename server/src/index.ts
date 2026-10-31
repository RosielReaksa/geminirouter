import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyHttpProxy from '@fastify/http-proxy';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { AccountTester, type AccountTestResult } from './accountTester.js';

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const BRIDGE_VERSION =
  (require_('../package.json') as { version?: string })?.version || 'unknown';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.GEMINIROUTER_ADMIN_PASSWORD || '';
const INTERNAL_GATEWAY_PORT = parseInt(process.env.INTERNAL_GATEWAY_PORT || '8045', 10);
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
    forceCloseConnections: true,
  });

  const coreClient = new CoreClient();
  let hostedOAuthSession: { sessionId: string; state: string; expiresAt: number } | null = null;
  // The core's /v1/oauth/complete answers ok as soon as it receives the code;
  // the token exchange is asynchronous. Track the account set at start so a
  // completion can be confirmed by an account that actually appeared.
  const oauthBaselines = new Map<string, { emails: Set<string>; expiresAt: number }>();
  const processManager = new CoreProcessManager();
  const store = new LocalStateStore();
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

  // Reverse proxy for coding tools on /v1/*
  // Dispatches requests across N accounts using ConcurrencyLeaseManager:
  // - Picks healthy account with fewest in-flight leases (min in-flight)
  // - Breaks ties by least quota used
  // - Enforces maxConcurrentRequestsPerAccount cap
  // - If at capacity: queues briefly or returns 429 Retry-After
  // - Transparently retries on next account if upstream 429 before streaming
  // - Never retries once first streamed byte is emitted
  app.all('/v1/*', async (request, reply) => {
    await handleV1ProxyRequest(request, reply, {
      leaseManager,
      store,
      getGatewayPort: () => resolveGateway().port,
    });
  });

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
    const { port: gatewayPort, apiKey } = resolveGateway();
    try {
      const res = await axios.get(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        timeout: 4000,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const ids: string[] = (res.data?.data || []).map((m: any) => m.id).filter(Boolean);
      if (ids.length > 0) {
        return {
          source: 'gateway',
          online: true,
          models: ids.map((id) => {
            const meta = MODEL_CATALOG.find((c) => c.id === id);
            const isClaude = id.includes('claude');
            const isGpt = id.includes('gpt') || id.includes('oss');
            return {
              id,
              name: meta?.name || id,
              provider:
                meta?.provider ||
                (isClaude ? 'Anthropic Claude' : isGpt ? 'OpenAI-compatible' : 'Google Gemini'),
              contextLength: meta?.contextLength || (isClaude ? 200000 : 1048576),
              maxOutputTokens: meta?.maxOutputTokens || 65535,
            };
          }),
        };
      }
    } catch {
      // fall through to the static catalog
    }
    return {
      source: 'catalog',
      online: false,
      models: MODEL_CATALOG.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        contextLength: m.contextLength,
        maxOutputTokens: m.maxOutputTokens,
      })),
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

  /** Polls the pool until an account that was absent at start appears. */
  const waitForNewAccount = async (sessionId: string, timeoutMs = 15_000): Promise<string | null> => {
    const baseline = oauthBaselines.get(sessionId)?.emails;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = (await loadCoreAccounts()) ?? store.getAccounts();
      const fresh = current.find((account) => !baseline || !baseline.has(account.email.toLowerCase()));
      if (fresh) return fresh.email;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return null;
  };

  const loadCoreAccounts = async (): Promise<GoogleAccount[] | null> => {
    if (!(await coreClient.isCoreAlive())) return null;
    try {
      const coreViews = await coreClient.callRpc<any[]>('accountViews');
      if (!Array.isArray(coreViews)) return null;

      const mapped: GoogleAccount[] = coreViews.map((cv: any) => {
        const quotas = cv.quota?.models
          ? Object.entries(cv.quota.models).map(([modelId, q]: [string, any]) => ({
              modelId,
              modelName: q.display_name || modelId,
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
            name: q.display_name || id,
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
          tier: (cv.quota?.subscription_tier as any) || 'Google AI Studio',
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

  const mapCoreTrafficItems = (items: any[], accounts: GoogleAccount[]): TrafficRecord[] => {
    const emailsByAccountId = new Map(accounts.map((account) => [account.id, account.email]));
    return items.map((item: any) => {
      const routedModel = item.mappedModel || item.physicalModel || item.model || 'unknown';
      const promptTokens = item.inputTokens ?? 0;
      const completionTokens = item.outputTokens ?? 0;
      return {
        id: item.id,
        timestamp: new Date(item.timestamp).toISOString(),
        clientName: item.clientName || item.userAgent || item.protocol || 'HTTP Client',
        clientIp: item.clientIp || '127.0.0.1',
        modelRequested: item.model || routedModel,
        modelRouted: routedModel,
        backingAccountEmail:
          emailsByAccountId.get(item.attributedAccountId) || item.attributedAccountId || 'unknown',
        status: item.status ?? 0,
        latencyMs: item.durationMs ?? 0,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    });
  };

  const loadCoreModelTraffic = async (options: {
    from?: number;
    to?: number;
    allPages?: boolean;
    accounts?: GoogleAccount[];
  } = {}): Promise<{ total: number; records: TrafficRecord[] } | null> => {
    if (!(await coreClient.isCoreAlive())) return null;
    try {
      const limit = 200;
      let query: { from?: number; to?: number; trafficClass: string; limit: number; offset: number } = {
        from: options.from,
        to: options.to,
        trafficClass: 'model',
        limit,
        offset: 0,
      };
      let firstPage = await coreClient.callRpc<any>('audit/list', query);
      // Older core builds may not accept an upper time bound. Retry with the
      // supported lower bound and apply `to` after mapping the returned rows.
      if (!firstPage && options.to !== undefined) {
        query = { from: options.from, trafficClass: 'model', limit, offset: 0 };
        firstPage = await coreClient.callRpc<any>('audit/list', query);
      }
      if (!firstPage || !Array.isArray(firstPage.items)) return null;

      const items = [...firstPage.items];
      if (options.allPages) {
        const total = Number(firstPage.total) || items.length;
        for (let offset = limit; offset < total; offset += limit) {
          const page = await coreClient.callRpc<any>('audit/list', { ...query, offset });
          if (!page || !Array.isArray(page.items) || page.items.length === 0) break;
          items.push(...page.items);
        }
      }

      const accounts = options.accounts ?? (await loadCoreAccounts()) ?? store.getAccounts();
      return {
        total: Number(firstPage.total) || items.length,
        records: mapCoreTrafficItems(items, accounts),
      };
    } catch {
      return null;
    }
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
  app.get('/api/status', async () => {
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
  const HELPER_BINARY_PATH =
    process.env.HELPER_BINARY_PATH ||
    path.resolve(process.cwd(), '../helper/framecall-helper-windows-amd64.exe');

  app.get('/api/helper/download', async (_request, reply) => {
    try {
      if (!fs.existsSync(HELPER_BINARY_PATH)) {
        return reply.code(404).send({
          error: 'Helper binary is not installed on this server',
          message: `Build it with helper/build.ps1 and set HELPER_BINARY_PATH (looked at ${HELPER_BINARY_PATH}).`,
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

  // 2. GET /api/accounts
  app.get('/api/accounts', async () => {
    // Real core accounts whenever the core is reachable — including an empty
    // pool. The demo fallback is ONLY for core-offline demo mode; it must
    // never mask the real pool state.
    return (await loadCoreAccounts()) ?? store.getAccounts();
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
            tier: v.quota?.subscription_tier || 'Google AI Studio',
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
      const model = request.body?.model || 'gemini-2.5-flash';
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
    const model = request.body?.model || 'gemini-2.5-flash';
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
    if (await coreClient.isCoreAlive()) {
      try {
        await coreClient.callRpc('accountDelete', { accountId: id });
      } catch {
        // proceed
      }
    }

    const removed = store.removeAccount(id);
    return {
      success: removed,
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

      const accepted = await coreClient.completeOAuth(pending.sessionId, code);
      if (!accepted) {
        hostedOAuthSession = null;
        oauthBaselines.delete(pending.sessionId);
        return reply.code(400).type('text/html; charset=utf-8').send(
          '<!doctype html><html><body><h1>Sign-in could not be completed</h1><p>Return to geminirouter and start a new Google sign-in.</p></body></html>',
        );
      }

      // "accepted" only means the core received the code. Confirm an account
      // actually appeared, otherwise the code was invalid or expired.
      const email = await waitForNewAccount(pending.sessionId);
      hostedOAuthSession = null;
      oauthBaselines.delete(pending.sessionId);
      if (!email) {
        return reply.code(400).type('text/html; charset=utf-8').send(
          '<!doctype html><html><body><h1>Google sign-in did not complete</h1><p>No account was added. The authorization code may be invalid or expired — return to geminirouter and start again.</p></body></html>',
        );
      }

      return reply.type('text/html; charset=utf-8').send(
        `<!doctype html><html><body><h1>Google sign-in complete</h1><p>${email
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

      const ok = await coreClient.completeOAuth(sessionId, actualCode);
      if (!ok) {
        return reply.code(400).send({
          success: false,
          error: 'The core rejected the authorization code',
          message:
            'Verify the code was copied from the OAuth redirect for this session, then retry.',
        });
      }

      // The core acknowledges the code before exchanging it, so wait for the
      // account to actually appear instead of reporting a false success.
      const email = await waitForNewAccount(sessionId);
      oauthBaselines.delete(sessionId);
      if (!email) {
        return reply.code(400).send({
          success: false,
          error: 'The authorization code was not accepted',
          message:
            'Google did not issue a token for this code. It may be expired or copied incorrectly — start the sign-in again and paste the whole callback URL.',
        });
      }

      return { success: true, email };
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

  // 11. GET /api/traffic
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/traffic', async (request) => {
    const from = request.query.from ? Number(request.query.from) : undefined;
    const to = request.query.to ? Number(request.query.to) : undefined;
    const hasValidRange = Number.isFinite(from) && Number.isFinite(to) && (to as number) > (from as number);
    const liveTraffic = await loadCoreModelTraffic({
      ...(hasValidRange ? { from, to, allPages: true } : {}),
    });
    const records = liveTraffic?.records ?? store.getTraffic();
    if (hasValidRange) {
      return records.filter((record) => {
        const timestamp = Date.parse(record.timestamp);
        return timestamp >= (from as number) && timestamp < (to as number);
      });
    }
    return records.slice(0, 50);
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
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
      from: new Date(windowStart + index * bucketMs).toISOString(),
      to: new Date(Math.min(windowStart + (index + 1) * bucketMs, windowEnd)).toISOString(),
      requests: 0,
      errors: 0,
    }));

    if (liveTraffic) {
      for (const record of liveTraffic.records) {
        const timestamp = Date.parse(record.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < windowStart || timestamp >= windowEnd) continue;
        const index = Math.floor((timestamp - windowStart) / bucketMs);
        const bucket = buckets[index];
        if (!bucket) continue;
        bucket.requests += 1;
        if (record.status >= 400) bucket.errors += 1;
      }
    }

    const value = {
      range,
      available: Boolean(liveTraffic),
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      bucketMs,
      buckets: liveTraffic ? buckets : [],
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
    { id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image', provider: 'Google Gemini', family: 'gemini-image', contextLength: 1048576, maxOutputTokens: 65535 },
    { id: 'claude-sonnet-4-5', name: 'Claude 4.5 Sonnet', provider: 'Anthropic Claude', family: 'claude', contextLength: 200000, maxOutputTokens: 65535 },
    { id: 'claude-sonnet-4-5-thinking', name: 'Claude 4.5 Sonnet (Thinking)', provider: 'Anthropic Claude', family: 'claude', contextLength: 200000, maxOutputTokens: 65535 },
    { id: 'claude-sonnet-4-6', name: 'Claude 4.6 Sonnet', provider: 'Anthropic Claude', family: 'claude', contextLength: 200000, maxOutputTokens: 65535 },
    { id: 'claude-opus-4-5', name: 'Claude 4.5 Opus', provider: 'Anthropic Claude', family: 'claude', contextLength: 200000, maxOutputTokens: 65535 },
    { id: 'claude-opus-4-5-thinking', name: 'Claude 4.5 Opus (Thinking)', provider: 'Anthropic Claude', family: 'claude', contextLength: 200000, maxOutputTokens: 65535 },
    { id: 'claude-opus-4-6', name: 'Claude 4.6 Opus', provider: 'Anthropic Claude', family: 'claude', contextLength: 200000, maxOutputTokens: 65535 },
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B', provider: 'OpenAI-compatible', family: 'gpt-oss', contextLength: 131072, maxOutputTokens: 65535 },
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
        const models = liveIds.map((id) => {
          const meta = MODEL_CATALOG.find((c) => c.id === id);
          const isClaude = id.includes('claude');
          const isGpt = id.includes('gpt') || id.includes('oss');
          return {
            id,
            name: meta?.name || id,
            provider: meta?.provider || (isClaude ? 'Anthropic Claude' : isGpt ? 'OpenAI-compatible' : 'Google Gemini'),
            family: meta?.family || (isClaude ? 'claude' : isGpt ? 'gpt-oss' : 'gemini'),
            contextLength: meta?.contextLength || (isClaude ? 200000 : 1048576),
            maxOutputTokens: meta?.maxOutputTokens || 65535,
            live: true,
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
      models: MODEL_CATALOG.map((m) => ({
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
    };
  }>('/api/playground', async (request, reply) => {
    const { model, prompt, systemPrompt, temperature, maxTokens } = request.body || {};
    if (typeof model !== 'string' || !model.trim()) {
      return reply.code(400).send({ ok: false, error: 'Choose a model to run.' });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return reply.code(400).send({ ok: false, error: 'Enter a prompt to run.' });
    }
    if (prompt.length > 20000 || (typeof systemPrompt === 'string' && systemPrompt.length > 5000)) {
      return reply.code(413).send({ ok: false, error: 'Prompt is too long.' });
    }

    const safeTemperature = typeof temperature === 'number' && Number.isFinite(temperature)
      ? Math.max(0, Math.min(2, temperature))
      : 0.7;
    const safeMaxTokens = typeof maxTokens === 'number' && Number.isFinite(maxTokens)
      ? Math.max(1, Math.min(8192, Math.floor(maxTokens)))
      : 1024;
    const { port: gatewayPort, apiKey } = resolveGateway();
    const startedAt = Date.now();
    const messages = [
      ...(typeof systemPrompt === 'string' && systemPrompt.trim()
        ? [{ role: 'system', content: systemPrompt.trim() }]
        : []),
      { role: 'user', content: prompt.trim() },
    ];

    try {
      const response = await axios.post(
        `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
        { model: model.trim(), messages, temperature: safeTemperature, max_tokens: safeMaxTokens },
        {
          timeout: 30000,
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
      return {
        ok: true,
        model: model.trim(),
        response: resultText || '(empty response)',
        latencyMs: Date.now() - startedAt,
        usage: response.data?.usage || undefined,
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
}

if (process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))) {
  void main();
}
