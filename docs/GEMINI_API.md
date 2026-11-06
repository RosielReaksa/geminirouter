# Gemini API Keys

The Gemini API page pools Google AI Studio keys for the two flash-lite models.
It exists so public traffic can use official API keys instead of routing OAuth
account tokens through a third-party gateway.

## Models

| Model | Served by |
|---|---|
| `gemini-3.1-flash-lite` | AI Studio key pool |
| `gemini-3.5-flash-lite` | AI Studio key pool |
| every other Gemini model | the OAuth account pool through the core |

The public website (`/models`, the landing page and the chatbot) exposes **only
the two flash-lite models**. The dashboard still lists the rest of the Gemini
catalog for account-pool management. Claude and GPT models are no longer exposed
anywhere on the website.

## Adding keys

1. Create a key at <https://aistudio.google.com/api-keys>.
2. Open **Gemini API** in the dashboard.
3. Paste one key per line (bulk add is supported) and press **Add keys**.

Keys are stored in the bridge state file (`.data/server-state.json`, mode
`0600`). The API returns only a masked value (`AQ.A…Yvpw`); the full key never
leaves the server.

## Rate limits

Each key is tracked **per model**, because AI Studio enforces separate limits for
each model:

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_RPM` | 15 | requests per minute per key/model |
| `GEMINI_API_TPM` | 250000 | tokens per minute per key/model |
| `GEMINI_API_RPD` | 500 | requests per day per key/model |
| `GEMINI_API_MAX_WAIT_MS` | 30000 | how long a request may wait for capacity |
| `GEMINI_API_CONCURRENCY` | 4 | concurrent calls per key |
| `GEMINI_API_QUEUE_LIMIT` | 200 | maximum queued requests |

RPM and TPM are **sliding token buckets**, not fixed calendar minutes, so a burst
at `:59` does not wait for the next minute. Requests that cannot be admitted wait
in a fair queue (round-robin across client IPs) for up to `maxWaitMs`; if the
wait expires the client gets a 429 with the earliest `Retry-After`. A key that
returns 429 is benched for Google's `Retry-After`; 401/403 benches the key for
five minutes; 5xx for thirty seconds.

## Egress proxies

The Gemini API keys can optionally leave through the Webshare inventory:

- Toggle **Egress proxies** on the Gemini API page.
- Each key gets one static proxy (least-used assignment); when there are more
  keys than proxies, extras share an IP.
- Assignments are persisted (`address:port` only, no credentials), so a restart
  keeps the same key on the same IP.
- The Test button and live traffic both use the assigned proxy.
- Key calls appear on the **Traffic** page as `Gemini API · <key label>`, with the
  egress IP they actually used (the key's proxy, or the gateway host when direct).
- Proxies change the **egress IP only**. They do not add RPM/TPM/RPD and do not
  bypass Google's project or account limits.

The inventory is the same list managed on the Proxy page. Account routing and key
routing are independent: you can use proxies for keys while account routing is
off, and vice versa.

## Routing

`gemini-3.1-flash-lite` and `gemini-3.5-flash-lite` can be served by **either**
the AI Studio key pool or the connected Google accounts. The Gemini API page
exposes three modes:

| Mode | Behaviour |
|---|---|
| **Balanced** (default) | Alternates between keys and accounts. If one side is out of capacity or cooling down, every call goes to the other side. |
| **API keys** | These two models use the key pool only. |
| **Accounts** | These two models use the connected accounts only. |

Key calls are forwarded to
`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` with
the selected key. Both JSON and SSE streaming are supported, and the response
carries `x-egress-provider: gemini-api`.

Account calls take the normal core path, so they appear on the Traffic page with
the account email and that account's egress proxy. Every other Gemini model always
uses the connected accounts.

The free tier is capped per key, project and model (500 requests/day for these
models). When a model's daily quota is exhausted, the key side serves the other
Flash Lite model instead of returning 429; the Traffic row shows the requested id
and the model that actually answered. The pool also parks the exhausted model
until Google's stated reset time, so later requests do not probe it again.

The bridge validates the caller's `Authorization: Bearer …` against the gateway
keys before using the pool. Without keys, or for any other model, the request
falls back to the normal core proxy path.

## Limitations

- Usage counters reset when the bridge restarts and at UTC midnight; they are
  operational counters, not billing records.
- Streamed responses record the estimated token cost because the OpenAI-compatible
  stream does not always include a usage block.
- The two models must be available to the key. Test a key from the dashboard; a
  bad key is reported without being used for traffic.