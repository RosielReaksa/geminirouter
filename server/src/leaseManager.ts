import EventEmitter from 'node:events';
import type { GoogleAccount } from './store.js';

export interface LeaseManagerOptions {
  maxConcurrentRequestsPerAccount?: number;
  capacityPolicy?: 'queue' | 'reject_429';
  queueTimeoutMs?: number;
  cooldownTtlMs?: number;
}

export class ConcurrencyLeaseManager extends EventEmitter {
  private inFlightMap = new Map<string, number>();
  // Cooldown keys are `accountId::model` so a quota burn on one model does not
  // remove the account from unrelated models. `accountId::*` is the wildcard
  // used when the failing request carried no model (account-wide cooldown).
  private cooldowns = new Map<string, number>(); // cooldownKey -> expiresAtMs
  private maxConcurrentRequestsPerAccount: number;
  private capacityPolicy: 'queue' | 'reject_429';
  private queueTimeoutMs: number;
  private cooldownTtlMs: number;

  constructor(options: LeaseManagerOptions = {}) {
    super();
    this.maxConcurrentRequestsPerAccount = options.maxConcurrentRequestsPerAccount ?? 10;
    this.capacityPolicy = options.capacityPolicy ?? 'queue';
    this.queueTimeoutMs = options.queueTimeoutMs ?? 5000;
    this.cooldownTtlMs = options.cooldownTtlMs ?? 30 * 60 * 1000;
  }

  setMaxConcurrentRequestsPerAccount(cap: number): void {
    if (cap > 0) {
      this.maxConcurrentRequestsPerAccount = cap;
    }
  }

  getMaxConcurrentRequestsPerAccount(): number {
    return this.maxConcurrentRequestsPerAccount;
  }

  setCapacityPolicy(policy: 'queue' | 'reject_429'): void {
    this.capacityPolicy = policy;
  }

  getCapacityPolicy(): 'queue' | 'reject_429' {
    return this.capacityPolicy;
  }

  setQueueTimeoutMs(ms: number): void {
    if (ms > 0) {
      this.queueTimeoutMs = ms;
    }
  }

  getQueueTimeoutMs(): number {
    return this.queueTimeoutMs;
  }

  private static readonly WILDCARD_MODEL = '*';

  private static normalizeModel(model?: string): string {
    const trimmed = model?.trim().toLowerCase();
    return trimmed ? trimmed : ConcurrencyLeaseManager.WILDCARD_MODEL;
  }

  private static cooldownKey(accountId: string, model?: string): string {
    return `${accountId}::${ConcurrencyLeaseManager.normalizeModel(model)}`;
  }

  /**
   * True when ANY cooldown is active for this account, regardless of model.
   * Used for display and for callers that have no model context.
   */
  isAccountInCooldown(accountId: string, now: number = Date.now()): boolean {
    const prefix = `${accountId}::`;
    for (const [key, expiresAt] of this.cooldowns.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (now >= expiresAt) {
        this.cooldowns.delete(key);
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * True when this account is cooling down for THIS model (or for the whole
   * account). A cooldown recorded against a different model must not exclude
   * the account — that is what keeps a Claude quota burn from starving Gemini
   * traffic.
   */
  isAccountModelInCooldown(accountId: string, model?: string, now: number = Date.now()): boolean {
    const modelKey = ConcurrencyLeaseManager.cooldownKey(accountId, model);
    const wildcardKey = ConcurrencyLeaseManager.cooldownKey(accountId);
    const candidates = modelKey === wildcardKey ? [wildcardKey] : [modelKey, wildcardKey];

    for (const key of candidates) {
      const expiresAt = this.cooldowns.get(key);
      if (!expiresAt) continue;
      if (now >= expiresAt) {
        this.cooldowns.delete(key);
        continue;
      }
      return true;
    }
    return false;
  }

  markCooldown(accountId: string, ttlMs?: number, model?: string): void {
    const ttl = ttlMs ?? this.cooldownTtlMs;
    this.cooldowns.set(
      ConcurrencyLeaseManager.cooldownKey(accountId, model),
      Date.now() + ttl
    );
  }

  clearCooldown(accountId: string): void {
    const prefix = `${accountId}::`;
    for (const key of this.cooldowns.keys()) {
      if (key.startsWith(prefix)) {
        this.cooldowns.delete(key);
      }
    }
  }

  getCooldownAccounts(now: number = Date.now()): Array<{
    accountId: string;
    remainingSeconds: number;
    model?: string;
  }> {
    // One row per (account, model) so the dashboard can show that an account is
    // limited for one model but still serving others.
    const list: Array<{ accountId: string; remainingSeconds: number; model?: string }> = [];
    for (const [key, expiresAt] of this.cooldowns.entries()) {
      if (now >= expiresAt) {
        this.cooldowns.delete(key);
        continue;
      }
      const sep = key.lastIndexOf('::');
      const accountId = sep === -1 ? key : key.slice(0, sep);
      const model = sep === -1 ? undefined : key.slice(sep + 2);
      list.push({
        accountId,
        remainingSeconds: Math.ceil((expiresAt - now) / 1000),
        model: model === ConcurrencyLeaseManager.WILDCARD_MODEL ? undefined : model,
      });
    }
    return list;
  }

  getInFlight(accountId: string): number {
    return this.inFlightMap.get(accountId) || 0;
  }

  getAllInFlight(): Record<string, number> {
    const res: Record<string, number> = {};
    for (const [id, count] of this.inFlightMap.entries()) {
      if (count > 0) {
        res[id] = count;
      }
    }
    return res;
  }

  getTotalInFlight(): number {
    let sum = 0;
    for (const count of this.inFlightMap.values()) {
      sum += count;
    }
    return sum;
  }

  getTotalCapacity(healthyAccountsCount: number): number {
    return healthyAccountsCount * this.maxConcurrentRequestsPerAccount;
  }

  /**
   * Selection algorithm:
   * 1. Filters eligible accounts: status !== 'error', not cooling down for
   *    THIS model, inFlight < cap.
   * 2. Sorts by fewest in-flight leases ascending (least loaded first).
   * 3. Breaks ties by least quota used (highest remaining quota percentage).
   * 4. If all accounts are at cap:
   *    - If capacityPolicy === 'queue': waits up to queueTimeoutMs for a slot to free.
   *    - If timeout or policy === 'reject_429': returns null.
   */
  async acquireLease(
    accounts: GoogleAccount[],
    options?: {
      model?: string;
      excludeAccountIds?: Set<string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ account: GoogleAccount; release: () => void } | null> {
    const now = Date.now();
    const timeout = options?.timeoutMs ?? this.queueTimeoutMs;
    const deadline = now + timeout;
    const exclude = options?.excludeAccountIds ?? new Set<string>();

    const tryPick = (): GoogleAccount | null => {
      const candidates = accounts.filter((acc) => {
        if (exclude.has(acc.id)) return false;
        if (acc.status === 'error' || acc.hasValidationLink) return false;
        if (this.isAccountModelInCooldown(acc.id, options?.model)) return false;
        const currentInFlight = this.getInFlight(acc.id);
        if (currentInFlight >= this.maxConcurrentRequestsPerAccount) return false;
        return true;
      });

      if (candidates.length === 0) return null;

      // Sort by fewest in-flight leases ascending
      candidates.sort((a, b) => {
        const inFlightA = this.getInFlight(a.id);
        const inFlightB = this.getInFlight(b.id);
        if (inFlightA !== inFlightB) {
          return inFlightA - inFlightB;
        }

        // Tie-breaker: least quota used (highest remaining quota)
        const quotaA = this.getAccountRemainingQuota(a, options?.model);
        const quotaB = this.getAccountRemainingQuota(b, options?.model);
        return quotaB - quotaA; // higher remaining percentage comes first
      });

      return candidates[0];
    };

    // First attempt: immediate pick
    const immediate = tryPick();
    if (immediate) {
      this.incrementLease(immediate.id);
      let released = false;
      return {
        account: immediate,
        release: () => {
          if (!released) {
            released = true;
            this.decrementLease(immediate.id);
          }
        },
      };
    }

    // If immediate pick failed and capacityPolicy === 'reject_429', fail fast
    if (this.capacityPolicy === 'reject_429') {
      return null;
    }

    // Wait in queue for a slot to free up
    return new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        settled = true;
        this.removeListener('slot_freed', onSlotFreed);
        if (timer) clearTimeout(timer);
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const onSlotFreed = () => {
        if (settled) return;
        const candidate = tryPick();
        if (candidate) {
          cleanup();
          this.incrementLease(candidate.id);
          let released = false;
          resolve({
            account: candidate,
            release: () => {
              if (!released) {
                released = true;
                this.decrementLease(candidate.id);
              }
            },
          });
        }
      };

      const onAbort = () => {
        if (settled) return;
        cleanup();
        resolve(null);
      };

      const remainingTime = Math.max(0, deadline - Date.now());
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        resolve(null);
      }, remainingTime);

      this.on('slot_freed', onSlotFreed);
      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private incrementLease(accountId: string): void {
    const current = this.inFlightMap.get(accountId) || 0;
    this.inFlightMap.set(accountId, current + 1);
  }

  private decrementLease(accountId: string): void {
    const current = this.inFlightMap.get(accountId) || 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      this.inFlightMap.delete(accountId);
    } else {
      this.inFlightMap.set(accountId, next);
    }
    // Notify waiters that a slot has been freed
    this.emit('slot_freed');
  }

  private getAccountRemainingQuota(acc: GoogleAccount, model?: string): number {
    if (!acc.quotas || acc.quotas.length === 0) return 100;
    if (model) {
      const match = acc.quotas.find((q) => q.modelId === model || q.modelName === model);
      if (match) {
        const remainingReq = Math.max(0, match.limitIn5h - match.requestsIn5h);
        return match.limitIn5h > 0 ? (remainingReq / match.limitIn5h) * 100 : 0;
      }
    }
    // Average remaining quota across all models
    let totalPct = 0;
    for (const q of acc.quotas) {
      const remainingReq = Math.max(0, q.limitIn5h - q.requestsIn5h);
      totalPct += q.limitIn5h > 0 ? (remainingReq / q.limitIn5h) * 100 : 0;
    }
    return totalPct / acc.quotas.length;
  }
}
