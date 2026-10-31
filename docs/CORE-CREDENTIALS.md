# Core OAuth credential lifecycle

> Step-by-step recovery for each failure (blocked sign-ins, revoked client,
> IP/account limits) lives in
> [CLIENT-BLOCKED-RECOVERY.md](./CLIENT-BLOCKED-RECOVERY.md).

Antigravity sign-in uses the OAuth client that ships inside the open-source
AntigravityManager core. Its `client_id` and `client_secret` are **publicly
committed** in the upstream repository and embedded in the built
`dist/core/main.cjs`:

```
src/modules/cloud-account/services/OAuthClientRegistryService.ts
  const CLIENT_ID = '1071006060591-….apps.googleusercontent.com'
  const CLIENT_SECRET = 'GOCSPX-…'
```

This is normal for a desktop/public OAuth client, but it means Google can rotate
or revoke those credentials at any time.

## Why we cannot substitute our own client

Google blocks any other client from requesting Antigravity's private
`https://www.googleapis.com/auth/aicode` scope:

```
Error 400: invalid_scope
```

`ANTIGRAVITY_OAUTH_CLIENTS` / `ANTIGRAVITY_OAUTH_CLIENT_KEY` exist in the core,
but they only help for clients that are already allowed those scopes. A
self-registered web client is not, so the built-in Antigravity client is the
only working option.

## Failure modes: what we can and cannot fix

| Mode | Symptom | Fixable by us? |
|---|---|---|
| **Secret rotated**, same client ID | new sign-ins fail; old accounts keep refreshing | ✅ yes — rebuild from upstream |
| **Client revoked / app blocked** | `invalid_client`; nobody can sign in, and refresh stops | ❌ no — only upstream can publish a new client |
| **Account flagged** (per user) | one account needs reauth, others fine | ✅ yes — reconnect that account |
| **IP / rate limited** | intermittent 429s or blocked sign-ins from one server | ✅ partly — back off, change IP, per-account proxy |
| **`aicode` scope revoked** | `invalid_scope` on the consent screen | ❌ no — same as blocked |

The important distinction: **rotation is recoverable, revocation is not.** Because
we cannot register our own client for the private `aicode` scope, a blocked
client can only be fixed by the upstream project shipping a new one (or Google
unblocking it). Every Antigravity user is affected at the same time, which is
why upstream usually resolves it quickly.

## Can we tell "blocked" apart from "rotated"?

Yes. `scripts/probe-core-client.mjs` sends the deployed client credentials to
Google's token endpoint with a deliberately invalid refresh token. Google's
error code classifies the client without touching real tokens:

| Google response | Meaning |
|---|---|
| `400 invalid_grant` | client is **accepted** (the dummy token was rejected, as expected) |
| `401 invalid_client` | client is **revoked or blocked** |
| `400 unauthorized_client` | client is not allowed the refresh grant |

## Detection

`geminirouter-core-creds.timer` runs `scripts/check-core-credentials.mjs` daily.
It compares the credential fingerprint in the deployed bundle against the public
upstream source and writes `.data/core-credentials.json`, which `/api/status`
exposes as `coreCredentials`:

```json
{ "checkedAt": "…", "drift": true, "deployed": {…}, "upstream": {…} }
```

Exit codes: `0` unchanged, `2` drift, `3` check failed.

`scripts/probe-core-client.mjs` writes `.data/core-client-health.json` with
`{ state: "ok" | "blocked" | "unknown", errorCode, httpStatus }`. `/api/status`
merges it into `coreCredentials.clientHealth`, and the timer runs it right after
the drift check. Exit codes: `0` accepted, `2` blocked, `3` unknown.

`/api/status` also reports `accountsNeedingReauth`, the number of accounts whose
OAuth refresh is blocked or expired. A sudden jump is the first symptom of a
revoked client.

Run either check manually:

```bash
sudo systemctl start geminirouter-core-creds
journalctl -u geminirouter-core-creds -n 30 --no-pager
# or directly:
sudo -u geminirouter node /opt/geminirouter/scripts/probe-core-client.mjs
```

## Response runbook

1. **Confirm** — `sudo systemctl start geminirouter-core-creds` and read the log:
   ```
   journalctl -u geminirouter-core-creds -n 20 --no-pager
   ```
   Or check `coreCredentials.drift` in `/api/status`.

2. **Get a new build.** Update the patched source clone (kept outside this
   repository) from upstream, or pull a new release, then build:
   ```bash
   cd /opt/core-src && git fetch && git reset --hard origin/main
   pnpm install --frozen-lockfile && pnpm run build:core
   ```

3. **Install it with rollback protection:**
   ```bash
   sudo ./deploy/update-core.sh --source /opt/core-src
   # or, with an already-built bundle:
   sudo ./deploy/update-core.sh --bundle /tmp/main.cjs
   ```
   The script backs up `dist/` **and** `cloud_accounts.db`, restarts the core,
   waits for `/v1/status`, and rolls back automatically on failure.

4. **Re-authorize only if needed.** Rotating the secret keeps the client ID, so
   existing refresh tokens usually survive. A revoked client requires users to
   sign in again.

5. **If the update fails:**
   ```bash
   sudo ./deploy/update-core.sh --rollback
   ```

## If the client itself is blocked

This is the one case the update script cannot fix by itself, because the
credentials are not the problem - Google refuses the client.

Short version: run the probe, check upstream for a new `CLIENT_ID`, rebuild with
`update-core.sh` if there is one, and expect accounts to re-authorize because
refresh tokens are bound to the client ID.

The full decision tree - blocked sign-ins vs revoked client vs IP/account
limits, including credential injection without a rebuild - is in
**[CLIENT-BLOCKED-RECOVERY.md](./CLIENT-BLOCKED-RECOVERY.md)**.

## Backups

`cloud_accounts.db` (in `$CORE_PROFILE`, default
`/home/geminirouter/.antigravity-agent`) holds every refresh token. Every
`update-core.sh` run copies it to
`/opt/geminirouter/backups/core-<timestamp>/cloud_accounts.db`. Keep those, or
add them to your normal backup job — losing this file loses all linked accounts.

## Notes

- Never put the client secret in this repository, logs, or API responses.
  `check-core-credentials.mjs` stores only a truncated SHA-256 fingerprint.
- Using someone else's OAuth client to serve your own users may breach Google's
  and Antigravity's terms; that risk is independent of this tooling.
- The core itself stays under CC BY-NC-SA 4.0 (see `NOTICE`). Patches and builds
  derived from it are not covered by the Framecall license.
