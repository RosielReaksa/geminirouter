import type { GoogleAccount } from './store.js';

/**
 * Quota-aware eligibility for the bridge's own account selection.
 *
 * The core already tracks quotas and normally avoids exhausted accounts, but
 * the bridge must not rely on that when it owns the request path (and tests /
 * other cores do not implement the same scheduler). These helpers read the
 * quota snapshot the core publishes and decide whether an account may serve a
 * model right now.
 *
 * Two rules matter:
 *  - A window at 0% blocks the account only for its own model family
 *    (Gemini vs Claude/GPT), so a burned Gemini window does not starve Claude.
 *  - A window whose resetTime has passed is available again. This is how an
 *    account returns to rotation automatically without manual intervention.
 */

export type QuotaFamily = 'gemini' | 'claude-gpt';

interface QuotaBucketLike {
  bucketId?: string;
  bucket_id?: string;
  remainingFraction?: number;
  remaining_fraction?: number;
  resetTime?: string;
  reset_time?: string;
}

interface QuotaGroupLike {
  displayName?: string;
  display_name?: string;
  buckets?: QuotaBucketLike[];
}

export interface AccountQuotaLike {
  quotaGroups?: QuotaGroupLike[];
  models5h?: Array<{ name: string; reset: string; percentage: number }>;
  quotas?: Array<{
    modelId?: string;
    modelName?: string;
    requestsIn5h?: number;
    limitIn5h?: number;
    resetTime5h?: string;
    isThrottled?: boolean;
  }>;
}

export interface QuotaExhaustion {
  exhausted: boolean;
  /** Human-readable quota group that is exhausted, when known. */
  group?: string;
  /** Bucket id (for example gemini-weekly or gemini-5h). */
  bucket?: string;
  /** When the exhausted window resets. */
  resetAt?: string;
  /** Remaining fraction reported by the core (0 when exhausted). */
  remainingFraction?: number;
}

const normalizeName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Claude, GPT-OSS and other third-party models share the "3p" quota group. */
export function quotaFamilyForModel(model?: string): QuotaFamily {
  const value = (model || '').toLowerCase();
  return /(claude|sonnet|opus|gpt|oss|3p)/.test(value) ? 'claude-gpt' : 'gemini';
}

function findGroup(
  account: AccountQuotaLike,
  family: QuotaFamily,
): QuotaGroupLike | undefined {
  const groups = Array.isArray(account.quotaGroups) ? account.quotaGroups : [];
  return groups.find((group) => {
    const name = String(group?.displayName ?? group?.display_name ?? '').toLowerCase();
    return family === 'gemini' ? name.includes('gemini') : /claude|gpt|3p/.test(name);
  });
}

function readFraction(bucket: QuotaBucketLike): number | undefined {
  const raw = bucket.remainingFraction ?? bucket.remaining_fraction;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function resetIsInTheFuture(resetAt: string | undefined, now: number): boolean {
  if (!resetAt) return true; // No reset time: assume the window still applies.
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return true;
  return resetMs > now;
}

/**
 * Returns the exhausted window that blocks this model, or { exhausted: false }.
 * The account may still be usable for the other quota family.
 */
export function findQuotaExhaustion(
  account: AccountQuotaLike,
  model?: string,
  now: number = Date.now(),
): QuotaExhaustion {
  const family = quotaFamilyForModel(model);

  const group = findGroup(account, family);
  if (group) {
    for (const bucket of group.buckets ?? []) {
      const fraction = readFraction(bucket);
      if (fraction === undefined || fraction > 0) continue;
      const resetAt = bucket.resetTime ?? bucket.reset_time;
      if (!resetIsInTheFuture(resetAt, now)) continue; // Window rolled over.
      return {
        exhausted: true,
        group: group.displayName ?? group.display_name,
        bucket: bucket.bucketId ?? bucket.bucket_id,
        resetAt,
        remainingFraction: 0,
      };
    }
  }

  // Per-model 5h view. The core exposes display names ("Gemini 3.5 Flash Lite"),
  // so match on a normalized name rather than the request id.
  const wanted = normalizeName(model || '');
  if (wanted) {
    for (const entry of account.models5h ?? []) {
      if (Number(entry.percentage) > 0) continue;
      if (normalizeName(entry.name) !== wanted) continue;
      if (!resetIsInTheFuture(entry.reset, now)) continue;
      return {
        exhausted: true,
        group: family === 'gemini' ? 'Gemini Models' : 'Claude and GPT models',
        bucket: 'model-5h',
        resetAt: entry.reset,
        remainingFraction: 0,
      };
    }
  }

  // Older cores only publish the compact per-model quota list.
  if (!group && (!account.models5h || account.models5h.length === 0)) {
    for (const quota of account.quotas ?? []) {
      const limit = Number(quota.limitIn5h ?? 0);
      const used = Number(quota.requestsIn5h ?? 0);
      if (!Number.isFinite(limit) || limit <= 0 || used < limit) continue;
      if (!resetIsInTheFuture(quota.resetTime5h, now)) continue;
      return {
        exhausted: true,
        group: '5h model quota',
        bucket: quota.modelId ?? quota.modelName,
        resetAt: quota.resetTime5h,
        remainingFraction: 0,
      };
    }
  }

  return { exhausted: false };
}

/**
 * Remaining quota for tie-breaking. Uses the limiting bucket in the model's
 * family (weekly or 5h), so a nearly burned weekly window makes the account a
 * lower priority even before it reaches 0%.
 */
export function remainingQuotaPercent(
  account: AccountQuotaLike,
  model?: string,
): number {
  const family = quotaFamilyForModel(model);
  const group = findGroup(account, family);
  if (group) {
    const fractions = (group.buckets ?? [])
      .map(readFraction)
      .filter((value): value is number => value !== undefined);
    if (fractions.length > 0) {
      return Math.max(0, Math.min(...fractions)) * 100;
    }
  }

  const quotas = account.quotas ?? [];
  if (quotas.length === 0) return 100;
  if (model) {
    const match = quotas.find(
      (quota) => quota.modelId === model || quota.modelName === model,
    );
    if (match) {
      const limit = Number(match.limitIn5h ?? 0);
      const used = Number(match.requestsIn5h ?? 0);
      return limit > 0 ? Math.max(0, (limit - used) / limit) * 100 : 0;
    }
  }
  let total = 0;
  for (const quota of quotas) {
    const limit = Number(quota.limitIn5h ?? 0);
    const used = Number(quota.requestsIn5h ?? 0);
    total += limit > 0 ? Math.max(0, (limit - used) / limit) * 100 : 0;
  }
  return total / quotas.length;
}

/** Convenience wrapper used by selection code. */
export function isAccountQuotaExhausted(
  account: GoogleAccount,
  model?: string,
  now: number = Date.now(),
): boolean {
  return findQuotaExhaustion(account, model, now).exhausted;
}