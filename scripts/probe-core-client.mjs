#!/usr/bin/env node
/**
 * Probes whether Google still accepts the OAuth client embedded in the core.
 *
 * It sends the client credentials with a deliberately invalid refresh token:
 *   - HTTP 400 invalid_grant      -> client is ACCEPTED (expected)
 *   - HTTP 401 invalid_client     -> client was revoked/blocked
 *   - HTTP 400 unauthorized_client-> client is not allowed this grant
 *
 * No real token is used or transmitted, and the secret is never printed.
 * The result is written to .data/core-client-health.json for /api/status.
 *
 * Exit codes: 0 accepted, 2 blocked, 3 unknown/network.
 */
import fs from 'node:fs';
import path from 'node:path';

const CORE_MAIN_PATH =
  process.env.CORE_MAIN_PATH || '/opt/geminirouter/core/dist/core/main.cjs';
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), '.data');
const STATE_FILE = path.join(DATA_DIR, 'core-client-health.json');
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';

const CLIENT_ID_RE = /([0-9]{8,}-[a-z0-9]+\.apps\.googleusercontent\.com)/;
const CLIENT_SECRET_RE = /(GOCSPX-[A-Za-z0-9_-]+)/;

const json = process.argv.includes('--json');
const quiet = process.argv.includes('--quiet');

function writeState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    if (!quiet) console.error(`warning: could not write ${STATE_FILE}: ${error.message}`);
  }
}

function finish(state, exitCode) {
  writeState(state);
  if (json) console.log(JSON.stringify(state));
  else if (!quiet) {
    console.log(`client: ${state.state}`);
    console.log(`detail: ${state.detail}`);
  }
  process.exitCode = exitCode;
}

let bundle;
try {
  bundle = fs.readFileSync(CORE_MAIN_PATH, 'utf8');
} catch (error) {
  finish(
    {
      checkedAt: new Date().toISOString(),
      state: 'unknown',
      detail: `cannot read ${CORE_MAIN_PATH}: ${error.message}`,
    },
    3,
  );
  process.exit();
}

const clientId = bundle.match(CLIENT_ID_RE)?.[1];
const clientSecret = bundle.match(CLIENT_SECRET_RE)?.[1];
if (!clientId || !clientSecret) {
  finish(
    {
      checkedAt: new Date().toISOString(),
      state: 'unknown',
      detail: 'no OAuth client credentials found in the core bundle',
    },
    3,
  );
  process.exit();
}

let response;
let payload = {};
try {
  response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: 'framecall-probe-invalid-refresh-token',
    }),
    signal: AbortSignal.timeout(15000),
  });
  payload = await response.json().catch(() => ({}));
} catch (error) {
  finish(
    {
      checkedAt: new Date().toISOString(),
      state: 'unknown',
      clientId,
      detail: `probe request failed: ${error.message}`,
    },
    3,
  );
  process.exit();
}

const errorCode = typeof payload.error === 'string' ? payload.error : '';
const base = {
  checkedAt: new Date().toISOString(),
  clientId,
  httpStatus: response.status,
  errorCode: errorCode || undefined,
};

if (errorCode === 'invalid_grant') {
  finish(
    {
      ...base,
      state: 'ok',
      detail: 'client credentials accepted (bogus refresh token rejected as expected)',
    },
    0,
  );
} else if (errorCode === 'invalid_client' || errorCode === 'unauthorized_client') {
  finish(
    {
      ...base,
      state: 'blocked',
      detail: 'Google rejected the client credentials — the client is revoked or blocked',
    },
    2,
  );
} else {
  finish(
    {
      ...base,
      state: 'unknown',
      detail: `unexpected token response (HTTP ${response.status}, error=${errorCode || 'none'})`,
    },
    3,
  );
}
