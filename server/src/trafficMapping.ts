import type { GoogleAccount, TrafficRecord } from './store.js';
import { canonicalModelId } from './modelIds.js';

const DEFAULT_STALE_IN_PROGRESS_MS = 300_000;

/**
 * Map the core's audit rows onto the dashboard's traffic records.
 *
 * The core reports the model it actually ran, which can still be a retired
 * alias (`gemini-3.8-flash-tiered`) even when the client asked for the
 * canonical id. Both the requested and routed names are canonicalised so the
 * dashboard never shows an id the gateway no longer exposes.
 */
export function mapCoreTrafficItems(
  items: any[],
  accounts: GoogleAccount[],
  staleInProgressMs: number = DEFAULT_STALE_IN_PROGRESS_MS,
): TrafficRecord[] {
  const emailsByAccountId = new Map(accounts.map((account) => [account.id, account.email]));

  return items.map((item: any) => {
    const routedModel = item.mappedModel || item.physicalModel || item.model || 'unknown';
    const promptTokens = item.inputTokens ?? 0;
    const completionTokens = item.outputTokens ?? 0;
    const cachedTokens = item.cachedTokens ?? item.cached_tokens ?? 0;
    const reasoningTokens = item.reasoningTokens ?? item.reasoning_tokens ?? 0;
    const timestampMs =
      typeof item.timestamp === 'number' ? item.timestamp : Date.parse(item.timestamp);
    const stale =
      item.outcome === 'in_progress' &&
      Number.isFinite(timestampMs) &&
      Date.now() - timestampMs > staleInProgressMs;

    return {
      id: item.id,
      timestamp: new Date(timestampMs).toISOString(),
      clientName: item.clientName || item.userAgent || item.protocol || 'HTTP Client',
      clientIp: item.clientIp || '127.0.0.1',
      modelRequested: canonicalModelId(item.model || routedModel),
      modelRouted: canonicalModelId(routedModel),
      backingAccountEmail:
        emailsByAccountId.get(item.attributedAccountId) || item.attributedAccountId || 'unknown',
      status: stale ? 0 : item.status ?? 0,
      outcome: stale ? 'aborted' : item.outcome ?? undefined,
      latencyMs: item.durationMs ?? 0,
      promptTokens,
      completionTokens,
      cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
      reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
      totalTokens: promptTokens + completionTokens,
    };
  });
}
