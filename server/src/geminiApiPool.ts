import type { GeminiApiKeyRecord, GeminiApiUsageState } from './store.js';

/** Models served by AI Studio keys for now. Others stay on the account pool. */
export const GEMINI_API_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'] as const;
export type GeminiApiModel = (typeof GEMINI_API_MODELS)[number];

export interface GeminiApiLimits {
  rpm: number;
  tpm: number;
  rpd: number;
}

export interface GeminiApiBucketSnapshot {
  /** Requests used in the current sliding minute. */
  rpm: number;
  /** Tokens used in the current sliding minute. */
  tpm: number;
  /** Requests used today (UTC). */
  rpd: number;
  limitRpm: number;
  limitTpm: number;
  limitRpd: number;
  active: number;
  cooldownUntil: number | null;
}

export interface GeminiApiUsageSnapshot {
  requestsToday: number;
  tokensToday: number;
  rpm: number;
  tpm: number;
  active: number;
  cooldownUntil: number | null;
  lastUsedAt?: string;
}

export interface GeminiApiKeyPublic {
  id: string;
  label: string;
  maskedKey: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt?: string;
  usage: GeminiApiUsageSnapshot;
  /** Per-model budgets; each model has its own Google rate limit. */
  models: Record<string, GeminiApiBucketSnapshot>;
}

export interface GeminiApiQueueSnapshot {
  depth: number;
  active: number;
  maxWaitMs: number;
  maxConcurrentPerKey: number;
  maxQueueSize: number;
}

export interface GeminiApiLease {
  keyId: string;
  model: string;
  estimatedTokens: number;
  clientId: string;
  /** The key record, including the secret used for the upstream call. */
  record: GeminiApiKeyRecord;
  /** Set by the caller when the request completes. */
  settled?: boolean;
}

export interface GeminiApiSettleOptions {
  /** Actual total tokens reported by Google, when known. */
  actualTokens?: number;
  /** Bench this key+model for the given time (429 / 5xx). */
  cooldownMs?: number;
  /** Bench the whole key (401/403). */
  keyWide?: boolean;
}

export interface GeminiApiPoolOptions {
  limits?: Partial<GeminiApiLimits>;
  maxWaitMs?: number;
  maxConcurrentPerKey?: number;
  maxQueueSize?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** How often the queue is pumped while waiters exist. */
  pumpIntervalMs?: number;
}

interface BucketState {
  rpmTokens: number;
  rpmUpdatedAt: number;
  tpmTokens: number;
  tpmUpdatedAt: number;
  dayKey: string;
  rpd: number;
  tokensToday: number;
  active: number;
  cooldownUntil: number;
  lastUsedAt?: string;
}

interface Waiter {
  clientId: string;
  model: string;
  estimatedTokens: number;
  enqueuedAt: number;
  resolve: (lease: GeminiApiLease | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per-key, per-model free-tier limits shown by AI Studio (15 RPM / 250K TPM / 500 RPD). */
export const DEFAULT_GEMINI_API_LIMITS: GeminiApiLimits = {
  rpm: intFromEnv('GEMINI_API_RPM', 15),
  tpm: intFromEnv('GEMINI_API_TPM', 250_000),
  rpd: intFromEnv('GEMINI_API_RPD', 500),
};

export const DEFAULT_GEMINI_API_QUEUE = {
  maxWaitMs: intFromEnv('GEMINI_API_MAX_WAIT_MS', 30_000),
  maxConcurrentPerKey: intFromEnv('GEMINI_API_CONCURRENCY', 4),
  maxQueueSize: intFromEnv('GEMINI_API_QUEUE_LIMIT', 200),
  pumpIntervalMs: intFromEnv('GEMINI_API_PUMP_MS', 250),
};

export function geminiApiBaseUrl(): string {
  return (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com').replace(
    /\/+$/,
    '',
  );
}

/** Rough prompt-token estimate used only for admission control. */
export function estimateGeminiTokens(body: any): number {
  let characters = 0;
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      characters += value.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) collect(item);
    }
  };

  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) collect(message?.content);
  }
  collect(body?.system);

  const maxOut = Number(body?.max_completion_tokens) || Number(body?.max_tokens) || 1024;
  return Math.max(1, Math.ceil(characters / 4) + Math.min(Math.max(maxOut, 1), 65_536));
}

/** Mask a secret for the dashboard: first four and last four characters. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Gemini API key pool with per-key, per-model sliding-window budgets.
 *
 * - RPM/TPM are continuous token buckets (no fixed-minute cliff).
 * - RPD is a UTC-day counter per key and model.
 * - Requests that cannot be admitted wait in a bounded, per-client fair queue.
 * - Each key has a concurrency cap; a request holds it until the stream ends.
 */
export class GeminiApiPool {
  private keys: GeminiApiKeyRecord[] = [];
  private buckets = new Map<string, BucketState>();
  private keyCooldowns = new Map<string, number>();
  private queues = new Map<string, Waiter[]>();
  private clientOrder: string[] = [];
  private clientIndex = 0;
  private queueDepth = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private roundRobin = 0;
  private limits: GeminiApiLimits;
  private maxWaitMs: number;
  private maxConcurrentPerKey: number;
  private maxQueueSize: number;
  private now: () => number;
  private pumpIntervalMs: number;
  private disposed = false;

  constructor(keys: GeminiApiKeyRecord[] = [], options: GeminiApiPoolOptions = {}) {
    this.limits = { ...DEFAULT_GEMINI_API_LIMITS, ...options.limits };
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_GEMINI_API_QUEUE.maxWaitMs;
    this.maxConcurrentPerKey =
      options.maxConcurrentPerKey ?? DEFAULT_GEMINI_API_QUEUE.maxConcurrentPerKey;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_GEMINI_API_QUEUE.maxQueueSize;
    this.now = options.now ?? (() => Date.now());
    this.pumpIntervalMs = options.pumpIntervalMs ?? DEFAULT_GEMINI_API_QUEUE.pumpIntervalMs;
    this.setKeys(keys);
  }

  setKeys(keys: GeminiApiKeyRecord[]): void {
    this.keys = keys
      .filter((key) => key && typeof key.id === 'string' && typeof key.key === 'string' && key.key)
      .map((key) => ({ ...key }));

    const live = new Set(this.keys.map((key) => key.id));
    for (const bucketKey of [...this.buckets.keys()]) {
      if (!live.has(bucketKey.split('::')[0])) this.buckets.delete(bucketKey);
    }
    for (const keyId of [...this.keyCooldowns.keys()]) {
      if (!live.has(keyId)) this.keyCooldowns.delete(keyId);
    }
  }

  hasEnabledKeys(): boolean {
    return this.keys.some((key) => key.enabled);
  }

  /**
   * True when at least one enabled key can accept this model right now without
   * waiting (no cooldown, concurrency, RPM, TPM or RPD block). Used to keep
   * balanced routing away from a key pool that is already saturated.
   */
  hasImmediateCapacity(model: string, estimatedTokens = 1): boolean {
    const tokens = Math.max(1, Math.ceil(estimatedTokens));
    if (tokens > this.limits.tpm) return true;
    return this.keys.some(
      (key) => key.enabled && this.canServe(key, this.bucketFor(key.id, model), tokens),
    );
  }

  getLimits(): GeminiApiLimits {
    return { ...this.limits };
  }

  getQueueStats(): GeminiApiQueueSnapshot {
    let active = 0;
    for (const bucket of this.buckets.values()) active += bucket.active;
    return {
      depth: this.queueDepth,
      active,
      maxWaitMs: this.maxWaitMs,
      maxConcurrentPerKey: this.maxConcurrentPerKey,
      maxQueueSize: this.maxQueueSize,
    };
  }

  private bucketId(keyId: string, model: string): string {
    return `${keyId}::${model}`;
  }

  private bucketFor(keyId: string, model: string): BucketState {
    const id = this.bucketId(keyId, model);
    const now = this.now();
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = {
        rpmTokens: this.limits.rpm,
        rpmUpdatedAt: now,
        tpmTokens: this.limits.tpm,
        tpmUpdatedAt: now,
        dayKey: utcDay(now),
        rpd: 0,
        tokensToday: 0,
        active: 0,
        cooldownUntil: 0,
      };
      this.buckets.set(id, bucket);
      return bucket;
    }

    if (bucket.dayKey !== utcDay(now)) {
      bucket.dayKey = utcDay(now);
      bucket.rpd = 0;
      bucket.tokensToday = 0;
    }
    return bucket;
  }

  private refill(bucket: BucketState, now: number): void {
    const rpmRate = this.limits.rpm / 60_000;
    const tpmRate = this.limits.tpm / 60_000;

    const rpmElapsed = Math.max(0, now - bucket.rpmUpdatedAt);
    if (rpmElapsed > 0) {
      bucket.rpmTokens = Math.min(
        this.limits.rpm,
        bucket.rpmTokens + rpmElapsed * rpmRate,
      );
      bucket.rpmUpdatedAt = now;
    }

    const tpmElapsed = Math.max(0, now - bucket.tpmUpdatedAt);
    if (tpmElapsed > 0) {
      bucket.tpmTokens = Math.min(
        this.limits.tpm,
        bucket.tpmTokens + tpmElapsed * tpmRate,
      );
      bucket.tpmUpdatedAt = now;
    }
  }

  private canServe(key: GeminiApiKeyRecord, bucket: BucketState, tokens: number): boolean {
    const now = this.now();
    if (!key.enabled) return false;
    if ((this.keyCooldowns.get(key.id) ?? 0) > now) return false;
    if (bucket.cooldownUntil > now) return false;
    if (bucket.active >= this.maxConcurrentPerKey) return false;

    this.refill(bucket, now);
    if (bucket.rpd >= this.limits.rpd) return false;
    if (bucket.rpmTokens < 1) return false;
    if (bucket.tpmTokens < tokens) return false;
    return true;
  }

  private reserve(
    key: GeminiApiKeyRecord,
    bucket: BucketState,
    estimatedTokens: number,
    clientId: string,
    model: string,
  ): GeminiApiLease {
    const tokens = Math.max(1, Math.ceil(estimatedTokens));
    bucket.rpmTokens = Math.max(0, bucket.rpmTokens - 1);
    bucket.tpmTokens = Math.max(0, bucket.tpmTokens - tokens);
    bucket.rpd += 1;
    bucket.active += 1;
    bucket.lastUsedAt = new Date(this.now()).toISOString();
    return { keyId: key.id, model, estimatedTokens: tokens, clientId, record: { ...key } };
  }

  private tryAcquire(
    model: string,
    estimatedTokens: number,
    clientId: string,
  ): GeminiApiLease | null {
    const tokens = Math.max(1, Math.ceil(estimatedTokens));
    if (tokens > this.limits.tpm) {
      // A single request larger than the per-minute token budget can never fit
      // a normal bucket; admit it once rather than rejecting it forever.
      return this.tryAcquireOversize(model, estimatedTokens, clientId);
    }

    const enabled = this.keys.filter((key) => key.enabled);
    if (enabled.length === 0) return null;

    const start = this.roundRobin % enabled.length;
    let best: { key: GeminiApiKeyRecord; bucket: BucketState } | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestIndex = -1;

    for (let offset = 0; offset < enabled.length; offset += 1) {
      const index = (start + offset) % enabled.length;
      const key = enabled[index];
      const bucket = this.bucketFor(key.id, model);
      if (!this.canServe(key, bucket, tokens)) continue;

      const rpmUsed = this.limits.rpm - bucket.rpmTokens;
      const tpmUsed = this.limits.tpm - bucket.tpmTokens;
      const score = rpmUsed / this.limits.rpm + tpmUsed / this.limits.tpm + bucket.rpd / this.limits.rpd;
      if (score < bestScore) {
        best = { key, bucket };
        bestScore = score;
        bestIndex = index;
      }
    }

    if (!best) return null;
    const lease = this.reserve(best.key, best.bucket, tokens, clientId, model);
    this.roundRobin = bestIndex + 1;
    return lease;
  }

  /** Admit one request that is larger than the per-minute TPM budget. */
  private tryAcquireOversize(
    model: string,
    estimatedTokens: number,
    clientId: string,
  ): GeminiApiLease | null {
    const enabled = this.keys.filter((key) => key.enabled);
    const now = this.now();
    for (const key of enabled) {
      const bucket = this.bucketFor(key.id, model);
      if ((this.keyCooldowns.get(key.id) ?? 0) > now) continue;
      if (bucket.cooldownUntil > now) continue;
      if (bucket.active >= this.maxConcurrentPerKey) continue;
      if (bucket.rpd >= this.limits.rpd) continue;
      bucket.rpmTokens = Math.max(0, bucket.rpmTokens - 1);
      bucket.tpmTokens = 0;
      bucket.rpd += 1;
      bucket.active += 1;
      bucket.lastUsedAt = new Date(now).toISOString();
      return {
        keyId: key.id,
        model,
        estimatedTokens: Math.max(1, Math.ceil(estimatedTokens)),
        clientId,
        record: { ...key },
      };
    }
    return null;
  }

  /**
   * Admit a request now, or queue it until a key has capacity.
   * Resolves null when the queue wait expires or the client aborts.
   */
  acquire(
    model: string,
    estimatedTokens: number,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<GeminiApiLease | null> {
    if (signal?.aborted) return Promise.resolve(null);

    const immediate = this.tryAcquire(model, estimatedTokens, clientId);
    if (immediate) return Promise.resolve(immediate);

    // If the next slot is further away than a client should wait (for example a
    // daily quota reset), return immediately instead of burning the full wait.
    if (this.nextAvailabilityMs(model) > Math.max(this.maxWaitMs, 1_000)) {
      return Promise.resolve(null);
    }

    if (this.queueDepth >= this.maxQueueSize) return Promise.resolve(null);

    return new Promise<GeminiApiLease | null>((resolve) => {
      const waiter: Waiter = {
        clientId,
        model,
        estimatedTokens: Math.max(1, Math.ceil(estimatedTokens)),
        enqueuedAt: this.now(),
        resolve,
        timer: null,
        signal,
      };

      if (signal) {
        waiter.onAbort = () => this.removeWaiter(waiter);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      waiter.timer = setTimeout(() => this.removeWaiter(waiter), this.maxWaitMs);
      waiter.timer.unref?.();

      const queue = this.queues.get(clientId) ?? [];
      queue.push(waiter);
      this.queues.set(clientId, queue);
      if (!this.clientOrder.includes(clientId)) this.clientOrder.push(clientId);
      this.queueDepth += 1;
      this.schedulePump();
    });
  }

  private removeWaiter(waiter: Waiter): void {
    const queue = this.queues.get(waiter.clientId);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index === -1) return;
    queue.splice(index, 1);
    this.queueDepth = Math.max(0, this.queueDepth - 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    if (queue.length === 0) {
      this.queues.delete(waiter.clientId);
      this.clientOrder = this.clientOrder.filter((id) => id !== waiter.clientId);
    }
    waiter.resolve(null);
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.disposed || this.pumpTimer || this.queueDepth === 0) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, this.pumpIntervalMs);
    this.pumpTimer.unref?.();
  }

  /** Dispatch queued waiters. Public for the scheduler timer and tests. */
  pump(): void {
    if (this.disposed) return;
    let progressed = true;

    while (progressed && this.queueDepth > 0) {
      progressed = false;
      const clients = this.clientOrder.slice();
      if (clients.length === 0) break;

      for (let step = 0; step < clients.length; step += 1) {
        const clientId = clients[(this.clientIndex + step) % clients.length];
        const queue = this.queues.get(clientId);
        if (!queue || queue.length === 0) continue;
        const waiter = queue[0];
        const lease = this.tryAcquire(waiter.model, waiter.estimatedTokens, clientId);
        if (!lease) continue;

        queue.shift();
        this.queueDepth = Math.max(0, this.queueDepth - 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        if (queue.length === 0) {
          this.queues.delete(clientId);
          this.clientOrder = this.clientOrder.filter((id) => id !== clientId);
        }
        this.clientIndex = (this.clientIndex + step + 1) % Math.max(1, this.clientOrder.length);
        waiter.resolve(lease);
        progressed = true;
      }
    }

    if (this.queueDepth > 0) this.schedulePump();
  }

  /** Complete a lease. Always call this once per acquired lease. */
  settle(lease: GeminiApiLease, options: GeminiApiSettleOptions = {}): void {
    if (lease.settled) return;
    lease.settled = true;

    const bucket = this.bucketFor(lease.keyId, lease.model);
    bucket.active = Math.max(0, bucket.active - 1);

    const actual = Math.max(0, Math.round(options.actualTokens ?? lease.estimatedTokens));
    const refund = lease.estimatedTokens - actual;
    bucket.tpmTokens = Math.min(
      this.limits.tpm,
      Math.max(0, bucket.tpmTokens + refund),
    );
    bucket.tokensToday += actual;

    const now = this.now();
    if (options.cooldownMs && options.cooldownMs > 0) {
      if (options.keyWide) {
        this.keyCooldowns.set(
          lease.keyId,
          Math.max(this.keyCooldowns.get(lease.keyId) ?? 0, now + options.cooldownMs),
        );
      } else {
        bucket.cooldownUntil = Math.max(bucket.cooldownUntil, now + options.cooldownMs);
      }
    }

    this.schedulePump();
  }

  /** Earliest time (ms from now) a model could accept work. */
  nextAvailabilityMs(model: string): number {
    const now = this.now();
    let best = Number.POSITIVE_INFINITY;
    for (const key of this.keys) {
      if (!key.enabled) continue;
      const keyCooldown = (this.keyCooldowns.get(key.id) ?? 0) - now;
      if (keyCooldown > 0) {
        best = Math.min(best, keyCooldown);
        continue;
      }
      const bucket = this.bucketFor(key.id, model);
      const cooldown = bucket.cooldownUntil - now;
      if (cooldown > 0) {
        best = Math.min(best, cooldown);
        continue;
      }
      if (bucket.active >= this.maxConcurrentPerKey) {
        // A concurrency slot can free at any moment; queue instead of failing.
        best = 0;
        continue;
      }
      if (bucket.rpd >= this.limits.rpd) continue;
      this.refill(bucket, now);
      const rpmWait = bucket.rpmTokens >= 1 ? 0 : ((1 - bucket.rpmTokens) * 60_000) / this.limits.rpm;
      best = Math.min(best, rpmWait);
    }
    return Math.max(1000, Math.ceil(Number.isFinite(best) ? best : 60_000));
  }

  /** Stop timers (tests/shutdown). */
  dispose(): void {
    this.disposed = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    for (const queue of this.queues.values()) {
      for (const waiter of queue) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.queues.clear();
    this.clientOrder = [];
    this.queueDepth = 0;
  }

  /** Persisted per-key/model usage so dashboard counters survive a restart. */
  exportUsageState(): GeminiApiUsageState {
    const now = this.now();
    const keys: GeminiApiUsageState['keys'] = {};

    for (const key of this.keys) {
      const models: GeminiApiUsageState['keys'][string]['models'] = {};
      for (const model of GEMINI_API_MODELS) {
        const bucket = this.bucketFor(key.id, model);
        const cooling = bucket.cooldownUntil > now;
        if (bucket.rpd === 0 && bucket.tokensToday === 0 && !cooling && !bucket.lastUsedAt) {
          continue;
        }
        models[model] = {
          dayKey: bucket.dayKey,
          rpd: bucket.rpd,
          tokensToday: bucket.tokensToday,
          ...(cooling ? { cooldownUntil: bucket.cooldownUntil } : {}),
          ...(bucket.lastUsedAt ? { lastUsedAt: bucket.lastUsedAt } : {}),
        };
      }
      const keyCooldown = this.keyCooldowns.get(key.id) ?? 0;
      if (Object.keys(models).length > 0 || keyCooldown > now) {
        keys[key.id] = {
          models,
          ...(keyCooldown > now ? { keyCooldownUntil: keyCooldown } : {}),
        };
      }
    }

    return { savedAt: new Date(now).toISOString(), keys };
  }

  /** Restore counters and cooldowns saved by `exportUsageState`. */
  hydrateUsageState(state: GeminiApiUsageState | null | undefined): void {
    if (!state || typeof state !== 'object' || !state.keys) return;
    const now = this.now();
    const today = utcDay(now);
    const known = new Set(this.keys.map((key) => key.id));

    for (const [keyId, entry] of Object.entries(state.keys)) {
      if (!known.has(keyId) || !entry || typeof entry !== 'object') continue;

      if (Number.isFinite(entry.keyCooldownUntil) && (entry.keyCooldownUntil ?? 0) > now) {
        this.keyCooldowns.set(keyId, entry.keyCooldownUntil as number);
      }

      for (const [model, saved] of Object.entries(entry.models || {})) {
        if (!(GEMINI_API_MODELS as readonly string[]).includes(model)) continue;
        if (!saved || typeof saved !== 'object') continue;
        const bucket = this.bucketFor(keyId, model);
        if (saved.dayKey === today) {
          bucket.rpd = Math.max(0, Number(saved.rpd) || 0);
          bucket.tokensToday = Math.max(0, Number(saved.tokensToday) || 0);
        }
        if (Number.isFinite(saved.cooldownUntil) && (saved.cooldownUntil ?? 0) > now) {
          bucket.cooldownUntil = Math.max(bucket.cooldownUntil, saved.cooldownUntil as number);
        }
        if (typeof saved.lastUsedAt === 'string') bucket.lastUsedAt = saved.lastUsedAt;
      }
    }
  }

  snapshot(): GeminiApiKeyPublic[] {
    const now = this.now();
    return this.keys.map((key) => {
      const models: Record<string, GeminiApiBucketSnapshot> = {};
      let requestsToday = 0;
      let tokensToday = 0;
      let rpm = 0;
      let tpm = 0;
      let active = 0;
      let cooldownUntil = 0;
      let lastUsedAt = key.lastUsedAt;

      for (const model of GEMINI_API_MODELS) {
        const bucket = this.bucketFor(key.id, model);
        this.refill(bucket, now);
        const rpmUsed = Math.max(0, this.limits.rpm - bucket.rpmTokens);
        const tpmUsed = Math.max(0, this.limits.tpm - bucket.tpmTokens);
        models[model] = {
          rpm: Math.round(rpmUsed),
          tpm: Math.round(tpmUsed),
          rpd: bucket.rpd,
          limitRpm: this.limits.rpm,
          limitTpm: this.limits.tpm,
          limitRpd: this.limits.rpd,
          active: bucket.active,
          cooldownUntil: bucket.cooldownUntil > now ? bucket.cooldownUntil : null,
        };
        requestsToday += bucket.rpd;
        tokensToday += bucket.tokensToday;
        rpm += rpmUsed;
        tpm += tpmUsed;
        active += bucket.active;
        cooldownUntil = Math.max(cooldownUntil, bucket.cooldownUntil);
        if (bucket.lastUsedAt) lastUsedAt = bucket.lastUsedAt;
      }

      const keyCooldown = this.keyCooldowns.get(key.id) ?? 0;
      cooldownUntil = Math.max(cooldownUntil, keyCooldown);

      return {
        id: key.id,
        label: key.label,
        maskedKey: maskApiKey(key.key),
        enabled: key.enabled,
        createdAt: key.createdAt,
        lastUsedAt,
        usage: {
          requestsToday,
          tokensToday,
          rpm: Math.round(rpm),
          tpm: Math.round(tpm),
          active,
          cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
          lastUsedAt,
        },
        models,
      };
    });
  }
}