import type { ProxyAssignment, ProxyManager } from './proxyManager.js';

export interface ProxySyncResult {
  ok: boolean;
  /** Desired assignments that differed from the last successful push. */
  changed: number;
  /** Accounts whose proxy_url the core accepted. */
  applied: number;
  /** Accounts the core refused (or could not be reached for). */
  failed: number;
  /** First few failure descriptions, for the dashboard and logs. */
  errors: string[];
  /**
   * `true` when the core reloaded its account cache, `false` when the core does
   * not support the reload RPC (restart required), `null` when nothing changed
   * so no reload was needed.
   */
  reloaded: boolean | null;
}

export interface ProxyApplyResult {
  ok: boolean;
  applied: number;
  failed: number;
  errors: string[];
  /** Assignments the core accepted, so the caller can remember them. */
  appliedAssignments: ProxyAssignment[];
}

/** Minimal shape of the core RPC client used here, so tests can inject a fake. */
export type RpcCaller = (procedure: string, input?: unknown) => Promise<any>;

function describeFailure(result: any): string {
  if (result === null || result === undefined) return 'core unreachable';
  if (typeof result === 'object' && typeof result.message === 'string' && result.message) {
    return result.message;
  }
  return 'core rejected the update';
}

/**
 * Push per-account proxy assignments to the core through `accountSetProxy`.
 *
 * The core owns the actual proxying: it reads `accounts.proxy_url` and routes
 * that account's upstream traffic through it. The bridge only decides which
 * proxy each account should use.
 *
 * Assignments are applied one at a time and every account is reported, so a
 * single failure never hides the rest of the pool.
 */
export async function applyProxyAssignments(
  assignments: ProxyAssignment[],
  callRpc: RpcCaller,
): Promise<ProxyApplyResult> {
  let applied = 0;
  let failed = 0;
  const errors: string[] = [];
  const appliedAssignments: ProxyAssignment[] = [];

  for (const assignment of assignments) {
    let result: any = null;
    try {
      result = await callRpc('accountSetProxy', {
        accountId: assignment.accountId,
        proxyUrl: assignment.proxyUrl,
      });
    } catch (err: any) {
      result = { message: err?.message || String(err) };
    }

    if (result && result.success === true) {
      applied += 1;
      appliedAssignments.push(assignment);
      continue;
    }

    failed += 1;
    if (errors.length < 3) {
      errors.push(`${assignment.accountId}: ${describeFailure(result)}`);
    }
  }

  return { ok: failed === 0, applied, failed, errors, appliedAssignments };
}

/**
 * Bring the core in sync with the manager's assignment plan.
 *
 * Only accounts whose proxy actually changed are written, and the core's
 * in-memory account cache is reloaded only when something was written. Reload
 * matters because the gateway caches account tokens (including the proxy URL)
 * at startup and would otherwise keep using the previous proxy.
 */
export async function syncProxyAssignments(
  manager: ProxyManager,
  accountIds: string[],
  callRpc: RpcCaller,
): Promise<ProxySyncResult> {
  const desired = manager.reconcile(accountIds);
  const changed = manager.changedSincePushed(desired);

  if (changed.length === 0) {
    return { ok: true, changed: 0, applied: 0, failed: 0, errors: [], reloaded: null };
  }

  const push = await applyProxyAssignments(changed, callRpc);
  manager.markPushed(push.appliedAssignments);

  let reloaded: boolean | null = null;
  if (push.applied > 0) {
    const result = await callRpc('accountLeaseReload');
    reloaded = Boolean(result && result.success === true);
    if (!reloaded) {
      push.errors.push(
        'Assignments saved, but the core could not reload them; restart the core to apply the change.',
      );
    }
  }

  // Never expose proxy URLs (and their credentials) to API clients.
  const { appliedAssignments: _applied, ...summary } = push;
  return { ...summary, changed: changed.length, reloaded };
}