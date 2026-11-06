import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Webshare proxy inventory and per-account assignment.
 *
 * The bridge does NOT talk to the AI providers itself. It only decides which
 * Webshare proxy each account should use, and hands that decision to the core
 * through the `accountSetProxy` RPC. The core already owns OAuth credentials,
 * quota accounting, cooldown and failover, and it routes every upstream call
 * for an account through `accounts.proxy_url` when one is set.
 */
export interface WebshareProxy {
  /** Webshare uses string ids ("d-…" for direct, "b-…" for backbone). */
  id: string | number;
  proxy_address: string;
  /**
   * The list API returns a single flat `port` per proxy; older/analytics
   * payloads use a `ports` object. Both are accepted.
   */
  port?: number;
  ports?: { http?: number; https?: number };
  username: string;
  password: string;
  country_code: string;
  /** False when Webshare has flagged the proxy as currently unusable. */
  valid?: boolean;
  protocol_type?: string;
}

/** One account's desired proxy state. `proxyUrl: null` means "go direct". */
export interface ProxyAssignment {
  accountId: string;
  proxyUrl: string | null;
}

/** Result of a Webshare inventory refresh. Never throws; reports failure via `ok`. */
export interface ProxyRefreshResult {
  ok: boolean;
  proxyCount: number;
  error?: string;
}

/** Client-safe view of the proxy configuration. The API key is never included. */
export interface ProxyConfigSnapshot {
  enabled: boolean;
  /** True when a Webshare API key is stored server-side. */
  hasApiKey: boolean;
  proxyCount: number;
  accountCount: number;
  lastFetchedAt: number;
  fetchIntervalMs: number;
  /** Last refresh failure, cleared by the next successful refresh. */
  lastError: string | null;
}

/** A proxy row for the dashboard, with the accounts currently pinned to it. */
export interface ProxyListEntry {
  address: string;
  port: number;
  country: string;
  assignedAccountIds: string[];
  /** Assignment / health state for the dashboard. */
  status: 'assigned' | 'cooling' | 'retired' | 'available';
  quarantineUntil: number | null;
}

const WEBSHARE_API_URL = 'https://proxy.webshare.io/api/v2/proxy/list/';

/** Webshare rejects the list call without an explicit mode. */
type WebshareMode = 'direct' | 'backbone';

const DEFAULT_FETCH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Webshare caps `page_size` at 100; keep a hard page cap so a bad API can't loop forever. */
const WEBSHARE_PAGE_SIZE = 100;
const WEBSHARE_MAX_PAGES = 20;

/** Stable identity for a proxy: address plus the port actually used for HTTPS upstreams. */
function proxyKey(proxy: WebshareProxy): string {
  return `${proxy.proxy_address}:${proxyPort(proxy)}`;
}

function proxyPort(proxy: WebshareProxy): number {
  return Number(proxy.port) || proxy.ports?.https || proxy.ports?.http || 0;
}

/**
 * Convert a Webshare inventory row into the `http://user:pass@host:port` form
 * the core accepts for `accounts.proxy_url`.
 */
export function toProxyUrl(proxy: WebshareProxy): string | null {
  const port = proxyPort(proxy);
  const host = proxy.proxy_address;
  if (!host || !port) return null;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
    : '';
  return `http://${auth}${host}:${port}`;
}

export class ProxyManager {
  private apiKey = '';
  private enabled = false;
  private proxyList: WebshareProxy[] = [];
  private assignments = new Map<string, WebshareProxy>();
  private roundRobinIndex = 0;
  private lastFetchedAt = 0;
  private lastError: string | null = null;
  private fetchIntervalMs = DEFAULT_FETCH_INTERVAL_MS;
  private fetchInventoryImpl: () => Promise<WebshareProxy[]>;
  private apiBaseUrl: string;
  /**
   * Last proxy URL successfully pushed to the core, per account. Used to avoid
   * re-writing every account (and reloading the core) on every refresh cycle.
   */
  private pushed = new Map<string, string | null>();
  /**
   * accountId -> "address:port" of the proxy it used in a previous process.
   * Restored after a refresh so a bridge restart does not rotate every account
   * onto a different IP.
   */
  private persistedAssignments = new Map<string, string>();
  // AI Studio key -> proxy. Kept separate from account assignments: the key
  // pool can use proxies while account routing is off (or vice versa).
  private apiKeyProxyEnabled = false;
  private apiKeyAssignments = new Map<string, WebshareProxy>();
  private persistedApiKeyAssignments = new Map<string, string>();
  private apiKeyAgentCache = new Map<string, HttpsProxyAgent<string>>();
  private apiKeyRoundRobin = 0;
  // Egress health: a proxy freed from a banned account cools down before it is
  // reused; a retired proxy is never assigned again.
  private quarantineUntil = new Map<string, number>();
  private retiredProxies = new Set<string>();

  /**
   * @param options.fetchInventory Injectable inventory source. Production uses
   *   the Webshare API; tests supply a fixed list.
   * @param options.apiBaseUrl Override for the Webshare list endpoint (tests).
   */
  constructor(options: { fetchInventory?: () => Promise<WebshareProxy[]>; apiBaseUrl?: string } = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? WEBSHARE_API_URL;
    this.fetchInventoryImpl = options.fetchInventory ?? (() => this.fetchInventoryFromWebshare());
  }

  /** Store (or clear) the Webshare API key. Clearing also disables routing. */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey.trim();
    if (!this.apiKey) {
      this.enabled = false;
      this.apiKeyProxyEnabled = false;
      this.clearInventory();
    }
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Enable or disable proxy routing. Enabling requires a stored key; returns
   * false when it was refused.
   */
  setEnabled(enabled: boolean): boolean {
    if (enabled && !this.hasApiKey()) return false;
    this.enabled = enabled;
    if (!enabled) {
      this.assignments.clear();
      if (!this.apiKeyProxyEnabled) this.clearInventory();
    }
    return true;
  }

  /**
   * Route AI Studio key traffic through the Webshare inventory. The inventory is
   * shared with account routing; this flag only decides whether keys use it.
   */
  setApiKeyProxyEnabled(enabled: boolean): boolean {
    if (enabled && !this.hasApiKey()) return false;
    this.apiKeyProxyEnabled = enabled;
    if (!enabled) {
      this.apiKeyAssignments.clear();
      this.apiKeyAgentCache.clear();
      if (!this.enabled) this.clearInventory();
    }
    return true;
  }

  isApiKeyProxyEnabled(): boolean {
    return this.apiKeyProxyEnabled && this.hasApiKey();
  }

  /** True when the shared inventory is needed by either routing mode. */
  isProxyInventoryActive(): boolean {
    return this.isEnabled() || this.isApiKeyProxyEnabled();
  }

  /** True only when routing is switched on AND a key is present. */
  isEnabled(): boolean {
    return this.enabled && this.hasApiKey();
  }

  getRefreshIntervalMs(): number {
    return this.fetchIntervalMs;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private clearInventory(): void {
    this.proxyList = [];
    this.assignments.clear();
    this.apiKeyAssignments.clear();
    this.apiKeyAgentCache.clear();
    this.lastFetchedAt = 0;
  }

  /**
   * Fetch the full proxy inventory from the Webshare API, following pagination.
   * Never throws; the returned result reports success, the resulting proxy
   * count, and any error message. On failure the previous inventory and
   * assignments are kept so live traffic is not disturbed by a transient error.
   */
  async refreshProxies(): Promise<ProxyRefreshResult> {
    if (!this.hasApiKey()) {
      this.lastError = 'No Webshare API key configured.';
      return { ok: false, proxyCount: this.proxyList.length, error: this.lastError };
    }

    try {
      const proxies = await this.fetchInventoryImpl();
      const previous = new Map(this.assignments);
      const previousApi = new Map(this.apiKeyAssignments);

      this.proxyList = proxies;
      this.lastFetchedAt = Date.now();
      this.lastError = null;
      this.restoreAssignments(previous);
      this.restoreApiKeyAssignments(previousApi);

      return { ok: true, proxyCount: proxies.length };
    } catch (err: any) {
      const message = err?.message || String(err);
      this.lastError = message;
      console.error('[ProxyManager] Failed to refresh Webshare proxies:', message);
      return { ok: false, proxyCount: this.proxyList.length, error: message };
    }
  }

  private async fetchInventoryFromWebshare(): Promise<WebshareProxy[]> {
    // `direct` is the static inventory (one fixed IP per row) and is what
    // per-account pinning wants. Subscriptions that only have rotating
    // endpoints fall back to `backbone` instead of reporting zero proxies.
    const direct = await this.fetchMode('direct');
    if (direct.length > 0) return direct;
    return this.fetchMode('backbone');
  }

  private async fetchMode(mode: WebshareMode): Promise<WebshareProxy[]> {
    const proxies: WebshareProxy[] = [];
    let page = 1;

    while (page <= WEBSHARE_MAX_PAGES) {
      const response = await axios.get<{ results: WebshareProxy[]; count: number }>(this.apiBaseUrl, {
        // `mode` is mandatory: Webshare answers 400 Bad Request without it.
        params: { mode, page, page_size: WEBSHARE_PAGE_SIZE },
        timeout: 15_000,
        headers: { Authorization: `Token ${this.apiKey}` },
        validateStatus: (status) => status === 200,
      });

      const results = Array.isArray(response.data?.results) ? response.data.results : [];
      proxies.push(...results);

      const total = Number(response.data?.count ?? proxies.length);
      if (results.length < WEBSHARE_PAGE_SIZE || proxies.length >= total) break;
      page += 1;
    }

    // Drop rows the core could never use: no host/port, or flagged unusable.
    return proxies.filter(
      (proxy) =>
        Boolean(proxy.proxy_address) && proxyPort(proxy) > 0 && proxy.valid !== false,
    );
  }

  /**
   * Restore the account -> proxy mapping persisted by a previous process.
   * Keys are `address:port`; unknown or vanished proxies are ignored and the
   * account is re-assigned on the next reconcile.
   */
  hydrateAssignments(assignments: Record<string, string>): void {
    this.persistedAssignments.clear();
    for (const [accountId, key] of Object.entries(assignments || {})) {
      if (typeof key === 'string' && key) this.persistedAssignments.set(accountId, key);
    }
  }

  /** Persisted AI Studio key -> proxy mapping. */
  hydrateApiKeyAssignments(assignments: Record<string, string>): void {
    this.persistedApiKeyAssignments.clear();
    for (const [keyId, key] of Object.entries(assignments || {})) {
      if (typeof key === 'string' && key) this.persistedApiKeyAssignments.set(keyId, key);
    }
  }

  /** Restore proxy health (quarantines and retired IPs) after a restart. */
  hydrateHealthState(quarantines: Record<string, number>, retired: string[]): void {
    this.quarantineUntil.clear();
    for (const [key, until] of Object.entries(quarantines || {})) {
      if (typeof key === 'string' && Number.isFinite(until) && until > Date.now()) {
        this.quarantineUntil.set(key, until);
      }
    }
    this.retiredProxies = new Set(
      Array.isArray(retired) ? retired.filter((key) => typeof key === 'string' && key) : [],
    );
  }

  getHealthState(): { quarantines: Record<string, number>; retired: string[] } {
    const quarantines: Record<string, number> = {};
    const now = Date.now();
    for (const [key, until] of this.quarantineUntil) {
      if (until > now) quarantines[key] = until;
    }
    return { quarantines, retired: [...this.retiredProxies] };
  }

  /** A proxy is assignable when it is neither retired nor cooling. */
  isProxyAvailable(proxy: WebshareProxy): boolean {
    const key = proxyKey(proxy);
    if (this.retiredProxies.has(key)) return false;
    const until = this.quarantineUntil.get(key) ?? 0;
    return until <= Date.now();
  }

  private availableProxies(): WebshareProxy[] {
    return this.proxyList.filter((proxy) => this.isProxyAvailable(proxy));
  }

  /** The `address:port` key of a proxy, for the dashboard actions. */
  proxyKeyFor(address: string, port: number): string {
    return `${address}:${port}`;
  }

  /** Proxy pinned to an account, as `address:port`, or null. */
  getAccountProxyKey(accountId: string): string | null {
    const proxy = this.assignments.get(accountId);
    return proxy ? proxyKey(proxy) : null;
  }

  /** Quarantine a proxy for the given duration; it will not be assigned. */
  quarantineProxy(key: string, durationMs: number): boolean {
    if (!this.proxyList.some((proxy) => proxyKey(proxy) === key)) return false;
    this.retiredProxies.delete(key);
    this.quarantineUntil.set(key, Date.now() + Math.max(60_000, durationMs));
    return true;
  }

  /** Permanently keep a proxy out of assignment. */
  retireProxy(key: string): boolean {
    if (!this.proxyList.some((proxy) => proxyKey(proxy) === key)) return false;
    this.retiredProxies.add(key);
    this.quarantineUntil.delete(key);
    return true;
  }

  /** Clear quarantine and retirement so the proxy can be assigned again. */
  restoreProxy(key: string): boolean {
    if (!this.proxyList.some((proxy) => proxyKey(proxy) === key)) return false;
    this.retiredProxies.delete(key);
    this.quarantineUntil.delete(key);
    return true;
  }

  getProxyStatus(proxy: WebshareProxy): {
    status: 'assigned' | 'cooling' | 'retired' | 'available';
    quarantineUntil: number | null;
  } {
    const key = proxyKey(proxy);
    const until = this.quarantineUntil.get(key) ?? 0;
    const assigned =
      [...this.assignments.values()].some((entry) => proxyKey(entry) === key) ||
      [...this.apiKeyAssignments.values()].some((entry) => proxyKey(entry) === key);
    const status = this.retiredProxies.has(key)
      ? 'retired'
      : until > Date.now()
        ? 'cooling'
        : assigned
          ? 'assigned'
          : 'available';
    return { status, quarantineUntil: until > Date.now() ? until : null };
  }

  /** Current mapping as `accountId -> "address:port"`, for persistence. */
  getAssignmentKeys(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [accountId, proxy] of this.assignments) {
      result[accountId] = proxyKey(proxy);
    }
    return result;
  }

  /** Current AI Studio key mapping as `keyId -> "address:port"`. */
  getApiKeyAssignmentKeys(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [keyId, proxy] of this.apiKeyAssignments) {
      result[keyId] = proxyKey(proxy);
    }
    return result;
  }

  /**
   * After a refresh, keep each account on its previous proxy while that proxy is
   * still in the inventory. Assignments for vanished proxies are dropped and
   * re-created by `reconcile`.
   */
  private restoreAssignments(previous: Map<string, WebshareProxy>): void {
    const byKey = new Map<string, WebshareProxy>();
    for (const proxy of this.proxyList) byKey.set(proxyKey(proxy), proxy);

    this.assignments.clear();
    for (const [accountId, oldProxy] of previous) {
      const match = byKey.get(proxyKey(oldProxy));
      if (match && this.isProxyAvailable(match)) this.assignments.set(accountId, match);
    }

    // Fresh process (or an account missing from the in-memory map): fall back to
    // the persisted mapping so restarting the bridge does not change the IP.
    for (const [accountId, key] of this.persistedAssignments) {
      if (this.assignments.has(accountId)) continue;
      const match = byKey.get(key);
      if (match && this.isProxyAvailable(match)) this.assignments.set(accountId, match);
    }
  }

  /** Refresh counterpart for AI Studio key assignments. */
  private restoreApiKeyAssignments(previous: Map<string, WebshareProxy>): void {
    const byKey = new Map<string, WebshareProxy>();
    for (const proxy of this.proxyList) byKey.set(proxyKey(proxy), proxy);

    this.apiKeyAssignments.clear();
    for (const [keyId, oldProxy] of previous) {
      const match = byKey.get(proxyKey(oldProxy));
      if (match && this.isProxyAvailable(match)) this.apiKeyAssignments.set(keyId, match);
    }
    for (const [keyId, key] of this.persistedApiKeyAssignments) {
      if (this.apiKeyAssignments.has(keyId)) continue;
      const match = byKey.get(key);
      if (match && this.isProxyAvailable(match)) this.apiKeyAssignments.set(keyId, match);
    }
  }

  /**
   * Compute the desired proxy state for the given accounts, assigning proxies
   * where needed. The returned list is what the caller must push to the core.
   *
   * - Disabled: every account is returned with `proxyUrl: null` so the core
   *   clears any proxy it still has for them.
   * - Enabled: existing assignments are preserved; removed accounts are
   *   forgotten; new accounts get the least-used proxy.
   */
  reconcile(accountIds: string[]): ProxyAssignment[] {
    // De-duplicate defensively: pushing the same account twice would double the
    // RPC traffic and make the applied count lie.
    const uniqueIds = [...new Set(accountIds)];
    const live = new Set(uniqueIds);

    for (const accountId of [...this.assignments.keys()]) {
      if (!live.has(accountId)) this.assignments.delete(accountId);
    }

    if (!this.isEnabled()) {
      this.assignments.clear();
      return uniqueIds.map((accountId) => ({ accountId, proxyUrl: null }));
    }

    if (this.proxyList.length > 0) {
      const byKey = new Map<string, WebshareProxy>();
      for (const proxy of this.proxyList) byKey.set(proxyKey(proxy), proxy);

      for (const accountId of uniqueIds) {
        const current = this.assignments.get(accountId);
        if (!current || !byKey.has(proxyKey(current)) || !this.isProxyAvailable(current)) {
          this.assignProxyToAccount(accountId, byKey);
        }
      }
    }

    return uniqueIds.map((accountId) => ({
      accountId,
      proxyUrl: this.proxyUrlFor(accountId),
    }));
  }

  /**
   * Assign the least-used proxy to an account (round-robin order breaks ties).
   * Returns the assigned proxy or null when no proxies are available.
   */
  private assignProxyToAccount(
    accountId: string,
    byKey: Map<string, WebshareProxy>,
  ): WebshareProxy | null {
    const candidates = this.availableProxies();
    if (!this.isEnabled() || candidates.length === 0) {
      this.assignments.delete(accountId);
      return null;
    }

    const usage = new Map<string, number>();
    for (const proxy of candidates) usage.set(proxyKey(proxy), 0);
    for (const [id, proxy] of this.assignments) {
      if (id === accountId) continue;
      const key = proxyKey(proxy);
      if (usage.has(key)) usage.set(key, (usage.get(key) ?? 0) + 1);
    }

    const count = candidates.length;
    let best: WebshareProxy | null = null;
    let bestUsage = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < count; offset += 1) {
      const candidate = candidates[(this.roundRobinIndex + offset) % count];
      const candidateUsage = usage.get(proxyKey(candidate)) ?? 0;
      if (candidateUsage < bestUsage) {
        best = candidate;
        bestUsage = candidateUsage;
      }
    }

    this.roundRobinIndex = (this.roundRobinIndex + 1) % Math.max(count, 1);
    if (!best) {
      this.assignments.delete(accountId);
      return null;
    }
    // Keep the canonical row from the current inventory.
    const canonical = byKey.get(proxyKey(best)) ?? best;
    this.assignments.set(accountId, canonical);
    return canonical;
  }

  /** The proxy URL for an account, or null when it should go direct. */
  proxyUrlFor(accountId: string): string | null {
    if (!this.isEnabled()) return null;
    const proxy = this.assignments.get(accountId);
    return proxy ? toProxyUrl(proxy) : null;
  }

  /**
   * Assign one proxy to each AI Studio key, keeping existing pins. Keys are
   * spread least-used first; when there are more keys than proxies, extras share
   * an IP. Does nothing when key proxies are disabled or the inventory is empty.
   */
  reconcileApiKeyAssignments(keyIds: string[]): void {
    const unique = [...new Set(keyIds)];
    const live = new Set(unique);

    for (const keyId of [...this.apiKeyAssignments.keys()]) {
      if (!live.has(keyId)) this.apiKeyAssignments.delete(keyId);
    }

    if (!this.isApiKeyProxyEnabled() || this.proxyList.length === 0) return;

    const byKey = new Map<string, WebshareProxy>();
    for (const proxy of this.proxyList) byKey.set(proxyKey(proxy), proxy);

    for (const keyId of unique) {
      const current = this.apiKeyAssignments.get(keyId);
      if (!current || !byKey.has(proxyKey(current)) || !this.isProxyAvailable(current)) {
        this.assignProxyToApiKey(keyId, byKey);
      }
    }
  }

  private assignProxyToApiKey(
    keyId: string,
    byKey: Map<string, WebshareProxy>,
  ): WebshareProxy | null {
    const candidates = this.availableProxies();
    if (!this.isApiKeyProxyEnabled() || candidates.length === 0) {
      this.apiKeyAssignments.delete(keyId);
      return null;
    }

    const usage = new Map<string, number>();
    for (const proxy of candidates) usage.set(proxyKey(proxy), 0);
    for (const [id, proxy] of this.apiKeyAssignments) {
      if (id === keyId) continue;
      const key = proxyKey(proxy);
      if (usage.has(key)) usage.set(key, (usage.get(key) ?? 0) + 1);
    }

    const count = candidates.length;
    let best: WebshareProxy | null = null;
    let bestUsage = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < count; offset += 1) {
      const candidate = candidates[(this.apiKeyRoundRobin + offset) % count];
      const candidateUsage = usage.get(proxyKey(candidate)) ?? 0;
      if (candidateUsage < bestUsage) {
        best = candidate;
        bestUsage = candidateUsage;
      }
    }

    this.apiKeyRoundRobin = (this.apiKeyRoundRobin + 1) % Math.max(count, 1);
    if (!best) {
      this.apiKeyAssignments.delete(keyId);
      return null;
    }
    const canonical = byKey.get(proxyKey(best)) ?? best;
    this.apiKeyAssignments.set(keyId, canonical);
    return canonical;
  }

  /** Proxy URL for an AI Studio key, or null when the key goes direct. */
  getApiKeyProxyUrl(keyId: string): string | null {
    if (!this.isApiKeyProxyEnabled()) return null;
    const proxy = this.apiKeyAssignments.get(keyId);
    if (!proxy || !this.isProxyAvailable(proxy)) return null;
    return toProxyUrl(proxy);
  }

  /** Cached HTTPS-over-HTTP agent for a key's assigned proxy. */
  getApiKeyProxyAgent(keyId: string): HttpsProxyAgent<string> | null {
    const url = this.getApiKeyProxyUrl(keyId);
    if (!url) return null;

    const cached = this.apiKeyAgentCache.get(url);
    if (cached) return cached;

    const agent = new HttpsProxyAgent<string>(url);
    this.apiKeyAgentCache.set(url, agent);
    return agent;
  }

  getApiKeyProxySummary(
    keyId: string,
  ): { address: string; port: number; country: string | null } | null {
    if (!this.isApiKeyProxyEnabled()) return null;
    const proxy = this.apiKeyAssignments.get(keyId);
    if (!proxy || !this.isProxyAvailable(proxy)) return null;
    return {
      address: proxy.proxy_address,
      port: proxyPort(proxy),
      country: proxy.country_code ? proxy.country_code.toUpperCase() : null,
    };
  }

  getApiKeyProxyState(): {
    enabled: boolean;
    available: number;
    hasApiKey: boolean;
    assigned: number;
  } {
    return {
      enabled: this.isApiKeyProxyEnabled(),
      available: this.proxyList.length,
      hasApiKey: this.hasApiKey(),
      assigned: this.apiKeyAssignments.size,
    };
  }

  /**
   * Egress identity for an account's traffic: the assigned proxy address and
   * its country. Null when the account is not routed through a proxy.
   */
  getEgressForAccount(accountId: string): { address: string; country: string | null } | null {
    if (!this.isEnabled()) return null;
    const proxy = this.assignments.get(accountId);
    if (!proxy) return null;
    return {
      address: proxy.proxy_address,
      country: proxy.country_code ? proxy.country_code.toUpperCase() : null,
    };
  }

  /** Egress identity for an AI Studio key, for traffic attribution. */
  getEgressForKey(keyId: string): { address: string; country: string | null } | null {
    const proxy = this.getApiKeyProxySummary(keyId);
    if (!proxy) return null;
    return { address: proxy.address, country: proxy.country };
  }

  /**
   * Filter a desired state down to the accounts whose core value actually
   * differs from the last successful push. An empty result means the core is
   * already in sync and should not be touched (or reloaded).
   */
  changedSincePushed(assignments: ProxyAssignment[]): ProxyAssignment[] {
    return assignments.filter((assignment) => {
      const pushedValue = this.pushed.has(assignment.accountId)
        ? this.pushed.get(assignment.accountId)!
        : undefined;
      // `undefined` (never pushed) always counts as a change.
      return pushedValue === undefined || pushedValue !== assignment.proxyUrl;
    });
  }

  /** Record assignments the core accepted, so the next cycle can skip them. */
  markPushed(assignments: ProxyAssignment[]): void {
    for (const assignment of assignments) {
      this.pushed.set(assignment.accountId, assignment.proxyUrl);
    }
  }

  /** Forget a push (used when the core rejects it) so the next cycle retries. */
  markPushFailed(accountIds: string[]): void {
    for (const accountId of accountIds) this.pushed.delete(accountId);
  }

  getConfigSnapshot(): ProxyConfigSnapshot {
    return {
      enabled: this.isEnabled(),
      // Write-only: the key is stored server-side and never echoed back.
      hasApiKey: this.hasApiKey(),
      proxyCount: this.proxyList.length,
      accountCount: this.assignments.size,
      lastFetchedAt: this.lastFetchedAt,
      fetchIntervalMs: this.fetchIntervalMs,
      lastError: this.lastError,
    };
  }

  /** Dashboard view of the inventory: address/port/country and pinned account ids. */
  getProxyListSummary(): ProxyListEntry[] {
    const accountsByProxy = new Map<string, string[]>();
    for (const [accountId, proxy] of this.assignments) {
      const key = proxyKey(proxy);
      const list = accountsByProxy.get(key) ?? [];
      list.push(accountId);
      accountsByProxy.set(key, list);
    }

    return this.proxyList.map((proxy) => ({
      address: proxy.proxy_address,
      port: proxyPort(proxy),
      country: proxy.country_code,
      assignedAccountIds: accountsByProxy.get(proxyKey(proxy)) ?? [],
      ...this.getProxyStatus(proxy),
    }));
  }
}

// Singleton reused across requests. Tests construct their own instances.
let _sharedProxyManager: ProxyManager | null = null;

export function getSharedProxyManager(): ProxyManager {
  if (!_sharedProxyManager) _sharedProxyManager = new ProxyManager();
  return _sharedProxyManager;
}