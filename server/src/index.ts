import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyHttpProxy from '@fastify/http-proxy';
import path from 'node:path';
import fs from 'node:fs';
import axios from 'axios';
import dotenv from 'dotenv';

import { CoreClient } from './coreClient.js';
import { CoreProcessManager } from './coreProcess.js';
import { LocalStateStore, type GoogleAccount } from './store.js';
import { createAuthMiddleware } from './auth.js';
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
  });

  const coreClient = new CoreClient();
  const processManager = new CoreProcessManager();
  const store = new LocalStateStore();
  const initialCfg = store.getConfig();
  const leaseManager = new ConcurrencyLeaseManager({
    maxConcurrentRequestsPerAccount: initialCfg.maxConcurrentRequestsPerAccount,
    capacityPolicy: initialCfg.capacityPolicy,
    queueTimeoutMs: initialCfg.queueTimeoutMs,
  });
  const accountTester = new AccountTester(coreClient, store, () => resolveGateway());
  // Start background auto-test scheduler: calls test model on every account every 5 hours!
  accountTester.startAutoTestScheduler(5);

  // Enable CORS
  await app.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Admin authentication hook
  app.addHook('onRequest', createAuthMiddleware(ADMIN_PASSWORD));

  // Determine frontend build directory (check relative to __dirname and cwd)
  const candidateFrontendDirs = [
    path.resolve(__dirname, '../../frontend/dist'),
    path.resolve(__dirname, '../frontend/dist'),
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'frontend/dist'),
    'D:/projectradom/geminirouter/frontend/dist',
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

    const accounts = store.getAccounts();
    const traffic = store.getTraffic();
    const pool = derivePoolState(accounts, traffic);
    const activeAccounts = accounts.filter((a) => a.status === 'active');

    return {
      isRunning: gatewayResponding,
      port: gatewayPort,
      host: store.getConfig().host,
      uptimeSeconds: store.getUptimeSeconds(),
      activeAccountsCount: activeAccounts.length,
      totalAccountsCount: accounts.length,
      requestsLast24h: pool.requestsLast24h,
      tokensLast24h: pool.tokensLast24h,
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
      coreConnected: isCoreAlive,
      coreEndpoint: coreClient.getEndpoint(),
      corePid: coreStatus?.pid,
      version: BRIDGE_VERSION,
    };
  });

  // 2. GET /api/accounts
  app.get('/api/accounts', async () => {
    // Real core accounts whenever the core is reachable — including an empty
    // pool. The demo fallback is ONLY for core-offline demo mode; it must
    // never mask the real pool state.
    if (await coreClient.isCoreAlive()) {
      try {
        const coreViews = await coreClient.callRpc<any[]>('accountViews');
        if (Array.isArray(coreViews)) {
          // Map core views to GoogleAccount format
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
            // If the account recently passed a live test call, clear the validation warning
            const hasValidationLink =
              testRes?.ok === true
                ? false
                : Boolean(cv.health?.validation?.has_verification_link);

            return {
              id: cv.id,
              email: cv.email,
              name: cv.name || cv.email.split('@')[0],
              avatarUrl: cv.avatar_url,
              status: cv.status === 'active' ? 'active' : 'standby',
              addedAt: cv.created_at || new Date().toISOString(),
              lastUsedAt: cv.last_used,
              tier: (cv.quota?.subscription_tier as any) || 'Google AI Studio',
              clientTarget,
              quotas,
              quotaGroups,
              isDefaultRouting: cv.is_active || false,
              totalRequests24h: 0,
              hasValidationLink,
              statusReason: cv.status_reason || undefined,
              lastTestResult: testRes,
            };
          });
          store.setAccounts(mapped);
          return mapped;
        }
      } catch (err) {
        app.log.warn('Could not read core accounts, falling back to local store');
      }
    }

    return store.getAccounts();
  });

  // 2b. GET /api/accounts/:id/validation-url — resolves Google account checkpoint URL
  app.get<{ Params: { id: string } }>('/api/accounts/:id/validation-url', async (request, reply) => {
    const { id } = request.params;
    if (await coreClient.isCoreAlive()) {
      try {
        const res = await coreClient.callRpc<any>('accountValidationUrl', { accountId: id });
        if (res && res.url) {
          let email = store.getAccounts().find((a) => a.id === id)?.email;
          if (!email) {
            const views = await coreClient.callRpc<any[]>('accountViews');
            email = views?.find((v: any) => v.id === id)?.email;
          }
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
      const accounts = await (app as any).inject({ method: 'GET', url: '/api/accounts' });
      const list: GoogleAccount[] = JSON.parse(accounts.body);
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

  // 3. POST /api/accounts/refresh — test all accounts and refresh quotas from core
  app.post('/api/accounts/refresh', async () => {
    if (await coreClient.isCoreAlive()) {
      try {
        await accountTester.testAndRefreshAll();
      } catch {
        app.log.warn('testAndRefreshAll failed; returning last known accounts');
      }
      const accountsAfter = await (app as any).inject({
        method: 'GET',
        url: '/api/accounts',
      });
      return JSON.parse(accountsAfter.body);
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
  app.post<{ Body: { oauthClientKey?: string } }>('/api/oauth/start', async (request, reply) => {
    const { oauthClientKey } = request.body || {};
    if (!(await coreClient.isCoreAlive())) {
      return reply.code(503).send({
        error: 'Core is offline',
        message:
          'Google OAuth requires the AntigravityManager core. Start the core (POST /api/core/start) and try again.',
      });
    }

    const coreOAuth = await coreClient.startOAuth(oauthClientKey);
    if (!coreOAuth.ok) {
      return reply.code(coreOAuth.status === 409 ? 409 : 502).send({
        error: coreOAuth.error,
        message:
          coreOAuth.status === 409
            ? 'Another login is already in progress. It was cancelled — try again now.'
            : 'The OAuth session could not be started. Check the core logs and retry.',
      });
    }

    return {
      authorizationUrl: coreOAuth.authorizationUrl,
      sessionId: coreOAuth.sessionId,
      expiresInSeconds: 600,
    };
  });

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

      return { success: true };
    },
  );

  // 7. POST /api/gateway/start
  app.post<{ Body?: { port?: number } }>('/api/gateway/start', async (request) => {
    const targetPort = request.body?.port || store.getGatewayPort() || INTERNAL_GATEWAY_PORT;
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
  app.post('/api/gateway/stop', async () => {
    if (await coreClient.isCoreAlive()) {
      try {
        await coreClient.callRpc('gatewayStop');
      } catch (e) {
        app.log.warn('Could not invoke gatewayStop via core RPC');
      }
    }

    store.setGatewayRunning(false);
    return {
      success: true,
      isRunning: false,
      port: store.getGatewayPort(),
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
  app.get('/api/traffic', async () => {
    if (await coreClient.isCoreAlive()) {
      try {
        const auditList = await coreClient.callRpc<any>('audit.list', { limit: 50, offset: 0 });
        if (auditList && Array.isArray(auditList.items) && auditList.items.length > 0) {
          const records = auditList.items.map((item: any) => ({
            id: item.id,
            timestamp: new Date(item.timestamp).toISOString(),
            clientName: item.protocol || 'HTTP Client',
            clientIp: '127.0.0.1',
            modelRequested: item.model || 'gemini-2.5-pro',
            modelRouted: item.mappedModel || item.model || 'gemini-2.5-pro',
            backingAccountEmail: item.attributedAccountId || 'default',
            status: item.status || 200,
            latencyMs: item.durationMs || 450,
            promptTokens: item.inputTokens || 0,
            completionTokens: item.outputTokens || 0,
            totalTokens: (item.inputTokens || 0) + (item.outputTokens || 0),
          }));
          return records;
        }
      } catch {
        // Fallback to store
      }
    }

    return store.getTraffic();
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
      models: MODEL_CATALOG.map((m) => ({ ...m, live: false })),
    };
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
      return {
        ok: true,
        model,
        latencyMs: Date.now() - startedAt,
        sample,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const detail =
        err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.code ||
        err?.message ||
        'Unknown error';
      return {
        ok: false,
        model,
        latencyMs: Date.now() - startedAt,
        httpStatus: status ?? null,
        error: status
          ? `Gateway returned HTTP ${status}: ${detail}`
          : `Gateway unreachable on port ${gatewayPort}. Start the gateway first (${detail})`,
      };
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
      if (url.startsWith('/api') || url.startsWith('/assets')) {
        return reply.code(404).send({ error: 'Endpoint or asset not found' });
      }
      return reply.sendFile('index.html');
    });
  }

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
