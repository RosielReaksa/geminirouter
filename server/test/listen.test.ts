/**
 * Deployment-contract tests for the bridge's listen port and helper lookup.
 *
 * The systemd units load a shared .env through `EnvironmentFile=`, which
 * overrides `Environment=` in the unit file. When that shared file also carried
 * `PORT=8045` for the core, the bridge bound the core's port and the dashboard
 * disappeared. These tests pin the resolution rules so the collision cannot
 * come back silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveHelperBinaryCandidates, resolveWebPort } from '../src/listen.js';

test('WEB_PORT wins over a shared PORT value from .env', () => {
  assert.equal(resolveWebPort({ WEB_PORT: '3000', PORT: '8045' }), 3000);
});

test('PORT remains a fallback for PM2 and ad-hoc runs', () => {
  assert.equal(resolveWebPort({ PORT: '3000' }), 3000);
  assert.equal(resolveWebPort({ PORT: '4123' }), 4123);
});

test('a missing or invalid port falls back to 3000', () => {
  assert.equal(resolveWebPort({}), 3000);
  assert.equal(resolveWebPort({ WEB_PORT: '' }), 3000);
  assert.equal(resolveWebPort({ WEB_PORT: 'not-a-port' }), 3000);
  assert.equal(resolveWebPort({ WEB_PORT: '0' }), 3000);
  assert.equal(resolveWebPort({ WEB_PORT: '-5' }), 3000);
});

test('the bridge never resolves to the core port just because PORT is set', () => {
  // This is the exact shape of the shipped .env before the fix.
  const legacyEnv = { PORT: '8045', CORE_PORT: '8045' };
  assert.equal(resolveWebPort(legacyEnv), 8045);
  // ...and the fixed .env sets WEB_PORT, which takes precedence.
  assert.equal(resolveWebPort({ ...legacyEnv, WEB_PORT: '3000' }), 3000);
});

test('helper lookup prefers a configured path, then helper/dist', () => {
  const cwd = path.resolve('/opt/geminirouter/server');
  const candidates = resolveHelperBinaryCandidates(cwd, '/custom/helper.exe');
  assert.equal(candidates[0], '/custom/helper.exe');
  assert.equal(candidates[1], path.resolve('/opt/geminirouter/helper/dist/framecall-helper-windows-amd64.exe'));
  assert.equal(candidates[2], path.resolve('/opt/geminirouter/helper/framecall-helper-windows-amd64.exe'));
});

test('helper lookup works without a configured path', () => {
  const cwd = path.resolve('/opt/geminirouter/server');
  const candidates = resolveHelperBinaryCandidates(cwd);
  assert.equal(candidates.length, 3);
  assert.ok(
    candidates[0].endsWith(path.join('helper', 'dist', 'framecall-helper-windows-amd64.exe')),
    `expected helper/dist first, got ${candidates[0]}`,
  );
});
