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
  quotaGroups?: any[];
  /** Compact per-model 5h remaining-quota list for dashboard display. */
  models5h?: Array<{ name: string; reset: string; percentage: number }>;
  /** Compact per-model weekly remaining-quota list for dashboard display. */
  modelsWeekly?: Array<{ name: string; reset: string; percentage: number }>;
  isDefaultRouting: boolean;
  totalRequests24h: number;
  hasValidationLink?: boolean;
  validationUrl?: string;
  statusReason?: string;
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
  maxConcurrentRequestsPerAccount: number;
  capacityPolicy: 'queue' | 'reject_429';
  queueTimeoutMs: number;
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
  maxConcurrentRequestsPerAccount: parseInt(process.env.MAX_CONCURRENT_REQUESTS_PER_ACCOUNT || '10', 10),
  capacityPolicy: 'queue',
  queueTimeoutMs: 5000,
};

const DEFAULT_ACCOUNTS: GoogleAccount[] = [];
const DEFAULT_TRAFFIC: TrafficRecord[] = [];

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
    // Real quota refresh happens in the core (accountRefreshQuota RPC).
    // Locally we only touch the observation timestamp — quota numbers are
    // never mutated or fabricated here.
    this.accounts = this.accounts.map((acc) => ({
      ...acc,
      lastUsedAt: new Date().toISOString(),
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
