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

Each key gets its own free-tier budget, configurable through the environment:

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_RPM` | 15 | requests per minute per key |
| `GEMINI_API_TPM` | 250000 | tokens per minute per key |
| `GEMINI_API_RPD` | 500 | requests per day per key |

The pool picks the least-used key with capacity, counts the request and an
estimated token cost before calling Google, and benches a key for its
`Retry-After` when Google returns 429. A 401/403 benches the key for five
minutes; a 5xx for thirty seconds. If every key is exhausted the client gets a
429 with an OpenAI-style error.

Adding more keys raises the pool's total RPM, TPM and RPD. The dashboard shows
current-minute and current-day usage per key.

## Routing

`POST /v1/chat/completions` is intercepted when:

- the model is `gemini-3.1-flash-lite` or `gemini-3.5-flash-lite`, and
- at least one enabled key exists.

The request is forwarded to
`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` with
the selected key. Both JSON and SSE streaming are supported. The response carries
`x-egress-provider: gemini-api`.

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