/**
 * Canonical model IDs exposed by the gateway.
 *
 * The upstream core still advertises `gemini-3.8-flash-tiered`, an alias we no
 * longer use. Every surface rewrites it to `gemini-3.8-flash-high` so listings,
 * dashboard quotas, traffic records and test results never mention it. Other
 * Gemini 3.8 variants (`...-high`, `...-low`) are real models and pass through
 * untouched.
 */
export const MODEL_ID_REPLACEMENTS: Readonly<Record<string, string>> = {
  'gemini-3.8-flash-tiered': 'gemini-3.8-flash-high',
};

/** IDs that must never be shown to or accepted from clients. */
export const RETIRED_MODEL_IDS: ReadonlySet<string> = new Set(Object.keys(MODEL_ID_REPLACEMENTS));

/** Map one retired id to the id the gateway exposes. */
export function canonicalModelId(model: string): string {
  return MODEL_ID_REPLACEMENTS[model] ?? model;
}

/** True for Gemini-family model ids only (no Claude, GPT, OSS or Gemma). */
export function isGeminiModelId(id: string): boolean {
  return /^gemini(?:[-.]|$)/i.test(id.trim());
}

/** Map and de-duplicate a list of model IDs, preserving the first occurrence. */
export function canonicalizeModelIds(ids: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const canonical = canonicalModelId(id);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}

/**
 * Rewrite a `/v1/models` list in place-equivalent form: retired aliases are
 * renamed, duplicate entries (for example tiered + high) collapse to one, and
 * unknown shapes pass through untouched.
 */
export function canonicalizeModelEntries<T extends { id?: unknown }>(entries: T[]): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      result.push(entry);
      continue;
    }

    const canonical = canonicalModelId(entry.id);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical === entry.id ? entry : ({ ...entry, id: canonical } as T));
  }
  return result;
}

/**
 * Model ids that the website dropdown may offer even when the core omits them
 * from `/v1/models`. Every entry was verified against the live gateway with a
 * real chat completion before being added; ids whose pool answered 503 (for
 * example the bare `claude-haiku-4-5` alias) are deliberately absent.
 *
 * These are website-only aliases: `/v1/models` still mirrors the core list, so
 * public API clients keep the exact catalogue the core advertises.
 */
export const VERIFIED_WEBSITE_MODEL_IDS: readonly string[] = [
  // Aliases the gateway accepts but sometimes omits from its own listing.
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-image',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash-high',
  // Claude models the core knows and serves but does not list.
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking',
  'claude-opus-4-5-thinking',
  'claude-haiku-4-5-20251001',
];

/**
 * Model ids that the website must not offer right now.
 *
 * Every id here was probed twice against the live bridge and answered
 * `503 All accounts failed or unhealthy` on both attempts while the other
 * models served normal chat completions. They are core-advertised ids whose
 * backing pool has no healthy account, so listing them only produces a failing
 * dropdown entry.
 *
 * This is a probe-derived snapshot, not a permanent fact: re-probe before
 * removing an id from the set, and delete it from the set once it answers 200
 * again. `/v1/models` is unaffected, so API clients still see the core list.
 */
export const UNAVAILABLE_WEBSITE_MODEL_IDS: ReadonlySet<string> = new Set([
  'gemini-3-flash',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-medium',
  'gemini-3.6-flash',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-low',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-tiered',
  'gemini-3.7-flash',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-tiered',
]);

/** True when the website should hide this id (canonical form is checked). */
export function isUnavailableWebsiteModel(id: string): boolean {
  return UNAVAILABLE_WEBSITE_MODEL_IDS.has(canonicalModelId(id));
}

/**
 * Merge the core's live listing with the verified website aliases, then drop
 * ids whose pool is currently unhealthy. Core order is preserved, aliases are
 * appended, retired ids are rewritten and duplicates collapse, so the website
 * dropdown and the Models page show one canonical list of working models.
 */
export function includeVerifiedWebsiteModels(gatewayIds: string[]): string[] {
  return canonicalizeModelIds([...gatewayIds, ...VERIFIED_WEBSITE_MODEL_IDS])
    .filter((id) => !isUnavailableWebsiteModel(id));
}
