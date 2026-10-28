import {
  GatewayStatus,
  GoogleAccount,
  GatewayConfig,
  TrafficRecord,
  OAuthStartResponse,
} from '../types';

export const INITIAL_MOCK_CONFIG: GatewayConfig = {
  port: 8080,
  host: '127.0.0.1',
  masterApiKey: 'gr-live_' + Math.random().toString(36).substring(2, 10),
  autoStartOnBoot: true,
  autoSwitchOnQuotaLimit: true,
  quotaWarningThresholdPercent: 85,
  autoCooldownMinutes: 30,
  rotationStrategy: 'least-used-quota',
  enableStreamRelay: true,
  enableThinkingTagPassthrough: true,
  rateLimitPerMinute: 120,
  logRetentionDays: 14,
  maxConcurrentRequestsPerAccount: 10,
  capacityPolicy: 'queue',
  queueTimeoutMs: 5000,
};

export const INITIAL_MOCK_ACCOUNTS: GoogleAccount[] = [];

export const INITIAL_MOCK_STATUS: GatewayStatus = {
  isRunning: false,
  port: 8046,
  host: '127.0.0.1',
  uptimeSeconds: 0,
  activeAccountsCount: 0,
  totalAccountsCount: 0,
  requestsLast24h: 0,
  tokensLast24h: 0,
  averageLatencyMs: null,
  successRate: null,
  activeBackingAccountEmail: undefined,
  version: '1.0.0',
  healthy: false,
};

export const INITIAL_MOCK_TRAFFIC: TrafficRecord[] = [];

export const MOCK_OAUTH_START_DATA: OAuthStartResponse = {
  authorizationUrl: '',
  sessionId: '',
  expiresInSeconds: 600,
};
