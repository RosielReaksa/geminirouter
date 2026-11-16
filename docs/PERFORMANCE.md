# Call performance guide

Measured on the live `framecall.site` gateway with a small prompt
("Reply with the single word ok") and `gemini-3.5-flash-lite`:

| Path | Time to first byte | Total |
|---|---:|---:|
| Direct core (`127.0.0.1:8046`) | 1.45–2.03 s | 1.45–2.03 s |
| Public gateway (`framecall.site`) | 1.32–2.03 s | 1.32–2.03 s |
| Public streaming (`stream: true`) | 1.40 s | 1.95 s |

The public gateway adds no measurable latency over the core. The remaining time
is model thinking and provider generation, not routing.

## Model speed

Same prompt, `max_tokens: 48`, non-streaming:

| Model | Total | Notes |
|---|---:|---|
| `gemini-2.5-flash-lite` | 0.99–1.15 s | fastest, no reasoning pass |
| `gemini-3.1-flash-lite` | 0.96–1.53 s | fast, good default for chat |
| `gemini-3.5-flash-lite` | 1.30–2.05 s | better quality, adds ~150–300 reasoning tokens |
| `gemini-3.8-flash-high` | 4.41 s | high reasoning, slow |
| `gemini-3-flash` | 503 | not entitled on the current account pool |

Use a `*-flash-lite` model for interactive calls. Use a high model only when
answer quality matters more than latency.

## Streaming

Streaming is supported end to end and is never compressed or buffered:

```text
content-type: text/event-stream
content-encoding: (none)
```

It cuts perceived latency to the first token. For anything longer than a short
answer, send `stream: true`:

```sh
curl -N https://framecall.site/v1/chat/completions \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-lite",
    "stream": true,
    "max_tokens": 2048,
    "messages": [{"role": "user", "content": "Explain HLS in 5 lines."}]
  }'
```

The Gemini-native route also streams:

```text
POST /v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse
```

## Timeouts

| Layer | Limit |
|---|---|
| Caddy `/v1/*`, `/v1beta/*` read timeout | 7,200 s |
| Bridge upstream response timeout | 900 s |
| Bridge Playground timeout | 180 s |
| Media transcription total timeout | 2 h |

Set client timeouts to at least 60 s for non-streaming chat and 180 s for long
outputs. With `stream: true`, use an inactivity timeout instead of a total
timeout, so a long answer is not cut while tokens are still arriving.

## Output limits

- `max_tokens` up to **65,535** (default 65,535 for transcription, 8,192 for the Playground).
- A response that stops at the cap fails with `model_output_truncated` instead
  of returning a shortened transcript.
- Long outputs take longer; prefer streaming and a `*-flash-lite` model.

## Error behavior

- `503` with `All accounts failed or unhealthy` means the model is not
  available on the current account pool. Retry later or choose another model.
- `429` means the pool is at capacity or in cooldown; the gateway adds
  `Retry-After`.
- Account failover is handled by the core, so a client does not need to retry
  on a single-account quota error.
