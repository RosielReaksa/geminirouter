# Dubbing Pipeline — Implementation Report

Date: 2026-11-08

## Summary

Implemented the first version of the finished-video dubbing pipeline and the
media burst gate that protects it. The work is in the working tree; the full
test suite has not completed yet because the long-running media transcription
tests timed out. Targeted tests for the new job store, subtitle generation and
media gate pass, and `tsc` builds cleanly.

## 1. Media concurrency gate

**Files:** `server/src/mediaGate.ts`, `server/src/mediaTranscription.ts`,
`server/src/index.ts`, `docs/MEDIA_API.md`

- Admits at most **50 media jobs** at once.
- Queues up to **500** jobs FIFO with a **10 minute** wait.
- Returns `503` + `Retry-After` + `media_queue_full` when the queue is full or
  the wait expires.
- Adds `x-media-queue-wait-ms` to every media response.
- Exposes `GET /api/media/queue` with active/queued/limit stats.
- Configurable with:
  - `MEDIA_MAX_CONCURRENT_JOBS` (default 50)
  - `MEDIA_QUEUE_LIMIT` (default 500)
  - `MEDIA_QUEUE_TIMEOUT_MS` (default 600000)
- Media routes now accept named gateway keys, not only the master key.

## 2. Async dubbing jobs

**Files:** `server/src/dubbingJob.ts`, `server/src/index.ts`

New persistent job pipeline:

- SQLite job store at `.data/dubbing-jobs.db`.
- Output files at `.data/dubbing-jobs/<jobId>/`.
- Crash recovery: jobs left in `processing`/`mixing` are re-queued on startup.
- Worker pool with `MEDIA_JOB_WORKERS` (default 2).
- Job API:
  - `POST /v1/audio/dubbing-job` → `202 { job_id, status, status_url }`
  - `GET /api/media/jobs` → recent jobs
  - `GET /api/media/jobs/:id` → status/progress/result
  - `GET /api/media/jobs/:id/output?type=video|audio|srt|vtt` → file stream
  - `DELETE /api/media/jobs/:id`
- Inputs are HTTP(S) URLs for media, optional music stem and optional SFX stem.
- Optional `webhook` receives a best-effort POST on completion/failure with
  job id, status, progress, error and output paths.

### Job processing steps

1. Download source media.
2. Extract audio if the source is video.
3. Probe duration; reject over the configured maximum.
4. Split audio into chunks and generate the timed dubbing script with the
   existing model path.
5. Synthesize one TTS clip per segment:
   - voice selected by `character_role` through the `speakers` map, falling
     back to gender/language defaults;
   - clip fitted to the original segment duration with FFmpeg `atempo`.
6. Assemble the dubbed timeline with silence gaps.
7. Mix music/SFX stems (looped, music at 0.25, SFX at 0.6).
8. Mux with the source video when the input was video.
9. Write SRT and VTT with numeric `startSeconds`/`endSeconds` in the job JSON.
10. Mark completed and call the webhook.

## 3. 5-hour media

**File:** `server/src/mediaTranscription.ts`

- Default `MEDIA_MAX_DURATION_SECONDS` raised from 2 hours to **5 hours**
  (180000 seconds). Maximum is 5 hours.
- `MEDIA_MAX_UPLOAD_BYTES` remains 2 GB default / 8 GB maximum; job downloads
  use the same limit.

## 4. Speaker stability, glossary, subtitles

- `speaker_id` is derived from `character_role` and stored on every segment.
- Voice mapping is stable per role across chunks because the same `speakers`
  map/defaults are used for every chunk.
- `glossary` is appended to the dubbing prompt.
- SRT and VTT are generated from the merged segments. Numeric timings are in
  the job's `segments` JSON.

## 5. Per-key concurrency

- The existing Gemini key pool keeps **4 concurrent calls per key**.
- Job chunk concurrency is configurable per job (`concurrency`, 1–4).
- `MEDIA_JOB_WORKERS` controls how many jobs run at once (default 2), so the
  total chunk fan-out stays bounded.

## 6. Verification status

Passing:

- `pnpm run build` (clean `tsc`).
- `test/media-gate.test.ts` — admission, FIFO queue, queue-full, timeout.
- `test/dubbing-job.test.ts` — create/list/read/delete, SRT/VTT formatting.
- Media route smoke test through the concurrency gate: `HTTP 200`,
  `x-media-queue-wait-ms: 0`, transcription returned.
- `GET /api/media/queue` returns live gate stats.

Not completed:

- The full `pnpm test` run timed out inside `test/media-transcription.test.ts`
  (long ffmpeg-heavy suite). The new tests pass individually; the complete
  suite still needs a run with a longer timeout.
- No end-to-end dubbing job has been run against a real media URL, real TTS
  voice and real webhook yet. That is the next verification step.

## 7. Known limitations / next steps

- Job input is URL-based; there is no multipart upload on the job endpoint yet.
- The media gate is in-memory; a bridge restart clears queued (not started)
  media jobs.
- The job queue is persistent, but worker state is process-local. Multiple
  bridge instances would need a shared worker claim mechanism.
- `edge-tts` is an external TTS dependency; if Microsoft blocks the VPS IP,
  jobs fail at the TTS step.
- Output files are local paths; production should move them to object storage
  and return signed URLs.
- Webhook delivery is best-effort with no retry table yet.
- The job logger uses `console` as a temporary Fastify logger substitute.
- `response_format` is stored but the job status API always returns JSON.
- The `speakers` map and glossary are passed as strings; validation is minimal.

## 8. How to run a job

```bash
curl -X POST "$GEMINIROUTER_URL/v1/audio/dubbing-job" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "media_url": "https://example.com/episode.mp4",
    "music_url": "https://example.com/music.mp3",
    "sfx_url": "https://example.com/sfx.mp3",
    "glossary": "character names and fixed terms",
    "speakers": {"sister": "km-KH-SreymomNeural", "brother": "km-KH-PisethNeural"},
    "target_language": "km",
    "webhook": "https://dubber.example.com/hooks/geminirouter"
  }'
```

Then poll `GET /api/media/jobs/:id` or wait for the webhook. Outputs are
available at `/api/media/jobs/:id/output?type=video|srt|vtt`.
