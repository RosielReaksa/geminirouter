import axios from 'axios';
import type { CoreClient } from './coreClient.js';
import type { LocalStateStore, GoogleAccount } from './store.js';

export interface AccountTestResult {
  accountId: string;
  email: string;
  ok: boolean;
  model: string;
  latencyMs: number;
  sample?: string;
  error?: string;
  timestamp: string;
}

export class AccountTester {
  private lastResults = new Map<string, AccountTestResult>();
  private autoTestTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly coreClient: CoreClient,
    private readonly store: LocalStateStore,
    private readonly resolveGateway: () => { port: number; apiKey: string }
  ) {}

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
   * Test an account by making a live model call targeting that exact account (x-account-id)
   * and then refreshing its quotas from Google.
   */
  async testAndRefreshAccount(
    account: GoogleAccount,
    model: string = 'gemini-2.5-flash'
  ): Promise<AccountTestResult> {
    const { port, apiKey } = this.resolveGateway();
    const startedAt = Date.now();

    let ok = false;
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
          timeout: 20000,
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
    } catch (err: any) {
      ok = false;
      const status = err?.response?.status;
      const detail =
        err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.message ||
        'Request failed';
      error = status ? `HTTP ${status}: ${detail}` : detail;
    }

    const latencyMs = Date.now() - startedAt;
    const result: AccountTestResult = {
      accountId: account.id,
      email: account.email,
      ok,
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
   * Test and refresh all accounts in the pool sequentially.
   */
  async testAndRefreshAll(model: string = 'gemini-2.5-flash'): Promise<AccountTestResult[]> {
    const accounts = this.store.getAccounts();
    const results: AccountTestResult[] = [];

    // Also trigger force poll across accounts
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
    console.log(`[AccountTester] Auto-test scheduler scheduled every ${intervalHours} hours.`);

    this.autoTestTimer = setInterval(async () => {
      console.log(`[AccountTester] Running scheduled 5-hour test call on all accounts...`);
      try {
        const results = await this.testAndRefreshAll();
        for (const r of results) {
          console.log(
            `[AccountTester] Account ${r.email}: ${r.ok ? `WORKING (${r.latencyMs}ms)` : `FAILED (${r.error})`}`
          );
        }
      } catch (err: any) {
        console.error('[AccountTester] Scheduled test call error:', err.message);
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
