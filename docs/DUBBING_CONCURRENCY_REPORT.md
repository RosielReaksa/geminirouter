# Dubbing Concurrency Fix — Post-Verification Report

**Date:** 2026-11-03
**Endpoint:** `POST /v1/audio/dubbing` (production `https://framecall.site`)
**Starting build:** `20261103-124415` (thought exclusion, coverage guard, short windows, graceful drain)
**Shipped build:** `20261103-140056`
**Commits:** `5c9cbb6` (code, tests, docs), `4dcb2e8` (live timings)
**Status:** deployed, live-verified, `NRestarts=0`

---

## 1. Executive summary

The previous round fixed the two hard defects: thought-JSON answers (single
segment) and empty-body 502s during deploys. The external verification of that
build confirmed both: 60 s → 27 segments, 120 s → 44, 300 s lite → 83, no empty
response bodies.

It exposed one remaining defect of a different kind. The endpoint was correct but
**could look hung**:

- 300 s on `gemini-3.8-flash-high` with the default `concurrency` returned
  nothing within 1,200 s (curl saw only `100 Continue`).
- The same request with `concurrency=3` returned 200 with 90 segments in 575 s.

The cause was the default itself: reasoning chunks are capped at 120 s, so a
300 s clip splits into three chunks, and the default of one worker ran them one
after another. A strict completeness retry can double a chunk's time, so the
serial path exceeded every practical client and proxy timeout.

This round changes the default for short-window models, exposes the chosen
concurrency, and adds a wall-clock planning estimate:

| Item | Before | After |
|---|---|---|
| 300 s `gemini-3.8-flash-high`, no `concurrency` | no answer in 1,200 s | **200 in 125 s**, 78 segments |
| 300 s `gemini-3.5-flash-lite`, no `concurrency` | 200 in ~54–65 s | **200 in 26 s**, 73 segments |
| Response metadata | `chunk_count`, `chunk_seconds` | plus `concurrency` and `timings.estimated_ms` |

Chat and model listing remain untouched, tests are 108/108, and every earlier
guarantee (7-field contract, absolute `MM:SS.S`, no silent truncation) holds on
the live responses.

---

## 2. What the verification round reported

Client was the dubber pipeline: multipart `file`, `source_language=zh`,
`target_language=km`, `response_format=array`.

| Clip | Model | Concurrency | HTTP | Time | Segments | Verdict |
|---|---|---|---:|---:|---:|---|
| 60 s | 3.8-high | default | 200 | 71 s | 27 | fixed (was 1) |
| 120 s | 3.8-high | default | 200 | 113 s | 44 | fixed (was 1) |
| 300 s | 3.8-high | default (1) | — | > 1,200 s | — | no response |
| 300 s | 3.8-high | 3 | 200 | 575 s | 90 | correct but slow |
| 300 s | 3.5-lite | default | 200 | 65 s | 83 | no regression |

Measured throughput per audio minute: 3.8 ≈ 1.2× (60 s), 0.9× (120 s), 0.5×
(300 s at concurrency 3); lite ≈ 4.6×. 3.8 is 5–8× slower than lite for the same
audio.

The report asked for four things:

1. default concurrency for reasoning models (one worker per chunk, up to 4);
2. keep the 120 s window, and surface a wall-clock estimate in `timings`;
3. document the client expectation (3.8 → 120 s chunks; lite when speed matters);
4. optional: queue position / chunked progress.

Items 1–3 are implemented. Item 4 is deliberately deferred (see §9).

---

## 3. Root cause

Three factors combined:

1. **Small windows multiply the chunk count.** Reasoning models are capped at
   120 s because 300 s produced single-line answers, so a 300 s clip is always
   three chunks.
2. **The default was a single worker.** `concurrency` defaulted to 1 for every
   model, so those chunks were serialised: three model round-trips back to back,
   each with a thinking pass.
3. **The completeness guard can retry.** A chunk that fails the coverage check is
   re-asked with the strict prompt, which roughly doubles that chunk's time when
   it triggers. On a cold account pool the serial path crossed 20 minutes.

Concurrency was already supported (1–4) and already fixed the problem when the
caller set it explicitly. The defect was that the correct value required the
caller to know an internal window rule.

---

## 4. What changed

### 4.1 Automatic concurrency

```ts
export function defaultDubbingConcurrency(model: string, chunkCount: number): number {
  if (!usesShortDubbingWindow(model)) return 1;
  return Math.max(1, Math.min(4, Math.floor(chunkCount)));
}
```

- Applies only to short-window models: `-lite` and the reasoning family
  (`gemini-3.8`, or any id containing `high`, `thinking`, `reasoner`, `pro`).
- One worker per chunk, capped at 4 so the account pool is not flooded.
- Long-window models keep the historical single worker, so existing behaviour
  for `gemini-3.6-*`, `claude-*`, `gpt-oss-*` and similar ids is unchanged.

`DubbingOptions` gained `concurrencyExplicit`, set from the parsed form value.
When the caller sends `concurrency`, the automatic path is skipped entirely:

```ts
if (!options.concurrencyExplicit) {
  const autoConcurrency = defaultDubbingConcurrency(options.model, chunks.length);
  if (autoConcurrency !== options.concurrency) {
    request.log.info({ media: { model, chunkCount, concurrency } },
      'media: dubbing concurrency raised for short-window model');
    options.concurrency = autoConcurrency;
  }
}
```

The decision runs after `splitAudio`, because it needs the real chunk count, and
before `dubChunks`.

### 4.2 Wall-clock estimate

```ts
export function estimatedDubbingMs(durationSeconds: number, model: string): number {
  const safe = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const factor = isReasoningDubbingModel(model) ? 2.2 : isLiteDubbingModel(model) ? 0.3 : 1;
  return Math.round(safe * factor * 1000);
}
```

Exposed as `timings.estimated_ms` on every `response_format=json` answer. It is a
planning figure for client timeouts, not a deadline and not a server-side
timeout. The factors come from measured throughput, rounded to the slow side:

| Class | Factor | Source |
|---|---:|---|
| Reasoning (`3.8`, `high`, `thinking`, `reasoner`, `pro`) | 2.2× | 575 s / 265 s of audio + retry headroom |
| `-lite` | 0.3× | 300 s clip in ~90 s before the parallel default |
| Other | 1.0× | historical 900 s-window behaviour |

Because the estimate is deliberately pessimistic, a warm-pool 300 s 3.8 request
can beat it by 5× (measured 125 s against a 660 s quote).

### 4.3 Response shape

Two additive fields, no removals:

```json
{
  "chunk_count": 3,
  "chunk_seconds": 120,
  "concurrency": 3,
  "segment_count": 78,
  "timings": {
    "estimated_ms": 660211,
    "transcode_ms": 2450,
    "model_ms": 116209,
    "total_ms": 118722
  }
}
```

`response_format=array` is unchanged (bare segment array) — the metadata only
exists in the JSON envelope, as before.

### 4.4 Code locations

| Symbol | File | Line |
|---|---|---|
| `concurrencyExplicit` field | `server/src/mediaTranscription.ts` | 200 |
| `defaultDubbingConcurrency` | `server/src/mediaTranscription.ts` | 1887 |
| `estimatedDubbingMs` | `server/src/mediaTranscription.ts` | 1898 |
| parse-time explicit flag | `server/src/mediaTranscription.ts` | 2380 |
| auto-concurrency block | `server/src/mediaTranscription.ts` | 2508 |
| `concurrency` in response | `server/src/mediaTranscription.ts` | 3079 |
| `estimated_ms` in response | `server/src/mediaTranscription.ts` | 3105 |

---

## 5. Tests

`pnpm --dir server build` clean, `pnpm --dir server test` → **108/108 passing**
(106 before; two new cases plus assertions inside the existing route runs).

| Case | Asserts |
|---|---|
| `short-window models default to one dubbing worker per chunk` | 3 chunks → 3 workers; 9 chunks → 4; lite 5 → 4; long-window (`gemini-3.6-flash`, `gemini-3.5-flash`) → 1; 0 chunks → 1 |
| `dubbing wall-clock estimates follow the measured per-model throughput` | 300 s 3.8 → 660,000 ms; 120 s 3.8 → 264,000 ms; 300 s lite → 90,000 ms; other → 1×; `NaN` and negative durations → 0 |
| 130 s lite route run (existing) | now also asserts `concurrency: 3` and `timings.estimated_ms: 39000` |
| 65 s lite route run (existing) | now also asserts `concurrency: 1`, proving an explicit value is never overridden |

Helper coverage is unit-level, so a future window change cannot silently break
the default: the relationship is derived from the same predicates
(`usesShortDubbingWindow`, `isReasoningDubbingModel`, `isLiteDubbingModel`) that
chose the window.

---

## 6. Deployment

| Item | Value |
|---|---|
| Artefact | `out/deploy-dubbing-concurrency-20261103.tar.gz` (2.42 MB) |
| Contents | `server/dist`, `frontend/dist` |
| Backup (pre-change) | `/opt/geminirouter/.deploy-backups/20261103-140056` (6.4 MB) |
| Extract | `/opt/geminirouter`, `chown -R ubuntu:ubuntu` |
| Bridge restart | `2026-11-03 14:00:56 UTC` |
| Health after restart | `active` / `active`, `NRestarts=0`, `TimeoutStopUSec=5min` |
| Frontend asset | `index-CRYuj1aE.js`, CSS `index-DKl6l1hE.css` |
| Chat regression | lite `/v1/chat/completions` → 200 `chat-ok` in 3.1 s |
| Catalogue | 28 ids; `gemini-3.5-flash-lite` and `gemini-3.8-flash-high` present, no `gemini-3.8-flash-tiered` |

Bridge logs during the verification:

```
media: dubbing concurrency raised for short-window model {"model":"gemini-3.5-flash-lite","chunkCount":5,"concurrency":4}
media: dubbing concurrency raised for short-window model {"model":"gemini-3.8-flash-high","chunkCount":3,"concurrency":3}
```

One expected artefact of the restart: the draining process answered two health
probes with `503 "refusing to accept new requests as server is closing"` for
about one second before exiting. That is the graceful drain refusing new work,
not a regression; in-flight dubbing requests are still allowed to finish.

---

## 7. Live verification

Fixture: 300 s synthetic clip, 2.40 MB, uploaded as multipart `file` with
`source_language=zh`, `target_language=km`, and **no `concurrency` field** — the
whole point of the round.

### 7.1 `gemini-3.5-flash-lite`

**200 in 26.2 s.** 73 segments in 5 × 60 s chunks, `concurrency: 4`,
`estimated_ms: 90029`.

| Chunk | Window | Segments | Speech | Covered | Tokens |
|---|---|---:|---:|---:|---:|
| 0 | 0–60.0 | 12 | 34.75 | 44.50 | 3,626 |
| 1 | 60.0–120.0 | 13 | 33.91 | 40.10 | 3,705 |
| 2 | 120.0–180.0 | 15 | 34.24 | 40.70 | 3,841 |
| 3 | 180.0–240.0 | 16 | 33.89 | 35.70 | 3,970 |
| 4 | 240.0–300.1 | 17 | 33.89 | 42.68 | 4,023 |

Coverage ratio 1.193, first cue `00:00.1`, last cue `04:57.9 → 05:00.1`,
`thought_characters: 0` on every chunk.

### 7.2 `gemini-3.8-flash-high`

**200 in 125.1 s.** 78 segments in 3 chunks (120/120/60), `concurrency: 3`,
`estimated_ms: 660211`.

| Chunk | Window | Segments | Speech | Covered | Thought chars | Tokens |
|---|---|---:|---:|---:|---:|---:|
| 0 | 0–120.0 | 41 | 68.65 | 75.10 | 3,247 | 21,051 |
| 1 | 120.0–240.0 | 24 | 68.13 | 84.19 | 1,574 | 13,619 |
| 2 | 240.0–300.1 | 13 | 33.96 | 41.40 | 1,899 | 6,424 |

Coverage ratio 1.175, first cue `00:00.6`, last cue `04:57.6 → 04:59.8`. Every
chunk used the 40,960-token floor.

### 7.3 Before / after

| Metric | Verification build `124415` | This build `140056` |
|---|---|---|
| 300 s 3.8, default concurrency | no answer in 1,200 s | 125 s, 78 segments |
| 300 s 3.8, concurrency 3 | 575 s, 90 segments | 125 s, 78 segments |
| 300 s lite, default concurrency | 65 s, 83 segments (serial windows) | 26 s, 73 segments (4 workers) |
| Empty bodies | none | none |
| Incomplete scripts returned as 200 | none observed | none |

Segment counts move between runs (78 vs 90, 73 vs 83) because the fixture loops a
14-line script and the model's segmentation of repeated lines is not stable. The
invariant that matters is coverage: every run reaches the end of the clip with
no gap over 12 s.

### 7.4 Contract checks on both responses

| Check | Result |
|---|---|
| Segment fields | exactly `start,end,speaker_gender,vocal_timbre,character_role,original_transcript,khmer_dubbing` |
| Timestamps | `MM:SS.S`, absolute on the upload, monotonic |
| Empty `khmer_dubbing` | 0 |
| `X-Geminirouter-Segments` | equals `segments.length` |
| Error-level log lines (10 min window) | 0 |

---

## 8. Client guidance

| Use case | Path | Budget |
|---|---|---|
| Production dubbing, best script quality | direct `:generateContent` with 120 s chunks (current dubber path) | 504 cues for a 30-minute episode in 6 m 50 s |
| Router, speed matters | `gemini-3.5-flash-lite` | 300 s clip in ~26 s |
| Router, 3.8 required | let the endpoint split; optionally send 120 s chunks | 125–575 s for 300 s, depending on pool load |

Practical rules:

1. Set the client / proxy timeout from `timings.estimated_ms`, not from the
   previous run's `total_ms`. It quotes the slow case on purpose.
2. Do not send `concurrency` unless you are deliberately throttling. Omitting it
   gives the model the worker count it needs.
3. A 3.8 request still sends no body bytes until it completes. If your proxy has
   a hard 60 s idle timeout, use the direct path rather than the router for long
   clips.
4. `response_format=array` drops the metadata; use `json` when you need
   `concurrency`, `coverage`, or `timings`.

---

## 9. Residual risks and follow-ups

1. **Latency variance is large and pool-driven.** The same 300 s 3.8 request took
   125 s and 575 s on different days. `estimated_ms` covers the slow end; it is
   not a guarantee.
2. **No progress channel.** Option 4 from the verification report (queue position,
   chunked progress, job id) is not implemented. A long request is still a single
   silent HTTP call. Recommended shape if built later: `POST` returns a job id,
   `GET /v1/audio/dubbing/:id` streams per-chunk completion.
3. **Coverage floor stays at 35 %.** Unchanged this round. The lite 60 s window
   avoids the known failure mode, but a chunk can still lose dialogue between
   35 % and ~75 % coverage without an error. The tail-gap guard needs real footage
   because music and overlapping speech distort `silencedetect`.
4. **Automatic concurrency is capped at 4.** A 30-minute clip at 120 s windows is
   15 chunks, so the request still runs in ~4 batches. Raising the cap trades
   wall clock for account-pool pressure.
5. **Restart 503 window (~1 s).** New requests during a drain get 503 rather than
   being queued. Acceptable for a deploy, but a blue/green swap would remove it.
6. **3.5 high/low/medium dubbing remains pool-blocked** (core 503 “All accounts
   failed or unhealthy”); unrelated to this change.

---

## 10. Rollback

```sh
# code
git revert 4dcb2e8 5c9cbb6

# server + frontend binaries
sudo systemctl stop geminirouter-bridge
sudo cp -r /opt/geminirouter/.deploy-backups/20261103-140056/server-dist/. /opt/geminirouter/server/dist/
sudo cp -r /opt/geminirouter/.deploy-backups/20261103-140056/frontend-dist/. /opt/geminirouter/frontend/dist/
sudo chown -R ubuntu:ubuntu /opt/geminirouter/server/dist /opt/geminirouter/frontend/dist
sudo systemctl start geminirouter-bridge
systemctl show geminirouter-bridge -p NRestarts --value
```

Rolling back restores serial chunking, so a 300 s 3.8 request will again need
`concurrency=3` from the caller to avoid the timeout.

---

## 11. File index

| File | Change |
|---|---|
| `server/src/mediaTranscription.ts` | `concurrencyExplicit`, `defaultDubbingConcurrency`, `estimatedDubbingMs`, response fields |
| `server/test/media-transcription.test.ts` | two new unit cases, route-run assertions for `concurrency` / `estimated_ms` |
| `docs/MEDIA_API.md` | default rule, response example, latency table, client guidance |
| `docs/DUBBING_CHANGELOG.md` | §15 — change, tests, deployment, live matrix |
| `docs/DUBBING_FIX_REPORT.md` | §14 — follow-up round summary |
| `frontend/src/components/marketing/DocsPage.tsx` | website dubbing section: parallel default + `estimated_ms` |
| `docs/DUBBING_CONCURRENCY_REPORT.md` | this report |

## 12. Artifacts

| File | Description |
|---|---|
| `out/deploy-dubbing-concurrency-20261103.tar.gz` | deployed server + frontend bundle |
| `out/live_300_lite_autoconc.json` | 300 s lite response, 26.2 s, `concurrency: 4` |
| `out/live_300_38_autoconc.json` | 300 s 3.8 response, 125.1 s, `concurrency: 3` |
| `out/chat_lite_after_conc.json` | chat regression ping |
| `out/models_after_conc.json` | `/v1/models` after deploy |

## 13. Commit history

| Commit | Purpose |
|---|---|
| `c701cb5` | add the previous fix build report |
| `5c9cbb6` | parallelise short-window chunks by default; `concurrency` + `estimated_ms`; tests and docs |
| `4dcb2e8` | record the concurrency defaults and live timings |
