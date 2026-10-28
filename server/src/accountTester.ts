import axios from 'axios';
import type { CoreClient } from './coreClient.js';
import type { LocalStateStore, GoogleAccount } from './store.js';

export interface AccountTestResult {
  accountId: string;
  email: string;
  ok: boolean;
  requiresValidation: boolean;
  validationUrl?: string;
  model: string;
  latencyMs: number;
  sample?: string;
  error?: string;
  timestamp: string;
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
    model: string = 'gemini-2.5-flash'
  ): Promise<AccountTestResult> {
    const { port, apiKey } = this.resolveGateway();
    const startedAt = Date.now();

    let ok = false;
    let requiresValidation = false;
    let freshValidationUrl: string | undefined;
    let sample: string | undefined;
    let error: string | undefined;

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
          },
        }
      );

      sample =
        response.data?.choices?.[0]?.message?.content?.toString().trim() || 'ok';
      ok = response.status === 200;

      // If test call succeeded, clear any previous validation requirement
      this.validationRequiredAccounts.delete(account.id);
      this.freshValidationUrls.delete(account.id);
    } catch (err: any) {
      ok = false;
      const status = err?.response?.status;
      const data = err?.response?.data;

      // Check for Google's VALIDATION_REQUIRED in 403 error body
      const details = data?.error?.details || data?.details;
      if (Array.isArray(details)) {
        for (const item of details) {
          if (
            item?.reason === 'VALIDATION_REQUIRED' ||
            item?.metadata?.validation_url ||
            item?.['@type']?.includes('ErrorInfo')
          ) {
            requiresValidation = true;
            if (item?.metadata?.validation_url) {
              freshValidationUrl = item.metadata.validation_url;
            }
          }
        }
      }

      const msg = data?.error?.message || data?.message || err?.message || 'Request failed';
      if (msg.includes('Verify your account') || msg.includes('VALIDATION_REQUIRED')) {
        requiresValidation = true;
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
      sample,
      error,
      timestamp: new Date().toISOString(),
    };

    this.lastResults.set(account.id, result);

    // Refresh quotas from Google via core RPC
    if (await this.coreClient.isCoreAlive()) {
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
  async testAndRefreshAll(model: string = 'gemini-2.5-flash'): Promise<AccountTestResult[]> {
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

  /**
   * Starts a background loop that automatically tests all accounts every N hours (default 5h).
   */
  startAutoTestScheduler(intervalHours: number = 5): void {
    if (this.autoTestTimer) {
      clearInterval(this.autoTestTimer);
    }

    const intervalMs = intervalHours * 60 * 60 * 1000;
    console.log(`[AccountTester] 5-hour automated test scheduler active (interval: ${intervalHours}h).`);

    this.autoTestTimer = setInterval(async () => {
      console.log(`[AccountTester] Executing scheduled 5-hour health test on all accounts...`);
      try {
        const results = await this.testAndRefreshAll();
        for (const r of results) {
          if (r.ok) {
            console.log(`[AccountTester] Account ${r.email}: OPERATIONAL (${r.latencyMs}ms)`);
          } else if (r.requiresValidation) {
            console.warn(`[AccountTester] Account ${r.email}: REQUIRES GOOGLE VERIFICATION (link captured)`);
          } else {
            console.warn(`[AccountTester] Account ${r.email}: FAILED (${r.error})`);
          }
        }
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
