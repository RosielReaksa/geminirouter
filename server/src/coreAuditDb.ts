import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface CacheStatRow {
  model: string;
  family: 'gemini' | 'claude' | 'gpt';
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requestsWithCache: number;
  hitRate: number; // 0-100
}

export interface CacheFamilyStats {
  family: 'gemini' | 'claude' | 'gpt';
  label: string;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requestsWithCache: number;
  hitRate: number; // 0-100
}

export interface CacheStats {
  totalRequests: number;
  totalInputTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  requestsWithCache: number;
  overallHitRate: number; // 0-100
  byModel: CacheStatRow[];
  byFamily: CacheFamilyStats[];
}

type FamilyKey = 'gemini' | 'claude' | 'gpt';

function modelFamily(id: string): FamilyKey {
  const lower = id.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('gpt') || lower.includes('oss')) return 'gpt';
  return 'gemini';
}

function familyLabel(family: FamilyKey): string {
  return family === 'gemini'
    ? 'Google Gemini'
    : family === 'claude'
      ? 'Anthropic Claude'
      : 'OpenAI-compatible';
}

export function coreAuditDbPath(): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(homeDir, '.antigravity-agent', 'proxy-state', 'request-audit.db');
}

export class CoreAuditDb {
  private dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || coreAuditDbPath();
  }

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    try {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      return this.db;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* best effort */ }
      this.db = null;
    }
  }

  /**
   * Read cache (prompt-token caching) stats from the core audit SQLite DB.
   * Falls back gracefully to null when the DB is missing, locked, or unreadable.
   * Never throws — callers should handle null.
   */
  getCacheStats(from?: number, to?: number): CacheStats | null {
    const db = this.open();
    if (!db) return null;

    try {
      // Build named parameters so node:sqlite accepts them without array-type issues.
      const namedParams: Record<string, string | number> = { trafficClass: 'model' };
      let where = 'WHERE traffic_class = :trafficClass';
      if (Number.isFinite(from)) {
        where += ' AND timestamp >= :from';
        namedParams.from = from as number;
      }
      if (Number.isFinite(to)) {
        where += ' AND timestamp < :to';
        namedParams.to = to as number;
      }

      const rows = db.prepare(`
        SELECT
          model,
          COUNT(*) as requests,
          SUM(COALESCE(input_tokens, 0)) as input_tokens,
          SUM(COALESCE(cached_tokens, 0)) as cached_tokens,
          SUM(COALESCE(output_tokens, 0)) as output_tokens,
          SUM(COALESCE(reasoning_tokens, 0)) as reasoning_tokens,
          SUM(CASE WHEN cached_tokens > 0 THEN 1 ELSE 0 END) as requests_with_cache
        FROM request_logs
        ${where}
        GROUP BY model
        ORDER BY input_tokens DESC
      `).all(namedParams) as Array<{
        model: string;
        requests: number;
        input_tokens: number;
        cached_tokens: number;
        output_tokens: number;
        reasoning_tokens: number;
        requests_with_cache: number;
      }>;

      const byModel: CacheStatRow[] = [];
      const familyTotals: Record<FamilyKey, {
        requests: number;
        inputTokens: number;
        cachedTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        requestsWithCache: number;
      }> = {
        gemini: { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, requestsWithCache: 0 },
        claude: { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, requestsWithCache: 0 },
        gpt: { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, requestsWithCache: 0 },
      };

      let totalRequests = 0;
      let totalInputTokens = 0;
      let totalCachedTokens = 0;
      let totalOutputTokens = 0;
      let totalReasoningTokens = 0;
      let totalRequestsWithCache = 0;

      for (const r of rows) {
        const input = Number(r.input_tokens) || 0;
        const cached = Number(r.cached_tokens) || 0;
        const output = Number(r.output_tokens) || 0;
        const reasoning = Number(r.reasoning_tokens) || 0;
        const requests = Number(r.requests) || 0;
        const requestsWithCache = Number(r.requests_with_cache) || 0;
        const hitRate = input > 0 ? Math.round((cached / input) * 10000) / 100 : 0;
        const family = modelFamily(r.model || 'unknown');

        byModel.push({
          model: r.model || 'unknown',
          family,
          requests,
          inputTokens: input,
          cachedTokens: cached,
          outputTokens: output,
          reasoningTokens: reasoning,
          requestsWithCache,
          hitRate,
        });

        const ft = familyTotals[family];
        ft.requests += requests;
        ft.inputTokens += input;
        ft.cachedTokens += cached;
        ft.outputTokens += output;
        ft.reasoningTokens += reasoning;
        ft.requestsWithCache += requestsWithCache;

        totalRequests += requests;
        totalInputTokens += input;
        totalCachedTokens += cached;
        totalOutputTokens += output;
        totalReasoningTokens += reasoning;
        totalRequestsWithCache += requestsWithCache;
      }

      const familyKeys: FamilyKey[] = ['gemini', 'claude', 'gpt'];
      const byFamily: CacheFamilyStats[] = familyKeys.map((family) => {
        const t = familyTotals[family];
        const hitRate = t.inputTokens > 0 ? Math.round((t.cachedTokens / t.inputTokens) * 10000) / 100 : 0;
        return {
          family,
          label: familyLabel(family),
          requests: t.requests,
          inputTokens: t.inputTokens,
          cachedTokens: t.cachedTokens,
          outputTokens: t.outputTokens,
          reasoningTokens: t.reasoningTokens,
          requestsWithCache: t.requestsWithCache,
          hitRate,
        };
      }).filter((f) => f.requests > 0 || f.inputTokens > 0);

      const overallHitRate = totalInputTokens > 0 ? Math.round((totalCachedTokens / totalInputTokens) * 10000) / 100 : 0;

      return {
        totalRequests,
        totalInputTokens,
        totalCachedTokens,
        totalOutputTokens,
        totalReasoningTokens,
        requestsWithCache: totalRequestsWithCache,
        overallHitRate,
        byModel,
        byFamily,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve the named gateway key used for core audit records. The bridge
   * injects `x-geminirouter-key-id` before forwarding; the core stores all
   * request headers as JSON, so the Traffic page can attribute account calls to
   * the client key that made them.
   */
  getGatewayKeyIds(recordIds: string[]): Map<string, string> {
    const result = new Map<string, string>();
    const ids = [...new Set(recordIds.filter((id) => typeof id === 'string' && id))];
    if (ids.length === 0) return result;

    const db = this.open();
    if (!db) return result;

    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, request_headers FROM request_logs WHERE id IN (${placeholders})`)
        .all(...ids) as Array<{ id: string; request_headers: string | null }>;

      for (const row of rows) {
        if (!row.request_headers) continue;
        try {
          const headers = JSON.parse(row.request_headers);
          const keyId = headers?.['x-geminirouter-key-id'];
          if (typeof keyId === 'string' && keyId) result.set(row.id, keyId);
        } catch {
          // Ignore malformed header JSON.
        }
      }
    } catch {
      // Missing table/columns on older cores: attribution simply stays blank.
    }
    return result;
  }
}

// Singleton reused across requests (read-only handle is safe to keep open).
let _sharedDb: CoreAuditDb | null = null;

export function getSharedCoreAuditDb(dbPath?: string): CoreAuditDb {
  if (!_sharedDb) _sharedDb = new CoreAuditDb(dbPath);
  return _sharedDb;
}
