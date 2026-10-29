/**
 * Public, unauthenticated API client for the marketing site.
 *
 * Only the /api/public/* endpoints are used here. They expose aggregates and
 * model ids — never account identities, quota detail or traffic contents.
 */

export interface PublicStats {
  online: boolean;
  uptimeSeconds: number;
  accountsConnected: number;
  accountsTotal: number;
  requestsServed: number;
  tokensServed: number;
  averageLatencyMs: number | null;
  successRate: number | null;
  version: string;
}

export interface PublicModel {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  maxOutputTokens: number;
}

export interface PublicModelsResponse {
  source: 'gateway' | 'catalog';
  online: boolean;
  models: PublicModel[];
}

async function getJson<T>(path: string, timeoutMs = 6000): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(path, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const publicApi = {
  getStats: () => getJson<PublicStats>('/api/public/stats'),
  getModels: async (): Promise<PublicModelsResponse> => {
    const res = await getJson<PublicModelsResponse>('/api/public/models');
    return res ?? { source: 'catalog', online: false, models: [] };
  },
};
