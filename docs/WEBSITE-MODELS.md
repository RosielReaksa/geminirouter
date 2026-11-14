# Website model list

Which model ids the dashboard, the Playground and the public marketing site
offer, and how each list is built.

## Three surfaces, all Gemini-only

| Surface | Source | Purpose |
|---|---|---|
| `GET /v1/models` | Core list, canonicalised, filtered to Gemini | Public API contract. The bridge appends the AI Studio key-pool models. |
| `GET /api/models` | Core list merged with `VERIFIED_WEBSITE_MODEL_IDS`, dead ids hidden | Dashboard and Playground. |
| `GET /api/public/models` | `GEMINI_API_MODELS` + `ACCOUNT_POOL_PUBLIC_MODELS` | Marketing model table. |

Anthropic and OpenAI-compatible ids are never offered on any surface; the
bridge rejects them at the `/v1` gate and the playground/test endpoints reject
them explicitly.

## The two backends and their model lists

The gateway serves Gemini models through two backends:

1. **AI Studio key pool** (`GEMINI_API_MODELS`, `server/src/geminiApiPool.ts`) —
   23 stored keys (15 permanently dead and disabled on 2026-11-14), per-key
   per-model RPM/TPM/RPD tracking with cooldown rotation:

   ```ts
   export const GEMINI_API_MODELS = [
     'gemini-3.1-flash-lite',
     'gemini-3.5-flash-lite',
     'gemini-3.6-flash',
     'gemini-3.7-flash',
     'gemini-4-carbon',
     'gemini-4-hydrogen',
   ] as const;
   ```

   3.6/3.7 Flash are Enterprise-only and Carbon/Hydrogen Ultra-only upstream,
   so the key pool is their only path. 3.7 Flash and 4 Carbon are free-tier
   quota-limited and answer 429 until the daily reset.

2. **OAuth account pool** (`ACCOUNT_POOL_PUBLIC_MODELS`) — verified with real
   requests on 2026-11-14:

   ```ts
   export const ACCOUNT_POOL_PUBLIC_MODELS = [
     'gemini-3.8-flash-high',
     'gemini-3.8-flash-low',
     'gemini-3.8-flash-medium',
     'gemini-4-argon',
   ] as const;
   ```

   `gemini-4-argon` requires the v0.30.0 core ("use CLI user-agent"); on the
   older core every account-pool stream answered the Antigravity deprecation
   notice.

Chat turns prefer the key pool when it has capacity (`keys-first`) and fall
back to the account pool when every key is rate-limited. The native dubbing
path keeps the original balanced alternation. Account-pool tier variants
(`-high/-low/-medium/-tiered`) do not exist on the AI Studio API —
`KEY_POOL_MODEL_ALIASES` maps them to base ids when the key pool serves a
variant, and traffic records keep the requested variant.

## Dashboard hiding

`UNAVAILABLE_WEBSITE_MODEL_IDS` hides ids whose account pool is dead **and**
which the key pool does not serve: `gemini-3-flash`, `gemini-3.1-pro-high/low`
and `gemini-3.5-flash-high/low/medium`. The 3.6/3.7 families were unhidden on
2026-11-14 when the key pool took them over.

## Admission rule

An id enters the public lists only after a real request returns `200` through
the live gateway. Probe again before adding — pool health is uneven and
changes (3.7 Flash and 4 Carbon currently exhaust free-tier quota daily).

## Transcription benchmark (2026-11-14, 80.4 s Chinese episode)

| Model | Wall time | Tokens |
|---|---:|---:|
| gemini-3.5-flash-lite | 4.6 s | 2,330 |
| gemini-3.1-flash-lite | 8.5 s | ~2,330 |
| gemini-3.6-flash | 10.5 s | 4,306 |
| gemini-4-argon | 26.2 s | 4,521 |
| gemini-4-hydrogen | 31.6 s | 6,547 |
| gemini-3.8-flash-low | 52.5 s | 4,371 |
| gemini-3.8-flash-medium | 90.2 s | 5,236 |
| gemini-3.8-flash-high | 150.5 s | 4,857 |
| gemini-3.7-flash | 504 | — |
| gemini-4-carbon | 502 | — |

Token counts include hidden reasoning; the audio+prompt input is ~2,056–2,739
tokens for 80 s of audio.

## Tests

`server/test/model-ids.test.ts`, `server/test/gemini-api-proxy.test.ts`,
`server/test/gemini-api-pool.test.ts` and `server/test/gemini-api-routes.test.ts`
cover the merges, hiding, aliases and key failover. Full suite: 224 passing.
