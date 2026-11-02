# Image generation API

GeminiRouter exposes `gemini-3.1-flash-image` through the OpenAI-compatible
image endpoint. The bridge forwards the request to the Antigravity core, so the
normal account leases, quota checks, and traffic records apply.

## Endpoint

```text
POST /v1/images/generations
Authorization: Bearer sk-live-...
Content-Type: application/json
```

Request:

```json
{
  "model": "gemini-3.1-flash-image",
  "prompt": "A simple red circle centered on a white background.",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

Response:

```json
{
  "created": 1793638000,
  "data": [
    { "b64_json": "/9j/4AAQSkZJRg..." }
  ]
}
```

The image is a JPEG returned as base64. Decode `data[0].b64_json` and write it to a
file, or use the Playground image card, which renders and downloads it for you.

## cURL example

```sh
curl -X POST "https://framecall.site/v1/images/generations" \
  -H "Authorization: Bearer $GEMINIROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-image",
    "prompt": "A cinematic photo of a red apple on a wooden table",
    "n": 1,
    "size": "1024x1024",
    "response_format": "b64_json"
  }' \
  -o image-response.json
```

Decode the result:

```sh
jq -r '.data[0].b64_json' image-response.json | base64 -d > image.jpg
```

## Playground

Select **Gemini 3.1 Flash (Image)** in the Playground, write an image prompt,
and run it. The output card renders the generated image and provides a
**Download** button.

## Notes

- The image endpoint can take roughly 10–60 seconds depending on the account
  pool and model load.
- `n` is currently treated as one image per request by the upstream model.
- `size` is passed through; the model may use its own supported dimensions.
- The model is not always listed in the core's `/v1/models`; the dashboard and
  `/api/models` expose the verified alias `gemini-3.1-flash-image`.
- Image generation consumes the account's Gemini quota like any other model
  request.
