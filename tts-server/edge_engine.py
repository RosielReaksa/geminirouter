"""Edge TTS engine behind the geminirouter TTS service.

Ported from the dubbing engine (``mibleappdubber/server/engine/gemini_dubber.py``)
so the public TTS API and the dubber share one battle-tested implementation:
Webshare inventory fetched directly, round-robin proxy selection with a short
cooldown, per-IP concurrency caps, direct fallback, bounded retries and
per-attempt timeouts.

Edge TTS is an unofficial Microsoft endpoint. The engine is deliberately
self-contained so an official provider (Gemini TTS, Azure Speech) can be added
behind the same ``synthesize`` coroutine without touching the HTTP API.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
import tempfile
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import edge_tts
import httpx

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

WEBSHARE_API_URL = "https://proxy.webshare.io/api/v2/proxy/list/"
WEBSHARE_PAGE_SIZE = 100
WEBSHARE_MAX_PAGES = 20


def _env_int(name: str, fallback: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, "") or fallback)
    except (TypeError, ValueError):
        value = fallback
    return min(maximum, max(minimum, value))


def _env_float(name: str, fallback: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.environ.get(name, "") or fallback)
    except (TypeError, ValueError):
        value = fallback
    return min(maximum, max(minimum, value))


def _env_bool(name: str, fallback: bool) -> bool:
    raw = str(os.environ.get(name, "")).strip().lower()
    if not raw:
        return fallback
    return raw not in {"0", "false", "no", "off"}


@dataclass
class EngineConfig:
    """Tunable limits. Defaults are sized for ~100 concurrent on 20 proxies."""

    max_concurrent: int = field(default_factory=lambda: _env_int("TTS_MAX_CONCURRENT", 100, 1, 400))
    queue_timeout_ms: int = field(
        default_factory=lambda: _env_int("TTS_QUEUE_TIMEOUT_MS", 60_000, 1_000, 10 * 60_000)
    )
    per_ip_concurrency: int = field(
        default_factory=lambda: _env_int("TTS_PER_IP_CONCURRENCY", 6, 1, 32)
    )
    attempts: int = field(default_factory=lambda: _env_int("TTS_ATTEMPTS", 6, 1, 12))
    attempt_timeout_seconds: float = field(
        default_factory=lambda: _env_float("TTS_ATTEMPT_TIMEOUT_SECONDS", 12.0, 3.0, 30.0)
    )
    proxy_cooldown_seconds: float = field(
        default_factory=lambda: _env_float("TTS_PROXY_COOLDOWN_SECONDS", 120.0, 10.0, 3_600.0)
    )
    direct_fallback: bool = field(default_factory=lambda: _env_bool("TTS_DIRECT_FALLBACK", True))
    webshare_api_key: str = field(
        default_factory=lambda: (
            os.environ.get("TTS_WEBSHARE_API_KEY")
            or os.environ.get("WEBSHARE_API_KEY")
            or ""
        ).strip()
    )
    webshare_refresh_seconds: int = field(
        default_factory=lambda: _env_int("TTS_PROXY_REFRESH_SECONDS", 600, 60, 3_600)
    )
    max_input_characters: int = field(
        default_factory=lambda: _env_int("TTS_MAX_INPUT_CHARACTERS", 4_096, 64, 20_000)
    )
    chunk_characters: int = field(default_factory=lambda: _env_int("TTS_CHUNK_CHARACTERS", 300, 80, 2_000))


# --------------------------------------------------------------------------
# Webshare inventory
# --------------------------------------------------------------------------


@dataclass
class ProxyInfo:
    url: str
    ip: str
    country: str


def _proxy_info_from_row(row: Dict[str, Any]) -> Optional[ProxyInfo]:
    address = row.get("proxy_address") or row.get("proxyAddress")
    if not address:
        return None
    port = row.get("port")
    if not port:
        ports = row.get("ports") or {}
        port = ports.get("https") or ports.get("http")
    if not port:
        return None
    username = str(row.get("username") or "")
    password = str(row.get("password") or "")
    auth = ""
    if username:
        auth = f"{urllib.parse.quote(username, safe='')}:{urllib.parse.quote(password, safe='')}@"
    url = f"http://{auth}{address}:{port}"
    country = str(row.get("country_code") or row.get("country") or "").upper()
    return ProxyInfo(url=url, ip=str(address), country=country)


async def fetch_webshare_proxies(api_key: str) -> List[ProxyInfo]:
    """Fetch the usable proxies from Webshare, with their IP and country.

    ``mode=direct`` first, ``backbone`` as a fallback, mirroring the bridge's
    ``proxyManager.fetchInventoryFromWebshare``.
    """
    if not api_key:
        return []
    headers = {"Authorization": f"Token {api_key}"}
    timeout = httpx.Timeout(15.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for mode in ("direct", "backbone"):
            proxies: List[ProxyInfo] = []
            for page in range(1, WEBSHARE_MAX_PAGES + 1):
                url = (
                    f"{WEBSHARE_API_URL}?mode={mode}&page={page}"
                    f"&page_size={WEBSHARE_PAGE_SIZE}"
                )
                try:
                    response = await client.get(url, headers=headers)
                except Exception:
                    break
                if response.status_code != 200:
                    break
                payload = response.json()
                for row in payload.get("results") or []:
                    if row.get("valid") is False:
                        continue
                    info = _proxy_info_from_row(row)
                    if info:
                        proxies.append(info)
                if not payload.get("next"):
                    break
            if proxies:
                return proxies
    return []


# --------------------------------------------------------------------------
# Proxy pool
# --------------------------------------------------------------------------


class ProxyPool:
    """Random proxy selection with a short failure cooldown and a per-IP
    concurrency cap. Every request picks a random healthy proxy with free
    capacity, so consecutive calls spread across the whole pool instead of
    hammering one IP; a busy or cooling IP is skipped, never stacked on."""

    def __init__(self, proxies: List[ProxyInfo], config: EngineConfig) -> None:
        seen: Dict[str, ProxyInfo] = {}
        for proxy in proxies:
            seen.setdefault(proxy.url, proxy)
        self._info = seen
        self._urls = list(seen.keys())
        self._config = config
        self._failed: Dict[str, float] = {}
        self._semaphores: Dict[str, asyncio.Semaphore] = {}
        self._lock = asyncio.Lock()

    @property
    def size(self) -> int:
        return len(self._urls)

    def info(self, url: Optional[str]) -> Optional[ProxyInfo]:
        return self._info.get(url) if url else None

    def stats(self) -> Dict[str, Any]:
        now = time.monotonic()
        cooling = [url for url, at in self._failed.items() if now - at < self._config.proxy_cooldown_seconds]
        return {
            "proxies": len(self._urls),
            "cooling": len(cooling),
            "per_ip_limit": self._config.per_ip_concurrency,
        }

    async def acquire(self) -> Optional[tuple[str, asyncio.Semaphore]]:
        """Reserve a random healthy proxy and its per-IP semaphore.

        Returns ``(url, semaphore)`` with the semaphore already acquired, or
        ``None`` to mean "go direct". The caller must call :meth:`release`
        exactly once with the returned URL.
        """
        if not self._urls:
            return None
        async with self._lock:
            return self._pick()

    def _expire(self) -> None:
        now = time.monotonic()
        for url in [u for u, at in self._failed.items() if now - at >= self._config.proxy_cooldown_seconds]:
            self._failed.pop(url, None)

    def _semaphore(self, url: str) -> asyncio.Semaphore:
        return self._semaphores.setdefault(
            url, asyncio.Semaphore(self._config.per_ip_concurrency)
        )

    def _pick(self) -> Optional[tuple[str, asyncio.Semaphore]]:
        self._expire()
        healthy = [u for u in self._urls if u not in self._failed]
        if not healthy:
            # Every proxy is cooling. Re-admit the one that has rested longest
            # rather than going direct, which is throttled from most hosts.
            oldest = min(self._failed, key=self._failed.get)
            self._failed.pop(oldest, None)
            healthy = [oldest]
        random.shuffle(healthy)
        for url in healthy:
            semaphore = self._semaphore(url)
            if not semaphore.locked():
                return (url, semaphore)
        # Every healthy proxy is at its per-IP cap. Wait on a random one rather
        # than exceeding the cap or falling direct.
        url = random.choice(healthy)
        return (url, self._semaphore(url))

    def mark_failed(self, url: Optional[str]) -> None:
        if url:
            self._failed[url] = time.monotonic()

    def release(self, url: Optional[str]) -> None:
        """Release the per-IP slot held for ``url``."""
        if not url:
            return
        semaphore = self._semaphores.get(url)
        if semaphore is None:
            return
        try:
            semaphore.release()
        except ValueError:
            # Already released; nothing to do.
            pass


# --------------------------------------------------------------------------
# Text chunking
# --------------------------------------------------------------------------

_SENTENCE_SPLIT = re.compile(r"(?<=[។!?.,;，。！？；:])\s+")


def split_tts_text(text: str, max_chars: int = 300) -> List[str]:
    """Split long input at sentence boundaries for Edge TTS.

    Edge TTS handles long text, but keeping each request near one spoken
    sentence improves resilience and lets word boundaries map cleanly.
    """
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if not clean:
        return []
    if len(clean) <= max_chars:
        return [clean]

    pieces = _SENTENCE_SPLIT.split(clean)
    chunks: List[str] = []
    current = ""
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        if not current:
            current = piece
        elif len(current) + 1 + len(piece) <= max_chars:
            current = f"{current} {piece}"
        else:
            chunks.append(current)
            current = piece
        while len(current) > max_chars:
            cut = current.rfind(" ", 0, max_chars)
            if cut <= 0:
                cut = max_chars
            chunks.append(current[:cut].strip())
            current = current[cut:].strip()
    if current:
        chunks.append(current)

    merged: List[str] = []
    for chunk in chunks:
        if merged and len(chunk) < 20 and len(merged[-1]) + 1 + len(chunk) <= max_chars:
            merged[-1] = f"{merged[-1]} {chunk}"
        else:
            merged.append(chunk)
    return [chunk for chunk in merged if chunk]


# --------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------


@dataclass
class SynthesizeResult:
    audio: bytes
    voice: str
    format: str
    characters: int
    duration_seconds: Optional[float]
    words: List[Dict[str, Any]]
    used_proxy: Optional[str]
    egress_ip: Optional[str] = None
    egress_country: Optional[str] = None
    egress_via: str = "direct"


class EdgeTtsEngine:
    def __init__(self, config: Optional[EngineConfig] = None) -> None:
        self.config = config or EngineConfig()
        self.pool = ProxyPool([], self.config)
        self.global_semaphore = asyncio.Semaphore(self.config.max_concurrent)
        self._voice_cache: Optional[List[Dict[str, Any]]] = None
        self._voice_cache_at = 0.0

    # -- pool lifecycle ----------------------------------------------------

    async def refresh_proxies(self) -> int:
        urls = await fetch_webshare_proxies(self.config.webshare_api_key)
        self.pool = ProxyPool(urls, self.config)
        return len(urls)

    async def start(self) -> None:
        await self.refresh_proxies()

    @property
    def stats(self) -> Dict[str, Any]:
        return {
            "proxies": self.pool.stats(),
            "max_concurrent": self.config.max_concurrent,
            "per_ip_limit": self.config.per_ip_concurrency,
            "attempts": self.config.attempts,
        }

    async def voices(self, force: bool = False) -> List[Dict[str, Any]]:
        """The Edge voice catalogue, cached for 24h."""
        now = time.monotonic()
        if not force and self._voice_cache and now - self._voice_cache_at < 24 * 3_600:
            return self._voice_cache
        voices = await edge_tts.list_voices()
        self._voice_cache = voices
        self._voice_cache_at = now
        return voices

    # -- synthesis ---------------------------------------------------------

    async def synthesize(
        self,
        text: str,
        voice: str,
        *,
        speed: float = 1.0,
        include_words: bool = False,
    ) -> SynthesizeResult:
        """Synthesize ``text`` with Edge TTS, proxying and retrying as needed."""
        clean = str(text or "").strip()
        if not clean:
            raise ValueError("text must not be empty")
        if len(clean) > self.config.max_input_characters:
            raise ValueError(
                f"text is {len(clean)} characters; the limit is {self.config.max_input_characters}"
            )

        chunks = split_tts_text(clean, self.config.chunk_characters)
        rate = _speed_to_edge_rate(speed)

        try:
            await asyncio.wait_for(
                self.global_semaphore.acquire(), timeout=self.config.queue_timeout_ms / 1000
            )
        except asyncio.TimeoutError:
            raise RuntimeError("tts queue is full; retry shortly")

        try:
            return await self._synthesize_chunks(chunks, voice, rate, include_words)
        finally:
            self.global_semaphore.release()

    async def _synthesize_chunks(
        self,
        chunks: List[str],
        voice: str,
        rate: str,
        include_words: bool,
    ) -> SynthesizeResult:
        """Synthesize chunks, preferably concurrently, then concatenate MP3 frames."""
        results = await asyncio.gather(
            *[self._synthesize_one(chunk, voice, rate, include_words) for chunk in chunks],
            return_exceptions=True,
        )

        audio_parts: List[bytes] = []
        words: List[Dict[str, Any]] = []
        duration = 0.0
        used_proxy: Optional[str] = None
        for result in results:
            if isinstance(result, Exception):
                raise result
            audio_parts.append(result["audio"])
            used_proxy = used_proxy or result.get("used_proxy")
            for word in result["words"]:
                words.append(
                    {
                        "word": word["word"],
                        "start": round(duration + word["start"], 3),
                        "end": round(duration + word["end"], 3),
                    }
                )
            duration += result["duration"] or 0.0

        info = self.pool.info(used_proxy)
        return SynthesizeResult(
            audio=b"".join(audio_parts),
            voice=voice,
            format="mp3",
            characters=sum(len(chunk) for chunk in chunks),
            duration_seconds=round(duration, 3) if duration else None,
            words=words,
            used_proxy=used_proxy,
            egress_ip=info.ip if info else None,
            egress_country=info.country if info else None,
            egress_via="proxy" if used_proxy else "direct",
        )

    async def _synthesize_one(
        self,
        text: str,
        voice: str,
        rate: str,
        include_words: bool,
    ) -> Dict[str, Any]:
        last_error: Optional[Exception] = None
        for attempt in range(self.config.attempts):
            reserved = await self.pool.acquire()
            proxy_url: Optional[str] = None
            semaphore: Optional[asyncio.Semaphore] = None
            if reserved is not None:
                proxy_url, semaphore = reserved
                await semaphore.acquire()
            failed = True
            try:
                audio, words = await asyncio.wait_for(
                    self._run_edge(text, voice, rate, proxy_url, include_words),
                    timeout=self.config.attempt_timeout_seconds,
                )
                if audio:
                    failed = False
                    duration = max((w["end"] for w in words), default=0.0)
                    return {
                        "audio": audio,
                        "words": words,
                        "duration": duration,
                        "used_proxy": proxy_url,
                    }
                last_error = RuntimeError("edge tts returned no audio")
            except Exception as exc:  # noqa: BLE001 - retried below
                last_error = exc
            finally:
                if failed:
                    self.pool.mark_failed(proxy_url)
                self.pool.release(proxy_url)
            if attempt < self.config.attempts - 1:
                await asyncio.sleep(0.4 * (attempt + 1))

        # Last resort: direct, no proxy.
        if self.config.direct_fallback:
            try:
                audio, words = await asyncio.wait_for(
                    self._run_edge(text, voice, rate, None, include_words),
                    timeout=self.config.attempt_timeout_seconds,
                )
                if audio:
                    duration = max((w["end"] for w in words), default=0.0)
                    return {"audio": audio, "words": words, "duration": duration, "used_proxy": None}
            except Exception as exc:  # noqa: BLE001
                last_error = exc
        raise RuntimeError(f"edge tts failed after {self.config.attempts} attempts: {last_error}")

    async def _run_edge(
        self,
        text: str,
        voice: str,
        rate: str,
        proxy_url: Optional[str],
        include_words: bool,
    ) -> tuple[bytes, List[Dict[str, Any]]]:
        # edge-tts 7.x emits SentenceBoundary by default; ask for word
        # boundaries only when the caller requested timestamps, because the
        # extra events cost a little work per request.
        communicate = edge_tts.Communicate(
            text,
            voice,
            rate=rate,
            proxy=proxy_url,
            boundary="WordBoundary" if include_words else "SentenceBoundary",
        )
        audio = bytearray()
        boundaries: List[Dict[str, Any]] = []
        async for chunk in communicate.stream():
            kind = chunk.get("type")
            if kind == "audio":
                audio.extend(chunk["data"])
            elif kind in ("WordBoundary", "SentenceBoundary"):
                # Collected either way: the last boundary end is the exact
                # duration of this chunk, which word timestamps then build on.
                offset = chunk["offset"] / 10_000_000
                duration = chunk["duration"] / 10_000_000
                boundaries.append(
                    {"word": chunk.get("text", ""), "start": offset, "end": offset + duration}
                )
        return bytes(audio), boundaries


def _speed_to_edge_rate(speed: float) -> str:
    """Map OpenAI's 0.25-4.0 speed onto Edge's percentage rate string."""
    try:
        value = float(speed)
    except (TypeError, ValueError):
        value = 1.0
    value = min(4.0, max(0.25, value))
    percent = round((value - 1.0) * 100)
    return f"{percent:+d}%"


# --------------------------------------------------------------------------
# Voice resolution
# --------------------------------------------------------------------------

# The dubber's curated language -> (female, male) Edge voices.
LANGUAGE_VOICES: Dict[str, tuple[str, str]] = {
    "km": ("km-KH-SreymomNeural", "km-KH-PisethNeural"),
    "khmer": ("km-KH-SreymomNeural", "km-KH-PisethNeural"),
    "en": ("en-US-JennyNeural", "en-US-GuyNeural"),
    "english": ("en-US-JennyNeural", "en-US-GuyNeural"),
    "es": ("es-ES-ElviraNeural", "es-ES-AlvaroNeural"),
    "spanish": ("es-ES-ElviraNeural", "es-ES-AlvaroNeural"),
    "fr": ("fr-FR-DeniseNeural", "fr-FR-HenriNeural"),
    "french": ("fr-FR-DeniseNeural", "fr-FR-HenriNeural"),
    "de": ("de-DE-KatjaNeural", "de-DE-ConradNeural"),
    "german": ("de-DE-KatjaNeural", "de-DE-ConradNeural"),
    "zh": ("zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural"),
    "chinese": ("zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural"),
    "mandarin": ("zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural"),
    "ja": ("ja-JP-NanamiNeural", "ja-JP-KeitaNeural"),
    "japanese": ("ja-JP-NanamiNeural", "ja-JP-KeitaNeural"),
    "ko": ("ko-KR-SunHiNeural", "ko-KR-InJoonNeural"),
    "korean": ("ko-KR-SunHiNeural", "ko-KR-InJoonNeural"),
    "th": ("th-TH-PremwadeeNeural", "th-TH-NiwatNeural"),
    "thai": ("th-TH-PremwadeeNeural", "th-TH-NiwatNeural"),
    "vi": ("vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"),
    "vietnamese": ("vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"),
    "id": ("id-ID-GadisNeural", "id-ID-ArdiNeural"),
    "indonesian": ("id-ID-GadisNeural", "id-ID-ArdiNeural"),
}

# OpenAI's six voices, mapped to a gender so a language can be applied.
OPENAI_VOICE_GENDER: Dict[str, str] = {
    "alloy": "female",
    "echo": "male",
    "fable": "male",
    "onyx": "male",
    "nova": "female",
    "shimmer": "female",
}

DEFAULT_VOICE = "en-US-JennyNeural"


def _normalise_language(language: str) -> str:
    return str(language or "").strip().lower().replace("_", "-")


def resolve_voice(voice: str, language: str = "") -> str:
    """Resolve a requested voice name or OpenAI alias to a real Edge voice.

    Precedence: an exact Edge voice name wins, then an OpenAI alias (gender +
    language), then the language default, then the service default.
    """
    requested = str(voice or "").strip()
    if requested:
        # A real Edge voice name (e.g. en-US-GuyNeural) is used verbatim.
        if requested.endswith("Neural") or "-" in requested:
            return requested
        alias = OPENAI_VOICE_GENDER.get(requested.lower())
        if alias:
            return _voice_for_language(language, alias)
        return requested

    return _voice_for_language(language, "female")


def _voice_for_language(language: str, gender: str) -> str:
    code = _normalise_language(language)
    base = code.split("-")[0]
    pair = LANGUAGE_VOICES.get(code) or LANGUAGE_VOICES.get(base)
    if not pair:
        # Unknown language: fall back to English rather than the old Khmer
        # default, because this is a general-purpose public API.
        pair = LANGUAGE_VOICES["en"]
    return pair[1] if gender == "male" else pair[0]


async def voice_catalogue(engine: EdgeTtsEngine) -> List[Dict[str, Any]]:
    """The Edge catalogue in a stable, JSON-friendly shape."""
    voices = await engine.voices()
    catalogue = []
    for voice in voices:
        name = voice.get("ShortName") or voice.get("Name") or ""
        if not name:
            continue
        locale = voice.get("Locale") or ""
        catalogue.append(
            {
                "id": name,
                "name": voice.get("FriendlyName") or name,
                "locale": locale,
                "language": locale.split("-")[0] if locale else "",
                "gender": (voice.get("Gender") or "").lower(),
            }
        )
    return catalogue
