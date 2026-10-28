# Account failover in geminirouter

## Who owns what

**Per-request account selection and quota failover are owned by the AntigravityManager core, not by this bridge.** The core holds the Google OAuth tokens (in its local database) and injects per-account credentials into every upstream request. The bridge (`server/`) cannot select accounts because it has no credentials — it proxies `/v1/*` to the core gateway and passes the core's answers through unchanged, including errors.

The bridge's job is: expose the core's scheduling knobs (`/api/config`), report real observed state (`/api/status`), and never fake success.

## How the core rotates accounts (verified in source)

Core repo: `github.com/Draculabo/AntigravityManager` (local clone: `D:/projectradom/AntigravityManager`).

| Behavior | Where it lives |
|---|---|
| Account selection policy: quota-aware weights, cooldown skipping, session affinity, `scheduling_mode` (`cache-first` / `balance` / `performance-first`), `account_selection_strategy` (`balanced` / `account-first`), `preferred_account_id`, `max_wait_ms` | `src/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-selection.policy.ts` |
| Retry/failover loop: `attemptedAccountIds` exclusion set, next-account lease, penalty marking on upstream errors | `src/modules/proxy-gateway/server/shared/services/proxy-retry.service.ts` |
| 429 / quota detection: upstream status, `Retry-After` header, structured `QUOTA_EXHAUSTED` markers; explicit long quota locks vs transient 5-minute cooldowns | `src/modules/proxy-gateway/server/shared/services/rate-limit-tracker.service.ts` and `docs/modules/proxy-gateway/compatibility.md` ("Explicit Quota Resets and Flash Routes") |
| Pool exhausted: `ProxyAccountUnavailableError` with HTTP 429 or 503 + `retryAfterSeconds`; `Retry-After` response header set by the controller | `src/modules/proxy-gateway/server/common/exceptions/proxy-account-unavailable.exception.ts` and `src/modules/proxy-gateway/server/common/base-proxy.controller.ts:13-21` |
| No retry once streaming has started | `docs/modules/proxy-gateway/compatibility.md`: "Once any response event has been sent, the gateway does not replay the request against another account because that could duplicate visible output or tool calls." |
| Cooldown expiry | Time-based inside the core's rate-limit tracker; cooldowns expire on their own schedule (upstream `Retry-After` or the backoff ladder `circuit_breaker_backoff_steps`, default `[60, 300, 1800, 7200]` seconds). A quota refresh does not clear an explicit quota lock early. |

So the outcome for clients is exactly the goal: when the active account hits a quota or rate limit, the core retries the request on the next eligible account **before any byte is streamed**; only when the whole pool is exhausted does the client see 429/503 with a `Retry-After` header carrying the earliest reset.

## Bridge config mapping (`/api/config`)

The core reads its scheduling settings from the `proxy` section of `~/.antigravity-agent/gui_config.json`. The bridge maps dashboard fields onto those real settings (`server/src/pool-state.ts`):

| Dashboard field | Core setting |
|---|---|
| `autoSwitchOnQuotaLimit` | `quota_aware_scheduling_enabled` |
| `rotationStrategy: least-used-quota` / `round-robin` | `scheduling_mode: balance` + `account_selection_strategy: balanced` |
| `rotationStrategy: priority-order` | `scheduling_mode: performance-first` + `account_selection_strategy: account-first` |
| `rotationStrategy: pinned-account` + `pinnedAccountId` | `account_selection_strategy: account-first` + `preferred_account_id` |
| `autoCooldownMinutes` | **not mapped** — the core has no single minutes value; cooldowns come from upstream `Retry-After` and `circuit_breaker_backoff_steps`. The core ladder is surfaced read-only in `GET /api/config` → `coreScheduling.circuit_breaker_backoff_steps`. |

`POST /api/config` writes the mapped patch into the core profile file (atomic write, never touching `api_key`). If a desktop app or standalone core is running, it may hold its own in-memory copy; the response's `coreApply.note` says so honestly. `GET /api/config` reflects the core's real current settings back into the dashboard fields.

## Bridge reporting (`/api/status`)

All numbers are derived from real traffic records and core-reported account states (`derivePoolState` in `server/src/pool-state.ts`):

- `requestsLast24h`, `tokensLast24h`, `averageLatencyMs`, `successRate` — computed from real records; `null` when there are none.
- `activeBackingAccountEmail` — the account that served the most recent real request.
- `cooldownAccounts` — accounts the core reported as `rate_limited` / `expired` (surfaced with status `cooldown`/`error` in account views).
- `lastSwitch` — the most recent observed backing-account change in traffic attribution (`reason: 'observed-account-change'`; the core does not expose its internal switch reason).
- `healthy` — computed: gateway port answering AND (an active account OR core reachable). Never hardcoded.

## Concurrency Leases & Parallel N-Account Balancing

geminirouter supports $N$ Google accounts in a single pool, serving many concurrent requests across all healthy accounts in parallel (similar to OpenRouter).

### Selection Algorithm
1. Evaluates all healthy accounts in the pool (status !== 'error', not in cooldown, in-flight < per-account cap).
2. Sends each new request to the account with the **fewest in-flight leases** (`min(inFlight)`).
3. Breaks ties by **least quota used** (highest remaining quota percentage).
4. Guarantees balance: across $N$ accounts, the difference between the most loaded and least loaded account ($\max - \min$) is always $\le 1$.

### Parallel Capacity & Cap Configuration
- Total parallel capacity = `healthyAccounts.length * maxConcurrentRequestsPerAccount`.
- `maxConcurrentRequestsPerAccount`: configurable in `store.ts` / `/api/config` / `MAX_CONCURRENT_REQUESTS_PER_ACCOUNT` env var (default: 10).
- When all accounts are at their cap, the behavior is governed by `capacityPolicy`:
  - `'queue'` (default): pauses incoming requests and queues them up to `queueTimeoutMs` (default: 5000ms) for an active lease to free up.
  - `'reject_429'`: immediately returns `HTTP 429 Too Many Requests` with a `Retry-After: 1` header.

### Stream Safety Rule
- If the upstream gateway or account returns HTTP 429 or quota error *before* the first response chunk is sent, the account is marked in cooldown and the request transparently retries on the next available account.
- Once the first byte has been streamed to the client (`streamStarted === true`), **the request is NEVER retried**, preventing corrupted or duplicated responses.

### Outbound Proxy Support
- The AntigravityManager core natively supports per-account outbound proxies via `account.proxy_url` (stored in the SQLite database and passed to the upstream Google HTTP client). Per-account proxying is optional.

- It does not fabricate accounts, quotas, or OAuth sessions. With the core offline, `/api/oauth/start` and `/api/oauth/complete` return 503 errors, and quota refresh returns the last known data unchanged.
