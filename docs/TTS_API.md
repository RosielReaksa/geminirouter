# Text-to-Speech API

`POST /v1/audio/speech` turns text into spoken audio. It is the voice half of
the dubbing stack: `/v1/audio/dubbing` writes the timed script, this endpoint
speaks it.

The route is served by the bridge, which authenticates the caller with the same
`sk-gw-…` gateway keys as every other `/v1` route, applies a concurrency gate,
records metered usage, and proxies the audio back. The speech itself is rendered
by an internal loopback service (`tts-server`) using **Edge TTS** spread across
the Webshare proxy pool.

## Endpoint

```text
POST /v1/audio/speech
Authorization: Bearer <gateway key>
Content-Type: application/json
```

```json
{
  "model": "tts-1",
  "input": "Hello and welcome to the show.",
  "voice": "nova",
  "language": "en",
  "response_format": "mp3",
  "speed": 1.0,
  "timestamp_granularities": ["word"]
}
```

| Field | Notes |
|---|---|
| `model` | `tts-1` (accepted for OpenAI compatibility; recorded, not billed by model). |
| `input` | The text to speak. Required, non-empty, ≤ 4,096 characters. |
| `voice` | An Edge voice id (`en-US-JennyNeural`), or an OpenAI alias: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`. |
| `language` | ISO code or name (`en`, `th`, `ja`, `es`, `ar`, …). Used to pick a voice when `voice` is omitted, and to resolve an alias. Default `en`. |
| `response_format` | `mp3` (default), `wav`, `opus`, `aac`, `flac`. Non-MP3 is converted with ffmpeg. |
| `speed` | 0.25–4.0, mapped onto Edge's rate. Default `1.0`. |
| `timestamp_granularities` | Add `word` to get per-word timings. |

### Response

Audio bytes with `Content-Type` matching `response_format`, plus:

```text
x-tts-characters: 28      # characters synthesized (the meter)
x-tts-voice: en-US-JennyNeural
x-tts-seconds: 1.99       # audio duration
x-tts-ms: 912             # time spent
x-egress-provider: tts
```

When `timestamp_granularities` includes `word`, the response is JSON instead:

```json
{
  "audio_base64": "…",
  "format": "mp3",
  "characters": 28,
  "duration_seconds": 1.99,
  "voice": "en-US-JennyNeural",
  "words": [{ "word": "Hello", "start": 0.1, "end": 0.438 }]
}
```

## Voices

```text
GET /v1/audio/voices
```

Returns the full Edge catalogue (`id`, `name`, `locale`, `language`, `gender`)
plus the six OpenAI aliases. Filter with `?language=en`.

## Concurrency and limits

- The bridge admits up to `TTS_MAX_CONCURRENT` (default 100) simultaneous
  requests; the rest queue in FIFO order and receive `503` with `Retry-After`
  after `TTS_QUEUE_TIMEOUT_MS`.
- The service caps each proxy at `TTS_PER_IP_CONCURRENCY` (default 6) so a burst
  spreads across the pool instead of stacking on a few IPs.
- A failed proxy cools down for `TTS_PROXY_COOLDOWN_SECONDS`, then returns to
  rotation. The last resort is a direct connection.

## Metering

Every call is recorded on the Traffic page with `provider: tts`, the caller's
gateway key, the voice, the character count and the audio duration. The
dashboard-facing ledger is:

```text
GET /api/tts/usage?from=<ms>&to=<ms>&key=<name>
```

Usage is metered for visibility. There is no checkout, balance or invoice in
this version.

## Reliability note

Edge TTS is an unofficial Microsoft endpoint. It is free and high quality, but it
can change or throttle without notice. The engine sits behind one interface, so
an official provider (Gemini TTS, Azure Speech) can be added behind the same API
without changing clients. Watch `GET /stats` on the service for pool health.

## Configuration

See `deploy/.env.example` for the full list. The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `TTS_PORT` | `8077` | Loopback port for `tts-server`. |
| `TTS_INTERNAL_SECRET` | — | Shared secret the bridge sends; required in production. |
| `TTS_URL` | `http://127.0.0.1:8077` | Where the bridge reaches the service. |
| `TTS_MAX_CONCURRENT` | `100` | Bridge-side admission limit. |
| `TTS_PER_IP_CONCURRENCY` | `6` | Service-side per-proxy cap. |
| `TTS_WEBSHARE_API_KEY` | `WEBSHARE_API_KEY` | Proxy inventory key. |

Deploy: copy `tts-server/` to `/opt/geminirouter/tts`, create `.venv`, install
`requirements.txt`, then install and start `deploy/geminirouter-tts.service`.
No Caddy change is needed — `/v1/audio/*` already routes to the bridge.
