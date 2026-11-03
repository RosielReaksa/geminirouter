# Timed Dubbing — Change Record

**Date:** 2026-11-03
**Scope:** `geminirouter` gateway (`server/`), public website (`frontend/`), VPS deployment
**Commits:** `fba3d22` (feature), `d21e3d4` (pitch removal)
**Production:** <https://framecall.site> — `/opt/geminirouter`, systemd `geminirouter-bridge`

---

## 1. Summary

Added a server-side timed dubbing pipeline to the gateway:

- `POST /v1/audio/dubbing` and alias `POST /v1/media/dubbing`.
- Accepts the same uploads as `/v1/audio/transcriptions` (multipart `file`, raw
  `audio/*` body, JSON `audio_base64`).
- Splits the recording with FFmpeg, calls Gemini-native `:generateContent` per
  chunk with `inline_data`, JSON mode, and a response schema.
- Returns speaker-aware Khmer dubbing segments with **absolute** `MM:SS.S`
  timestamps.
- Removed the separate `pitch` (`low`/`high`) field after the first deploy.
  `speaker_gender` is inferred directly from the audio by the model; pitch added
  no signal and could contradict the gender label.

---

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/audio/dubbing` | Timed dubbing segments (canonical) |
| `POST` | `/v1/media/dubbing` | Identical alias |
| `GET` | `/v1/audio/languages` | Existing convenience language list |

Auth is the normal gateway key: `Authorization: Bearer <key>` or `x-api-key`.
If no gateway keys are configured, the media routes allow anonymous access, but
dubbing still needs a key for its own internal `:generateContent` calls, so it
fails with `upstream_auth_failed` (401).

---

## 3. Request contract

### Upload forms

| Form | How |
|---|---|
| Multipart | `file` field (also `audio` / `video` aliases), optional metadata fields |
| Raw binary | `Content-Type: audio/*`, metadata as query string |
| JSON | `{"audio_base64": "...", "filename": "clip.mp3", ...}` |

### Options

| Field | Default | Range / notes |
|---|---|---|
| `source_language` | `zh` | Any name or ISO code; normalized for display |
| `target_language` | `km` | Any name or ISO code |
| `model` | `MEDIA_DEFAULT_MODEL` or `gemini-3.5-flash-lite` | Non-empty |
| `prompt` | built-in Chinese→Khmer prompt | ≤ 50,000 chars; replaces the built-in text, contract still appended |
| `chunk_seconds` | `300` | 60–1800; auto-shrunk if a chunk would exceed the core's inline audio limit |
| `max_tokens` | duration table | 256–65,535; overrides the table |
| `temperature` | `0` | 0–2 |
| `concurrency` | `1` | 1–4 parallel chunk workers |
| `response_format` | `json` | `json` or `array` (aliases `segments` / `raw`) |

### Built-in prompt rules (when `prompt` is omitted)

- Natural spoken Khmer for dubbing, not literary Khmer.
- Male speakers use `បាទ`; female speakers use `ចាស`.
- 小梨 is the younger sister (`ប្អូនស្រី`), never `អ៊ុំស្រី`.
- 抢钱 → `កាប់ថ្លៃ` or `ប្លន់លុយ` by context.
- 桃子 → `ផ្លែប៉េស`.
- 块/元 (money) → `យ័ន` or `រៀល`, never `បាត`.
- Names/places stay consistent across the whole recording.
- No additions, omissions, summaries, or censorship.

Voice rules after the pitch removal:

- `speaker_gender` must be `male` or `female` (from the audio).
- `character_role` stays stable for the same character.
- `vocal_timbre` mentions whispering, shouting, or crying when audible.

---

## 4. Output contract

Each segment has **exactly seven fields**:

```json
{
  "start": "00:12.4",
  "end": "00:16.8",
  "speaker_gender": "female",
  "vocal_timbre": "young and bright",
  "character_role": "younger sister",
  "original_transcript": "你来了",
  "khmer_dubbing": "អ្នកមកហើយ ចាស"
}
```

- `start` / `end` — `MM:SS.S`, absolute on the uploaded recording.
- `speaker_gender` — `male` | `female`; normalized from model output and, as a
  last resort, inferred from `បាទ` / `ចាស`.
- `vocal_timbre` — short free-text voice description.
- `character_role` — stable role label for the speaker.
- `original_transcript` — verbatim source line.
- `khmer_dubbing` — spoken Khmer line for TTS.

`pitch` was removed in `d21e3d4`. Segments are 7 fields, not 8.

### `response_format=json` (default)

```json
{
  "id": "dub_...",
  "object": "audio.dubbing",
  "created": 1793703566,
  "model": "gemini-3.5-flash-lite",
  "source_language": "Chinese",
  "target_language": "Khmer",
  "duration_seconds": 9.576,
  "chunk_count": 1,
  "chunk_seconds": 300,
  "segment_count": 3,
  "segments": [ ... ],
  "chunks": [
    {
      "index": 0,
      "start_seconds": 0,
      "end_seconds": 9.576,
      "segment_count": 3,
      "max_output_tokens": 8192,
      "model": "gemini-3.5-flash-lite",
      "usage": { "promptTokens": 758, "completionTokens": 120, "totalTokens": 878 }
    }
  ],
  "usage": { "promptTokens": 758, "completionTokens": 120, "totalTokens": 878 },
  "timings": { "transcode_ms": 198, "model_ms": 2710, "total_ms": 2971 }
}
```

`warnings` appears only when segments were dropped (missing Khmer text or
invalid timing).

### `response_format=array`

Returns only the segment array — no metadata envelope.

### Response headers

- `Cache-Control: no-store`
- `X-Geminirouter-Model`
- `X-Geminirouter-Chunks`
- `X-Geminirouter-Segments`
- `X-Geminirouter-Duration-Seconds`

---

## 5. Chunking and token budget

- Default chunk: **300 s**; maximum: **1800 s**.
- Chunks are auto-shrunk so an inline chunk stays under ~14 MiB at the configured
  bitrate (48 kbps on production ⇒ the 1800 s cap applies).
- `concurrency` workers process chunks; results are merged and sorted by absolute
  start time.
- When there is more than one chunk, the prompt states the part number and
  forbids restarting at 00:00 (chunk-local times are shifted by the server).
- Chunk 2+ receives the last three segments of the previous chunk as continuity
  context (names, roles, terminology) with an explicit "do not repeat" rule.

### Duration-based `maxOutputTokens`

| Chunk duration | Cap |
|---|---|
| ≤ 55 s | 8,192 |
| ≤ 120 s | 8,192 |
| ≤ 240 s | 16,384 |
| ≤ 300 s | 24,576 |
| ≤ 600 s | 40,960 |
| > 600 s (incl. 1800 s) | 65,535 |

A `finishReason` of `length` / `max_tokens` fails the request with
`model_output_truncated`; the server never returns a silently shortened script.

---

## 6. Reliability behavior

| Situation | Behavior |
|---|---|
| Model/core rejects `responseSchema` (HTTP 400) | Retry the chunk once without the schema, keeping `responseMimeType: application/json` and the prompt contract |
| HTTP 403/408/429/500/502/503/504 | Retry with exponential backoff (`5s × 2^attempt`, capped at 60 s) up to `MEDIA_MAX_RETRIES + 1` attempts |
| HTTP 400/404/413/415/422 | Fail fast as `model_rejected_media` (422) |
| HTTP 401 from core | `upstream_auth_failed` (401) — no retry |
| Truncated output | `model_output_truncated` (502) — no partial script returned |
| Empty content | Retried; `empty_model_response` (502) when exhausted |
| Generic model failure sentence | Retried up to 2 attempts; `model_failure_text` (502) |
| Non-JSON / unparseable output | Retried; `invalid_model_json` (502) |
| A chunk still fails | Error `details.completed_chunks` + `details.partial_segments` so finished work is not lost |
| Client disconnects | Abort upstream, return `client_closed_request` (499) internally, no response |
| Total timeout | `total_timeout` (504) |
| FFmpeg/FFprobe missing | `ffmpeg_unavailable` (503) |

Prompt JSON recovery: the parser accepts bare arrays, Markdown fences, wrapper
objects, and prose around the array, then normalizes/clamps/drops invalid
segments.

---

## 7. Files changed

| File | Change |
|---|---|
| `server/src/mediaTranscription.ts` | Dubbing routes, options, prompt, schema, parser, normalizer, chunk runner, response builder; pitch field and `normalizePitch()` removed |
| `server/test/media-transcription.test.ts` | 8 dubbing tests added/updated (caps, timestamps, JSON recovery, clamping/offset, prompt continuity, route integration, schema fallback, auth) |
| `docs/MEDIA_API.md` | Dubbing endpoint documentation, contract, caps, examples, error behavior |
| `README.md` | Dubbing route mention; pitch removed from the description |
| `frontend/src/components/marketing/DocsPage.tsx` | Docs site: endpoint table rows + “Timed dubbing · Chinese → Khmer” section with request/response samples; pitch removed |
| `docs/DUBBING_CHANGELOG.md` | This file |

No deploy config changes were required: `deploy/Caddyfile`, `deploy/nginx.conf`,
and `deploy/install-vps.sh` already route `/v1/audio/*` and `/v1/media/*` to the
bridge (port 3000) instead of the core (8045).

---

## 8. Tests

`pnpm --dir server test` → **87/87 passing** after both commits.

Dubbing-specific coverage:

- Output caps follow the duration table.
- `MM:SS.S` / `HH:MM:SS.S` / numeric timestamp parsing and formatting.
- JSON array recovery from fences, wrappers, and surrounding prose.
- Clamping, missing values, gender inference, and absolute-time offset.
- Prompt keeps the caller text, appends the contract, and adds chunk context.
- Route integration: chunking, token caps, absolute offsets, auth.
- `response_format=array` returns the bare array; rejected schema retries without it.
- Dubbing rejects a request without an API key before reading the upload.

Frontend: `pnpm --dir frontend run build` clean; `oxlint` reports only
pre-existing warnings.

---

## 9. Website update

`https://framecall.site/docs`:

- Endpoint table now lists `POST /v1/audio/transcriptions` and
  `POST /v1/audio/dubbing` (protocol “Media”).
- New “Timed dubbing · Chinese → Khmer” block:
  - server-side `fetch` example (`FormData`, `source_language`, `target_language`,
    `response_format=array`)
  - one-segment response sample (7 fields)
  - defaults, `chunk_seconds`, token caps, absolute timestamps
  - `បាទ` / `ចាស` speaker rule
  - note that TTS/muxing still happen in the dubbing app
- Live bundle after deploy: `index-o1PTuUTF.js` (CSS `index-DKl6l1hE.css`).

---

## 10. Deployment record

**Target:** `ubuntu@52.64.141.143` (AWS ap-southeast-2), public origin
`https://framecall.site`, install root `/opt/geminirouter`.

| Service | Unit | Port |
|---|---|---|
| Bridge / dashboard | `geminirouter-bridge.service` | 3000 |
| Antigravity core | `geminirouter-core.service` | 8045 |
| TLS/reverse proxy | `caddy.service` | 443 |

Method: build locally, `tar` the `dist` trees, `scp` to `/tmp`, extract as root,
`chown geminirouter:geminirouter`, `systemctl restart geminirouter-bridge`.
`/opt/geminirouter` is not a git checkout; deploy is artifact-based.

Backups created under `/opt/geminirouter/.deploy-backups/`:

| Backup | Contents |
|---|---|
| `20261103-104441` | Pre-dubbing `server/dist` + `frontend/dist` |
| `20261103-104737` | Pre-docs-update `frontend/dist` |
| `20261103-105635` | Pre-pitch-removal `server/dist` + `frontend/dist` |

### Production media settings

From `/etc/geminirouter/geminirouter.env`:

```
MEDIA_MAX_UPLOAD_BYTES=2147483648
MEDIA_MAX_DURATION_SECONDS=7200
MEDIA_CHUNK_SECONDS=900
MEDIA_AUDIO_BITRATE=48k
MEDIA_JSON_BODY_LIMIT_BYTES=100663296
MEDIA_CHUNK_TIMEOUT_MS=900000
MEDIA_TRANSCODE_TIMEOUT_MS=1800000
MEDIA_TOTAL_TIMEOUT_MS=7200000
MEDIA_MAX_RETRIES=2
```

Dubbing ignores `MEDIA_CHUNK_SECONDS` and uses its own 300 s default; the
`MEDIA_*` upload/duration/timeout limits still apply.

---

## 11. Live verification

Run after the final deploy (`20261103-105635`):

| Check | Result |
|---|---|
| `systemctl is-active geminirouter-bridge` | `active`, `NRestarts=0`, no error log entries |
| `GET /v1/audio/languages` | 200 |
| `POST /v1/audio/dubbing` (`response_format=array`, 9.6 s clip) | 200 in 6.3 s, 3 segments |
| Segment keys | `start,end,speaker_gender,vocal_timbre,character_role,original_transcript,khmer_dubbing` |
| Khmer payload | Valid UTF-8 (30 / 68 / 63 Khmer characters), no replacement characters |
| `pitch` in deployed `/opt/geminirouter/server/dist/mediaTranscription.js` | `0` occurrences |
| `POST /v1/audio/dubbing` (`json`) | 200, `object: "audio.dubbing"`, 1 chunk, `max_output_tokens: 8192`, usage + timings present |
| `POST /v1/audio/transcriptions` | 200, transcript in `text` (not `transcript`) |
| Live frontend assets | `index-o1PTuUTF.js`, `index-DKl6l1hE.css` — match local build |

Example call:

```sh
curl -X POST "https://framecall.site/v1/audio/dubbing" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -F "file=@episode.mp3" \
  -F "source_language=zh" \
  -F "target_language=km" \
  -F "response_format=array"
```

---

## 12. Known limitations / follow-ups

1. **Model can return `[]` on valid speech.** One live JSON-mode run on a 9.6 s
   English clip with `source_language=zh` returned `segment_count: 0` and
   `completionTokens: 1` (the model answered an empty array). The same clip
   returned 3 segments in array mode. The built-in prompt is Chinese→Khmer, so a
   mismatched source hint can make the model skip the audio. Suggested fix:
   treat an empty array on non-silent audio as retryable, or add a prompt hint
   when the audio language may differ from `source_language`. Not implemented
   yet.
2. **No speaker diarization IDs.** Segments carry `speaker_gender` and
   `character_role`, but no stable speaker index. Similar voices can be
   relabeled between chunks.
3. **No pitch field by design.** TTS voice selection must use `speaker_gender`,
   `vocal_timbre`, and `character_role`.
4. **No cross-chunk overlap trim.** Overlapping utterances at a chunk boundary
   are sorted but not de-duplicated.
5. **Inline audio ceiling.** Very long single chunks at a high bitrate are
   auto-shrunk; the production bitrate (48 kbps) keeps 1800 s within reach.
6. **Docs/site deploy is manual.** There is no CI pipeline; the artifact
   procedure above is the deployment path.

---

## 13. Rollback

Restore the previous build and restart:

```sh
sudo cp -a /opt/geminirouter/.deploy-backups/20261103-104441/server/dist/. /opt/geminirouter/server/dist/
sudo cp -a /opt/geminirouter/.deploy-backups/20261103-104441/frontend/dist/. /opt/geminirouter/frontend/dist/
sudo chown -R geminirouter:geminirouter /opt/geminirouter/server/dist /opt/geminirouter/frontend/dist
sudo systemctl restart geminirouter-bridge
```

To roll back only the pitch removal, use backup `20261103-105635` for
`server/dist` and the `20261103-104737` or `20261103-104441` frontend tree
depending on whether the docs section should remain.
