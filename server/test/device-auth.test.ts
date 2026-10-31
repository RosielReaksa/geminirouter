import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DeviceTokenStore } from '../src/deviceAuth.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gr-device-test-'));
}

test('pairing returns a token that verifies, and the code is single use', () => {
  const store = new DeviceTokenStore(tempDir());
  const { code } = store.createPairingCode();

  const paired = store.pair(code, 'laptop');
  assert.ok(paired);
  assert.ok(paired.token.length >= 32);
  assert.equal(store.verify(paired.token), true);
  assert.equal(store.verify('not-a-token'), false);

  // Reusing the code must fail.
  assert.equal(store.pair(code, 'second'), null);
});

test('rejects a wrong code and rate-limits brute force', () => {
  const store = new DeviceTokenStore(tempDir());
  const { code } = store.createPairingCode();

  assert.equal(store.pair('000000' === code ? '111111' : '000000', 'x'), null);

  // Burn the per-request window; after the limit even the right code fails.
  for (let i = 0; i < 20; i += 1) store.pair('999999', 'x');
  assert.equal(store.pair(code, 'x'), null);
  assert.equal(store.list().length, 0);
});

test('exposes devices without their hashes and supports revocation', () => {
  const store = new DeviceTokenStore(tempDir());
  const { code } = store.createPairingCode();
  const paired = store.pair(code, 'desktop')!;

  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'desktop');
  assert.equal('hash' in listed[0], false);

  assert.equal(store.revoke(paired.device.id), true);
  assert.equal(store.verify(paired.token), false);
  assert.equal(store.revoke(paired.device.id), false);
});

test('persists devices across restarts', () => {
  const dir = tempDir();
  const first = new DeviceTokenStore(dir);
  const { code } = first.createPairingCode();
  const paired = first.pair(code, 'persisted')!;

  const second = new DeviceTokenStore(dir);
  assert.equal(second.verify(paired.token), true);
  assert.equal(second.list().length, 1);
});

test('an expired code cannot be used', () => {
  const store = new DeviceTokenStore(tempDir());
  const { code } = store.createPairingCode();
  const internal = store as unknown as { activeCode: { code: string; expiresAt: number; attempts: number } };
  internal.activeCode.expiresAt = Date.now() - 1;

  assert.equal(store.pair(code, 'late'), null);
});
