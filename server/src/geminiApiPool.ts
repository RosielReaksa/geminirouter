import type { GeminiApiKeyRecord } from './store.js';

/** Models served by AI Studio keys for now. Others stay on the account pool. */
export const GEMINI_API_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'] as const;
export type GeminiApiModel = (typeof GEMINI_API_MODELS)[number];

export interface GeminiApiLimits {
  rpm: number;
  tpm: number;
  rpd: number;
}

export interface GeminiApiUsageSnapshot {
  requestsToday: number;
  tokensToday: number;
  rpm: number;
  tpm: number;
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
}

export interface GeminiApiLease {
  record: GeminiApiKeyRecord;
  estimatedTokens: number;
}

interface UsageState {
  minuteKey: number;
  rpm: number;
  tpm: number;
  dayKey: string;
  rpd: number;
  tokensToday: number;
  cooldownUntil: number;
  lastUsedAt?: string;
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per-key free-tier limits shown by AI Studio (15 RPM / 250K TPM / 500 RPD). */
export const DEFAULT_GEMINI_API_LIMITS: GeminiApiLimits = {
  rpm: intFromEnv('GEMINI_API_RPM', 15),
  tpm: intFromEnv('GEMINI_API_TPM', 250_000),
  rpd: intFromEnv('GEMINI_API_RPD', 500),
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

  const maxOut =
    Number(body?.max_completion_tokens) ||
    Number(body?.max_tokens) ||
    1024;

  return Math.max(1, Math.ceil(characters / 4) + Math.min(Math.max(maxOut, 1), 65_536));
}

/** Mask a secret for the dashboard: first four and last four characters. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export class GeminiApiPool {
  private keys: GeminiApiKeyRecord[] = [];
  private usage = new Map<string, UsageState>();
  private roundRobin = 0;
  private limits: GeminiApiLimits;

  constructor(keys: GeminiApiKeyRecord[] = [], limits: Partial<GeminiApiLimits> = {}) {
    this.limits = { ...DEFAULT_GEMINI_API_LIMITS, ...limits };
    this.setKeys(keys);
  }

  setKeys(keys: GeminiApiKeyRecord[]): void {
    this.keys = keys
      .filter((key) => key && typeof key.id === 'string' && typeof key.key === 'string' && key.key)
      .map((key) => ({ ...key }));
    // Drop usage for keys that no longer exist so the map cannot grow forever.
    const live = new Set(this.keys.map((key) => key.id));
    for (const id of [...this.usage.keys()]) {
      if (!live.has(id)) this.usage.delete(id);
    }
  }

  hasEnabledKeys(): boolean {
    return this.keys.some((key) => key.enabled);
  }

  getLimits(): GeminiApiLimits {
    return { ...this.limits };
  }

  private stateFor(id: string): UsageState {
    const now = Date.now();
    const minuteKey = Math.floor(now / 60_000);
    const dayKey = new Date(now).toISOString().slice(0, 10);

    let state = this.usage.get(id);
    if (!state) {
      state = {
        minuteKey,
        rpm: 0,
        tpm: 0,
        dayKey,
        rpd: 0,
        tokensToday: 0,
        cooldownUntil: 0,
      };
      this.usage.set(id, state);
    }

    if (state.minuteKey !== minuteKey) {
      state.minuteKey = minuteKey;
      state.rpm = 0;
      state.tpm = 0;
    }
    if (state.dayKey !== dayKey) {
      state.dayKey = dayKey;
      state.rpd = 0;
      state.tokensToday = 0;
    }
    return state;
  }

  /**
   * Pick a key with capacity for one more request. Counts the request and the
   * estimated tokens immediately so concurrent callers cannot oversubscribe the
   * same key. Returns null when every enabled key is at a limit or cooling down.
   */
  acquire(estimatedTokens: number): GeminiApiLease | null {
    const estimate = Math.max(1, Math.ceil(estimatedTokens));
    const now = Date.now();
    const enabled = this.keys.filter((key) => key.enabled);
    if (enabled.length === 0) return null;

    const start = this.roundRobin % enabled.length;
    let best: GeminiApiKeyRecord | null = null;
    let bestState: UsageState | null = null;
    let bestIndex = -1;

    for (let offset = 0; offset < enabled.length; offset += 1) {
      const index = (start + offset) % enabled.length;
      const key = enabled[index];
      const state = this.stateFor(key.id);
      if (state.cooldownUntil > now) continue;
      if (state.rpm >= this.limits.rpm) continue;
      if (state.rpd >= this.limits.rpd) continue;
      if (state.tpm + estimate > this.limits.tpm) continue;

      if (
        bestState === null ||
        state.rpd < bestState.rpd ||
        (state.rpd === bestState.rpd && state.rpm < bestState.rpm)
      ) {
        best = key;
        bestState = state;
        bestIndex = index;
      }
    }

    if (!best || !bestState) return null;

    bestState.rpm += 1;
    bestState.rpd += 1;
    bestState.tpm += estimate;
    bestState.lastUsedAt = new Date(now).toISOString();
    this.roundRobin = bestIndex + 1;

    return { record: best, estimatedTokens: estimate };
  }

  /** Reconcile the token estimate with the actual usage reported by Google. */
  recordTokens(id: string, actualTokens: number, estimatedTokens: number): void {
    const actual = Number.isFinite(actualTokens) && actualTokens > 0 ? Math.round(actualTokens) : 0;
    const estimate = Math.max(1, Math.ceil(estimatedTokens));
    const state = this.stateFor(id);
    state.tpm = Math.max(0, state.tpm + actual - estimate);
    state.tokensToday += actual > 0 ? actual : estimate;
  }

  /** Bench a key after a 429 (or a transient 5xx). */
  markCooldown(id: string, cooldownMs: number): void {
    const state = this.stateFor(id);
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + Math.max(0, cooldownMs));
  }

  /** Snapshot for the dashboard. Keys are masked here, never returned raw. */
  snapshot(): GeminiApiKeyPublic[] {
    const now = Date.now();
    return this.keys.map((key) => {
      const state = this.stateFor(key.id);
      return {
        id: key.id,
        label: key.label,
        maskedKey: maskApiKey(key.key),
        enabled: key.enabled,
        createdAt: key.createdAt,
        lastUsedAt: state.lastUsedAt ?? key.lastUsedAt,
        usage: {
          requestsToday: state.rpd,
          tokensToday: state.tokensToday,
          rpm: state.rpm,
          tpm: state.tpm,
          cooldownUntil: state.cooldownUntil > now ? state.cooldownUntil : null,
          lastUsedAt: state.lastUsedAt ?? key.lastUsedAt,
        },
      };
    });
  }
}