import {
  GatewayStatus,
  GoogleAccount,
  GatewayConfig,
  TrafficRecord,
  OAuthStartResponse,
  OAuthCompleteResponse,
  ModelsResponse,
  ModelTestResult,
  PlaygroundResult,
  TrafficVolumeRange,
  TrafficVolumeResponse,
} from '../types';
import {
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

  private async fetchWithFallback<T>(
    endpoint: string,
    options: RequestInit | undefined,
    mockFallbackFn: () => Promise<T> | T
  ): Promise<{ data: T; isLiveApi: boolean }> {
    try {
      const controller = new AbortController();
      // Allow up to 35 seconds for live LLM completions and Google quota probes
      const timeoutId = setTimeout(() => controller.abort(), 35000);

      const res = await fetch(endpoint, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...authApi.headers(),
          ...(options?.headers || {}),
        },
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const json = await res.json();
        this.isOnlineCache = true;
        return { data: json as T, isLiveApi: true };
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
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
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
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
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
    const res = await fetch('/api/models/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authApi.headers(),
      },
      body: JSON.stringify({ model }),
    });
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
    }
    return res.json();
  }

  async testAllModelsAcrossAccounts(): Promise<{ ok: boolean; models?: number; accounts?: number; error?: string }> {
    const res = await fetch('/api/models/test-all-accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authApi.headers(),
      },
      body: JSON.stringify({}),
    });
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
    }
    return res.json();
  }

  async playgroundRequest(input: {
    model: string;
    prompt: string;
    systemPrompt?: string;
    temperature: number;
    maxTokens: number;
  }): Promise<PlaygroundResult> {
    const res = await fetch('/api/playground', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authApi.headers(),
      },
      body: JSON.stringify(input),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(result.error || `Request failed with HTTP ${res.status}`);
    }
    return result as PlaygroundResult;
  }

  // Helper: Delete account
  async deleteAccount(accountId: string): Promise<GoogleAccount[]> {    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
        headers: authApi.headers(),
      });
      if (res.status === 401) {
        window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
        return [];
      }
      if (res.ok) {
        const { data } = await this.getAccounts();
        return data;
      }
    } catch {
      // fallback
    }
    const current = getStored<GoogleAccount[]>(
      STORAGE_KEYS.ACCOUNTS,
      INITIAL_MOCK_ACCOUNTS
    );
    const updated = current.filter((acc) => acc.id !== accountId);
    setStored(STORAGE_KEYS.ACCOUNTS, updated);
    return updated;
  }

  async importAccounts(
    content: string,
    strategy: 'merge' | 'overwrite' | 'skip-existing' = 'merge',
  ): Promise<{ success: boolean; result?: unknown; error?: string; message?: string }> {
    const res = await fetch('/api/accounts/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authApi.headers(),
      },
      body: JSON.stringify({ content, strategy }),
    });
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('geminirouter:unauthorized'));
    }
    return res.json().catch(() => ({ success: false, error: 'Invalid response from server' }));
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
