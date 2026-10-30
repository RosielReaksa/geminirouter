#!/usr/bin/env node
/**
 * Detects when Antigravity's public OAuth client credentials change upstream.
 *
 * The core ships a public client_id/client_secret. If Google rotates them, new
 * sign-ins start failing until the core is rebuilt. This script compares the
 * credential fingerprint embedded in the DEPLOYED core bundle with the one in
 * the upstream public source and records the result for /api/status.
 *
 * It never prints the client secret.
 *
 * Exit codes: 0 = unchanged, 2 = drift (update the core), 3 = check failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UPSTREAM_URL =
  process.env.CORE_CREDENTIALS_URL ||
  'https://raw.githubusercontent.com/Draculabo/AntigravityManager/main/src/modules/cloud-account/services/OAuthClientRegistryService.ts';
const CORE_MAIN_PATH =
  process.env.CORE_MAIN_PATH || '/opt/geminirouter/core/dist/core/main.cjs';
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), '.data');
const STATE_FILE = path.join(DATA_DIR, 'core-credentials.json');

const CLIENT_ID_RE = /([0-9]{8,}-[a-z0-9]+\.apps\.googleusercontent\.com)/;
const CLIENT_SECRET_RE = /(GOCSPX-[A-Za-z0-9_-]+)/;

const json = process.argv.includes('--json');
const quiet = process.argv.includes('--quiet');

function fingerprint(clientId, clientSecret) {
  return crypto.createHash('sha256').update(`${clientId}:${clientSecret}`).digest('hex').slice(0, 16);
}

function extract(text) {
  const id = text.match(CLIENT_ID_RE);
  const secret = text.match(CLIENT_SECRET_RE);
  if (!id || !secret) return null;
  return { clientId: id[1], fingerprint: fingerprint(id[1], secret[1]) };
}

function writeState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    if (!quiet) console.error(`warning: could not write ${STATE_FILE}: ${error.message}`);
  }
}

function fail(reason, extra = {}) {
  const state = { checkedAt: new Date().toISOString(), error: reason, ...extra };
  writeState(state);
  if (json) console.log(JSON.stringify(state));
  else if (!quiet) console.error(`[core-credentials] check failed: ${reason}`);
  process.exit(3);
}

let deployedText;
try {
  deployedText = fs.readFileSync(CORE_MAIN_PATH, 'utf8');
} catch (error) {
  fail(`cannot read deployed core bundle at ${CORE_MAIN_PATH}: ${error.message}`, {
    coreMainPath: CORE_MAIN_PATH,
  });
}

const deployed = extract(deployedText);
if (!deployed) {
  fail(`no OAuth client credentials found in ${CORE_MAIN_PATH}`, { coreMainPath: CORE_MAIN_PATH });
}

let upstreamText;
try {
  const response = await fetch(UPSTREAM_URL, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'geminirouter-credential-check' },
  });
  if (!response.ok) fail(`upstream returned HTTP ${response.status}`, { source: UPSTREAM_URL });
  upstreamText = await response.text();
} catch (error) {
  fail(`cannot fetch upstream source: ${error.message}`, { source: UPSTREAM_URL });
}

const upstream = extract(upstreamText);
if (!upstream) {
  fail('no OAuth client credentials found in upstream source (file layout changed?)', {
    source: UPSTREAM_URL,
  });
}

const drift = deployed.fingerprint !== upstream.fingerprint;
const state = {
  checkedAt: new Date().toISOString(),
  drift,
  coreMainPath: CORE_MAIN_PATH,
  source: UPSTREAM_URL,
  deployed: { clientId: deployed.clientId, fingerprint: deployed.fingerprint },
  upstream: { clientId: upstream.clientId, fingerprint: upstream.fingerprint },
};

writeState(state);

if (json) {
  console.log(JSON.stringify(state));
} else if (!quiet) {
  console.log(`deployed core: ${deployed.clientId} (${deployed.fingerprint})`);
  console.log(`upstream source: ${upstream.clientId} (${upstream.fingerprint})`);
  if (drift) {
    console.log('[core-credentials] DRIFT: upstream credentials differ — update the core bundle.');
  } else {
    console.log('[core-credentials] OK: deployed credentials match upstream.');
  }
}

// Use exitCode instead of process.exit(): forcing exit while undici is closing
// its keep-alive sockets crashes Node on Windows.
process.exitCode = drift ? 2 : 0;
