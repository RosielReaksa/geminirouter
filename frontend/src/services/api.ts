import {
  GatewayStatus,
  GoogleAccount,
  GatewayConfig,
  TrafficRecord,
  CacheStats,
  ProxyConfig,
  ProxyListSummary,
  ProxyRefreshResult,
  GeminiApiConfig,
  GeminiApiTestResult,
  OAuthStartResponse,
  OAuthCompleteResponse,
  ModelsResponse,
  ModelTestResult,
  PlaygroundResult,
  PlaygroundMedia,
  TrafficVolumeRange,
  TrafficVolumeResponse,
} from '../types';import {
  INITIAL_MOCK_ACCOUNTS,
  INITIAL_MOCK_CONFIG,
  INITIAL_MOCK_STATUS,
  INITIAL_MOCK_TRAFFIC,
  MOCK_OAUTH_START_DATA,
} from './mockData';
import { authApi } from './authApi';

// Clean any legacy demo accounts from earlier builds
try {
  localStorage.removeItem('geminirouter_accounts_v1');
  localStorage.removeItem('geminirouter_traffic_v1');
} catch {
  // ignore
}

// Local storage keys for persistent demo/mock modifications
const STORAGE_KEYS = {
  ACCOUNTS: 'geminirouter_accounts_v1',
  CONFIG: 'geminirouter_config_v1',
  STATUS: 'geminirouter_status_v1',
  TRAFFIC: 'geminirouter_traffic_v1',
};

function getStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function setStored<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error('Failed to save to local storage', err);
  }
}

export class ApiClient {
  private isOnlineCache: boolean | null = null;

  private async fetchJson<T>(
    endpoint: string,
    options: RequestInit | undefined,
    timeoutMs = 35000,
  ): Promise<{ response: Response; data: T | null }> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    const method = (options?.method || 'GET').toUpperCase();
    // Fastify rejects an empty body when Content-Type is application/json, and
    // the headers below always set that content type. Sending `{}` makes
    // body-less POST/PATCH/DELETE calls (account removal, refresh) valid.
    const requestOptions: RequestInit =
      method !== 'GET' && method !== 'HEAD' && options?.body === undefined
        ? { ...options, body: '{}' }
        : { ...options };

    try {
      const response = await fetch(endpoint, {
        ...requestOptions,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...authApi.headers(),
          ...(requestOptions.headers || {}),
        },
      });
      const data = await response.json().catch(() => null) as T | null;
      return { response, data };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`The request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
      }
      throw error instanceof Error ? error : new Error('Could not reach the gateway.');
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  private async fetchWithFallback<T>(
    endpoint: string,
    options: RequestInit | undefined,
    mockFallbackFn: () => Promise<T> | T
  ): Promise<{ data: T; isLiveApi: boolean }> {
    try {
      // Keep the deadline active through response-body parsing as well as headers.
      const { response: res, data } = await this.fetchJson<T>(endpoint, options);

      if (res.ok) {
        this.isOnlineCache = true;
        return { data: data as T, isLiveApi: true };
      }

      // 401 means the session is missing or expired. Surface it so the app can
      // route to the login page instead of silently showing mock data.
      if (res.status === 401) {
        this.isOnlineCache = false;
        window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
        return { data: await mockFallbackFn(), isLiveApi: false };
      }
    } catch {
      // Backend is offline or not deployed yet, smoothly use mock store
    }

    this.isOnlineCache = false;
    const fallbackData = await mockFallbackFn();
    return { data: fallbackData, isLiveApi: false };
  }

  /** Mutation helper: surface the server's error message instead of mock data. */
  private async mutateJson<T>(endpoint: string, options: RequestInit): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    // Fastify rejects an empty body when Content-Type is application/json; send
    // an empty object for body-less POST/PATCH/DELETE calls.
    const requestOptions: RequestInit = {
      ...options,
      ...(method !== 'GET' && method !== 'HEAD' && options.body === undefined
        ? { body: '{}' }
        : {}),
    };
    const { response, data } = await this.fetchJson<T>(endpoint, requestOptions);
    if (!response.ok) {
      const raw =
        (data as any)?.error ??
        (data as any)?.message;
      let message: string;
      if (typeof raw === 'string' && raw.trim()) {
        message = raw;
      } else if (raw && typeof raw === 'object') {
        message =
          (typeof (raw as any).message === 'string' && (raw as any).message) ||
          (typeof (raw as any).type === 'string' && (raw as any).type) ||
          JSON.stringify(raw);
      } else {
        message = `Request failed (HTTP ${response.status}).`;
      }
      throw new Error(String(message));
    }
    return data as T;
  }

  // 1. GET /api/status
  async getStatus(): Promise<{ data: GatewayStatus; isLiveApi: boolean }> {
    return this.fetchWithFallback<GatewayStatus>(
      '/api/status',
      { method: 'GET' },
      () => {
        const stored = getStored<GatewayStatus>(
          STORAGE_KEYS.STATUS,
          INITIAL_MOCK_STATUS
        );
        return stored;
      }
    );
  }

  private cachedAccounts: GoogleAccount[] = [];

  // 2. GET /api/accounts — real accounts from core pool only (never demo accounts)
  async getAccounts(): Promise<{ data: GoogleAccount[]; isLiveApi: boolean }> {
    const res = await this.fetchWithFallback<GoogleAccount[]>(
      '/api/accounts',
      { method: 'GET' },
      () => this.cachedAccounts
    );
    if (Array.isArray(res.data)) {
      this.cachedAccounts = res.data;
    }
    return res;
  }

  // 3. POST /api/accounts/refresh — calls core to refresh real quotas
  async refreshAccounts(): Promise<{ data: GoogleAccount[]; isLiveApi: boolean }> {
    const res = await this.fetchWithFallback<GoogleAccount[]>(
      '/api/accounts/refresh',
      { method: 'POST' },
      () => this.cachedAccounts
    );
    if (Array.isArray(res.data)) {
      this.cachedAccounts = res.data;
    }
    return res;
  }

  // 4. POST /api/oauth/start
  async startOAuth(): Promise<{ data: OAuthStartResponse; isLiveApi: boolean }> {
    return this.fetchWithFallback<OAuthStartResponse>(
      '/api/oauth/start',
      { method: 'POST' },
      () => {
        const sessionSuffix = Math.random().toString(36).substring(2, 9);
        return {
          ...MOCK_OAUTH_START_DATA,
          sessionId: `sess_oauth_${sessionSuffix}`,
        };
      }
    );
  }

  // 5. POST /api/oauth/complete
  async completeOAuth(
    sessionId: string,
    codeOrUrl: string
  ): Promise<{ data: OAuthCompleteResponse; isLiveApi: boolean }> {
    return this.fetchWithFallback<OAuthCompleteResponse>(
      '/api/oauth/complete',
      {
        method: 'POST',
        body: JSON.stringify({ sessionId, codeOrUrl }),
      },
      () => {
        // Derive email from input or assign a realistic fresh identity
        let derivedEmail = 'gemini.user.' + Math.floor(100 + Math.random() * 900) + '@gmail.com';
        if (codeOrUrl.includes('@')) {
          const match = codeOrUrl.match(/[\w.-]+@[\w.-]+\.\w+/);
          if (match) derivedEmail = match[0];
        }

        const newAccount: GoogleAccount = {
          id: `acc-${Date.now().toString(36)}`,
          email: derivedEmail,
          name: derivedEmail.split('@')[0].replace(/[._]/g, ' '),
          avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${derivedEmail}`,
          status: 'active',
          addedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          tier: 'Google AI Studio',
          isDefaultRouting: false,
          totalRequests24h: 0,
          quotas: [
            {
              modelId: 'gemini-2.5-pro',
              modelName: 'Gemini 2.5 Pro',
              requestsIn5h: 1,
              limitIn5h: 50,
              resetTime5h: 'in 5h 00m',
              tokensIn7d: 15000,
              limitIn7d: 2000000,
              resetTime7d: 'in 7 days',
              isThrottled: false,
            },
            {
              modelId: 'gemini-2.5-flash',
              modelName: 'Gemini 2.5 Flash',
              requestsIn5h: 0,
              limitIn5h: 500,
              resetTime5h: 'in 5h 00m',
              tokensIn7d: 0,
              limitIn7d: 10000000,
              resetTime7d: 'in 7 days',
              isThrottled: false,
            },
            {
              modelId: 'gemini-2.5-flash-thinking',
              modelName: 'Gemini 2.5 Flash Thinking',
              requestsIn5h: 0,
              limitIn5h: 100,
              resetTime5h: 'in 5h 00m',
              tokensIn7d: 0,
              limitIn7d: 5000000,
              resetTime7d: 'in 7 days',
              isThrottled: false,
            },
          ],
        };

        const existing = getStored<GoogleAccount[]>(
          STORAGE_KEYS.ACCOUNTS,
          INITIAL_MOCK_ACCOUNTS
        );
        const updated = [...existing, newAccount];
        setStored(STORAGE_KEYS.ACCOUNTS, updated);

        return {
          success: true,
          account: newAccount,
        };
      }
    );
  }

  // 6. POST /api/gateway/start or /api/gateway/stop
  async toggleGateway(start: boolean): Promise<{ data: GatewayStatus; isLiveApi: boolean }> {
    const endpoint = start ? '/api/gateway/start' : '/api/gateway/stop';
    return this.fetchWithFallback<GatewayStatus>(
      endpoint,
      { method: 'POST' },
      () => {
        const current = getStored<GatewayStatus>(
          STORAGE_KEYS.STATUS,
          INITIAL_MOCK_STATUS
        );
        const updated = {
          ...current,
          isRunning: start,
        };
        setStored(STORAGE_KEYS.STATUS, updated);
        return updated;
      }
    );
  }

  // 7. GET /api/config
  async getConfig(): Promise<{ data: GatewayConfig; isLiveApi: boolean }> {
    return this.fetchWithFallback<GatewayConfig>(
      '/api/config',
      { method: 'GET' },
      () => {
        return getStored<GatewayConfig>(
          STORAGE_KEYS.CONFIG,
          INITIAL_MOCK_CONFIG
        );
      }
    );
  }

  // 8. POST /api/config
  async updateConfig(
    partial: Partial<GatewayConfig>
  ): Promise<{ data: GatewayConfig; isLiveApi: boolean }> {
    return this.fetchWithFallback<GatewayConfig>(
      '/api/config',
      {
        method: 'POST',
        body: JSON.stringify(partial),
      },
      () => {
        const current = getStored<GatewayConfig>(
          STORAGE_KEYS.CONFIG,
          INITIAL_MOCK_CONFIG
        );
        const updated = { ...current, ...partial };
        setStored(STORAGE_KEYS.CONFIG, updated);
        return updated;
      }
    );
  }

  // 9. GET /api/traffic
  async getTraffic(range?: { from: number; to: number }): Promise<{ data: TrafficRecord[]; isLiveApi: boolean }> {
    const query = range
      ? `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
      : '';
    return this.fetchWithFallback<TrafficRecord[]>(
      `/api/traffic${query}`,
      { method: 'GET' },
      () => {
        return getStored<TrafficRecord[]>(
          STORAGE_KEYS.TRAFFIC,
          INITIAL_MOCK_TRAFFIC
        );
      }
    );
  }

  async getCacheStats(range?: { from: number; to: number }): Promise<{ data: CacheStats; isLiveApi: boolean }> {
    const query = range
      ? `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
      : '';
    return this.fetchWithFallback<CacheStats>(
      `/api/usage/cache${query}`,
      { method: 'GET' },
      () => ({
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
      })
    );
  }

  async getProxyConfig(): Promise<{ data: ProxyConfig; isLiveApi: boolean }> {
    return this.fetchWithFallback<ProxyConfig>(
      '/api/proxy/config',
      { method: 'GET' },
      () => ({
        enabled: false,
        hasApiKey: false,
        proxyCount: 0,
        accountCount: 0,
        lastFetchedAt: 0,
        fetchIntervalMs: 600000,
        lastError: null,
      })
    );
  }

  async updateProxyConfig(
    partial: { enabled?: boolean; webshareApiKey?: string },
  ): Promise<{ data: ProxyConfig; isLiveApi: boolean }> {
    return this.fetchWithFallback<ProxyConfig>(
      '/api/proxy/config',
      { method: 'POST', body: JSON.stringify(partial) },
      () => ({
        enabled: partial.enabled ?? false,
        hasApiKey: Boolean(partial.webshareApiKey),
        proxyCount: 0,
        accountCount: 0,
        lastFetchedAt: 0,
        fetchIntervalMs: 600000,
        lastError: 'Gateway is offline.',
        error: 'Gateway is offline.',
      })
    );
  }

  async refreshProxyList(): Promise<{ data: ProxyRefreshResult; isLiveApi: boolean }> {
    return this.fetchWithFallback<ProxyRefreshResult>(
      '/api/proxy/refresh',
      { method: 'POST' },
      () => ({ ok: false, proxyCount: 0, error: 'Gateway is offline.' })
    );
  }

  async getProxyList(): Promise<{ data: ProxyListSummary; isLiveApi: boolean }> {
    return this.fetchWithFallback<ProxyListSummary>(
      '/api/proxy/list',
      { method: 'GET' },
      () => ({
        enabled: false,
        proxies: [],
      })
    );
  }

  async setProxyStatus(
    address: string,
    port: number,
    action: 'quarantine' | 'retire' | 'restore',
    hours?: number,
  ): Promise<{ data: ProxyListSummary; isLiveApi: boolean }> {
    return this.fetchWithFallback<ProxyListSummary>(
      '/api/proxy/status',
      { method: 'POST', body: JSON.stringify({ address, port, action, hours }) },
      () => ({
        enabled: false,
        proxies: [],
      })
    );
  }

  async getGeminiApiConfig(): Promise<{ data: GeminiApiConfig; isLiveApi: boolean }> {
    return this.fetchWithFallback<GeminiApiConfig>(
      '/api/gemini/config',
      { method: 'GET' },
      () => ({
        models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
        limits: { rpm: 15, tpm: 250000, rpd: 500 },
        queue: { depth: 0, active: 0, maxWaitMs: 30000, maxConcurrentPerKey: 4, maxQueueSize: 200 },
        proxy: { enabled: false, available: 0, hasApiKey: false, assigned: 0 },
        keys: [],
      })
    );
  }

  async addGeminiApiKeys(payload: {
    label?: string;
    key?: string;
    keys?: string[];
  }): Promise<GeminiApiConfig> {
    return this.mutateJson<GeminiApiConfig>('/api/gemini/keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async updateGeminiApiKey(
    id: string,
    patch: { enabled?: boolean; label?: string }
  ): Promise<GeminiApiConfig> {
    return this.mutateJson<GeminiApiConfig>(`/api/gemini/keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async deleteGeminiApiKey(id: string): Promise<GeminiApiConfig> {
    return this.mutateJson<GeminiApiConfig>(`/api/gemini/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async testGeminiApiKey(id: string): Promise<GeminiApiTestResult> {
    return this.mutateJson<GeminiApiTestResult>(
      `/api/gemini/keys/${encodeURIComponent(id)}/test`,
      { method: 'POST' }
    );
  }

  async setGeminiApiProxy(enabled: boolean): Promise<GeminiApiConfig> {
    return this.mutateJson<GeminiApiConfig>('/api/gemini/proxy', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }

  async getTrafficVolume(range: TrafficVolumeRange): Promise<{ data: TrafficVolumeResponse; isLiveApi: boolean }> {
    const durations: Record<TrafficVolumeRange, number> = {
      '12h': 12 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
    };
    const windowEnd = Date.now();
    return this.fetchWithFallback<TrafficVolumeResponse>(
      `/api/traffic/volume?range=${range}`,
      { method: 'GET' },
      () => ({
        range,
        available: false,
        windowStart: new Date(windowEnd - durations[range]).toISOString(),
        windowEnd: new Date(windowEnd).toISOString(),
        bucketMs: range === '7d' ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000,
        buckets: [],
        totalRequests: 0,
        totalErrors: 0,
      }),
    );
  }

  // Models catalog (live gateway listing with catalog fallback)
  async getModels(): Promise<{ data: ModelsResponse; isLiveApi: boolean }> {
    return this.fetchWithFallback<ModelsResponse>(
      '/api/models',
      { method: 'GET' },
      () => ({
        source: 'catalog' as const,
        gatewayOnline: false,
        gatewayPort: 8045,
        models: [],
      })
    );
  }

  // Real test call through the gateway — never falls back to mock data
  async testModel(model: string): Promise<ModelTestResult> {
    const { response, data } = await this.fetchJson<ModelTestResult>('/api/models/test', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }, 45000);
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
    }
    if (response.ok && data) return data;
    return {
      ok: false,
      model,
      latencyMs: 0,
      error: data?.error || `Model test failed (HTTP ${response.status}).`,
    };
  }

  async testAllModelsAcrossAccounts(): Promise<{ ok: boolean; models?: number; accounts?: number; error?: string }> {
    // This endpoint checks every advertised model against every account serially.
    const { response, data } = await this.fetchJson<{ ok: boolean; models?: number; accounts?: number; error?: string }>(
      '/api/models/test-all-accounts',
      {
      method: 'POST',
        body: JSON.stringify({}),
      },
      // Up to 31 models × 6 accounts × 25-second probes can take over an hour.
      2 * 60 * 60 * 1000,
    );
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
    }
    if (response.ok && data) return data;
    if (data?.error) return { ok: false, error: data.error };
    return { ok: false, error: `Full model check failed (HTTP ${response.status}).` };
  }

  async playgroundRequest(input: {
    model: string;
    prompt: string;
    systemPrompt?: string;
    temperature: number;
    maxTokens: number;
    media?: PlaygroundMedia;
  }): Promise<PlaygroundResult> {
    const { response, data } = await this.fetchJson<PlaygroundResult & { error?: string }>('/api/playground', {
      method: 'POST',
      body: JSON.stringify(input),
    }, 180000);
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
    }
    if (!response.ok || !data) {
      throw new Error(data?.error || `Request failed with HTTP ${response.status}`);
    }
    return data;
  }

  async playgroundMediaRequest(input: {
    file: File;
    model: string;
    prompt: string;
    systemPrompt?: string;
    temperature: number;
    maxTokens: number;
    onUploadProgress?: (percent: number) => void;
  }): Promise<PlaygroundResult> {
    const form = new FormData();
    form.append('file', input.file, input.file.name);
    form.append('model', input.model);
    form.append('prompt', input.prompt);
    if (input.systemPrompt) form.append('systemPrompt', input.systemPrompt);
    form.append('temperature', String(input.temperature));
    form.append('maxTokens', String(input.maxTokens));

    const startedAt = Date.now();
    return new Promise<PlaygroundResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/playground/media');
      const headers = authApi.headers();
      for (const [name, value] of Object.entries(headers)) {
        xhr.setRequestHeader(name, value);
      }
      xhr.timeout = 2 * 60 * 60 * 1000;
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        input.onUploadProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      };
      xhr.onload = () => {
        let data: (PlaygroundResult & { error?: string }) | null = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status === 401) {
          window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
        }
        if (xhr.status < 200 || xhr.status >= 300 || !data) {
          reject(new Error(data?.error || `Large media request failed (HTTP ${xhr.status}).`));
          return;
        }
        resolve({ ...data, latencyMs: Date.now() - startedAt });
      };
      xhr.onerror = () => reject(new Error('Could not upload the media.'));
      xhr.ontimeout = () => reject(new Error('The large media request timed out after 2 hours.'));
      xhr.onabort = () => reject(new Error('The large media request was cancelled.'));
      xhr.send(form);
    });
  }

  // Helper: Delete account
  async deleteAccount(accountId: string): Promise<GoogleAccount[]> {
    const { response, data } = await this.fetchJson<{
      success: boolean;
      accounts?: GoogleAccount[];
      error?: string;
    }>(`/api/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
    }
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || `Account removal failed (HTTP ${response.status}).`);
    }

    // The endpoint returns the updated real account list. Keep the cached list
    // aligned so a subsequent offline fallback cannot resurrect the removed account.
    const updated = Array.isArray(data.accounts)
      ? data.accounts
      : this.cachedAccounts.filter((account) => account.id !== accountId);
    this.cachedAccounts = updated;
    return updated;
  }

  async createPairCode(): Promise<{ code: string; expiresAt: number; error?: string }> {
    const { response, data } = await this.fetchJson<{ code: string; expiresAt: number; error?: string }>(
      '/api/device/pair-code',
      {
      method: 'POST',
        body: '{}',
      },
    );
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
      return { code: '', expiresAt: 0, error: 'Unauthorized' };
    }
    if (!response.ok || !data) {
      return { code: '', expiresAt: 0, error: data?.error || `Request failed (HTTP ${response.status})` };
    }
    return data;
  }

  async importAccounts(
    content: string,
    strategy: 'merge' | 'overwrite' | 'skip-existing' = 'merge',
  ): Promise<{ success: boolean; result?: unknown; error?: string; message?: string }> {
    const { response, data } = await this.fetchJson<{ success: boolean; result?: unknown; error?: string; message?: string }>(
      '/api/accounts/import',
      {
      method: 'POST',
        body: JSON.stringify({ content, strategy }),
      },
      60000,
    );
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
    }
    if (!response.ok || !data) {
      return { success: false, error: data?.error || `Import failed (HTTP ${response.status})` };
    }
    return data;
  }

  // Helper: Set default account
  async setDefaultAccount(accountId: string): Promise<GoogleAccount[]> {
    const current = getStored<GoogleAccount[]>(
      STORAGE_KEYS.ACCOUNTS,
      INITIAL_MOCK_ACCOUNTS
    );
    const updated = current.map((acc) => ({
      ...acc,
      isDefaultRouting: acc.id === accountId,
    }));
    setStored(STORAGE_KEYS.ACCOUNTS, updated);
    return updated;
  }
}

export const api = new ApiClient();
