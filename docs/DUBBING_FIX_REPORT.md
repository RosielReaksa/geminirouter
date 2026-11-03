# Dubbing Endpoint Fix — Full Build Report

**Date:** 2026-11-03
**Endpoint:** `POST /v1/audio/dubbing` (production: `https://framecall.site/v1/audio/dubbing`)
**Branch:** `codex/playground-page`
**Range:** `fba3d22` … `5136481`
**Status:** deployed and live-verified (`NRestarts=0`, no empty 502s, no unresolved `partial_script` since the final deploy)

---

## 1. Executive summary

The dubbing route had three independent defects that all produced the same user-visible
result: a 200 with an incomplete script, or an empty-body 502.

1. **Thought leakage.** Reasoning models emitted a draft JSON array inside a `thought: true`
   part. The bridge concatenated thoughts with the answer and parsed the first balanced array, so
   the draft (a single line) was returned instead of the real script.
2. **Deploy-time 502s.** `forceCloseConnections: true` plus a 20 s `TimeoutStopSec` killed
   in-flight 300 s requests during a restart; Caddy turned the dropped socket into an empty 502.
3. **Lite early stop.** `gemini-3.5-flash-lite` stops at the end of the first complete script
   pass. It returned the first ~69 s of a 300 s window, and even on a 120 s window it stopped at
   `01:09` and dropped 10 lines while the global coverage ratio still read 1.013.

The fix set adds thought stripping, largest-array parsing, per-chunk silence-based coverage
validation with one strict retry, model-specific dubbing windows, a graceful drain, and JSON
error envelopes. Long-model output is never silently truncated: an incomplete chunk retries once,
then fails with `partial_script`.

Final live state:

| Model | Dubbing window | 300 s fixture |
|---|---|---|
| `gemini-3.5-flash-lite` (default) | 60 s | 200, 5 chunks, **67–73 segments**, ratio 1.20–1.22 |
| `gemini-3.8-flash-high` | 120 s | 200, 3 chunks, **82 segments**, ratio 1.216 |
| Other models | requested `chunk_seconds` (max 1800 s) | unchanged |

All model ids remain usable for normal chat. The short windows live only in the dubbing chunker;
`/v1/chat/completions`, `/v1/models`, and routing are untouched.

---

## 2. Reported symptoms

| # | Symptom | Observed |
|---|---|---|
| 1 | Single-segment 200s | Long clips returned one line, or a script that stopped at `01:09` |
| 2 | Empty-body 502s | No JSON, no `Content-Length`, no error code, only after a deploy |
| 3 | Silent truncation | Output looked successful but dropped dialogue (lite, 300 s window) |
| 4 | Model catalogue confusion | `gemini-3.8-flash-tiered` was listed and routed while `high` was the real id |

---

## 3. Root causes

### 3.1 Thought JSON concatenation (defect 1)

`geminiResponseAnswer()` joined every part's text, including `thought: true` parts. A reasoning
model writes a draft array in its thinking pass and the final array in the answer, so the combined
text held two arrays. `parseDubbingPayload()` took the first balanced array — the draft — and
returned one segment per chunk.

**Fix:** skip `thought: true` parts, then prefer the last valid array in the remaining text.
Thought characters are still counted for telemetry (`thought_characters` in each chunk).

### 3.2 Deploy-time connection reset (defect 2)

The bridge used `forceCloseConnections: true`. On `SIGTERM` the process closed active sockets
instantly; `TimeoutStopSec=20s` left no room for a 300 s chunk to finish. Caddy saw a closed
connection after headers were expected and produced an empty 502.

**Fix:** graceful drain.

| Setting | Value |
|---|---|
| `forceCloseConnections` | `'idle'` |
| `SHUTDOWN_GRACE_MS` | `240000` |
| systemd `TimeoutStopSec` | `300s` |
| systemd `KillSignal` | `SIGTERM` |
| PM2 `kill_timeout` | `300000` |
| Error handler | global JSON envelope (`error.code`, `error.message`) |

Production keeps this via the drop-in
`/etc/systemd/system/geminirouter-bridge.service.d/10-graceful-drain.conf`, so a reinstall of the
unit file cannot silently restore the 20 s stop.

### 3.3 Lite stops at the end of a script pass (defect 3)

Measured on the 300 s fixture (14-line script looped, ~5 s per line, ~1.8 s gaps):

- 300 s window → 20 segments / 43 s of 170 s of speech (26 %) → `partial_script`
- 120 s window → 56 segments, but **chunk 1 stopped at `01:09`**. The transcript resumed in chunk 2
  at script line 11, proving the 10 lines between `01:09` and `02:00` were dropped. The global
  ratio was **1.013**, so the old 35 % gate passed.
- 60 s window → 67 segments (first run) and 73 segments (second run), last line `04:59.8`,
  no gap over 12 s.

Lite appears to treat the end of a complete pass as the end of the conversation when the chunk
starts at the beginning of the script. A 60 s window ends mid-pass, so it transcribes the whole
chunk. Reasoning models do not show this behaviour and keep the 120 s window that produced the
82-segment 3.8 result.

---

## 4. What was built

### 4.1 Endpoint (new feature)

`POST /v1/audio/dubbing` accepts a raw audio body or `multipart/form-data` (plus a JSON
`audio_base64` form for small clips) and returns a timed Khmer dubbing script.

**Response contract — exactly 7 fields per segment:**

| Field | Rule |
|---|---|
| `start`, `end` | `MM:SS.S`, already shifted to the recording start |
| `speaker_gender` | `male` or `female` |
| `vocal_timbre` | short free-text description |
| `character_role` | relationship/role label |
| `original_transcript` | source-language line |
| `khmer_dubbing` | natural spoken Khmer |

No `pitch` field (removed in `d21e3d4`).

**CLI/form options:** `model`, `chunk_seconds` (60–1800, default 300), `max_tokens` (256–65,535),
`concurrency` (1–4), `temperature` (default 0), `response_format` (`json` | `array`),
`source_language`, `target_language`, `prompt` (caller instructions; the contract is always
appended).

### 4.2 Dubbing prompt rules

- Male speakers use `បាទ`, female speakers use `ចាស`.
- 小梨 = younger sister; 桃子 = `ផ្លែប៉េស`.
- 抢钱 = `កាប់ថ្លៃ` / `ប្លន់លុយ`.
- 块/元 = `យ័ន` / `រៀល`; never `បាត`.
- Natural spoken Khmer, not literary Khmer.
- Prior segments are passed as context so names and roles stay consistent across chunks.

### 4.3 Model-specific windows and token budgets

| Model class | Detection | Dubbing window | Output tokens |
|---|---|---|---|
| `-lite` | `isLiteDubbingModel()` | **60 s** | floor 40,960 |
| Reasoning (`3.8`, `high`, `thinking`, `reasoner`, `pro`) | `isReasoningDubbingModel()` | **120 s** | floor 40,960 |
| Everything else | — | `chunk_seconds` (max 1800) | duration table |

Duration table (when no floor applies): ≤120 s → 8,192; ≤240 s → 16,384; ≤300 s → 24,576;
≤600 s → 40,960; >600 s → 65,535.

`maxSecondsBySize` still caps the window for large uploads (14 MB of 32 kbps audio ≈ 3,584 s), so
the effective window is `min(model window, size window)`.

### 4.4 Completeness pipeline

Per chunk, after parsing:

1. **Measure audible speech** with FFmpeg `silencedetect=noise=-30dB:d=0.7` (no extra decode pass;
   it runs while the chunk is prepared).
2. **Coverage verdict:**
   - no speech measured / < 2 s → accept (silent chunk)
   - 0 segments → `empty_script`
   - 1 segment covering ≥ 8 s of speech → `single_segment`
   - covered / speech < 0.35 → `low_coverage`
3. **One strict retry** with `DUBBING_COMPLETENESS_RETRY_PROMPT` (does not consume the transient
   retry budget).
4. **Still incomplete → `partial_script` (502)**, with `error.code`, `error.message`, and details
   (`segmentCount`, `coveredSeconds`, `speechSeconds`, `coverageRatio`, `durationSeconds`).

Other guards: `finishReason` of `length`/`max_tokens` → `model_output_truncated`; no content →
`empty_model_response`; failure text → `model_failure_text`; unparseable JSON → `invalid_model_json`;
schema rejection → one retry without `responseSchema`.

### 4.5 Parser and telemetry

- `geminiResponseAnswer()` strips thought parts and returns `{ text, thoughtCharacters }`.
- `parseDubbingPayload()` accepts an object with a segment array or a bare array, chooses the last
  valid array, and normalizes/clamps each segment to the chunk.
- Each chunk reports `thought_characters`, `answerCharacters`, finish reason, usage, and timing.
- `X-Geminirouter-Segments` equals `segments.length` on every 200.

### 4.6 Model catalogue

- Only `gemini-3.8-flash-tiered` was retired; requests for it map to `gemini-3.8-flash-high`.
- `gemini-3.8-flash-low` was not touched.
- Audit traffic and `/v1` requests were canonicalised so the alias never resurfaces in listings.
- All lite/reasoning ids stay available for chat.

### 4.7 Docs and UI

- `docs/MEDIA_API.md` — public contract, windows, token table, error envelopes, examples.
- `docs/DUBBING_CHANGELOG.md` — rollout record; §14 is the defect fix log.
- `frontend/src/components/marketing/DocsPage.tsx` — website docs (60 s lite / 120 s reasoning,
  chat-unaffected note).
- Deployed bundles: `index-49ZyM23a.js` (120 s lite note), then `index-wo0mslzi.js` (60 s note).

---

## 5. Behaviour matrix

| Model id | Chat | Dubbing | Window |
|---|---|---|---|
| `gemini-3.5-flash-lite` | yes | yes (default) | 60 s |
| `gemini-3.8-flash-high` | yes | yes | 120 s |
| `gemini-3.8-flash-tiered` | mapped → `high` | mapped → `high` | 120 s |
| `gemini-3.5-flash-high/low/medium` | yes | yes (pool-dependent) | requested |
| `gemini-3.6-*`, `gemini-3.7-*`, `claude-*`, `gpt-oss-*` | yes | yes | requested |

The window is applied only inside `handleDubbingRequest`. No global model setting is modified.

---

## 6. Tests

`pnpm --dir server test` → **106/106 passing** (build clean with `tsc`).

New/updated cases in `server/test/media-transcription.test.ts`:

| Case | Asserts |
|---|---|
| Reasoning caps/floor | 120 s window, 40,960 tokens |
| `-lite` caps/floor | 60 s window, 40,960 tokens, `isLiteDubbingModel` |
| 130 s lite route run | 3 chunks (60/60/10), every chunk `max_output_tokens = 40960` |
| Thought exclusion | draft array in thoughts is ignored |
| Largest-array parsing | last valid array wins |
| Silence maths | `silencedetect` parsing, edge clamps |
| Coverage verdicts | empty, single-segment, low-coverage |
| Thought-part route run | 200 with the real script |
| Strict-retry success | second attempt accepted |
| `partial_script` envelope | 502 JSON with `error.code`, empty body asserted against |

Frontend builds: `index-49ZyM23a.js`, final `index-wo0mslzi.js` (CSS `index-DKl6l1hE.css`).

---

## 7. Deployment record

| Item | Value |
|---|---|
| Host | `ubuntu@52.64.141.143`, root `/opt/geminirouter` (not a git checkout) |
| Services | `geminirouter-bridge` (3000), `geminirouter-core`, Caddy 443 |
| Production env | `MEDIA_CHUNK_SECONDS=900`, `MEDIA_CHUNK_TIMEOUT_MS=900000`, `MEDIA_MAX_RETRIES=2` |
| Server + frontend backup | `/opt/geminirouter/.deploy-backups/20261103-114543` |
| Frontend-only backup | `/opt/geminirouter/.deploy-backups/20261103-122456` |
| Lite-window v1 backup | `/opt/geminirouter/.deploy-backups/20261103-123853` |
| Final server + frontend backup | `/opt/geminirouter/.deploy-backups/20261103-124415` |
| Artefacts | `/tmp/deploy-lite-window-20261103.tar.gz`, `/tmp/deploy-lite-window-20261103-v2.tar.gz` |
| Restarts | 11:46, 12:38, 12:44 UTC — all clean, `NRestarts=0` |

Deploy procedure used each time: back up `server/dist` + `frontend/dist`, extract the archive over
`/opt/geminirouter`, `chown -R ubuntu:ubuntu`, restart the bridge, wait 6 s, verify `active` and
`NRestarts=0`.

---

## 8. Live verification

Synthetic English TTS clips: 12 lines / 24 lines / ~66 lines.

### 8.1 `gemini-3.8-flash-high`

| Request | Result |
|---|---|
| 60 s | 200 in ~63 s, 12 segments, ratio 1.226; repeat run 22 segments |
| 120 s | 200 in 128 s, 24 segments, ratio 1.155 |
| 300 s | 200 in 616 s, **82 segments** in 3 × 120 s chunks (35/34/13), ratio 1.216 |

### 8.2 `gemini-3.5-flash-lite`

| Request | Result |
|---|---|
| 300 s, old 300 s window | 502 `partial_script`, 20 segments / 43.4 s of 169.6 s (26 %) |
| 300 s, 120 s window | 200 in 42 s, 56 segments (14/24/18), ratio 1.013 — **chunk 1 stopped at `01:09`, 10 lines dropped** |
| 300 s, 60 s window (current) | 200 in 54 s, **67 segments** (12/13/14/13/15), ratio 1.224; second run 200 in 59 s, **73 segments** (18/12/14/14/15), ratio 1.204, last line `04:59.8`, no gap > 12 s |
| Normal chat ping | 200, `content: "chat-ok"`, `reasoning_content` present |
| `/v1/models` | still lists `gemini-3.5-flash-lite` |

### 8.3 Service checks

| Check | Result |
|---|---|
| `systemctl show -p NRestarts` | `0` |
| `TimeoutStopUSec` / `KillSignal` | `5min` / `SIGTERM` (drop-in) |
| 502 / `partial_script` since the 60 s deploy | `0` |
| `Content-Length: 0` responses | none |
| Unhandled route errors | `0` |
| `X-Geminirouter-Segments` vs `segments.length` | equal on every 200 |

### 8.4 Not verifiable this round

`gemini-3.5-flash-high/low/medium` returned core **HTTP 503 “All accounts failed or unhealthy”**
for their pool (mapping `gemini-3-flash-agent`), for both chat and dubbing. The 300 s ≥ 80 segment
target for those ids is pending pool recovery.

---

## 9. Error envelopes

Every failure returns JSON with `error.type`, `error.code`, `error.message`, and route-specific
details. Empty bodies are never returned by the bridge; the global error handler covers unhandled
route errors.

| `error.code` | HTTP | Meaning |
|---|---|---|
| `partial_script` | 502 | Chunk incomplete after the strict retry |
| `empty_model_response` | 502 | Model returned no content |
| `model_failure_text` | 502 | Model returned a failure sentence instead of a script |
| `model_output_truncated` | 502 | `finishReason` `length`/`max_tokens` |
| `invalid_model_json` | 502 | Answer was not a segment array |
| `upstream_unavailable` | 502 | Core 403/408/429/500/502/503/504 after retries |
| `upstream_auth_failed` | 401 | All gateway keys rejected |
| `model_rejected_media` | 422 | Core 400/404/413/415/422 |
| `schema_rejected` | 422 | Schema retry also failed |
| `invalid_media` | 422 | FFprobe could not read the file |
| `duration_too_long` | 422 | Clip longer than the configured maximum |
| `file_required` | 400 | No audio body or multipart file |
| `multipart_error` | 400 | Malformed upload |
| `invalid_response_format` | 400 | Unsupported `response_format` |
| `chunk_request_failed` | 502 | Transport failure after retries |
| `upstream_error` | 502 | Other core HTTP failure |
| `chunk_too_large` | 500 | Audio chunk above the 14.5 MB inline limit |
| `ffmpeg_unavailable` | 503 | `ffmpeg`/`ffprobe` missing on the host |
| `missing_api_key` / `invalid_api_key` | 401 | Gateway authentication |

---

## 10. Known limitations

1. **35 % coverage floor is lenient.** A chunk can lose dialogue between 35 % and ~75 % coverage.
   The 120 s lite run proved it: 10 lines missing, ratio 1.013, HTTP 200. Lite now avoids the
   trigger with 60 s windows, but the general gate is still weak. A tail-gap check needs a corpus
   of real footage because music and overlapping speech distort the measured ratio.
2. **`silencedetect` undercounts TTS speech** (gaps under 0.7 s count as speech); coverage ratios
   above 1 are normal.
3. **Lite transcript quality** on repeated/looped scripts is weaker than 3.8. Use 3.8 for critical
   long clips.
4. **3.5 high/low/medium dubbing is pool-blocked** (403/503 from core); retry after recovery.
5. **Latency** scales with chunk count: 3.8 runs ~63 s per 60 s clip, lite ~54–59 s per 300 s clip
   on 5 windows; a busy account pool can add hundreds of seconds.

---

## 11. Rollback

```sh
# code
git revert 5136481 8ca9700          # 60 s window, then the defect fix set

# server (restore binaries built from the previous commit)
cd /opt/geminirouter
sudo systemctl stop geminirouter-bridge
sudo cp -r .deploy-backups/20261103-114543/server-dist/. server/dist/
sudo cp -r .deploy-backups/20261103-114543/frontend-dist/. frontend/dist/
sudo chown -R ubuntu:ubuntu server/dist frontend/dist
sudo systemctl start geminirouter-bridge
systemctl show geminirouter-bridge -p NRestarts --value
```

The graceful drain drop-in is independent of the code and can stay installed.

---

## 12. File index

| File | Change |
|---|---|
| `server/src/mediaTranscription.ts` | endpoint, prompt, windows, parser, coverage guard, retry, errors |
| `server/test/media-transcription.test.ts` | 106-test suite incl. lite window route run |
| `server/src/index.ts` | graceful shutdown, JSON error handler, `forceCloseConnections: 'idle'` |
| `server/src/modelIds.ts`, `server/src/trafficMapping.ts` | retire only `gemini-3.8-flash-tiered`; keep `gemini-3.8-flash-low` |
| `server/src/accountTester.ts` | account test default back to `gemini-3.8-flash-low` |
| `deploy/geminirouter-bridge.service`, `deploy/ecosystem.config.js` | stop/kill grace |
| `docs/MEDIA_API.md` | public contract, windows, token table, errors |
| `docs/DUBBING_CHANGELOG.md` | rollout + defect fix log (§14) |
| `docs/DUBBING_FIX_REPORT.md` | this report |
| `frontend/src/components/marketing/DocsPage.tsx` | website docs |

---

## 13. Commit history

| Commit | Purpose |
|---|---|
| `fba3d22` | add timed Chinese→Khmer dubbing endpoint |
| `d21e3d4` | drop `pitch` from segments |
| `ccf021f` | expose only `gemini-3.8-flash-high` |
| `322c9c4` | document the dubbing rollout and limitations |
| `5bda463` | canonicalise audit traffic, route `/v1` through the bridge |
| `3432d1d` | retire only `gemini-3.8-flash-tiered` |
| `8ca9700` | exclude thoughts, validate completeness, graceful drain |
| `5136481` | run `-lite` models on 60-second chunks |

---

## 14. Follow-up: concurrency default and wall-clock estimate

**Full write-up:** [`docs/DUBBING_CONCURRENCY_REPORT.md`](./DUBBING_CONCURRENCY_REPORT.md)

The verification round against build `20261103-124415` confirmed defect A
(60 s → 27 segments, 120 s → 44) and defect B (no empty 502s) as fixed, and found
one remaining problem: a 300 s `gemini-3.8-flash-high` request with the default
`concurrency` did not answer within 1,200 s, because three 120 s chunks ran one
after another and the strict retry can double a chunk. The same request with
`concurrency=3` returned 90 segments in 575 s.

| Item | Change |
|---|---|
| `defaultDubbingConcurrency(model, chunkCount)` | `-lite` and reasoning models default to `min(4, chunkCount)` workers; long-window models stay at 1 |
| Explicit `concurrency` | never overridden (`DubbingOptions.concurrencyExplicit`) |
| Response metadata | `concurrency` added alongside `chunk_count` / `chunk_seconds` |
| `timings.estimated_ms` | `2.2×` duration (reasoning), `0.3×` (lite), `1×` (other), for client timeout planning |
| Docs | `docs/MEDIA_API.md`, `docs/DUBBING_CHANGELOG.md` §15, website dubbing section |

Client guidance: for 3.8 production dubbing keep the direct `:generateContent`
path with 120 s chunks; through the router, 300 s 3.8 is now accepted and runs
its chunks in parallel, while `gemini-3.5-flash-lite` returns the same clip in
about half a minute. Chunked progress or a job id stays an optional follow-up.

Live check on build `20261103-140056` (300 s fixture, no `concurrency` field):

| Model | Result |
|---|---|
| `gemini-3.5-flash-lite` | 200 in **26.2 s**, 73 segments, `concurrency: 4`, `estimated_ms: 90029` |
| `gemini-3.8-flash-high` | 200 in **125.1 s**, 78 segments, `concurrency: 3`, `estimated_ms: 660211` |

Both answers cover the whole clip (last segment `05:00.1` / `04:59.8`) with the
7-field contract intact and no empty `khmer_dubbing` values. The 3.8 estimate is
deliberately pessimistic: earlier measurements on a colder pool put the same
request at 575 s.
