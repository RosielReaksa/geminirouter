import {
  GatewayStatus,
  GoogleAccount,
  GatewayConfig,
  TrafficRecord,
  OAuthStartResponse,
  OAuthCompleteResponse,
  ModelsResponse,
  ModelTestResult,
} from '../types';
import {
  INITIAL_MOCK_ACCOUNTS,
  INITIAL_MOCK_CONFIG,
  INITIAL_MOCK_STATUS,
  INITIAL_MOCK_TRAFFIC,
  MOCK_OAUTH_START_DATA,
} from './mockData';

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
      const timeoutId = setTimeout(() => controller.abort(), 1800);

      const res = await fetch(endpoint, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const json = await res.json();
        this.isOnlineCache = true;
        return { data: json as T, isLiveApi: true };
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

  // 2. GET /api/accounts
  async getAccounts(): Promise<{ data: GoogleAccount[]; isLiveApi: boolean }> {
    return this.fetchWithFallback<GoogleAccount[]>(
      '/api/accounts',
      { method: 'GET' },
      () => {
        return getStored<GoogleAccount[]>(
          STORAGE_KEYS.ACCOUNTS,
          INITIAL_MOCK_ACCOUNTS
        );
      }
    );
  }

  // 3. POST /api/accounts/refresh
  async refreshAccounts(): Promise<{ data: GoogleAccount[]; isLiveApi: boolean }> {
    return this.fetchWithFallback<GoogleAccount[]>(
      '/api/accounts/refresh',
      { method: 'POST' },
      () => {
        const current = getStored<GoogleAccount[]>(
          STORAGE_KEYS.ACCOUNTS,
          INITIAL_MOCK_ACCOUNTS
        );
        // Slightly update quota usage to simulate dynamic refresh
        const refreshed = current.map((acc) => ({
          ...acc,
          lastUsedAt: new Date().toISOString(),
          quotas: acc.quotas.map((q) => ({
            ...q,
            requestsIn5h: Math.min(
              q.limitIn5h,
              Math.max(2, q.requestsIn5h + Math.floor(Math.random() * 3) - 1)
            ),
          })),
        }));
        setStored(STORAGE_KEYS.ACCOUNTS, refreshed);
        return refreshed;
      }
    );
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
  async getTraffic(): Promise<{ data: TrafficRecord[]; isLiveApi: boolean }> {
    return this.fetchWithFallback<TrafficRecord[]>(
      '/api/traffic',
      { method: 'GET' },
      () => {
        return getStored<TrafficRecord[]>(
          STORAGE_KEYS.TRAFFIC,
          INITIAL_MOCK_TRAFFIC
        );
      }
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    return res.json();
  }

  // Helper: Delete account
  async deleteAccount(accountId: string): Promise<GoogleAccount[]> {    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      });
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
