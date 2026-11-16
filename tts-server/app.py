"""geminirouter TTS service.

Internal loopback service that turns text into speech with Edge TTS, spreading
requests across a Webshare proxy pool. The public edge is the Node bridge:
it authenticates the caller, records usage and proxies the audio back.

Public API (internal only):
    POST /speech          text -> audio bytes (or JSON with word timings)
    GET  /voices          the Edge voice catalogue
    GET  /healthz         liveness
    GET  /readyz          readiness (proxy pool loaded)
    GET  /stats           pool and concurrency statistics
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from edge_engine import (
    EdgeTtsEngine,
    EngineConfig,
    resolve_voice,
    voice_catalogue,
)

logging.basicConfig(
    level=os.environ.get("TTS_LOG_LEVEL", "info").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("geminirouter-tts")

ENGINE = EdgeTtsEngine(EngineConfig())
INTERNAL_SECRET = os.environ.get("TTS_INTERNAL_SECRET", "").strip()

CONTENT_TYPES = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "opus": "audio/ogg",
    "ogg": "audio/ogg",
    "aac": "audio/aac",
    "flac": "audio/flac",
}


class SpeechRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str = ""
    language: str = ""
    response_format: str = "mp3"
    speed: float = 1.0
    timestamp_granularities: List[str] = Field(default_factory=list)


def _check_internal(x_geminirouter_internal: Optional[str]) -> None:
    if not INTERNAL_SECRET:
        # No secret configured: loopback-only service, dev mode.
        return
    if x_geminirouter_internal != INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="invalid internal credential")


async def _convert(audio: bytes, fmt: str) -> bytes:
    """Convert MP3 bytes to another container with ffmpeg when required."""
    if fmt == "mp3":
        return audio
    with tempfile.TemporaryDirectory(prefix="geminirouter-tts-") as tmp:
        src = os.path.join(tmp, "in.mp3")
        dst = os.path.join(tmp, f"out.{fmt}")
        with open(src, "wb") as handle:
            handle.write(audio)
        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            src,
            "-f",
            fmt,
            dst,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        if process.returncode != 0 or not os.path.exists(dst):
            raise HTTPException(
                status_code=502,
                detail=f"audio conversion failed: {stderr.decode('utf-8', 'replace')[:200]}",
            )
        with open(dst, "rb") as handle:
            return handle.read()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ENGINE.start()
    logger.info("proxy pool loaded: %s proxies", ENGINE.pool.size)

    refresh_task = asyncio.create_task(_refresh_loop())
    try:
        yield
    finally:
        refresh_task.cancel()


async def _refresh_loop() -> None:
    interval = ENGINE.config.webshare_refresh_seconds
    while True:
        try:
            await asyncio.sleep(interval)
            count = await ENGINE.refresh_proxies()
            logger.info("proxy pool refreshed: %s proxies", count)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - background task must not die
            logger.warning("proxy refresh failed: %s", exc)


app = FastAPI(title="geminirouter TTS", version="1.0.0", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> Dict[str, Any]:
    return {"ok": True}


@app.get("/readyz")
async def readyz() -> Dict[str, Any]:
    return {"ok": ENGINE.pool.size > 0, "proxies": ENGINE.pool.size}


@app.get("/stats")
async def stats(x_geminirouter_internal: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _check_internal(x_geminirouter_internal)
    return ENGINE.stats


@app.get("/voices")
async def voices(
    x_geminirouter_internal: Optional[str] = Header(default=None),
    language: str = "",
) -> JSONResponse:
    _check_internal(x_geminirouter_internal)
    catalogue = await voice_catalogue(ENGINE)
    if language:
        code = language.strip().lower().split("-")[0]
        catalogue = [v for v in catalogue if v["language"] == code]
    return JSONResponse(
        {
            "count": len(catalogue),
            "voices": catalogue,
            "openai_aliases": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
        }
    )


@app.post("/speech")
async def speech(
    request: SpeechRequest,
    x_geminirouter_internal: Optional[str] = Header(default=None),
) -> Response:
    _check_internal(x_geminirouter_internal)

    fmt = str(request.response_format or "mp3").strip().lower()
    if fmt not in CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"response_format must be one of {', '.join(sorted(CONTENT_TYPES))}",
        )

    voice = resolve_voice(request.voice, request.language)
    include_words = "word" in {str(item).lower() for item in request.timestamp_granularities}

    try:
        result = await ENGINE.synthesize(request.text, voice, speed=request.speed, include_words=include_words)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("tts synthesis failed")
        raise HTTPException(status_code=502, detail=f"tts synthesis failed: {exc}")

    audio = await _convert(result.audio, fmt)
    headers = {
        "x-tts-characters": str(result.characters),
        "x-tts-voice": result.voice,
        "x-tts-format": fmt,
        "x-tts-proxy": "direct" if not result.used_proxy else "proxy",
    }
    if result.duration_seconds is not None:
        headers["x-tts-seconds"] = str(result.duration_seconds)

    if include_words:
        # Callers that need timestamps get JSON with the audio embedded, so the
        # timings and the media can never drift apart.
        payload = {
            "audio_base64": base64.b64encode(audio).decode("ascii"),
            "format": fmt,
            "characters": result.characters,
            "duration_seconds": result.duration_seconds,
            "voice": result.voice,
            "words": result.words,
        }
        return JSONResponse(content=payload, headers=headers)

    return Response(content=audio, media_type=CONTENT_TYPES[fmt], headers=headers)


@app.get("/")
async def index() -> Dict[str, Any]:
    return {"service": "geminirouter-tts", "proxies": ENGINE.pool.size}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TTS_PORT", "8077"))
    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=port,
        workers=1,
        log_level=os.environ.get("TTS_LOG_LEVEL", "info").lower(),
    )
