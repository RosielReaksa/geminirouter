# Website model list

Which model ids the dashboard and the Playground chat offer, and how they relate
to the public `/v1/models` catalogue.

## Two lists, on purpose

| Surface | Source | Purpose |
|---|---|---|
| `GET /v1/models` | Core list, canonicalised (`server/src/index.ts` §6) | Public API contract. Mirrors what the gateway advertises, minus the retired `gemini-3.8-flash-tiered` alias. |
| `GET /api/models` | Core list **plus** `VERIFIED_WEBSITE_MODEL_IDS` | Website dashboard and Playground. Adds ids the gateway serves but does not list. |
| `GET /api/public/models` | Same merge | Marketing model table. |

`server/src/modelIds.ts` owns the merge:

```ts
export const VERIFIED_WEBSITE_MODEL_IDS = [
  // Aliases the gateway accepts but sometimes omits from its own listing.
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-image',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash-high',
  // Claude models the core knows and serves but does not list.
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking',
  'claude-opus-4-5-thinking',
  'claude-haiku-4-5-20251001',
];

export function includeVerifiedWebsiteModels(gatewayIds: string[]): string[] {
  return canonicalizeModelIds([...gatewayIds, ...VERIFIED_WEBSITE_MODEL_IDS]);
}
```

Core order is preserved, aliases are appended, retired ids are rewritten and
duplicates collapse. `/v1/models` never calls this function, so API clients still
get the exact catalogue the core advertises.

## Admission rule

An id enters `VERIFIED_WEBSITE_MODEL_IDS` only after a real chat completion
returns `200` through the live gateway. Ids that answer `503 All accounts failed
or unhealthy` stay out even when the core knows them:

| Excluded id | Reason |
|---|---|
| `claude-opus-4-5` | 503 from the pool while its `-thinking` sibling answers 200 |
| `claude-haiku-4-5` (bare alias) | 503; the dated `claude-haiku-4-5-20251001` answers 200 |
| `gemini-3.5-flash-high/low/medium` | 503 pool (`gemini-3-flash-agent`) |

Probe again before adding an id — per-model pool health is uneven and changes.

## Playground behaviour

`frontend/src/components/PlaygroundPage.tsx`:

1. Loads `/api/models` and keeps **every** entry. A failed last probe no longer
   hides a model, because the probe result is a stale snapshot.
2. Sorts usable models first (`availability?.ok !== false`) and last-failed ones
   last.
3. Labels a failed entry `Name — last check failed` in both the model and
   compare dropdowns.
4. Picks defaults only from the usable subset: `gemini-3.5-flash-lite`, then
   `gemini-3.1-flash-lite`, then `gemini-2.5-flash-lite`, then any Gemini, then
   the first usable model. A saved selection is kept when it is still in the
   list.

## Dubbing is unaffected

The extra Claude ids work for chat only. `/v1/audio/dubbing` posts audio as
Gemini-native `inline_data` to `:generateContent`; Anthropic has no audio input,
so a Claude id on that route fails with `502 upstream_unavailable`
(chunk-level `HTTP 500 Request contains an invalid argument`). See
`docs/MEDIA_API.md` for the dubbing contract.

## Tests

`server/test/model-ids.test.ts`:

| Case | Asserts |
|---|---|
| website list adds verified ids | live order preserved, every alias present once, no duplicate ids, excluded aliases absent |
| retired tiered id | rewritten to `gemini-3.8-flash-high`, appears once, `tiered` never leaks |
| empty gateway list | returns the verified ids in declaration order |

Full suite: 111/111 (`pnpm --dir server test`).
