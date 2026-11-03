# Audio and video input API

GeminiRouter is the model gateway. A separate dubbing website can send requests
to the gateway's OpenAI-compatible API, or upload long recordings directly to
the gateway's `/v1/audio/transcriptions` endpoint; the gateway returns the model
response. The dashboard itself is not the upload or dubbing app.

## Request flow

1. The dubbing website's server receives the user's audio or video upload.
2. Its server reads the file and sends a `POST /v1/chat/completions` request to
   GeminiRouter with the media in an OpenAI-compatible content block.
3. GeminiRouter forwards the request to the Antigravity core, which maps the
   audio/video into the model request.
4. The website reads `choices[0].message.content`, for example translated
   dialogue or a transcript, and presents it to the user.

Use a server-to-server call. Keep the GeminiRouter API key in the dubbing
website's server environment; do not expose it in browser JavaScript.

## Audio input

Send audio as base64 in an `input_audio` content block. The current core accepts
MP3, WAV, OGG, FLAC, AAC/M4A, and AIFF. Its audio validator limits decoded audio
to 15 MiB per request.

```js
const audioBase64 = (await fs.readFile(audioPath)).toString('base64');
const TARGET_LANGUAGE = 'Japanese'; // any language name or ISO code: es, th, km, ar, ...

const response = await fetch(`${GEMINIROUTER_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${GEMINIROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL_ID,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Transcribe the speech, translate it to ${TARGET_LANGUAGE}, and return one line per speaker.`,
        },
        {
          type: 'input_audio',
          input_audio: { data: audioBase64, format: 'wav' },
        },
      ],
    }],
  }),
});

if (!response.ok) throw new Error(`Gateway returned ${response.status}: ${await response.text()}`);
const result = await response.json();
const translatedDialogue = result.choices?.[0]?.message?.content ?? '';
```

Set `format` to the actual file format (`mp3`, `wav`, `ogg`, `flac`, `aac`,
`m4a`, or `aiff`). The core validates audio bytes and rejects unsupported or
mislabeled input.

## 10–20 minute windows (up to 2 hours for large files)

10–20 minute windows are the recommended unit for the website. The core's
audio validator caps decoded audio at 15 MiB (roughly 40 minutes at 48 kbps),
so each window fits comfortably in one chunk. The bridge-level endpoint streams
the upload to disk, transcodes it to mono 16 kHz MP3, and sends each 15-minute
chunk through the same lease/quota/failover path as `/v1/chat/completions`. One
call returns the transcript and translation for that window.

The playground's large-media path and the API accept up to **2 hours** per
request; the server splits it into 15-minute chunks automatically. Each chunk
has a 65,535-token output budget, so 15–20 minute windows fit without
truncating dialogue. The website can still split at 10–20 minutes for faster
responses. A request over the 2-hour maximum is rejected with
`duration_too_long`.

### Prompt-first requests

Put the user's own instruction in `prompt`. The endpoint sends that prompt with
the audio and returns the model's answer in `text`; it does not force a
transcript/translation shape or add website-authored instructions. `task` and
`target_language` are optional fallbacks for callers that do not send a prompt.

| Route | Purpose |
|---|---|
| `POST /v1/audio/transcriptions` | Transcribe, translate, or do both in one call. |
| `POST /v1/audio/translations` | Same handler; defaults to `task=translate` and English when no target is set. |
| `POST /v1/media/transcriptions` | Alias of `/v1/audio/transcriptions`. |
| `GET /v1/audio/languages` | Convenience list of common language names/codes (`accepts_any: true`). |

### Request formats

All three formats accept the same options:

- `prompt` — the user's own instruction, sent with the audio. This is the
  primary field: the model returns whatever the prompt asks for. If omitted,
  the endpoint builds a fallback prompt from `task` and `target_language`.
- `task` — optional fallback: `transcribe`, `translate`, or `both`. When a
  `prompt` is present and `task` is omitted, the response is `task: "custom"` and
  `text` is the raw model answer. If no prompt is sent, `task` defaults to
  `both` when `target_language` is present, otherwise `transcribe`.
- `target_language` — optional fallback for the built-in prompts. Any language
  name or ISO 639-1/639-2 code works: `Spanish`, `es`, `Japanese`, `ja`,
  `Thai`, `th`, `Khmer`, `km`, `pt-BR`, `zh-TW`, `Arabic`, `ar`. It is not an
  allow-list; unknown values are passed to the model unchanged.
- `source_language` — optional source language hint (`en`, `French`, etc.).
- `model` — defaults to `gemini-3.5-flash-lite`.
- `response_format` — `json` (default) or `text`.
- `chunk_seconds` — target chunk length, 60–3600 seconds; default `900`
  (15 minutes). The server also reduces it automatically if a chunk would
  exceed the core's audio limit.
- `temperature`, `max_tokens` (256–65,535, default `65,535`), `concurrency`
  (1–4 chunks in parallel).

#### Multipart upload (recommended for large files)

```sh
# The user's own prompt. No task/target_language is set by the website.
curl -X POST "$GEMINIROUTER_URL/v1/audio/transcriptions" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -F "file=@episode.mp3" \
  -F "prompt=Summarize this recording in Japanese, list the speakers, and include the key points."
```

If the caller does not send a prompt, the optional built-in transcript+translation
mode still works:

```sh
curl -X POST "$GEMINIROUTER_URL/v1/audio/transcriptions" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -F "file=@episode.mp3" \
  -F "task=both" \
  -F "target_language=ja"
```

#### Raw binary upload

Metadata travels in the query string. The body is the audio file itself.

```sh
curl -X POST "$GEMINIROUTER_URL/v1/audio/transcriptions?task=both&target_language=th" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -H "Content-Type: audio/mpeg" \
  --data-binary @episode.mp3
```

#### JSON/base64 upload (smaller files)

```js
const response = await fetch(`${GEMINIROUTER_URL}/v1/audio/transcriptions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${GEMINIROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gemini-3.5-flash-lite',
    audio_base64: audioBase64,
    filename: 'episode.mp3',
    task: 'both',
    target_language: 'fr',
    prompt: 'Transcribe and translate to French. Return speaker turns on separate lines.',
  }),
});
```

#### Standard LLM chat with audio

If the website already uses the OpenAI chat shape, it can pass the user's prompt
and audio unchanged to `/v1/chat/completions`:

```js
const response = await fetch(`${GEMINIROUTER_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${GEMINIROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gemini-3.5-flash-lite',
    stream: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        { type: 'input_audio', input_audio: { data: audioBase64, format: 'mp3' } },
      ],
    }],
  }),
});
const answer = (await response.json()).choices?.[0]?.message?.content;
```

This path sends the prompt verbatim. Use compressed 10–20 minute audio
(≤15 MiB decoded); for larger or unsupported files, use
`/v1/audio/transcriptions` with the same `prompt`.

### Response

```json
{
  "id": "audtr_...",
  "object": "audio.transcription",
  "model": "gemini-3.5-flash-lite",
  "task": "both",
  "source_language": null,
  "target_language": "Japanese",
  "duration_seconds": 3720.4,
  "chunk_count": 3,
  "chunk_seconds": 1800,
  "text": "TRANSCRIPT:\n...\n\nTRANSLATION:\n...",
  "transcript": "...",
  "translation": "...",
  "segments": [
    {
      "index": 0,
      "start_seconds": 0,
      "end_seconds": 1800,
      "text": "...",
      "transcript": "...",
      "translation": "...",
      "model": "gemini-3.5-flash-lite"
    }
  ],
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
  "timings": { "transcode_ms": 0, "model_ms": 0, "total_ms": 0 }
}
```

For prompt-first requests, `task` is `"custom"` and `text` is the raw model
answer. `transcript` and `translation` are included only if the model happened
to return those section markers. With `response_format=text`, the response body
is the plain `text` value.
If a chunk still fails after retries, the error includes
`details.completed_chunks` and `details.partial_text` so the caller can keep the
work that succeeded instead of losing the whole recording. Always use a
server-to-server request; the upload and the API key must not be exposed in
browser JavaScript.

### Language support

Translation is model-driven, so the practical limit is the model's language
ability, not an endpoint allow-list. Any language the selected model understands
can be requested by name or ISO code. Common codes are normalized for you
(`ja` → Japanese, `pt-BR` → Brazilian Portuguese, `zh-TW` → Traditional
Chinese); an unrecognized name such as `Klingon` is still sent to the model.
`/v1/audio/translations` without a target defaults to English, matching the
OpenAI audio-translations convention.

`GET /v1/audio/languages` returns a convenience list with `accepts_any: true`;
it is deliberately not an allow-list. If you need several target languages,
make one call per language with the same audio and a different
`target_language` (or `prompt`). Each call is independent and uses the normal
account pool.

### Deployment routing

The upload must reach the bridge, not the core. The shipped Caddy and Nginx
configs route `/v1/audio/*` to `127.0.0.1:3000` (bridge) and everything else
under `/v1` to the core. If you use a custom reverse proxy, add the same rule and
raise the request-body and response timeouts for this path.

## Timed dubbing endpoint (Chinese → Khmer by default)

`POST /v1/audio/dubbing` is the server-side dubbing pipeline. It accepts the
same multipart, raw-binary, and JSON/base64 uploads as the transcription route,
splits the recording into safe chunks, and sends each chunk to the
Gemini-native `:generateContent` endpoint with `inline_data`, a JSON response
schema, and a duration-based `maxOutputTokens` cap. The returned timed segments
are shifted from chunk-local time onto the absolute recording timeline.

| Route | Purpose |
|---|---|
| `POST /v1/audio/dubbing` | Timed, speaker-aware dubbing segments. |
| `POST /v1/media/dubbing` | Alias of `/v1/audio/dubbing`. |

### Request fields

The route reuses the transcription upload parsers: multipart `file`,
`Content-Type: audio/*` raw body with query metadata, or JSON with
`audio_base64`. Options:

- `prompt` — optional full dubbing instruction. When omitted, the server sends
  a built-in Chinese→Khmer prompt covering gender particles (male `បាទ`, female
  `ចាស`), kinship terms, and the money/fruit terminology rules. When supplied,
  the caller's prompt is used and the JSON/timing output contract is appended.
- `source_language` — default `zh`.
- `target_language` — default `km`.
- `model` — defaults to `MEDIA_DEFAULT_MODEL` or `gemini-3.5-flash-lite`.
- `chunk_seconds` — 60–1800 seconds; default `300` (five minutes). The server
  also shrinks it automatically if a chunk would exceed the core's audio limit.
- `max_tokens` — optional override, 256–65,535. When omitted, each chunk uses
  the duration table below.
- `temperature` — default `0`; `concurrency` — 1–4 chunks in parallel;
  `response_format` — `json` (default) or `array`.

When `concurrency` is omitted, short-window models (`-lite` and the reasoning
family) run **one worker per chunk, up to 4**. Serial 120-second reasoning chunks
made a 300-second request look hung: one worker did not answer in 20 minutes,
while three parallel chunks returned a complete 90-segment script in 575 seconds.
Long-window models keep the historical default of 1. Set `concurrency` explicitly
to override; the effective value is echoed in the response.

Reasoning models (the `gemini-3.8` family and any id containing `high`,
`thinking`, `reasoner` or `pro`) spend output tokens on a thinking pass before
the JSON answer. They are capped at **120 seconds per chunk** and always get at
least **40,960** output tokens, because their earlier 300-second answers returned
a single line.

The `-lite` models get a **60-second window** and the same 40,960-token floor.
`gemini-3.5-flash-lite` stops when it reaches the end of the first complete
script pass: on a 300-second window it returned only the first ~69 seconds, and
on a 120-second chunk it still stopped at `01:09`. 60-second windows end mid-pass,
so the whole chunk is transcribed (300 s → 5 chunks, 67 segments). Other models
keep the requested chunk size and the duration table. This cap is dubbing-only:
the same model id is unchanged for `/v1/chat/completions` and `/v1/models`.

### Output contract

Each segment has exactly these fields:

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

The default `json` response wraps the merged segments with metadata:

```json
{
  "id": "dub_...",
  "object": "audio.dubbing",
  "model": "gemini-3.5-flash-lite",
  "source_language": "Chinese",
  "target_language": "Khmer",
  "duration_seconds": 3720.4,
  "chunk_count": 13,
  "chunk_seconds": 300,
  "concurrency": 4,
  "segment_count": 284,
  "segments": [
    { "start": "00:12.4", "end": "00:16.8", "speaker_gender": "female",
      "vocal_timbre": "young and bright", "character_role": "younger sister",
      "original_transcript": "你来了", "khmer_dubbing": "អ្នកមកហើយ ចាស" }
  ],
  "coverage": {
    "speech_seconds": 332.8,
    "covered_seconds": 318.4,
    "ratio": 0.957
  },
  "chunks": [
    { "index": 0, "start_seconds": 0, "end_seconds": 300, "segment_count": 24,
      "speech_seconds": 271.2, "covered_seconds": 260.4, "thought_characters": 0,
      "max_output_tokens": 40960, "model": "gemini-3.5-flash-lite",
      "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 } }
  ],
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
  "timings": {
    "estimated_ms": 93010,
    "transcode_ms": 0,
    "model_ms": 0,
    "total_ms": 0
  }
}
```

With `response_format=array`, the body is only the segment array.

`timings.estimated_ms` is a wall-clock planning figure derived from production
throughput, not a deadline: 2.2× audio duration for reasoning models, 0.3× for
`-lite`, 1× for everything else. A 300-second `gemini-3.8-flash-high` request is
therefore quoted around 11 minutes. Account-pool contention can push a request
well past the estimate, so use it to set client timeouts, not to abort work.

| Model | 60 s clip | 120 s clip | 300 s clip |
|---|---:|---:|---:|
| `gemini-3.8-flash-high` | ~71 s | ~113 s | ~575 s (3 parallel chunks) |
| `gemini-3.5-flash-lite` | ~25 s | ~45 s | ~65 s (5 parallel chunks) |

For latency-sensitive work prefer `gemini-3.5-flash-lite`; when the 3.8 script
quality is required, send 120-second chunks from the client or let the endpoint
split a 300-second clip and budget ~10 minutes.

### Duration-based output caps

| Chunk duration | `maxOutputTokens` |
|---|---|
| ≤ 120 s | 8,192 |
| ≤ 240 s | 16,384 |
| ≤ 300 s | 24,576 |
| ≤ 600 s | 40,960 |
| > 600 s | 65,535 |

Reasoning models and `-lite` models always receive at least 40,960 tokens, even
for a 60- or 120-second chunk.

A response that stops at the cap (`finishReason: "MAX_TOKENS"`) fails the whole
request with `model_output_truncated`; the server never returns a silently
shortened script. Use a shorter `chunk_seconds` or a larger `max_tokens`.

If the selected model or core rejects `responseSchema`, the chunk is retried
once without the schema, keeping `responseMimeType: application/json` and the
prompt contract. If a chunk still fails after retries, the error includes
`details.completed_chunks` and `details.partial_segments` so successful work is
not lost.

### Completeness validation

Thinking parts (`parts[].thought: true`) are never mixed into the answer. The
server parses only the model's final JSON, and when an answer contains several
arrays it uses the largest/last one, so an example draft cannot become the
script.

For every chunk the server also runs FFmpeg `silencedetect` to measure audible
speech, then compares it with the time covered by the returned segments. When
the answer is empty, a single line for a long conversation, or covers less than
35% of the audible speech, the chunk is retried once with an explicit
completeness prompt. If the retry is still incomplete, the request fails instead
of silently dropping dialogue:

```json
{
  "error": {
    "message": "Chunk 1 returned 1 segment(s) covering 0.2s of 3.1s of audible speech (7%). ...",
    "type": "media_error",
    "code": "partial_script",
    "details": {
      "chunkIndex": 0,
      "segmentCount": 1,
      "coveredSeconds": 0.2,
      "speechSeconds": 3.1,
      "durationSeconds": 3.1,
      "coverageRatio": 0.065,
      "thoughtCharacters": 0
    }
  }
}
```

`empty_model_response` is used when the model returned no answer at all.
Silent or unmeasurable chunks are accepted with an empty segment list; the
`coverage` block reports `speech_seconds: null` when FFmpeg could not measure
the chunk.

Completeness is checked per chunk. `gemini-3.5-flash-lite` used to stop early on
a 300 s window (20 segments covering 43 s of 170 s of dialogue), and on a 120 s
window it still stopped at the end of the first script pass (`01:09`, dropping
10 lines). It now uses 60 s windows plus the 40,960-token floor, which covered
the same clip completely (5 chunks, 67–73 segments across runs). If a chunk is
still incomplete after the strict retry, the request fails with `partial_script`
instead of returning a truncated script.

### Examples

```sh
# Default Chinese → Khmer dubbing with the built-in prompt.
curl -X POST "$GEMINIROUTER_URL/v1/audio/dubbing" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -F "file=@episode.mp3" \
  -F "model=gemini-3.5-flash-lite" \
  -F "chunk_seconds=300"

# The website's own prompt; the server still appends the JSON/timing contract.
curl -X POST "$GEMINIROUTER_URL/v1/audio/dubbing?response_format=array&prompt=Translate%20this%20short%20drama%20into%20spoken%20Khmer%20for%20TTS." \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -H "Content-Type: audio/mpeg" \
  --data-binary @episode.mp3

# JSON/base64 upload for smaller clips.
curl -X POST "$GEMINIROUTER_URL/v1/audio/dubbing" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash-lite","audio_base64":"...","filename":"clip.mp3"}'
```

## Video input

Send video as a `video_url` block. For an uploaded file, the dubbing website's
server can base64-encode the bytes and use a data URL:

```js
const videoBase64 = (await fs.readFile(videoPath)).toString('base64');
const TARGET_LANGUAGE = 'Spanish'; // any language name or ISO code

const response = await fetch(`${GEMINIROUTER_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${GEMINIROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL_ID,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Describe the spoken dialogue and translate it to ${TARGET_LANGUAGE}. Keep speaker turns separate.`,
        },
        {
          type: 'video_url',
          video_url: { url: `data:video/mp4;base64,${videoBase64}` },
        },
      ],
    }],
  }),
});

if (!response.ok) throw new Error(`Gateway returned ${response.status}: ${await response.text()}`);
const result = await response.json();
const translatedDialogue = result.choices?.[0]?.message?.content ?? '';
```

The core also accepts a reachable HTTP(S) video URL. A URL must be accessible to
the upstream model service. Use a data URL for a private upload that must not be
hosted publicly.

## Limits and behavior

- `/v1/chat/completions` accepts bodies up to 64 MiB, matching the core's
  model-request limit. Base64 expands files by about one third. Keep inline
  audio at or below 15 MiB decoded and inline video around 20 MiB or smaller.
- `/v1/audio/transcriptions` recommends 10–20 minute windows and accepts up
  to 2 hours (`MEDIA_MAX_DURATION_SECONDS=7200`). Uploads are streamed to disk,
  so the JSON body limit is not the constraint. Chunks stay below the core's
  15 MiB audio limit automatically.
- Each transcription chunk gets a 65,535-token output budget by default. If a
  response still stops at the cap (`finish_reason: "length"`), the endpoint
  fails the request with `model_output_truncated` instead of returning a
  silently shortened transcript. Lower `chunk_seconds` or send a smaller
  `max_tokens` only when you also accept shorter output.
- Large requests can take many minutes. Set the client and reverse-proxy
  timeouts to at least 30 minutes for short windows and up to 2 hours for the
  largest files. The shipped configs allow 2 hours for `/v1/audio/*`.
- Model availability does not guarantee audio/video capability. Choose a model
  from `GET /v1/models` and test it with the actual media type before making it
  selectable in the dubbing app. The current model list does not advertise
  per-model media capabilities.
- The response is model-generated text. The current core does not provide a
  text-to-speech endpoint or combine translated speech with the source video.
  The dubbing app must add speech generation and media muxing if it needs a
  finished dubbed video.

## Connection settings

- `GEMINIROUTER_URL`: public HTTPS origin, for example `https://framecall.site`
- `GEMINIROUTER_API_KEY`: the configured gateway Bearer key
- `MODEL_ID`: an id returned by `GET /v1/models`

Verify the connection and model list before uploading media:

```sh
curl "$GEMINIROUTER_URL/v1/models" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY"
```

Then issue a small audio or video request and inspect the returned HTTP status
and message. A successful model-list request only checks authentication and
connectivity; it does not prove the selected model can process that media type.
