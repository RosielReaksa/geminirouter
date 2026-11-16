# Recovery playbook: Antigravity client blocked, rotated or rate-limited

Antigravity sign-in uses a public OAuth client that ships inside the upstream
core. Google can rotate its secret, block new authorizations, or revoke the
client entirely. This file is the step-by-step response for each case.

Related: [CORE-CREDENTIALS.md](./CORE-CREDENTIALS.md) (credential drift, updates,
backups) and [ACCOUNT-FAILOVER.md](./ACCOUNT-FAILOVER.md) (routing).

---

## 0. Identify the failure first

```bash
# what the deployment thinks (the env file is root-readable, hence sudo)
sudo bash -c 'set -a; . /etc/geminirouter/geminirouter.env; set +a; \
  curl -s http://127.0.0.1:3000/api/status \
    -H "Authorization: Bearer $GEMINIROUTER_ADMIN_PASSWORD"' \
  | jq '{coreCredentials, accountsNeedingReauth, activeAccountsCount}'

# classify the deployed client (safe: uses a dummy refresh token)
sudo -u geminirouter node /opt/geminirouter/scripts/probe-core-client.mjs

# is the deployed bundle behind upstream?
sudo systemctl start geminirouter-core-creds
sudo journalctl -u geminirouter-core-creds -n 30 --no-pager
```

| Signal | Meaning |
|---|---|
| `clientHealth.state: ok` / `invalid_grant` | client is **accepted**; normal |
| `clientHealth.state: blocked` / `invalid_client` | client is **revoked or blocked** |
| `invalid_scope` on the consent screen | client cannot request `aicode` |
| `coreCredentials.drift: true` | upstream has newer credentials |
| `accountsNeedingReauth > 0` | some accounts need reconnection, client may be fine |

Decision tree:

```
clientHealth = ok?
├── yes → the problem is per-account or per-IP  → Case C
└── no  → is drift true?
          ├── yes → upstream has new credentials → Case B.2a
          └── no  → did the consent screen fail before redirect?
                    ├── yes → Case A (new authorizations blocked)
                    └── no  → Case B (client revoked)
```

---

## Case A — only *new authorizations* are blocked

Typical symptoms: "Access blocked", "app not verified", `invalid_scope`, or the
consent screen refuses before redirecting. Existing accounts keep refreshing.

**Do:**
1. Do not delete or re-add accounts — their refresh tokens still work.
2. Add accounts with **Accounts → Import accounts file**, exported from a machine
   where the official Antigravity app is still signed in.
3. Keep using the gateway normally.

**Do not:** retry the OAuth flow in a loop; repeated failures can make a rate
decision worse.

---

## Case B — the client is revoked (`invalid_client`)

This client is dead for everyone, including the official app. You need different
credentials.

### B.1 Confirm

```bash
sudo -u geminirouter node /opt/geminirouter/scripts/probe-core-client.mjs
# expect: state=blocked, errorCode=invalid_client
```

### B.2a Upstream already ships a new client

```bash
sudo systemctl start geminirouter-core-creds   # look for "drift": true upstream

# /opt/core-src is the patched core source kept outside this repository.
# If it does not exist yet, clone it there first (see CORE-CREDENTIALS.md).
cd /opt/core-src && git fetch && git reset --hard origin/main
pnpm install --frozen-lockfile && pnpm run build:core
sudo /opt/geminirouter/deploy/update-core.sh --source /opt/core-src
```

If you have no build environment on the VPS, build on your workstation and copy
the bundle, then run `update-core.sh --bundle /tmp/main.cjs`.

`update-core.sh` backs up `dist/` and `cloud_accounts.db`, restarts the core,
checks `/v1/status` and rolls back automatically on failure.

### B.2b Inject new credentials without rebuilding the core

The core reads extra clients from an environment file:

```
# /etc/geminirouter/oauth-clients.env
ANTIGRAVITY_OAUTH_CLIENTS=framecall_new|<client_id>|<client_secret>|Antigravity New
ANTIGRAVITY_OAUTH_CLIENT_KEY=framecall_new
```

Format: `key|client_id|client_secret|label`, entries separated by `;`.

The core unit must load it (already installed as a drop-in):

```
# /etc/systemd/system/geminirouter-core.service.d/oauth-clients.conf
[Service]
EnvironmentFile=/etc/geminirouter/oauth-clients.env
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart geminirouter-core
sudo -u geminirouter node /opt/geminirouter/scripts/probe-core-client.mjs
```

You can take the new `client_id` / `client_secret` from:

- a newer upstream release of `OAuthClientRegistryService.ts`, or
- a newer official Antigravity build (the credentials are public desktop-client
  values, not secrets).

### B.3 Expect re-authorization

Google ties refresh tokens to the `client_id` that minted them. Changing the
client ID means **existing accounts must sign in again**. The new client is not
blocked, so the consent screen works:

- desktop: run the Framecall Helper (relay mode), or
- any device: paste the failed callback URL (no download), or
- fastest: import tokens minted by the new client from a signed-in machine.

### B.4 Verify

```bash
sudo -u geminirouter node /opt/geminirouter/scripts/probe-core-client.mjs
# expect: state=ok, errorCode=invalid_grant
sudo bash -c 'set -a; . /etc/geminirouter/geminirouter.env; set +a; \
  curl -s http://127.0.0.1:3000/api/status \
    -H "Authorization: Bearer $GEMINIROUTER_ADMIN_PASSWORD"' | jq .healthy
```

---

## Case C — per-account or per-IP problems (client is fine)

Symptoms: `clientHealth.state: ok` but individual accounts fail, or sign-ins are
intermittent.

1. **Per-account flag** — reconnect that account:
   Accounts → the **Reauth Required** badge → **Reconnect account**.
   The account row, quotas and history are kept.
2. **IP-level block** — change the egress IP (new static IP / IPv6) or route
   per-account traffic through a proxy (`account.proxy_url` is supported by the
   core).
3. **Rate/abuse heuristics** — lower concurrency, pause the background model
   test matrix, stop retry loops during the incident.

---

## What does not work

- Registering our own Google client: Antigravity refuses the private
  `https://www.googleapis.com/auth/aicode` scope (`invalid_scope`).
- Importing accounts while the client is revoked: the core still has to refresh
  them with the same client.
- Any bypass of the block. There is none.

---

## Prevention checklist

- [ ] `geminirouter-core-creds.timer` enabled (daily drift + client probe).
- [ ] Backups of `cloud_accounts.db` kept outside the server.
- [ ] The patched core source kept at `/opt/core-src` for fast rebuilds.
- [ ] `accountsNeedingReauth` monitored — a jump is the earliest symptom.
- [ ] Import-from-export tested once, so Case A/B.3 is a known path.
- [ ] `update-core.sh --rollback` tested once.

---

## Legal note

Using Antigravity's OAuth client to serve your own users may breach Google's or
Antigravity's terms. That risk is unchanged by any of the tooling above, and a
blocked client is not a bug we can patch away.
