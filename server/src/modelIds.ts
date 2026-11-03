/**
 * Canonical model IDs exposed by the gateway.
 *
 * The upstream core still advertises several aliases for the same Gemini 3.8
 * Flash model. The gateway exposes exactly one of them (`...-high`) so that
 * listings, dashboard quotas, traffic records and test results never disagree
 * about which model ran.
 */
export const MODEL_ID_REPLACEMENTS: Readonly<Record<string, string>> = {
  'gemini-3.8-flash-tiered': 'gemini-3.8-flash-high',
  'gemini-3.8-flash-low': 'gemini-3.8-flash-high',
};

/** IDs that must never be shown to or accepted from clients. */
export const RETIRED_MODEL_IDS: ReadonlySet<string> = new Set(Object.keys(MODEL_ID_REPLACEMENTS));

/** Map one alias to the single ID the gateway exposes. */
export function canonicalModelId(model: string): string {
  return MODEL_ID_REPLACEMENTS[model] ?? model;
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
 * Rewrite a `/v1/models` list in place-equivalent form: aliases are renamed,
 * duplicate entries (for example tiered + high) collapse to one, and unknown
 * shapes pass through untouched.
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
