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
  /** Raw core status (`active` | `rate_limited` | `expired`). */
  coreStatus?: string;
  /** True when the core reports the OAuth refresh is blocked (needs reauth). */
  refreshBlocked?: boolean;
}

/** AI Studio (Gemini API) key managed from the Gemini API page. */
export interface GeminiApiKeyRecord {
  id: string;
  label: string;
  key: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt?: string;
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

/** How the two shared flash-lite models pick a provider. */
export type GeminiApiSharedRouting = 'balanced' | 'keys' | 'accounts';

/** Persisted per-key/model usage so dashboard counters survive a restart. */
export interface GeminiApiUsageState {
  savedAt: string;
  keys: Record<
    string,
    {
      keyCooldownUntil?: number;
      models: Record<
        string,
        {
          dayKey: string;
          rpd: number;
          tokensToday: number;
          cooldownUntil?: number;
          cooldownReason?: 'daily' | 'rate' | 'error';
          lastUsedAt?: string;
        }
      >;
    }
  >;
}

export interface TrafficRecord {
  id: string;
  timestamp: string;
  clientName: string;
  clientIp: string;
  modelRequested: string;
  modelRouted: string;
  backingAccountEmail: string;
  /** Core account id that served the call, when known. */
  accountId?: string;
  status: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  /** Core audit outcome: completed | in_progress | auth_failed | internal_error. */
  outcome?: string;
  /** Public IP this call left from (proxy address, or the gateway host). */
  egressIp?: string;
  /** ISO 3166-1 alpha-2 country of `egressIp`, when known. */
  egressCountry?: string | null;
  /** Whether the call left through the account's proxy or the gateway host. */
  egressVia?: 'proxy' | 'direct';
  /** Which provider served the call. Undefined means the OAuth core pool. */
  provider?: 'core' | 'gemini-api';
}

export interface ModelAvailabilityResult {
  model: string;
  ok: boolean;
  status?: 'working' | 'temporarily_unavailable' | 'expired' | 'needs_verification';
  checkedAccounts?: number;
  workingAccounts?: number;
  latencyMs: number;
  sample?: string;
  httpStatus?: number | null;
  error?: string;
  checkedAt: string;
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
  private modelTests: Record<string, ModelAvailabilityResult>;
  private startTime = Date.now();
  private gatewayRunning = true;
  private gatewayPort = 8045;
  // Webshare API key. Kept out of GatewayConfig so it can never ride along on
  // /api/config responses; it is only ever read by the proxy manager.
  private webshareApiKey = '';
  // Persisted routing intent: null until the dashboard has set it once, so a
  // key supplied only by the environment can still default to enabled.
  private proxyRoutingEnabled: boolean | null = null;
  // accountId -> "address:port" of the assigned proxy, so a restart keeps the
  // account on the same IP. The credentials are not stored here.
  private proxyAssignments: Record<string, string> = {};
  // Egress health: a proxy freed from a banned account cools down; retired
  // proxies are never assigned again.
  private proxyQuarantines: Record<string, number> = {};
  private retiredProxies: string[] = [];
  // AI Studio keys used by the Gemini API provider. Stored server-side only and
  // never returned in full by the API.
  private geminiApiKeys: GeminiApiKeyRecord[] = [];
  // For the two shared flash-lite models, decide whether the core account pool,
  // the AI Studio keys, or an even split serves a request.
  private geminiApiSharedRouting: GeminiApiSharedRouting = 'balanced';
  private geminiApiUsageState: GeminiApiUsageState | null = null;
  // Whether key traffic should leave through the Webshare inventory, and the
  // stable keyId -> "address:port" pins.
  private geminiApiProxyEnabled = false;
  private geminiApiProxyAssignments: Record<string, string> = {};
  // Debounce timer: traffic writes are batched so disk I/O is not on the hot
  // request path. Config/account changes still flush immediately.
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly TRAFFIC_FLUSH_DELAY_MS = 3000;

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
    this.modelTests = loaded.modelTests || {};
    this.webshareApiKey = typeof loaded.webshareApiKey === 'string' ? loaded.webshareApiKey : '';
    this.proxyRoutingEnabled =
      typeof loaded.proxyRoutingEnabled === 'boolean' ? loaded.proxyRoutingEnabled : null;
    this.proxyAssignments =
      loaded.proxyAssignments && typeof loaded.proxyAssignments === 'object'
        ? { ...loaded.proxyAssignments }
        : {};
    this.proxyQuarantines =
      loaded.proxyQuarantines && typeof loaded.proxyQuarantines === 'object'
        ? { ...loaded.proxyQuarantines }
        : {};
    this.retiredProxies = Array.isArray(loaded.retiredProxies)
      ? loaded.retiredProxies.filter((key): key is string => typeof key === 'string' && Boolean(key))
      : [];
    this.geminiApiKeys = Array.isArray(loaded.geminiApiKeys)
      ? loaded.geminiApiKeys
          .filter((key): key is GeminiApiKeyRecord =>
            Boolean(key && typeof key.id === 'string' && typeof key.key === 'string' && key.key.trim()),
          )
          .map((key) => ({
            id: key.id,
            label: typeof key.label === 'string' ? key.label : 'API key',
            key: key.key.trim(),
            enabled: key.enabled !== false,
            createdAt: typeof key.createdAt === 'string' ? key.createdAt : new Date().toISOString(),
            lastUsedAt: typeof key.lastUsedAt === 'string' ? key.lastUsedAt : undefined,
          }))
      : [];
    this.geminiApiProxyEnabled = loaded.geminiApiProxyEnabled === true;
    this.geminiApiSharedRouting =
      loaded.geminiApiSharedRouting === 'keys' || loaded.geminiApiSharedRouting === 'accounts'
        ? loaded.geminiApiSharedRouting
        : 'balanced';
    this.geminiApiUsageState =
      loaded.geminiApiUsageState && typeof loaded.geminiApiUsageState === 'object'
        ? loaded.geminiApiUsageState
        : null;
    this.geminiApiProxyAssignments =
      loaded.geminiApiProxyAssignments && typeof loaded.geminiApiProxyAssignments === 'object'
        ? { ...loaded.geminiApiProxyAssignments }
        : {};
    this.gatewayPort = this.config.port || 8045;
  }

  private loadState(): {
    config?: GatewayConfig;
    accounts?: GoogleAccount[];
    traffic?: TrafficRecord[];
    modelTests?: Record<string, ModelAvailabilityResult>;
    webshareApiKey?: string;
    proxyRoutingEnabled?: boolean;
    proxyAssignments?: Record<string, string>;
    proxyQuarantines?: Record<string, number>;
    retiredProxies?: string[];
    geminiApiKeys?: GeminiApiKeyRecord[];
    geminiApiProxyEnabled?: boolean;
    geminiApiSharedRouting?: GeminiApiSharedRouting;
    geminiApiUsageState?: GeminiApiUsageState | null;
    geminiApiProxyAssignments?: Record<string, string>;
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
            traffic: this.traffic.slice(0, 500), // persist up to 500 records
            modelTests: this.modelTests,
            webshareApiKey: this.webshareApiKey,
            proxyRoutingEnabled: this.proxyRoutingEnabled,
            proxyAssignments: this.proxyAssignments,
            proxyQuarantines: this.proxyQuarantines,
            retiredProxies: this.retiredProxies,
            geminiApiKeys: this.geminiApiKeys,
            geminiApiProxyEnabled: this.geminiApiProxyEnabled,
            geminiApiSharedRouting: this.geminiApiSharedRouting,
            geminiApiUsageState: this.geminiApiUsageState,
            geminiApiProxyAssignments: this.geminiApiProxyAssignments,
          },
          null,
          2
        ),
        { encoding: 'utf-8', mode: 0o600 }
      );
      // `mode` only applies when the file is created; tighten an existing file
      // too, because it now holds the Webshare API key.
      try {
        fs.chmodSync(this.stateFile, 0o600);
      } catch {
        // Windows and read-only filesystems do not support chmod.
      }
    } catch (e) {
      console.error('Failed to save server state', e);
    }
  }

  // Deferred save: coalesces rapid traffic writes into one disk flush.
  // Structural changes (config, accounts) still call saveState() directly.
  private scheduleSave(): void {
    if (this.saveTimer !== null) return; // already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveState();
    }, LocalStateStore.TRAFFIC_FLUSH_DELAY_MS);
  }

  getConfig(): GatewayConfig {
    return { ...this.config };
  }

  getModelTest(model: string): ModelAvailabilityResult | undefined {
    const result = this.modelTests[model];
    return result ? { ...result } : undefined;
  }

  setModelTest(result: ModelAvailabilityResult): void {
    this.modelTests[result.model] = result;
    this.saveState();
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

  /** Webshare API key. Never returned to clients; only the proxy manager reads it. */
  getWebshareApiKey(): string {
    return this.webshareApiKey;
  }

  hasWebshareApiKey(): boolean {
    return this.webshareApiKey.trim().length > 0;
  }

  setWebshareApiKey(key: string): void {
    this.webshareApiKey = key.trim();
    this.saveState();
  }

  /** Persisted routing intent, or null when it has never been set. */
  getProxyRoutingEnabled(): boolean | null {
    return this.proxyRoutingEnabled;
  }

  setProxyRoutingEnabled(enabled: boolean): void {
    this.proxyRoutingEnabled = enabled;
    this.saveState();
  }

  /** accountId -> "address:port" of the assigned proxy (no credentials). */
  getProxyAssignments(): Record<string, string> {
    return { ...this.proxyAssignments };
  }

  setProxyAssignments(assignments: Record<string, string>): void {
    const next: Record<string, string> = {};
    for (const [accountId, key] of Object.entries(assignments || {})) {
      if (typeof key === 'string' && key) next[accountId] = key;
    }
    this.proxyAssignments = next;
    this.saveState();
  }

  getProxyQuarantines(): Record<string, number> {
    return { ...this.proxyQuarantines };
  }

  setProxyQuarantines(quarantines: Record<string, number>): void {
    const next: Record<string, number> = {};
    for (const [key, until] of Object.entries(quarantines || {})) {
      if (typeof key === 'string' && key && Number.isFinite(until) && until > 0) {
        next[key] = until;
      }
    }
    this.proxyQuarantines = next;
    this.saveState();
  }

  getRetiredProxies(): string[] {
    return [...this.retiredProxies];
  }

  setRetiredProxies(proxies: string[]): void {
    this.retiredProxies = Array.isArray(proxies)
      ? [...new Set(proxies.filter((key) => typeof key === 'string' && key))]
      : [];
    this.saveState();
  }

  /** AI Studio keys, full values for the provider. Never expose this to clients. */
  getGeminiApiKeys(): GeminiApiKeyRecord[] {
    return this.geminiApiKeys.map((key) => ({ ...key }));
  }

  setGeminiApiKeys(keys: GeminiApiKeyRecord[]): void {
    this.geminiApiKeys = keys.map((key) => ({ ...key }));
    this.saveState();
  }

  isGeminiApiProxyEnabled(): boolean {
    return this.geminiApiProxyEnabled;
  }

  setGeminiApiProxyEnabled(enabled: boolean): void {
    this.geminiApiProxyEnabled = enabled;
    this.saveState();
  }

  getGeminiApiSharedRouting(): GeminiApiSharedRouting {
    return this.geminiApiSharedRouting;
  }

  setGeminiApiSharedRouting(routing: GeminiApiSharedRouting): void {
    this.geminiApiSharedRouting = routing;
    this.saveState();
  }

  getGeminiApiUsageState(): GeminiApiUsageState | null {
    return this.geminiApiUsageState;
  }

  setGeminiApiUsageState(state: GeminiApiUsageState): void {
    this.geminiApiUsageState = state;
    this.saveState();
  }

  getGeminiApiProxyAssignments(): Record<string, string> {
    return { ...this.geminiApiProxyAssignments };
  }

  setGeminiApiProxyAssignments(assignments: Record<string, string>): void {
    const next: Record<string, string> = {};
    for (const [keyId, proxyKey] of Object.entries(assignments || {})) {
      if (typeof proxyKey === 'string' && proxyKey) next[keyId] = proxyKey;
    }
    this.geminiApiProxyAssignments = next;
    this.saveState();
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
    if (this.traffic.length > 2000) {
      this.traffic.length = 2000; // cap in-memory ring at 2000
    }
    // Batch disk writes: don't block the hot request path with sync I/O.
    this.scheduleSave();
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
