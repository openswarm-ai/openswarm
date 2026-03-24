"""Provider-abstracted Speech-to-Text service.

Supports: Twilio built-in (via Gather), Deepgram Nova-3, OpenAI Whisper.
"""
import logging
from typing import Optional

import httpx

from backend.apps.channels.models import STTConfig
from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)

SUPPORTED_AUDIO_FORMATS = {
    "audio/ogg", "audio/mpeg", "audio/wav", "audio/mp4",
    "audio/flac", "audio/webm", "audio/x-wav",
}
MAX_MEDIA_BYTES = 20 * 1024 * 1024  # 20 MB


async def transcribe(
    audio_bytes: bytes,
    config: STTConfig,
    content_type: str = "audio/wav",
) -> Optional[str]:
    """Transcribe audio bytes to text using the configured provider chain."""
    if len(audio_bytes) > MAX_MEDIA_BYTES:
        logger.warning("Audio exceeds %d bytes limit", MAX_MEDIA_BYTES)
        return None
    if len(audio_bytes) < 1024:
        logger.debug("Audio too short, skipping")
        return None

    providers = config.fallback_chain or [config.provider]

    for provider in providers:
        try:
            if provider == "twilio_builtin":
                # Twilio STT is handled inline by <Gather> — no bytes to process
                continue
            elif provider == "deepgram":
                result = await _deepgram_transcribe(audio_bytes, config, content_type)
            elif provider == "openai_whisper":
                result = await _openai_transcribe(audio_bytes, config, content_type)
            else:
                logger.warning("Unknown STT provider: %s", provider)
                continue

            if result:
                return result
        except Exception:
            logger.exception("STT provider %s failed, trying next", provider)

    return None


async def transcribe_from_url(
    url: str, config: STTConfig, content_type: str = "audio/ogg"
) -> Optional[str]:
    """Download audio from URL and transcribe."""
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(url, follow_redirects=True)
            resp.raise_for_status()
            return await transcribe(resp.content, config, content_type)
    except Exception:
        logger.exception("Failed to download audio from %s", url)
        return None


async def _deepgram_transcribe(
    audio_bytes: bytes, config: STTConfig, content_type: str
) -> Optional[str]:
    settings = load_settings()
    api_key = settings.deepgram_api_key if hasattr(settings, "deepgram_api_key") else None
    if not api_key:
        logger.warning("Deepgram API key not configured")
        return None

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://api.deepgram.com/v1/listen",
                headers={
                    "Authorization": f"Token {api_key}",
                    "Content-Type": content_type,
                },
                params={
                    "model": config.deepgram_model,
                    "language": config.language,
                    "smart_format": "true",
                    "punctuate": "true",
                },
                content=audio_bytes,
            )
            resp.raise_for_status()
            data = resp.json()
            return (
                data.get("results", {})
                .get("channels", [{}])[0]
                .get("alternatives", [{}])[0]
                .get("transcript", "")
            )
    except Exception:
        logger.exception("Deepgram transcription failed")
        return None


async def _openai_transcribe(
    audio_bytes: bytes, config: STTConfig, content_type: str
) -> Optional[str]:
    settings = load_settings()
    api_key = settings.openai_api_key if hasattr(settings, "openai_api_key") else None
    if not api_key:
        logger.warning("OpenAI API key not configured")
        return None

    ext_map = {
        "audio/ogg": "ogg",
        "audio/mpeg": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/mp4": "m4a",
        "audio/flac": "flac",
        "audio/webm": "webm",
    }
    ext = ext_map.get(content_type, "wav")

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": (f"audio.{ext}", audio_bytes, content_type)},
                data={"model": "whisper-1", "language": config.language[:2]},
            )
            resp.raise_for_status()
            return resp.json().get("text", "")
    except Exception:
        logger.exception("OpenAI Whisper transcription failed")
        return None
