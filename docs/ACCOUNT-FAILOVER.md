# Account failover in geminirouter

## Who owns what

**Per-request account selection and quota failover are owned by the AntigravityManager core, not by this bridge.** The core holds the Google OAuth tokens (in its local database) and injects per-account credentials into every upstream request. The bridge (`server/`) cannot select accounts because it has no credentials — it proxies `/v1/*` to the core gateway and passes the core's answers through unchanged, including errors.

The bridge's job is: expose the core's scheduling knobs (`/api/config`), report real observed state (`/api/status`), and never fake success.

## How the core rotates accounts (verified in source)

Core repo: `github.com/Draculabo/AntigravityManager`. The core is an external dependency and is not bundled with this repository; the bridge locates it via `CORE_MAIN_PATH` (or `CORE_HOME`).

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
1. Evaluates all healthy accounts in the pool (status !== 'error', not cooling down **for the requested model**, in-flight < per-account cap).
2. Sends each new request to the account with the **fewest in-flight leases** (`min(inFlight)`).
3. Breaks ties by **least quota used** (highest remaining quota percentage).
4. Guarantees balance: across $N$ accounts, the difference between the most loaded and least loaded account ($\max - \min$) is always $\le 1$.

The bridge's lease manager caps in-flight requests per account. The core makes the final
account choice, because it is the only process holding the Google OAuth tokens and the
per-model quota picture. See "Per-Request Account Pinning" below.

### Parallel Capacity & Cap Configuration
- Total parallel capacity = `healthyAccounts.length * maxConcurrentRequestsPerAccount`.
- `maxConcurrentRequestsPerAccount`: configurable in `store.ts` / `/api/config` / `MAX_CONCURRENT_REQUESTS_PER_ACCOUNT` env var (default: 10).
- When all accounts are at their cap, the behavior is governed by `capacityPolicy`:
  - `'queue'` (default): pauses incoming requests and queues them up to `queueTimeoutMs` (default: 5000ms) for an active lease to free up.
  - `'reject_429'`: immediately returns `HTTP 429 Too Many Requests` with a `Retry-After: 1` header.

### Stream Safety Rule
- If the upstream gateway or account returns HTTP 429 or quota error *before the first response chunk is sent*, the account is marked in cooldown and the request transparently retries on the next available account.
- Cooldowns are keyed by `accountId + model`, so a quota burn on one model (e.g. Claude) does not remove the account from unrelated models (e.g. Gemini). A cooldown recorded without a model applies to every model.
- Cooldown is applied to the account the **core reports** in `x-antigravity-account-id`, not the account the bridge leased — the core may fall back to a different account, and the wrong account must not be quarantined.
- Once the first byte has been streamed to the client (`streamStarted === true`), **the request is NEVER retried**, preventing corrupted or duplicated responses.

### Outbound Proxy Support
- The AntigravityManager core natively supports per-account outbound proxies via `account.proxy_url` (stored in the SQLite database and passed to the upstream Google HTTP client). Per-account proxying is optional.

## Per-Request Account Pinning

Upstream account choice must ultimately be made by the core, because only the core holds the Google OAuth tokens and the per-model quota and rate-limit state.

### Normal traffic: the core selects (no pin)

`server/src/v1Proxy.ts` deliberately does **not** send `x-account-id` on ordinary `/v1/*` requests. Pinning every request would bypass three core behaviours that matter under load:

1. **Per-model rate limits** — the core's `rate-limit-tracker.service.ts` keys limits by `accountId + model`, so a Claude quota burn does not stop Gemini traffic.
2. **Quota-weighted round-robin** — accounts at ≥75% remaining get weight 3, ≥25% weight 2, below that weight 1, so traffic flows toward healthy accounts.
3. **Session affinity** — multi-turn conversations stick to one account instead of bouncing.

Pinning also caused a correctness bug: when the pinned account was ineligible the core silently fell back to another account, and the bridge then cooled down the account it had *asked for* rather than the one that actually failed.

The bridge still reads `x-antigravity-account-id` off the upstream response to attribute traffic records and cooldowns to the account that really served the request.

### Single-account tests: explicit pin

`server/src/accountTester.ts` posts **directly to the core gateway** with `x-account-id` + `x-single-account: true`. The pin makes the core target exactly that account; `x-single-account` caps the core's retry count at 1 so a test never silently fails over to a different account and reports a false pass.

The core patch backing this is `src/modules/proxy-gateway/server/common/pinned-account-context.ts` (an `AsyncLocalStorage` request context; a Fastify `onRequest` hook reads `x-account-id` and `x-single-account`), wired into `account-lease.service.ts` (`pinnedAccountId`) and `account-lease-selection.policy.ts` (`pickPinnedCandidate`, which honours an eligible pin and falls back to normal selection when the pin is cooling down, rate-limited, or unknown).

Verified by: `src/tests/unit/pinned-account-selection.test.ts` (8 tests) plus the 12 pre-existing policy tests (no regression).

**Activation note:** the pinning support must be present in the core build you deploy (`CORE_MAIN_PATH`). An unpatched Antigravity Manager desktop build silently ignores the pin, so if single-account tests appear to fail over, verify you are running a core build that includes `pinned-account-context.ts`.

### Why not pin every request?

Pinning every request was the original design (Option A) and it made the bridge's lease counts authoritative. It was removed because the core's own selection is strictly better informed, and because the pin's silent fallback corrupted the bridge's cooldown bookkeeping. `ConcurrencyLeaseManager` still owns per-account in-flight caps — the core has no equivalent for chat requests.

### Option B — FUTURE (not built): one core process per account

If per-account process isolation or multi-core CPU parallelism is ever needed (e.g. very large-context payloads saturating a single event loop):

- Run $N$ standalone core instances, each with its own profile directory holding exactly one account and its own gateway port (8045, 8046, ...).
- The bridge already selects the account per request; it would map `account.id -> port` and route to that core.
- Trade-offs vs Option A: ~100–150 MB RAM per account, $N$ profile directories and OAuth setups, $N$ ports to firewall — but per-account crash isolation and real multi-core scaling.
- Option A does not block this later: a patched core can also be run per-account.

- It does not fabricate accounts, quotas, or OAuth sessions. With the core offline, `/api/oauth/start` and `/api/oauth/complete` return 503 errors, and quota refresh returns the last known data unchanged.
