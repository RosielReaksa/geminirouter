import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyLeaseManager } from '../src/leaseManager.js';
import type { GoogleAccount } from '../src/store.js';

function createMockAccounts(count: number, quotaPct: number = 100): GoogleAccount[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `acc-${i + 1}`,
    email: `user${i + 1}@gmail.com`,
    name: `User ${i + 1}`,
    status: 'active',
    addedAt: '2026-01-01T00:00:00Z',
    tier: 'Google AI Studio',
    quotas: [
      {
        modelId: 'gemini-2.5-pro',
        modelName: 'Gemini 2.5 Pro',
        requestsIn5h: Math.round((1 - quotaPct / 100) * 50),
        limitIn5h: 50,
        resetTime5h: 'in 4h',
        tokensIn7d: 1000,
        limitIn7d: 2000000,
        resetTime7d: 'in 5d',
        isThrottled: false,
      },
    ],
    isDefaultRouting: i === 0,
    totalRequests24h: 0,
  }));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('spread 30 concurrent requests across N=3 accounts with max-min in-flight <= 1', async () => {
  const accounts = createMockAccounts(3);
  const manager = new ConcurrencyLeaseManager({
    maxConcurrentRequestsPerAccount: 15,
  });

  const activeLeases: Array<{ account: GoogleAccount; release: () => void }> = [];

  // Acquire 30 leases sequentially while keeping them open
  for (let i = 0; i < 30; i++) {
    const lease = await manager.acquireLease(accounts);
    assert.ok(lease, `lease ${i} must be acquired`);
    activeLeases.push(lease);

    // Verify balance at every single step!
    const inFlightCounts = accounts.map((a) => manager.getInFlight(a.id));
    const max = Math.max(...inFlightCounts);
    const min = Math.min(...inFlightCounts);
    assert.ok(
      max - min <= 1,
      `Step ${i + 1}: max (${max}) - min (${min}) must be <= 1 across all 3 accounts`
    );
  }

  // After 30 requests on 3 accounts, each account must have exactly 10 leases
  const finalCounts = accounts.map((a) => manager.getInFlight(a.id));
  assert.deepEqual(finalCounts, [10, 10, 10]);

  // Release all
  activeLeases.forEach((l) => l.release());
  const afterRelease = accounts.map((a) => manager.getInFlight(a.id));
  assert.deepEqual(afterRelease, [0, 0, 0]);
});

test('spread 30 concurrent requests across N=10 accounts with max-min in-flight <= 1', async () => {
  const accounts = createMockAccounts(10);
  const manager = new ConcurrencyLeaseManager({
    maxConcurrentRequestsPerAccount: 5,
  });

  const activeLeases: Array<{ account: GoogleAccount; release: () => void }> = [];

  // Acquire 30 leases concurrently
  for (let i = 0; i < 30; i++) {
    const lease = await manager.acquireLease(accounts);
    assert.ok(lease, `lease ${i} must be acquired`);
    activeLeases.push(lease);

    const inFlightCounts = accounts.map((a) => manager.getInFlight(a.id));
    const max = Math.max(...inFlightCounts);
    const min = Math.min(...inFlightCounts);
    assert.ok(
      max - min <= 1,
      `Step ${i + 1}: max (${max}) - min (${min}) must be <= 1 across all 10 accounts`
    );
  }

  // After 30 requests on 10 accounts, each account must have exactly 3 leases
  const finalCounts = accounts.map((a) => manager.getInFlight(a.id));
  assert.deepEqual(finalCounts, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);

  // Release all
  activeLeases.forEach((l) => l.release());
  const afterRelease = accounts.map((a) => manager.getInFlight(a.id));
  assert.deepEqual(
    afterRelease,
    Array.from({ length: 10 }, () => 0)
  );
});

test('no account exceeds its per-account concurrency cap', async () => {
  const cap = 4;
  const accounts = createMockAccounts(2);
  const manager = new ConcurrencyLeaseManager({
    maxConcurrentRequestsPerAccount: cap,
    capacityPolicy: 'reject_429',
  });

  const totalCapacity = manager.getTotalCapacity(accounts.length);
  assert.equal(totalCapacity, 8, 'Total capacity must be 2 * 4 = 8');

  const leases: Array<{ account: GoogleAccount; release: () => void }> = [];

  // Acquire up to total capacity (8)
  for (let i = 0; i < 8; i++) {
    const l = await manager.acquireLease(accounts);
    assert.ok(l);
    leases.push(l);
    assert.ok(manager.getInFlight(l.account.id) <= cap);
  }

  // Confirm both accounts are exactly at cap
  assert.equal(manager.getInFlight(accounts[0].id), cap);
  assert.equal(manager.getInFlight(accounts[1].id), cap);

  // 9th request must be rejected because capacity is full
  const rejectedLease = await manager.acquireLease(accounts);
  assert.equal(rejectedLease, null, 'Must reject when every account is at its cap');

  // Release one lease from account 0
  leases[0].release();
  assert.equal(manager.getInFlight(accounts[0].id), cap - 1);

  // Now a lease can be acquired, and it MUST pick account 0
  const newlyAcquired = await manager.acquireLease(accounts);
  assert.ok(newlyAcquired);
  assert.equal(newlyAcquired.account.id, accounts[0].id);

  // Clean up
  leases.slice(1).forEach((l) => l.release());
  newlyAcquired.release();
});

test('tie-breaker picks account with least quota used (highest remaining quota)', async () => {
  // Account 1 has 90% remaining quota, Account 2 has 50% remaining quota
  const acc1 = createMockAccounts(1, 90)[0];
  acc1.id = 'acc-high-quota';
  const acc2 = createMockAccounts(1, 50)[0];
  acc2.id = 'acc-low-quota';

  const manager = new ConcurrencyLeaseManager({ maxConcurrentRequestsPerAccount: 5 });

  // Both have 0 in-flight. Must pick acc1 (least quota used)
  const lease1 = await manager.acquireLease([acc1, acc2]);
  assert.ok(lease1);
  assert.equal(lease1.account.id, 'acc-high-quota');

  // Now acc1 has 1 in-flight, acc2 has 0 in-flight. Must pick acc2 (fewest in-flight)
  const lease2 = await manager.acquireLease([acc1, acc2]);
  assert.ok(lease2);
  assert.equal(lease2.account.id, 'acc-low-quota');

  lease1.release();
  lease2.release();
});

test('skip accounts in cooldown or error status', async () => {
  const accounts = createMockAccounts(3);
  accounts[0].status = 'error'; // Account 1 in error

  const manager = new ConcurrencyLeaseManager({ maxConcurrentRequestsPerAccount: 5 });
  manager.markCooldown(accounts[1].id, 10000); // Account 2 in cooldown

  // Must pick Account 3 (the only eligible healthy account)
  const lease = await manager.acquireLease(accounts);
  assert.ok(lease);
  assert.equal(lease.account.id, accounts[2].id);

  lease.release();
});

test('queue briefly when accounts are at capacity and acquire when slot frees', async () => {
  const accounts = createMockAccounts(1);
  const manager = new ConcurrencyLeaseManager({
    maxConcurrentRequestsPerAccount: 1,
    capacityPolicy: 'queue',
    queueTimeoutMs: 3000,
  });

  const lease1 = await manager.acquireLease(accounts);
  assert.ok(lease1);
  assert.equal(manager.getInFlight(accounts[0].id), 1);

  let queuedAcquired = false;
  // Queue a second request in background
  const queuedPromise = manager.acquireLease(accounts).then((l) => {
    queuedAcquired = true;
    return l;
  });

  await wait(200);
  assert.equal(queuedAcquired, false, 'Second request must be waiting in queue');

  // Release first lease
  lease1.release();

  // Queued request should now immediately resolve
  const lease2 = await queuedPromise;
  assert.ok(lease2, 'Queued lease must be acquired after slot freed');
  assert.equal(queuedAcquired, true);

  lease2.release();
});

test('concurrent streaming requests run in parallel across accounts without retry after stream start', async () => {
  const accounts = createMockAccounts(3);
  const manager = new ConcurrencyLeaseManager({
    maxConcurrentRequestsPerAccount: 5,
  });

  // Track concurrent executions
  let activeConcurrentStreams = 0;
  let peakConcurrentStreams = 0;
  const inFlightPerAccount = new Map<string, number>();

  const runStreamingRequest = async (requestId: number) => {
    const lease = await manager.acquireLease(accounts);
    assert.ok(lease, `Request ${requestId} must acquire a lease`);

    const accId = lease.account.id;
    inFlightPerAccount.set(accId, (inFlightPerAccount.get(accId) || 0) + 1);
    activeConcurrentStreams++;
    peakConcurrentStreams = Math.max(peakConcurrentStreams, activeConcurrentStreams);

    // Simulate streaming transmission (first chunk sent, then duration)
    let streamStarted = false;
    let chunksSent = 0;

    // First byte sent:
    streamStarted = true;
    chunksSent++;

    // Hold connection open to simulate concurrent streaming
    await wait(80);
    chunksSent++;

    // Stream ends cleanly:
    inFlightPerAccount.set(accId, inFlightPerAccount.get(accId)! - 1);
    activeConcurrentStreams--;
    lease.release();

    return { requestId, accountId: accId, chunksSent, streamStarted };
  };

  // Launch 12 streaming requests concurrently
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => runStreamingRequest(i + 1))
  );

  assert.equal(results.length, 12);
  assert.ok(peakConcurrentStreams > 1, 'Requests must run concurrently in parallel');
  assert.equal(activeConcurrentStreams, 0, 'All streams must have concluded');

  // Verify accounts were used evenly
  const usageCount: Record<string, number> = {};
  for (const r of results) {
    usageCount[r.accountId] = (usageCount[r.accountId] || 0) + 1;
    assert.equal(r.streamStarted, true);
    assert.equal(r.chunksSent, 2);
  }

  // 12 requests across 3 accounts = 4 requests each
  assert.deepEqual(Object.values(usageCount), [4, 4, 4]);
});


test('cooldown is scoped per model: a burn on one model leaves the account usable for others', async () => {
  const accounts = createMockAccounts(2);
  const manager = new ConcurrencyLeaseManager({ maxConcurrentRequestsPerAccount: 5 });

  // Account 1 burns its quota on claude-sonnet only.
  manager.markCooldown(accounts[0].id, 60_000, 'claude-sonnet-4');

  assert.equal(
    manager.isAccountModelInCooldown(accounts[0].id, 'claude-sonnet-4'),
    true,
    'must be cooling down for the model that failed'
  );
  assert.equal(
    manager.isAccountModelInCooldown(accounts[0].id, 'gemini-2.5-pro'),
    false,
    'a different model must NOT be blocked'
  );

  // A gemini request must still be allowed onto account 1.
  const lease = await manager.acquireLease(accounts, { model: 'gemini-2.5-pro' });
  assert.ok(lease);
  assert.equal(lease.account.id, accounts[0].id, 'account 1 must serve gemini traffic');
  lease.release();
});

test('a cooldown with no model applies to every model (account-wide)', async () => {
  const accounts = createMockAccounts(2);
  const manager = new ConcurrencyLeaseManager({ maxConcurrentRequestsPerAccount: 5 });

  manager.markCooldown(accounts[0].id, 60_000); // no model => wildcard

  assert.equal(manager.isAccountModelInCooldown(accounts[0].id, 'gemini-2.5-pro'), true);
  assert.equal(manager.isAccountModelInCooldown(accounts[0].id, 'claude-sonnet-4'), true);
  assert.equal(manager.isAccountInCooldown(accounts[0].id), true);

  const lease = await manager.acquireLease(accounts, { model: 'gemini-2.5-pro' });
  assert.ok(lease);
  assert.equal(lease.account.id, accounts[1].id, 'must fall through to the healthy account');
  lease.release();
});

test('expired per-model cooldowns are pruned and do not block selection', async () => {
  const accounts = createMockAccounts(2);
  const manager = new ConcurrencyLeaseManager({ maxConcurrentRequestsPerAccount: 5 });

  manager.markCooldown(accounts[0].id, 20, 'gemini-2.5-pro');
  await wait(40);

  assert.equal(manager.isAccountModelInCooldown(accounts[0].id, 'gemini-2.5-pro'), false);
  assert.deepEqual(manager.getCooldownAccounts(), [], 'expired entries must be pruned');
});

test('getCooldownAccounts reports the model alongside the account', async () => {
  const accounts = createMockAccounts(2);
  const manager = new ConcurrencyLeaseManager({ maxConcurrentRequestsPerAccount: 5 });

  manager.markCooldown(accounts[0].id, 60_000, 'claude-sonnet-4');
  manager.markCooldown(accounts[1].id, 60_000); // account-wide

  const rows = manager.getCooldownAccounts();
  assert.equal(rows.length, 2);

  const scoped = rows.find((r) => r.accountId === accounts[0].id);
  assert.ok(scoped);
  assert.equal(scoped.model, 'claude-sonnet-4');

  const wildcard = rows.find((r) => r.accountId === accounts[1].id);
  assert.ok(wildcard);
  assert.equal(wildcard.model, undefined, 'account-wide cooldown has no model');
});

test('clearCooldown clears every model for that account only', async () => {
  const accounts = createMockAccounts(2);
  const manager = new ConcurrencyLeaseManager({ maxConcurrentRequestsPerAccount: 5 });

  manager.markCooldown(accounts[0].id, 60_000, 'gemini-2.5-pro');
  manager.markCooldown(accounts[0].id, 60_000, 'claude-sonnet-4');
  manager.markCooldown(accounts[1].id, 60_000, 'gemini-2.5-pro');

  manager.clearCooldown(accounts[0].id);

  assert.equal(manager.isAccountInCooldown(accounts[0].id), false);
  assert.equal(
    manager.isAccountModelInCooldown(accounts[1].id, 'gemini-2.5-pro'),
    true,
    'other accounts must be untouched'
  );
});
