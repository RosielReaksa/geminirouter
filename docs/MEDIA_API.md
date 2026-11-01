# Audio and video input API

GeminiRouter is the model gateway. A separate dubbing website sends requests to
the gateway's OpenAI-compatible API; the gateway returns the model response.
The dashboard itself is not the upload or dubbing app.

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
          text: 'Transcribe the speech, translate it to Khmer, and return one line per speaker.',
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

## Video input

Send video as a `video_url` block. For an uploaded file, the dubbing website's
server can base64-encode the bytes and use a data URL:

```js
const videoBase64 = (await fs.readFile(videoPath)).toString('base64');

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
          text: 'Describe the spoken dialogue and translate it to Khmer. Keep speaker turns separate.',
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

- The web bridge accepts `/v1` request bodies up to 64 MiB, matching the core's
  model-request limit. Base64 expands files by about one third.
- Keep audio at or below 15 MiB decoded. Keep video around 20 MiB or smaller;
  the core warns when inline video exceeds 20 MiB, and the provider may have its
  own limits.
- For feature films, split the source into short scenes or audio segments in the
  dubbing app, then send each segment as a separate model request. Do not send a
  whole movie as one large JSON body.
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
