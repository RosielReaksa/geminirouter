# Proxy Routing (Webshare)

The Proxy page pins each pooled account to its own Webshare IP. It exists so a
pool of Google accounts does not all share the bridge host's single egress
address, which is what triggers IP-based rate limits.

The bridge does **not** proxy AI calls itself. It only decides which proxy each
account should use and hands that decision to the core. The core already owns
OAuth credentials, quota accounting, cooldown and failover, and it routes an
account's upstream traffic through `accounts.proxy_url`.

## How it works

1. `POST /api/proxy/config` (or `POST /api/proxy/refresh`, or the 10-minute
   timer) fetches the Webshare inventory.
2. The inventory is assigned least-used-first, with a round-robin tie-break, so
   accounts spread evenly across the available proxies.
3. Each account's `http://user:pass@host:port` is pushed to the core through the
   `accountSetProxy` RPC. The core persists it in `accounts.proxy_url`.
4. The core's own precedence is: **account `proxy_url`** → global
   `proxy.upstream_proxy` → `HTTP(S)_PROXY` environment. Per-account values win,
   which is why the dashboard only manages `proxy_url`.
5. Disabling routing pushes `proxyUrl: null` for every account, which clears the
   per-account override and returns traffic to the global/environment default.

Assignments survive an inventory refresh: an account keeps its proxy as long as
that proxy is still listed. If a proxy disappears, only the orphaned account is
re-assigned.

## Configuration

| Setting | Where | Notes |
|---|---|---|
| Webshare API key | Proxy page, or `WEBSHARE_API_KEY` | Stored in `.data/server-state.json`; never returned to the browser. An env key overrides the saved one at startup. |
| Auto-refresh interval | `WEBSHARE_REFRESH_INTERVAL_MS` | Default 600000 (10 min), floor 60000. |
| Routing on/off | Proxy page | Persisted. Enabling requires a stored key. |

The key is written the moment it is saved, so it survives a restart. The key is
only used against `proxy.webshare.io`; it is never forwarded to the core or to
an AI provider. The on/off choice is persisted as well, so a restart never
silently re-enables routing that the operator turned off.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/proxy/config` | Redacted snapshot: enabled, `hasApiKey`, counts, last fetch, last error. |
| `POST` | `/api/proxy/config` | Save key and/or toggle routing, refresh inventory, apply assignments. Always 200; failures surface in `error` / `sync.failed`. |
| `POST` | `/api/proxy/refresh` | Force an inventory refresh and re-apply assignments. |
| `GET` | `/api/proxy/list` | Inventory with the emails of the accounts pinned to each proxy. |

## Failure behaviour

- **Webshare unreachable**: the previous inventory and assignments stay live;
  `lastError` reports the failure and the UI shows it.
- **Core offline**: assignments cannot be pushed. The refresh result reports
  `failed` with the affected account ids; the next successful cycle retries.
- **New account added**: it is assigned on the next refresh cycle (10 minutes by
  default) or immediately via the Refresh button.
- **Proxy removed from the Webshare account**: only the accounts pinned to it
  are re-assigned.

## Applying changes to a running core

`accountSetProxy` writes `accounts.proxy_url` in the core database. The core's
gateway keeps its account tokens (including the resolved proxy URL) in memory
and only rebuilds that cache at startup or after an account reload, so a
**running core keeps using the previous proxy** until it reloads.

After the first enable, or after the assignment changes (a proxy was replaced),
restart the core once:

```bash
sudo systemctl restart geminirouter-core
```

Check the core log for `Proxy source: account proxy_url` when
`DEBUG_PROXY_TRACE=1`. A future core build exposes a reload RPC so the bridge can
do this automatically; until then, the restart is the reliable step.

## Verification

```bash
# after saving the key on the Proxy page
curl -s https://<your-host>/api/proxy/config -H "Authorization: Bearer <session>"
# expect enabled:true, hasApiKey:true, proxyCount > 0

# confirm the core received it (per account)
curl -s https://<your-host>/api/proxy/list -H "Authorization: Bearer <session>"
```

On the core host, the same values appear in the account rows, and the core logs
`[GoogleAPIService] Proxy source: account proxy_url` when `DEBUG_PROXY_TRACE=1`.

## Limitations

- Only traffic the core sends on behalf of an account is proxied. The bridge's
  own calls (dashboard, audit DB, model listing) still leave from the bridge IP.
- Proxying is per account, not per request: every request for that account uses
  its assigned IP until the assignment changes.
- If the core is an older build without `accountSetProxy`, assignments fail with
  `core rejected the update`; upgrade the core.