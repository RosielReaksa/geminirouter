import axios from 'axios';
import type { CoreClient } from './coreClient.js';
import type { LocalStateStore, GoogleAccount, ModelAvailabilityResult } from './store.js';

export interface AccountTestResult {
  accountId: string;
  email: string;
  ok: boolean;
  requiresValidation: boolean;
  validationUrl?: string;
  model: string;
  latencyMs: number;
  httpStatus?: number;
  sample?: string;
  error?: string;
  timestamp: string;
}

export function summarizeModelAccountTests(
  model: string,
  results: AccountTestResult[],
): ModelAvailabilityResult {
  const workingAccounts = results.filter((result) => result.ok).length;
  const allExpired = results.length > 0 && results.every((result) =>
    result.httpStatus === 404 || result.httpStatus === 410 ||
    /model (was )?(not found|expired|deprecated)|unknown model/i.test(result.error || ''),
  );
  const allNeedVerification = results.length > 0 && results.every((result) => result.requiresValidation);
  const status = workingAccounts > 0
    ? 'working'
    : allExpired
    ? 'expired'
    : allNeedVerification
    ? 'needs_verification'
    : 'temporarily_unavailable';
  const firstFailure = results.find((result) => !result.ok);

  return {
    model,
    ok: workingAccounts > 0,
    status,
    checkedAccounts: results.length,
    workingAccounts,
    latencyMs: results.length
      ? Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / results.length)
      : 0,
    httpStatus: firstFailure?.httpStatus,
    error: workingAccounts > 0 ? undefined : firstFailure?.error,
    checkedAt: new Date().toISOString(),
  };
}

export class AccountTester {
  private lastResults = new Map<string, AccountTestResult>();
  private freshValidationUrls = new Map<string, { url: string; timestamp: number }>();
  private validationRequiredAccounts = new Set<string>();
  private autoTestTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly coreClient: CoreClient,
    private readonly store: LocalStateStore,
    private readonly resolveGateway: () => { port: number; apiKey: string }
  ) {}

  isValidationRequired(accountId: string): boolean {
    return this.validationRequiredAccounts.has(accountId);
  }

  getLastResult(accountId: string): AccountTestResult | undefined {
    return this.lastResults.get(accountId);
  }

  getAllLastResults(): Record<string, AccountTestResult> {
    const res: Record<string, AccountTestResult> = {};
    for (const [id, r] of this.lastResults.entries()) {
      res[id] = r;
    }
    return res;
  }

  /**
   * Test an account by making a live model call targeting that exact account (x-account-id).
   * Detects if Google requires account verification (403 VALIDATION_REQUIRED) and extracts
   * the brand-new fresh validation URL directly from Google's response!
   */
  async testAndRefreshAccount(
    account: GoogleAccount,
    model: string = 'gemini-3.8-flash-low',
    refreshQuota = true,
  ): Promise<AccountTestResult> {
    const { port, apiKey } = this.resolveGateway();
    const startedAt = Date.now();

    let ok = false;
    let requiresValidation = false;
    let freshValidationUrl: string | undefined;
    let sample: string | undefined;
    let error: string | undefined;
    let httpStatus: number | undefined;

    try {
      const response = await axios.post(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply: ok' }],
        },
        {
          timeout: 25000,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'x-account-id': account.id,
            'x-single-account': 'true', // Test ONLY this account, do not failover!
          },
        }
      );

      sample =
        response.data?.choices?.[0]?.message?.content?.toString().trim() || 'ok';
      ok = response.status === 200;
      httpStatus = response.status;

      // If test call succeeded, clear any previous validation requirement
      this.validationRequiredAccounts.delete(account.id);
      this.freshValidationUrls.delete(account.id);
    } catch (err: any) {
      ok = false;
      const status = err?.response?.status;
      httpStatus = status;
      const data = err?.response?.data;

      // Check for Google's VALIDATION_REQUIRED in 403 error body
      const details = data?.error?.details || data?.details;
      if (Array.isArray(details)) {
        for (const item of details) {
          if (
            item?.reason === 'VALIDATION_REQUIRED' ||
            item?.metadata?.validation_url ||
            item?.['@type']?.includes('ErrorInfo') ||
            item?.['@type']?.includes('Help')
          ) {
            requiresValidation = true;
            if (item?.metadata?.validation_url) {
              freshValidationUrl = item.metadata.validation_url;
            } else if (Array.isArray(item?.links)) {
              for (const l of item.links) {
                if (l?.url && typeof l.url === 'string' && l.url.includes('continue')) {
                  freshValidationUrl = l.url;
                  break;
                }
              }
            }
          }
        }
      }

      const rawString = typeof data === 'string' ? data : JSON.stringify(data || {});
      const msg = data?.error?.message || data?.message || err?.message || 'Request failed';
      if (
        msg.includes('Verify your account') ||
        msg.includes('VALIDATION_REQUIRED') ||
        rawString.includes('VALIDATION_REQUIRED')
      ) {
        requiresValidation = true;
      }

      // Regex fallback to extract any Google continue validation URL
      if (!freshValidationUrl && (requiresValidation || rawString.includes('signin/continue'))) {
        const match = rawString.match(/https:\/\/accounts\.google\.com\/[^\s"'\\]+/);
        if (match) {
          freshValidationUrl = match[0];
        }
      }

      if (requiresValidation) {
        this.validationRequiredAccounts.add(account.id);
        if (freshValidationUrl) {
          this.freshValidationUrls.set(account.id, {
            url: freshValidationUrl,
            timestamp: Date.now(),
          });
        }
        error = 'Google requires account verification before this account can be used.';
      } else {
        error = status ? `HTTP ${status}: ${msg}` : msg;
      }
    }

    const latencyMs = Date.now() - startedAt;
    const result: AccountTestResult = {
      accountId: account.id,
      email: account.email,
      ok,
      requiresValidation,
      validationUrl: freshValidationUrl,
      model,
      latencyMs,
      httpStatus,
      sample,
      error,
      timestamp: new Date().toISOString(),
    };

    this.lastResults.set(account.id, result);

    // Refresh quotas from Google via core RPC
    if (refreshQuota && await this.coreClient.isCoreAlive()) {
      try {
        await this.coreClient.callRpc('accountRefreshQuota', { accountId: account.id });
      } catch {
        // ignore
      }
    }

    return result;
  }

  /**
   * Returns a fresh, live Google verification URL for this account.
   * If existing cached URL is older than 90 seconds, makes a fresh test probe to Google
   * to guarantee a brand-new live link from Google!
   */
  async getOrFetchFreshValidationUrl(account: GoogleAccount): Promise<string | null> {
    const cached = this.freshValidationUrls.get(account.id);
    // If cached URL was generated less than 90 seconds ago, reuse it
    if (cached && Date.now() - cached.timestamp < 90 * 1000) {
      return cached.url;
    }

    // Ping Google directly to get a fresh 0-second-old validation URL
    console.log(`[AccountTester] Fetching fresh validation URL from Google for ${account.email}...`);
    await this.testAndRefreshAccount(account);

    const fresh = this.freshValidationUrls.get(account.id);
    if (fresh) {
      return fresh.url;
    }

    // Fallback to core RPC
    if (await this.coreClient.isCoreAlive()) {
      try {
        const res = await this.coreClient.callRpc<any>('accountValidationUrl', { accountId: account.id });
        if (res && res.url) {
          return res.url;
        }
      } catch {
        // ignore
      }
    }

    return null;
  }

  /**
   * Test and refresh all accounts in the pool sequentially.
   */
  async testAndRefreshAll(model: string = 'gemini-3.8-flash-low'): Promise<AccountTestResult[]> {
    const accounts = this.store.getAccounts();
    const results: AccountTestResult[] = [];

    // Trigger force poll across accounts in core
    if (await this.coreClient.isCoreAlive()) {
      try {
        await this.coreClient.callRpc('monitor.forcePoll', {});
      } catch {
        // ignore
      }
    }

    for (const acc of accounts) {
      const r = await this.testAndRefreshAccount(acc, model);
      results.push(r);
    }

    return results;
  }

  /** Tests every model advertised by the gateway against every connected account. */
  async testAllModelsAcrossAccounts(): Promise<{ models: number; accounts: number }> {
    const accounts = this.store.getAccounts();
    const { port, apiKey } = this.resolveGateway();
    if (!accounts.length) return { models: 0, accounts: 0 };

    const response = await axios.get(`http://127.0.0.1:${port}/v1/models`, {
      timeout: 10000,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const models: string[] = [...new Set<string>(
      (response.data?.data || [])
        .map((item: any) => item?.id)
        .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0),
    )];

    for (const model of models) {
      const results: AccountTestResult[] = [];
      for (const account of accounts) {
        results.push(await this.testAndRefreshAccount(account, model, false));
      }

      this.store.setModelTest(summarizeModelAccountTests(model, results));
    }

    return { models: models.length, accounts: accounts.length };
  }

  /**
   * Starts a background loop that automatically tests all accounts every N hours (default 5h).
   */
  startAutoTestScheduler(intervalHours: number = 24): void {
    if (this.autoTestTimer) {
      clearInterval(this.autoTestTimer);
    }

    const intervalMs = intervalHours * 60 * 60 * 1000;
    console.log(`[AccountTester] Scheduled full model/account test active (interval: ${intervalHours}h).`);

    this.autoTestTimer = setInterval(async () => {
      console.log(`[AccountTester] Testing all advertised models against all accounts...`);
      try {
        const counts = await this.testAllModelsAcrossAccounts();
        console.log(`[AccountTester] Finished ${counts.models} models across ${counts.accounts} accounts.`);
      } catch (err: any) {
        console.error('[AccountTester] Scheduled test error:', err.message);
      }
    }, intervalMs);

    this.autoTestTimer.unref();
  }

  stopAutoTestScheduler(): void {
    if (this.autoTestTimer) {
      clearInterval(this.autoTestTimer);
      this.autoTestTimer = null;
    }
  }
}
