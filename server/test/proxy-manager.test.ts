/**
 * Unit tests for proxy routing.
 *
 * The bridge no longer calls the AI providers itself: it decides which Webshare
 * proxy each account should use and hands that to the core via
 * `accountSetProxy`. These tests cover the assignment maths, failure behaviour,
 * credential hygiene, and the RPC contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ProxyManager, toProxyUrl, type WebshareProxy } from '../src/proxyManager.js';
import { applyProxyAssignments, syncProxyAssignments } from '../src/proxySync.js';
import { LocalStateStore } from '../src/store.js';

function proxy(id: number, address = `${id}.${id}.${id}.${id}`): WebshareProxy {
  return {
    // Mirrors the real Webshare payload: string id, flat port, `valid` flag.
    id: `d-${id}`,
    proxy_address: address,
    port: 9000 + id,
    username: `user${id}`,
    password: `pass${id}`,
    country_code: 'US',
    valid: true,
  };
}

function inventory(ids: number[]): WebshareProxy[] {
  return ids.map((id) => proxy(id));
}

async function managerWith(
  proxies: WebshareProxy[],
  accounts: string[],
): Promise<{ manager: ProxyManager; assignments: Array<{ accountId: string; proxyUrl: string | null }> }> {
  const manager = new ProxyManager({ fetchInventory: async () => proxies });
  manager.setApiKey('test-key');
  assert.equal(manager.setEnabled(true), true);
  const refresh = await manager.refreshProxies();
  assert.equal(refresh.ok, true);
  return { manager, assignments: manager.reconcile(accounts) };
}

test('proxies spread across the inventory, least-used first', async () => {
  const accounts = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
  const { manager, assignments } = await managerWith(inventory([1, 2, 3]), accounts);

  assert.equal(assignments.length, 7);
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    assert.ok(assignment.proxyUrl, 'every account must get a proxy');
    assert.match(assignment.proxyUrl!, /^http:\/\/user\d:pass\d@\d+\.\d+\.\d+\.\d+:900\d$/);
    const host = new URL(assignment.proxyUrl!).hostname;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }

  // 7 accounts over 3 proxies: 3 / 2 / 2, nobody starved.
  assert.deepEqual([...counts.values()].sort(), [2, 2, 3]);

  const summary = manager.getProxyListSummary();
  assert.equal(summary.length, 3);
  assert.equal(summary.reduce((total, entry) => total + entry.assignedAccountIds.length, 0), 7);
});

test('reconcile is idempotent and does not reshuffle live assignments', async () => {
  const accounts = ['a1', 'a2', 'a3', 'a4'];
  const { manager, assignments } = await managerWith(inventory([1, 2]), accounts);
  const first = new Map(assignments.map((a) => [a.accountId, a.proxyUrl]));

  const again = manager.reconcile(accounts);
  for (const assignment of again) {
    assert.equal(assignment.proxyUrl, first.get(assignment.accountId));
  }
});

test('refresh keeps accounts on the same proxy when the inventory is reordered', async () => {
  const accounts = ['a1', 'a2', 'a3'];
  let current = inventory([1, 2, 3]);
  const manager = new ProxyManager({ fetchInventory: async () => current });
  manager.setApiKey('test-key');
  manager.setEnabled(true);
  await manager.refreshProxies();
  const first = new Map(manager.reconcile(accounts).map((a) => [a.accountId, a.proxyUrl]));

  current = inventory([3, 1, 2]);
  const refresh = await manager.refreshProxies();
  assert.equal(refresh.ok, true);

  for (const assignment of manager.reconcile(accounts)) {
    assert.equal(assignment.proxyUrl, first.get(assignment.accountId));
  }
});

test('a failed refresh keeps the previous inventory and assignments', async () => {
  const accounts = ['a1', 'a2'];
  let fail = false;
  const manager = new ProxyManager({
    fetchInventory: async () => {
      if (fail) throw new Error('webshare 503');
      return inventory([1, 2]);
    },
  });
  manager.setApiKey('test-key');
  manager.setEnabled(true);
  await manager.refreshProxies();
  const before = manager.reconcile(accounts);

  fail = true;
  const refresh = await manager.refreshProxies();
  assert.equal(refresh.ok, false);
  assert.equal(refresh.error, 'webshare 503');
  assert.equal(refresh.proxyCount, 2, 'stale inventory is kept');

  const after = manager.reconcile(accounts);
  assert.deepEqual(after, before);
  assert.equal(manager.getConfigSnapshot().lastError, 'webshare 503');
  assert.equal(manager.getConfigSnapshot().proxyCount, 2);
});

test('disabling routing clears every account and refuses to stay enabled without a key', async () => {
  const accounts = ['a1', 'a2'];
  const { manager } = await managerWith(inventory([1, 2]), accounts);
  manager.setEnabled(false);

  const cleared = manager.reconcile(accounts);
  assert.deepEqual(cleared, [
    { accountId: 'a1', proxyUrl: null },
    { accountId: 'a2', proxyUrl: null },
  ]);

  const snapshot = manager.getConfigSnapshot();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.proxyCount, 0);
  assert.equal(snapshot.accountCount, 0);
  assert.equal(snapshot.hasApiKey, true, 'the key is kept for the next enable');

  const empty = new ProxyManager();
  assert.equal(empty.setEnabled(true), false);
  assert.equal(empty.isEnabled(), false);
});

test('accounts that disappear from the pool lose their assignment', async () => {
  const { manager } = await managerWith(inventory([1, 2, 3]), ['a1', 'a2', 'a3']);
  assert.equal(manager.getConfigSnapshot().accountCount, 3);

  const remaining = manager.reconcile(['a1']);
  assert.deepEqual(remaining.map((a) => a.accountId), ['a1']);
  assert.equal(manager.getConfigSnapshot().accountCount, 1);
});

test('proxy URLs are http(s) with encoded credentials and a real port', () => {
  const url = toProxyUrl({
    ...proxy(1, '10.0.0.1'),
    username: 'user name',
    password: 'p@ss:word',
  });
  assert.equal(url, 'http://user%20name:p%40ss%3Aword@10.0.0.1:9001');

  // Legacy payloads that carry a ports object instead of a flat port still work.
  assert.equal(
    toProxyUrl({ ...proxy(1), port: undefined, ports: { http: 8001, https: 9001 } }),
    'http://user1:pass1@1.1.1.1:9001',
  );

  assert.equal(toProxyUrl({ ...proxy(1), port: 0 }), null);
  assert.equal(toProxyUrl(proxy(1, '')), null);
});

test('Webshare inventory is fetched with mode=direct and parsed from flat ports', async () => {
  const requested: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requested.push(url.searchParams);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        count: 2,
        results: [
          { id: 'd-1', proxy_address: '1.1.1.1', port: 7408, username: 'u1', password: 'p1', country_code: 'US', valid: true },
          // Flagged unusable by Webshare: must never be assigned.
          { id: 'd-2', proxy_address: '2.2.2.2', port: 7409, username: 'u2', password: 'p2', country_code: 'DE', valid: false },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const manager = new ProxyManager({ apiBaseUrl: `http://127.0.0.1:${port}/` });
    manager.setApiKey('ws-key');
    manager.setEnabled(true);

    const refresh = await manager.refreshProxies();
    assert.equal(refresh.ok, true);
    assert.equal(refresh.proxyCount, 1, 'invalid proxies are dropped');

    // The API rejects the call without mode, so it must always be present.
    assert.equal(requested[0].get('mode'), 'direct');
    assert.equal(requested[0].get('page_size'), '100');

    const [assignment] = manager.reconcile(['a1']);
    assert.equal(assignment.proxyUrl, 'http://u1:p1@1.1.1.1:7408');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a subscription without static proxies falls back to the backbone list', async () => {
  const modes: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const mode = url.searchParams.get('mode') || '';
    modes.push(mode);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'backbone') {
      res.end(
        JSON.stringify({
          count: 1,
          results: [
            { id: 'b-1', proxy_address: '3.3.3.3', port: 10000, username: 'u', password: 'p', country_code: 'DE', valid: true },
          ],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ count: 0, results: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const manager = new ProxyManager({ apiBaseUrl: `http://127.0.0.1:${port}/` });
    manager.setApiKey('ws-key');
    manager.setEnabled(true);

    const refresh = await manager.refreshProxies();
    assert.equal(refresh.ok, true);
    assert.equal(refresh.proxyCount, 1);
    assert.deepEqual(modes, ['direct', 'backbone']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the config snapshot never exposes the key or proxy credentials', async () => {
  const { manager } = await managerWith(inventory([1]), ['a1']);
  const serialized = JSON.stringify(manager.getConfigSnapshot());

  assert.equal(serialized.includes('test-key'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('username'), false);
  assert.equal(serialized.includes('webshareApiKey'), false);
  assert.equal(manager.getConfigSnapshot().hasApiKey, true);
});

test('applyProxyAssignments pushes accountSetProxy once per account', async () => {
  const calls: Array<{ procedure: string; input: any }> = [];
  const result = await applyProxyAssignments(
    [
      { accountId: 'a1', proxyUrl: 'http://u:p@1.1.1.1:9001' },
      { accountId: 'a2', proxyUrl: null },
    ],
    async (procedure, input) => {
      calls.push({ procedure, input });
      return { success: true };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.applied, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.appliedAssignments, [
    { accountId: 'a1', proxyUrl: 'http://u:p@1.1.1.1:9001' },
    { accountId: 'a2', proxyUrl: null },
  ]);
  assert.deepEqual(calls, [
    { procedure: 'accountSetProxy', input: { accountId: 'a1', proxyUrl: 'http://u:p@1.1.1.1:9001' } },
    { procedure: 'accountSetProxy', input: { accountId: 'a2', proxyUrl: null } },
  ]);
});

test('applyProxyAssignments reports failures without aborting the rest of the pool', async () => {
  let seen = 0;
  const result = await applyProxyAssignments(
    [
      { accountId: 'a1', proxyUrl: 'http://u:p@1.1.1.1:9001' },
      { accountId: 'a2', proxyUrl: 'http://u:p@2.2.2.2:9002' },
      { accountId: 'a3', proxyUrl: 'http://u:p@3.3.3.3:9003' },
      { accountId: 'a4', proxyUrl: 'http://u:p@4.4.4.4:9004' },
    ],
    async () => {
      seen += 1;
      if (seen === 1) return null; // core unreachable
      if (seen === 2) throw new Error('rpc timeout');
      return { success: true };
    },
  );

  assert.equal(seen, 4, 'every account is attempted');
  assert.equal(result.ok, false);
  assert.equal(result.applied, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.appliedAssignments.length, 2);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /core unreachable/);
  assert.match(result.errors[1], /rpc timeout/);
});

test('only changed assignments reach the core, and each change reloads it once', async () => {
  const { manager } = await managerWith(inventory([1, 2]), ['a1', 'a2']);
  const calls: string[] = [];
  const rpc = async (procedure: string) => {
    calls.push(procedure);
    return { success: true };
  };

  const first = await syncProxyAssignments(manager, ['a1', 'a2'], rpc);
  assert.equal(first.changed, 2);
  assert.equal(first.applied, 2);
  assert.equal(first.reloaded, true);
  assert.deepEqual(calls, ['accountSetProxy', 'accountSetProxy', 'accountLeaseReload']);

  // Same inventory and same accounts: the core is already in sync, so nothing
  // is written and no reload (which would drop sessions) happens.
  calls.length = 0;
  const second = await syncProxyAssignments(manager, ['a1', 'a2'], rpc);
  assert.equal(second.changed, 0);
  assert.equal(second.reloaded, null);
  assert.deepEqual(calls, []);

  // Disabling must clear both accounts and reload once.
  manager.setEnabled(false);
  calls.length = 0;
  const third = await syncProxyAssignments(manager, ['a1', 'a2'], rpc);
  assert.equal(third.changed, 2);
  assert.equal(third.applied, 2);
  assert.equal(third.reloaded, true);
  assert.deepEqual(calls, ['accountSetProxy', 'accountSetProxy', 'accountLeaseReload']);
});

test('an assignment the core refused is retried on the next sync', async () => {
  const { manager } = await managerWith(inventory([1]), ['a1']);
  let setProxyCalls = 0;
  const rpc = async (procedure: string) => {
    if (procedure === 'accountLeaseReload') return { success: true };
    setProxyCalls += 1;
    return setProxyCalls === 1 ? null : { success: true };
  };

  const first = await syncProxyAssignments(manager, ['a1'], rpc);
  assert.equal(first.applied, 0);
  assert.equal(first.failed, 1);
  assert.equal(first.reloaded, null, 'nothing applied, so no reload');

  const second = await syncProxyAssignments(manager, ['a1'], rpc);
  assert.equal(second.changed, 1);
  assert.equal(second.applied, 1);
  assert.equal(second.reloaded, true);
});

test('egress identity follows the assigned proxy and disappears when disabled', async () => {
  const { manager } = await managerWith(inventory([1]), ['a1']);

  assert.deepEqual(manager.getEgressForAccount('a1'), { address: '1.1.1.1', country: 'US' });
  assert.equal(manager.getEgressForAccount('not-in-pool'), null);

  manager.setEnabled(false);
  assert.equal(manager.getEgressForAccount('a1'), null, 'no proxy label when routing is off');
});

test('a restart keeps every account on the same proxy', async () => {
  const proxies = inventory([1, 2, 3]);
  const first = new ProxyManager({ fetchInventory: async () => proxies });
  first.setApiKey('test-key');
  first.setEnabled(true);
  await first.refreshProxies();
  const before = first.reconcile(['a1', 'a2', 'a3']);
  const saved = first.getAssignmentKeys();
  assert.deepEqual(Object.keys(saved).sort(), ['a1', 'a2', 'a3']);
  assert.match(saved.a1, /^1\.1\.1\.1:9001$/, 'keys never contain credentials');

  // Simulate a process restart: new manager, same inventory, restored mapping.
  const second = new ProxyManager({ fetchInventory: async () => proxies });
  second.setApiKey('test-key');
  second.setEnabled(true);
  second.hydrateAssignments(saved);
  await second.refreshProxies();

  assert.deepEqual(second.reconcile(['a1', 'a2', 'a3']), before);
});

test('a vanished proxy forces only the affected account to be re-assigned', async () => {
  const first = new ProxyManager({ fetchInventory: async () => inventory([1, 2]) });
  first.setApiKey('test-key');
  first.setEnabled(true);
  await first.refreshProxies();
  const before = new Map(first.reconcile(['a1', 'a2']).map((a) => [a.accountId, a.proxyUrl]));

  // Proxy 1 disappears; a1 must move, a2 must keep its IP.
  const second = new ProxyManager({ fetchInventory: async () => inventory([2, 3]) });
  second.setApiKey('test-key');
  second.setEnabled(true);
  second.hydrateAssignments(first.getAssignmentKeys());
  await second.refreshProxies();
  const after = new Map(second.reconcile(['a1', 'a2']).map((a) => [a.accountId, a.proxyUrl]));

  assert.notEqual(after.get('a1'), before.get('a1'));
  assert.equal(after.get('a2'), before.get('a2'));
});

test('AI Studio keys get their own proxy pins, spread least-used', async () => {
  const { manager } = await managerWith(inventory([1, 2]), ['a1']);
  assert.equal(manager.setApiKeyProxyEnabled(true), true);

  manager.reconcileApiKeyAssignments(['k1', 'k2', 'k3']);
  const urls = ['k1', 'k2', 'k3'].map((id) => manager.getApiKeyProxyUrl(id));
  assert.ok(urls.every(Boolean));
  assert.match(urls[0]!, /^http:\/\/user\d:pass\d@\d+\.\d+\.\d+\.\d+:900\d$/);

  const hosts = urls.map((url) => new URL(url!).hostname);
  assert.equal(new Set(hosts).size, 2, 'three keys share two proxies');

  const state = manager.getApiKeyProxyState();
  assert.equal(state.enabled, true);
  assert.equal(state.available, 2);
  assert.equal(state.assigned, 3);

  manager.setApiKeyProxyEnabled(false);
  assert.equal(manager.getApiKeyProxyUrl('k1'), null);
  assert.equal(manager.getApiKeyProxyState().assigned, 0);
});

test('key proxy pins survive a refresh and a restart', async () => {
  const manager = new ProxyManager({ fetchInventory: async () => inventory([1, 2]) });
  manager.setApiKey('test-key');
  manager.setApiKeyProxyEnabled(true);
  await manager.refreshProxies();
  manager.reconcileApiKeyAssignments(['k1', 'k2']);

  const before = new Map(
    ['k1', 'k2'].map((id) => [id, manager.getApiKeyProxyUrl(id)]),
  );
  const saved = manager.getApiKeyAssignmentKeys();

  const second = new ProxyManager({ fetchInventory: async () => inventory([2, 1]) });
  second.setApiKey('test-key');
  second.setApiKeyProxyEnabled(true);
  second.hydrateApiKeyAssignments(saved);
  await second.refreshProxies();
  second.reconcileApiKeyAssignments(['k1', 'k2']);

  for (const id of ['k1', 'k2']) {
    assert.equal(second.getApiKeyProxyUrl(id), before.get(id));
  }
});

test('quarantining an assigned proxy moves the account onto a healthy IP', async () => {
  const { manager } = await managerWith(inventory([1, 2]), ['a1', 'a2']);
  const before = new Map(
    manager.reconcile(['a1', 'a2']).map((assignment) => [assignment.accountId, assignment.proxyUrl]),
  );
  const a1 = new URL(before.get('a1')!);
  const quarantinedKey = `${a1.hostname}:${a1.port}`;

  assert.equal(manager.quarantineProxy(quarantinedKey, 60 * 60 * 1000), true);
  const after = new Map(
    manager.reconcile(['a1', 'a2']).map((assignment) => [assignment.accountId, assignment.proxyUrl]),
  );

  assert.ok(after.get('a1'));
  assert.notEqual(after.get('a1'), before.get('a1'), 'the account leaves the cooling IP');
  assert.equal(after.get('a2'), before.get('a2'), 'the unaffected account keeps its IP');

  const entry = manager
    .getProxyListSummary()
    .find((proxy) => `${proxy.address}:${proxy.port}` === quarantinedKey)!;
  assert.equal(entry.status, 'cooling');
  assert.ok(entry.quarantineUntil && entry.quarantineUntil > Date.now());
});

test('a cooling proxy is not assigned to new accounts until it is restored', async () => {
  const manager = new ProxyManager({ fetchInventory: async () => inventory([1, 2]) });
  manager.setApiKey('test-key');
  manager.setEnabled(true);
  await manager.refreshProxies();
  manager.reconcile(['a1', 'a2']);

  manager.quarantineProxy('1.1.1.1:9001', 2 * 60 * 60 * 1000);
  const during = new Map(
    manager.reconcile(['a1', 'a2', 'a3']).map((assignment) => [assignment.accountId, assignment.proxyUrl]),
  );
  assert.equal(new URL(during.get('a3')!).hostname, '2.2.2.2', 'only the healthy IP is used');

  assert.equal(manager.restoreProxy('1.1.1.1:9001'), true);
  const after = new Map(
    manager.reconcile(['a1', 'a2', 'a3', 'a4']).map((assignment) => [assignment.accountId, assignment.proxyUrl]),
  );
  assert.equal(new URL(after.get('a4')!).hostname, '1.1.1.1', 'the restored IP is back in rotation');
});

test('a retired proxy stays out of rotation and can be restored', async () => {
  const { manager } = await managerWith(inventory([1, 2]), ['a1']);

  assert.equal(manager.retireProxy('1.1.1.1:9001'), true);
  assert.equal(manager.retireProxy('1.1.1.1:9001'), true, 'retiring twice is harmless');
  const assignments = manager.reconcile(['a1', 'a2']);
  for (const assignment of assignments) {
    assert.ok(assignment.proxyUrl);
    assert.equal(new URL(assignment.proxyUrl!).hostname, '2.2.2.2');
  }

  const retired = manager
    .getProxyListSummary()
    .find((proxy) => `${proxy.address}:${proxy.port}` === '1.1.1.1:9001')!;
  assert.equal(retired.status, 'retired');
  assert.equal(retired.quarantineUntil, null);

  assert.equal(manager.restoreProxy('1.1.1.1:9001'), true);
  const restored = manager
    .getProxyListSummary()
    .find((proxy) => `${proxy.address}:${proxy.port}` === '1.1.1.1:9001')!;
  assert.equal(restored.status, 'available');
});

test('quarantines and retirements survive a restart', async () => {
  const proxies = inventory([1, 2, 3]);
  const first = new ProxyManager({ fetchInventory: async () => proxies });
  first.setApiKey('test-key');
  first.setEnabled(true);
  await first.refreshProxies();
  first.reconcile(['a1', 'a2']);

  first.quarantineProxy('1.1.1.1:9001', 60 * 60 * 1000);
  first.retireProxy('3.3.3.3:9003');
  const health = first.getHealthState();
  assert.deepEqual(health.retired, ['3.3.3.3:9003']);

  const second = new ProxyManager({ fetchInventory: async () => proxies });
  second.setApiKey('test-key');
  second.setEnabled(true);
  second.hydrateHealthState(health.quarantines, health.retired);
  await second.refreshProxies();

  const hosts = second
    .reconcile(['a1', 'a2', 'a3'])
    .map((assignment) => new URL(assignment.proxyUrl!).hostname);
  assert.deepEqual(hosts, ['2.2.2.2', '2.2.2.2', '2.2.2.2']);
});

test('proxy health survives a store reload', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-proxy-health-'));
  try {
    const first = new LocalStateStore(dataDir);
    const until = Date.now() + 60_000;
    first.setProxyQuarantines({ '96.62.148.198:7408': until });
    first.setRetiredProxies(['195.40.128.173:6893', '195.40.128.173:6893']);

    const reloaded = new LocalStateStore(dataDir);
    assert.deepEqual(reloaded.getProxyQuarantines(), { '96.62.148.198:7408': until });
    assert.deepEqual(reloaded.getRetiredProxies(), ['195.40.128.173:6893']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('key egress attribution follows the key proxy and disappears when disabled', async () => {
  const { manager } = await managerWith(inventory([1]), ['a1']);
  manager.setApiKeyProxyEnabled(true);
  manager.reconcileApiKeyAssignments(['k1']);

  assert.deepEqual(manager.getEgressForKey('k1'), { address: '1.1.1.1', country: 'US' });
  assert.equal(manager.getEgressForKey('unknown'), null);

  manager.setApiKeyProxyEnabled(false);
  assert.equal(manager.getEgressForKey('k1'), null);
});

test('a throttled key proxy is bypassed while the key keeps its assignment', async () => {
  const { manager } = await managerWith(inventory([1]), ['a1']);
  manager.setApiKeyProxyEnabled(true);
  manager.reconcileApiKeyAssignments(['k1']);

  assert.ok(manager.getApiKeyProxyAgent('k1'));
  assert.deepEqual(manager.getEgressForKey('k1'), { address: '1.1.1.1', country: 'US' });

  manager.markApiKeyProxyRateLimited('k1', 60_000);
  assert.equal(manager.isApiKeyProxyBypassed('k1'), true);
  assert.equal(manager.getApiKeyProxyAgent('k1'), null, 'traffic goes direct');
  assert.equal(manager.getEgressForKey('k1'), null, 'attribution follows the direct egress');
  assert.ok(manager.getApiKeyProxyUrl('k1'), 'the assignment survives the bypass');
});

test('sync results never expose proxy credentials to API clients', async () => {
  const { manager } = await managerWith(inventory([1]), ['a1']);
  const rpc = async () => ({ success: true });

  const result = await syncProxyAssignments(manager, ['a1'], rpc);
  assert.equal(result.applied, 1);
  assert.equal(JSON.stringify(result).includes('@'), false, 'no proxy URL may be serialized');
  assert.equal(JSON.stringify(result).includes('pass1'), false, 'no proxy password may be serialized');
});

test('an older core without the reload RPC reports that a restart is needed', async () => {
  const { manager } = await managerWith(inventory([1]), ['a1']);
  const rpc = async (procedure: string) =>
    procedure === 'accountLeaseReload' ? null : { success: true };

  const result = await syncProxyAssignments(manager, ['a1'], rpc);
  assert.equal(result.applied, 1);
  assert.equal(result.reloaded, false);
  assert.match(result.errors[result.errors.length - 1], /restart the core/i);
});

test('the Webshare key survives a store reload and never leaks into gateway config', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-proxy-store-'));
  try {
    const first = new LocalStateStore(dataDir);
    first.setWebshareApiKey('  ws-secret-key  ');
    assert.equal(first.getWebshareApiKey(), 'ws-secret-key');
    assert.equal(first.hasWebshareApiKey(), true);
    assert.equal(first.getProxyRoutingEnabled(), null, 'routing intent starts unset');
    assert.equal(JSON.stringify(first.getConfig()).includes('ws-secret-key'), false);

    first.setProxyRoutingEnabled(false);
    first.setProxyAssignments({ a1: '96.62.148.198:7408' });
    first.setGeminiApiUsageState({
      savedAt: new Date().toISOString(),
      keys: {
        'gk-1': {
          models: {
            'gemini-3.5-flash-lite': {
              dayKey: '2026-11-06',
              rpd: 42,
              tokensToday: 1234,
            },
          },
        },
      },
    });

    const reloaded = new LocalStateStore(dataDir);
    assert.equal(reloaded.getWebshareApiKey(), 'ws-secret-key');
    assert.equal(reloaded.getProxyRoutingEnabled(), false, 'a disabled choice survives restart');
    assert.deepEqual(
      reloaded.getProxyAssignments(),
      { a1: '96.62.148.198:7408' },
      'the account -> IP mapping survives restart',
    );
    assert.equal(
      reloaded.getGeminiApiUsageState()?.keys['gk-1'].models['gemini-3.5-flash-lite'].rpd,
      42,
      'per-key usage survives restart',
    );
    assert.equal(JSON.stringify(reloaded.getConfig()).includes('ws-secret-key'), false);

    reloaded.setWebshareApiKey('');
    assert.equal(reloaded.hasWebshareApiKey(), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});