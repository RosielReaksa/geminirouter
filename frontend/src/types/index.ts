// Data models and API types for geminirouter

export interface CompactModelQuota {
  name: string;
  reset: string; // e.g. "4h 31m", "4h 32m"
  percentage: number; // e.g. 100, 93, 39
}

export interface WeeklyQuota {
  name: string;
  reset: string; // e.g. "6d 7h", "6d 18h"
  percentage: number; // e.g. 98, 55, 48
}

export interface ModelQuota {
  modelId: string;
  modelName: string;
  // 5-hour window
  requestsIn5h: number;
  limitIn5h: number;
  resetTime5h: string; // e.g. "in 1h 24m"
  // 7-day window
  tokensIn7d: number;
  limitIn7d: number;
  resetTime7d: string; // e.g. "in 3 days"
  isThrottled: boolean;
}

export interface QuotaBucket {
  bucketId: string;
  window: '5h' | 'weekly';
  remainingFraction: number; // e.g. 0.96
  resetTime: string; // ISO date
  displayName: string;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface AccountTestResult {
  accountId: string;
  email: string;
  ok: boolean;
  requiresValidation?: boolean;
  validationUrl?: string;
  model: string;
  latencyMs: number;
  sample?: string;
  error?: string;
  timestamp: string;
}

export interface GoogleAccount {
  id: string;
  email: string;
  name: string;
  avatarLetter?: string;
  avatarColor?: string; // e.g. '#0284c7', '#16a34a', '#9333ea', '#e11d48'
  avatarUrl?: string;
  status: 'active' | 'standby' | 'cooldown' | 'error';
  statusMessage?: string;
  addedAt: string;
  lastUsedAt?: string | number;
  tier: 'Free Tier' | 'Google AI Studio' | 'Workspace Pay-As-You-Go' | 'Google AI Pro';
  clientTarget?: 'CLI' | 'IDE' | 'Classic' | 'Not in use';
  credits?: number; // e.g. 0
  isRecommendedNext?: boolean;
  models5h?: CompactModelQuota[];
  modelsWeekly?: WeeklyQuota[];
  quotaGroups?: QuotaGroup[];
  quotas: ModelQuota[];
  isDefaultRouting: boolean;
  totalRequests24h: number;
  hasValidationLink?: boolean;
  statusReason?: string;
  coreStatus?: string;
  refreshBlocked?: boolean;
  lastTestResult?: AccountTestResult;
}

export interface OverviewAccountSummary {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  status: 'active' | 'standby' | 'cooldown' | 'error';
  tier: string;
  isDefaultRouting: boolean;
  hasValidationLink: boolean;
  statusReason?: string;
  lastUsedAt?: string | number;
  lastTestResult?: AccountTestResult;
  models5h: CompactModelQuota[];
  modelsWeekly: WeeklyQuota[];
  quotaGroups: QuotaGroup[];
}

export interface GatewayStatus {
  isRunning: boolean;
  /** The gateway is always-on by design; there is no pause state. */
  alwaysOn?: boolean;
  port: number;
  host: string;
  uptimeSeconds: number;
  activeAccountsCount: number;
  totalAccountsCount: number;
  requestsLast24h: number;
  tokensLast24h: number;
  requestsLast12h?: number;
  errorsLast12h?: number;
  errorsLast24h?: number;
  requestVolume12h?: number[];
  requestVolume12hWindowEnd?: string;
  averageLatencyMs: number | null;
  successRate: number | null; // percentage, e.g. 99.4
  activeBackingAccountEmail?: string | null;
  inFlightPerAccount?: Record<string, number>;
  totalInFlight?: number;
  totalCapacity?: number;
  maxConcurrentRequestsPerAccount?: number;
  capacityPolicy?: 'queue' | 'reject_429';
  queueTimeoutMs?: number;
  coreConnected?: boolean;
  coreEndpoint?: string;
  corePid?: number;
  cooldownAccounts?: Array<{ id: string; email: string; status: string }>;
  lastSwitch?: {
    fromEmail: string | null;
    toEmail: string;
    at: string;
    reason: string;
  } | null;
  accounts?: OverviewAccountSummary[];
  config?: {
    rotationStrategy: string;
    autoSwitchOnQuotaLimit: boolean;
    enableStreamRelay: boolean;
    quotaWarningThresholdPercent: number;
  };
  version: string;
  healthy: boolean;
}

export interface TrafficRecord {
  id: string;
  timestamp: string; // ISO
  clientName: string; // e.g. "Claude Code CLI", "Codex CLI", "Cursor", "Custom cURL"
  clientIp: string;
  modelRequested: string; // e.g. "gemini-2.5-pro", "gemini-2.5-flash"
  modelRouted: string;
  backingAccountEmail: string;
  status: number; // 200, 429, 500, etc.
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface GatewayConfig {
  port: number;
  host: string;
  masterApiKey: string;
  autoStartOnBoot: boolean;
  autoSwitchOnQuotaLimit: boolean;
  quotaWarningThresholdPercent: number; // e.g. 85
  autoCooldownMinutes: number; // e.g. 30
  rotationStrategy: 'round-robin' | 'least-used-quota' | 'priority-order' | 'pinned-account';
  pinnedAccountId?: string;
  enableStreamRelay: boolean;
  enableThinkingTagPassthrough: boolean;
  rateLimitPerMinute: number;
  logRetentionDays: number;
  maxConcurrentRequestsPerAccount?: number;
  capacityPolicy?: 'queue' | 'reject_429';
  queueTimeoutMs?: number;
}

export interface OAuthStartResponse {
  authorizationUrl: string;
  sessionId: string;
  expiresInSeconds: number;
}

export interface OAuthCompleteRequest {
  sessionId: string;
  codeOrUrl: string;
}

export interface OAuthCompleteResponse {
  success: boolean;
  account?: GoogleAccount;
  error?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: 'Google Gemini' | 'Anthropic Claude' | 'OpenAI-compatible';
  family: string;
  contextLength: number;
  maxOutputTokens: number;
  live: boolean;
  availability?: ModelTestResult & { checkedAt: string };
  availabilityHistory?: ModelAvailabilityHistory;
}

export interface ModelAvailabilityHistory {
  windowStart: string;
  windowEnd: string;
  bucketMs: number;
  buckets: Array<{
    state: 'ok' | 'partial' | 'error' | 'empty';
    requests: number;
    successes: number;
    failures: number;
  }>;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  availabilityPercent: number | null;
}

export type TrafficVolumeRange = '12h' | '24h' | '7d';

export interface TrafficVolumeBucket {
  from: string;
  to: string;
  requests: number;
  errors: number;
}

export interface TrafficVolumeResponse {
  range: TrafficVolumeRange;
  available: boolean;
  windowStart: string;
  windowEnd: string;
  bucketMs: number;
  buckets: TrafficVolumeBucket[];
  totalRequests: number;
  totalErrors: number;
}

export interface ModelsResponse {
  source: 'gateway' | 'catalog';
  gatewayOnline: boolean;
  gatewayPort: number;
  models: ModelInfo[];
}

export interface ModelTestResult {
  ok: boolean;
  model: string;
  status?: 'working' | 'temporarily_unavailable' | 'expired' | 'needs_verification';
  checkedAccounts?: number;
  workingAccounts?: number;
  latencyMs: number;
  sample?: string;
  httpStatus?: number | null;
  error?: string;
}

export interface PlaygroundResult {
  ok: boolean;
  model: string;
  response?: string;
  latencyMs: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: string;
  httpStatus?: number | null;
}
