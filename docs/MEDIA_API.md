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

## Long recordings (1–2 hours or more)

A single model request cannot carry a long recording: the core's audio validator
caps decoded audio at 15 MiB, which is roughly 40 minutes at 48 kbps. Use the
bridge-level audio endpoint for long files. It streams the upload to disk,
transcodes it to mono 16 kHz MP3, splits it into safe chunks, and sends each
chunk through the same lease/quota/failover path as `/v1/chat/completions`. One
call returns the combined transcript and translation.

| Route | Purpose |
|---|---|
| `POST /v1/audio/transcriptions` | Transcribe, translate, or do both in one call. |
| `POST /v1/audio/translations` | Same handler; defaults to `task=translate` and English when no target is set. |
| `POST /v1/media/transcriptions` | Alias of `/v1/audio/transcriptions`. |
| `GET /v1/audio/languages` | Convenience list of common language names/codes (`accepts_any: true`). |

### Request formats

All three formats accept the same options:

- `prompt` — your instruction for every chunk. If omitted, the endpoint builds
  a prompt from `task`, `source_language`, and `target_language`.
- `task` — `transcribe`, `translate`, or `both`. Defaults to `both` when
  `target_language` is present, otherwise `transcribe`.
- `target_language` — any language name or ISO 639-1/639-2 code. Examples:
  `Spanish`, `es`, `Japanese`, `ja`, `Thai`, `th`, `Khmer`, `km`, `pt-BR`,
  `zh-TW`, `Arabic`, `ar`. The endpoint does not restrict this to a fixed list;
  values it does not recognize are passed to the model unchanged.
- `source_language` — optional source language hint (`en`, `French`, etc.).
- `model` — defaults to `gemini-3.5-flash-lite`.
- `response_format` — `json` (default) or `text`.
- `chunk_seconds` — target chunk length, 60–3600 seconds; the server also
  reduces it automatically if a chunk would exceed the core's audio limit.
- `temperature`, `max_tokens`, `concurrency` (1–4 chunks in parallel).

#### Multipart upload (recommended for large files)

```sh
curl -X POST "$GEMINIROUTER_URL/v1/audio/transcriptions" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -F "file=@episode.mp3" \
  -F "model=gemini-3.5-flash-lite" \
  -F "task=both" \
  -F "target_language=ja" \
  -F "prompt=Transcribe the dialogue and translate it into Japanese. Keep speaker turns."
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

With `response_format=text`, the response body is the plain `text` value.
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
- `/v1/audio/transcriptions` is the long-recording path. It streams uploads to
  disk, so a 1–2 hour file is not limited by the JSON body size. The default
  maximum is 2 GiB uploaded / 4 hours of audio, configurable with
  `MEDIA_MAX_UPLOAD_BYTES` and `MEDIA_MAX_DURATION_SECONDS`. Chunks are kept
  below the core's 15 MiB audio limit automatically.
- A long synchronous request can take several minutes. Set the client and
  reverse-proxy timeouts accordingly, or send smaller `chunk_seconds` values
  from an async job worker. The shipped configs allow up to two hours for
  `/v1/audio/*`.
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
