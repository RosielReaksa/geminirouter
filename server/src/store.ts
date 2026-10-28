import fs from 'node:fs';
import path from 'node:path';

export interface ModelQuota {
  modelId: string;
  modelName: string;
  requestsIn5h: number;
  limitIn5h: number;
  resetTime5h: string;
  tokensIn7d: number;
  limitIn7d: number;
  resetTime7d: string;
  isThrottled: boolean;
}

export interface GoogleAccount {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  status: 'active' | 'standby' | 'cooldown' | 'error';
  statusMessage?: string;
  addedAt: string;
  lastUsedAt?: string;
  tier: 'Free Tier' | 'Google AI Studio' | 'Workspace Pay-As-You-Go';
  quotas: ModelQuota[];
  isDefaultRouting: boolean;
  totalRequests24h: number;
}

export interface GatewayConfig {
  port: number;
  host: string;
  masterApiKey: string;
  autoStartOnBoot: boolean;
  autoSwitchOnQuotaLimit: boolean;
  quotaWarningThresholdPercent: number;
  autoCooldownMinutes: number;
  rotationStrategy: 'round-robin' | 'least-used-quota' | 'priority-order' | 'pinned-account';
  pinnedAccountId?: string;
  enableStreamRelay: boolean;
  enableThinkingTagPassthrough: boolean;
  rateLimitPerMinute: number;
  logRetentionDays: number;
}

export interface TrafficRecord {
  id: string;
  timestamp: string;
  clientName: string;
  clientIp: string;
  modelRequested: string;
  modelRouted: string;
  backingAccountEmail: string;
  status: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface GatewayStatus {
  isRunning: boolean;
  port: number;
  host: string;
  uptimeSeconds: number;
  activeAccountsCount: number;
  totalAccountsCount: number;
  requestsLast24h: number;
  tokensLast24h: number;
  averageLatencyMs: number;
  successRate: number;
  activeBackingAccountEmail?: string;
  version: string;
  healthy: boolean;
  coreConnected: boolean;
  coreEndpoint?: string;
}

const DEFAULT_CONFIG: GatewayConfig = {
  port: 8045,
  host: '0.0.0.0',
  masterApiKey: 'gr-live_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
  autoStartOnBoot: true,
  autoSwitchOnQuotaLimit: true,
  quotaWarningThresholdPercent: 85,
  autoCooldownMinutes: 30,
  rotationStrategy: 'least-used-quota',
  enableStreamRelay: true,
  enableThinkingTagPassthrough: true,
  rateLimitPerMinute: 120,
  logRetentionDays: 14,
};

const DEFAULT_ACCOUNTS: GoogleAccount[] = [
  {
    id: 'acc-1',
    email: 'alex.developer.ai@gmail.com',
    name: 'Alex Developer (Primary)',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=128&q=80',
    status: 'active',
    addedAt: '2026-09-12T08:30:00Z',
    lastUsedAt: new Date().toISOString(),
    tier: 'Google AI Studio',
    isDefaultRouting: true,
    totalRequests24h: 342,
    quotas: [
      {
        modelId: 'gemini-2.5-pro',
        modelName: 'Gemini 2.5 Pro',
        requestsIn5h: 38,
        limitIn5h: 50,
        resetTime5h: 'in 42m',
        tokensIn7d: 1420000,
        limitIn7d: 2000000,
        resetTime7d: 'in 2.4 days',
        isThrottled: false,
      },
      {
        modelId: 'gemini-2.5-flash',
        modelName: 'Gemini 2.5 Flash',
        requestsIn5h: 124,
        limitIn5h: 500,
        resetTime5h: 'in 2h 15m',
        tokensIn7d: 3100000,
        limitIn7d: 10000000,
        resetTime7d: 'in 4 days',
        isThrottled: false,
      },
      {
        modelId: 'gemini-2.5-flash-thinking',
        modelName: 'Gemini 2.5 Flash Thinking',
        requestsIn5h: 46,
        limitIn5h: 100,
        resetTime5h: 'in 1h 05m',
        tokensIn7d: 1840000,
        limitIn7d: 5000000,
        resetTime7d: 'in 3.1 days',
        isThrottled: false,
      },
    ],
  },
  {
    id: 'acc-2',
    email: 'radom.research.lab@gmail.com',
    name: 'Radom Research Lab',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=128&q=80',
    status: 'standby',
    addedAt: '2026-10-01T14:15:00Z',
    lastUsedAt: new Date(Date.now() - 3600000).toISOString(),
    tier: 'Google AI Studio',
    isDefaultRouting: false,
    totalRequests24h: 188,
    quotas: [
      {
        modelId: 'gemini-2.5-pro',
        modelName: 'Gemini 2.5 Pro',
        requestsIn5h: 12,
        limitIn5h: 50,
        resetTime5h: 'in 3h 10m',
        tokensIn7d: 650000,
        limitIn7d: 2000000,
        resetTime7d: 'in 5.2 days',
        isThrottled: false,
      },
      {
        modelId: 'gemini-2.5-flash',
        modelName: 'Gemini 2.5 Flash',
        requestsIn5h: 45,
        limitIn5h: 500,
        resetTime5h: 'in 4h 00m',
        tokensIn7d: 1200000,
        limitIn7d: 10000000,
        resetTime7d: 'in 6 days',
        isThrottled: false,
      },
    ],
  },
];

const DEFAULT_TRAFFIC: TrafficRecord[] = [
  {
    id: 'req_8923a',
    timestamp: new Date(Date.now() - 1000 * 20).toISOString(),
    clientName: 'Claude Code CLI',
    clientIp: '127.0.0.1',
    modelRequested: 'gemini-2.5-pro',
    modelRouted: 'gemini-2.5-pro',
    backingAccountEmail: 'alex.developer.ai@gmail.com',
    status: 200,
    latencyMs: 1240,
    promptTokens: 450,
    completionTokens: 820,
    totalTokens: 1270,
    cachedTokens: 256,
  },
  {
    id: 'req_8922b',
    timestamp: new Date(Date.now() - 1000 * 120).toISOString(),
    clientName: 'Codex CLI',
    clientIp: '127.0.0.1',
    modelRequested: 'gemini-2.5-flash',
    modelRouted: 'gemini-2.5-flash',
    backingAccountEmail: 'alex.developer.ai@gmail.com',
    status: 200,
    latencyMs: 420,
    promptTokens: 120,
    completionTokens: 310,
    totalTokens: 430,
  },
  {
    id: 'req_8921c',
    timestamp: new Date(Date.now() - 1000 * 300).toISOString(),
    clientName: 'Cursor IDE',
    clientIp: '192.168.1.104',
    modelRequested: 'gemini-2.5-flash-thinking',
    modelRouted: 'gemini-2.5-flash-thinking',
    backingAccountEmail: 'radom.research.lab@gmail.com',
    status: 200,
    latencyMs: 890,
    promptTokens: 890,
    completionTokens: 540,
    totalTokens: 1430,
  },
];

export class LocalStateStore {
  private dataDir: string;
  private stateFile: string;
  private config: GatewayConfig;
  private accounts: GoogleAccount[];
  private traffic: TrafficRecord[];
  private startTime = Date.now();
  private gatewayRunning = true;
  private gatewayPort = 8045;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.resolve(process.cwd(), '.data');
    this.stateFile = path.join(this.dataDir, 'server-state.json');

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    const loaded = this.loadState();
    this.config = loaded.config || { ...DEFAULT_CONFIG };
    this.accounts = loaded.accounts || [...DEFAULT_ACCOUNTS];
    this.traffic = loaded.traffic || [...DEFAULT_TRAFFIC];
    this.gatewayPort = this.config.port || 8045;
  }

  private loadState(): {
    config?: GatewayConfig;
    accounts?: GoogleAccount[];
    traffic?: TrafficRecord[];
  } {
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = fs.readFileSync(this.stateFile, 'utf-8');
        return JSON.parse(raw);
      } catch (e) {
        console.warn('Could not read state file, using defaults', e);
      }
    }
    return {};
  }

  private saveState(): void {
    try {
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify(
          {
            config: this.config,
            accounts: this.accounts,
            traffic: this.traffic.slice(0, 100), // persist recent 100 logs
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch (e) {
      console.error('Failed to save server state', e);
    }
  }

  getConfig(): GatewayConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<GatewayConfig>): GatewayConfig {
    this.config = { ...this.config, ...partial };
    if (partial.port) {
      this.gatewayPort = partial.port;
    }
    this.saveState();
    return this.getConfig();
  }

  getAccounts(): GoogleAccount[] {
    return [...this.accounts];
  }

  setAccounts(accounts: GoogleAccount[]): void {
    this.accounts = accounts;
    this.saveState();
  }

  addAccount(acc: GoogleAccount): void {
    this.accounts.push(acc);
    this.saveState();
  }

  removeAccount(id: string): boolean {
    const prev = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accounts.length !== prev) {
      this.saveState();
      return true;
    }
    return false;
  }

  refreshQuotas(): GoogleAccount[] {
    this.accounts = this.accounts.map((acc) => ({
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
    this.saveState();
    return this.getAccounts();
  }

  getTraffic(): TrafficRecord[] {
    return [...this.traffic];
  }

  addTrafficRecord(record: TrafficRecord): void {
    this.traffic.unshift(record);
    if (this.traffic.length > 500) {
      this.traffic.pop();
    }
    this.saveState();
  }

  setGatewayRunning(running: boolean, port?: number): void {
    this.gatewayRunning = running;
    if (port) this.gatewayPort = port;
  }

  isGatewayRunning(): boolean {
    return this.gatewayRunning;
  }

  getGatewayPort(): number {
    return this.gatewayPort;
  }

  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
}
