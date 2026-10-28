import type { GoogleAccount, TrafficRecord, GatewayConfig } from './store.js';

/**
 * Bridge-level view of the account pool.
 *
 * Per-request account selection, quota/rate-limit failover, cooldowns and the
 * pool-exhausted response all live in the AntigravityManager core (see
 * docs/ACCOUNT-FAILOVER.md). The bridge only observes and reports: these
 * helpers turn real traffic records and account views into honest status
 * numbers, with no fabricated values.
 */

export interface PoolState {
  requestsLast24h: number;
  tokensLast24h: number;
  averageLatencyMs: number | null;
  successRate: number | null;
  activeBackingAccountEmail: string | null;
  cooldownAccounts: Array<{ id: string; email: string; status: string }>;
  lastSwitch: {
    fromEmail: string | null;
    toEmail: string;
    at: string;
    reason: 'observed-account-change';
  } | null;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function derivePoolState(accounts: GoogleAccount[], traffic: TrafficRecord[]): PoolState {
  const now = Date.now();
  const recent = traffic.filter((r) => {
    const ts = Date.parse(r.timestamp);
    return Number.isFinite(ts) && now - ts <= TWENTY_FOUR_HOURS_MS;
  });

  const requestsLast24h = recent.length;
  const tokensLast24h = recent.reduce((sum, r) => sum + (r.totalTokens || 0), 0);

  const latencyValues = recent.map((r) => r.latencyMs).filter((v) => typeof v === 'number' && v >= 0);
  const averageLatencyMs = latencyValues.length
    ? Math.round(latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length)
    : null;

  const successes = recent.filter((r) => r.status >= 200 && r.status < 400).length;
  const successRate = requestsLast24h > 0 ? Math.round((successes / requestsLast24h) * 1000) / 10 : null;

  // The backing account serving traffic most recently (real attribution only).
  const sorted = [...recent].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
  const activeBackingAccountEmail = sorted[0]?.backingAccountEmail || null;

  // Accounts the core reported as rate-limited or expired. The core owns the
  // cooldown clock; the bridge only surfaces the states it published.
  const cooldownAccounts = accounts
    .filter((a) => a.status === 'cooldown' || a.status === 'error')
    .map((a) => ({ id: a.id, email: a.email, status: a.status }));

  // Last observed switch: walking chronologically, the newest record whose
  // backing account differs from the previous record's. The core does not
  // expose the switch reason, so the reason is reported as an observation,
  // not a claim.
  let lastSwitch: PoolState['lastSwitch'] = null;
  const chronological = [...recent].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  for (let i = 1; i < chronological.length; i++) {
    const prev = chronological[i - 1];
    const curr = chronological[i];
    if (
      prev.backingAccountEmail &&
      curr.backingAccountEmail &&
      prev.backingAccountEmail !== curr.backingAccountEmail
    ) {
      lastSwitch = {
        fromEmail: prev.backingAccountEmail,
        toEmail: curr.backingAccountEmail,
        at: curr.timestamp,
        reason: 'observed-account-change',
      };
    }
  }

  return {
    requestsLast24h,
    tokensLast24h,
    averageLatencyMs,
    successRate,
    activeBackingAccountEmail,
    cooldownAccounts,
    lastSwitch,
  };
}

/** Shape of the `proxy` section in the core's ~/.antigravity-agent/gui_config.json. */
export interface CoreProxyConfig {
  port?: number;
  api_key?: string;
  quota_aware_scheduling_enabled?: boolean;
  scheduling_mode?: 'cache-first' | 'balance' | 'performance-first';
  account_selection_strategy?: 'balanced' | 'account-first';
  preferred_account_id?: string;
  max_wait_seconds?: number;
  circuit_breaker_enabled?: boolean;
  circuit_breaker_backoff_steps?: number[];
  [key: string]: unknown;
}

/**
 * Map the dashboard's routing controls onto the core's real scheduling
 * settings. Only fields the core actually reads are produced; anything the
 * core does not support is not invented here (see docs/ACCOUNT-FAILOVER.md).
 */
export function bridgeToCoreProxy(config: Partial<GatewayConfig>): CoreProxyConfig {
  const patch: CoreProxyConfig = {};

  if (typeof config.autoSwitchOnQuotaLimit === 'boolean') {
    patch.quota_aware_scheduling_enabled = config.autoSwitchOnQuotaLimit;
  }

  if (config.rotationStrategy === 'least-used-quota' || config.rotationStrategy === 'round-robin') {
    patch.scheduling_mode = 'balance';
    patch.account_selection_strategy = 'balanced';
  } else if (config.rotationStrategy === 'priority-order') {
    patch.scheduling_mode = 'performance-first';
    patch.account_selection_strategy = 'account-first';
  } else if (config.rotationStrategy === 'pinned-account') {
    patch.account_selection_strategy = 'account-first';
    if (config.pinnedAccountId !== undefined) {
      patch.preferred_account_id = config.pinnedAccountId || '';
    }
  }

  if (typeof config.pinnedAccountId === 'string') {
    patch.preferred_account_id = config.pinnedAccountId;
  }

  return patch;
}

/** Reflect the core's real scheduling settings back into dashboard config fields. */
export function coreProxyToBridge(
  core: CoreProxyConfig | null,
  config: GatewayConfig,
): GatewayConfig & { coreScheduling: CoreProxyConfig | null } {
  if (!core) {
    return { ...config, coreScheduling: null };
  }

  // Defense in depth: never let credentials ride along, even if a caller
  // passed an unsanitized core config.
  const safeCore: CoreProxyConfig = { ...core };
  delete safeCore.api_key;
  delete safeCore.upstream_proxy;

  const merged: GatewayConfig & { coreScheduling: CoreProxyConfig | null } = {
    ...config,
    coreScheduling: safeCore,
  };

  if (typeof core.quota_aware_scheduling_enabled === 'boolean') {
    merged.autoSwitchOnQuotaLimit = core.quota_aware_scheduling_enabled;
  }

  if (core.account_selection_strategy === 'account-first' && core.preferred_account_id) {
    merged.rotationStrategy = 'pinned-account';
    merged.pinnedAccountId = core.preferred_account_id;
  } else if (core.scheduling_mode === 'performance-first') {
    merged.rotationStrategy = 'priority-order';
  } else {
    // 'balance' distributes by remaining quota; closest dashboard notion is
    // least-used-quota. The core has no pure round-robin mode.
    merged.rotationStrategy = 'least-used-quota';
  }

  if (typeof core.preferred_account_id === 'string') {
    merged.pinnedAccountId = core.preferred_account_id || merged.pinnedAccountId;
  }

  return merged;
}
