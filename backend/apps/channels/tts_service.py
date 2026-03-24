"""Provider-abstracted Text-to-Speech service.

Supports: Twilio built-in Say, ElevenLabs, OpenAI TTS, Microsoft Edge TTS.
"""
import logging
from typing import Optional

import httpx

from backend.apps.channels.models import TTSConfig
from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)


async def synthesize(text: str, config: TTSConfig) -> Optional[bytes]:
    """Convert text to audio bytes. Returns None for twilio_say (handled in TwiML)."""
    if should_skip(text, config):
        return None

    if len(text) > config.max_tts_chars and config.summarize_long_replies:
        text = text[: config.max_tts_chars]

    provider = config.provider
    if provider == "twilio_say":
        # Twilio renders speech inline via <Say> — no audio bytes needed
        return None
    elif provider == "elevenlabs":
        return await _elevenlabs_synthesize(text, config)
    elif provider == "openai_tts":
        return await _openai_synthesize(text, config)
    elif provider == "edge_tts":
        return await _edge_synthesize(text, config)

    logger.warning("Unknown TTS provider: %s", provider)
    return None


def should_skip(text: str, config: TTSConfig) -> bool:
    if config.skip_short_text and len(text.strip()) < 20:
        return True
    return False


async def _elevenlabs_synthesize(text: str, config: TTSConfig) -> Optional[bytes]:
    settings = load_settings()
    api_key = settings.elevenlabs_api_key if hasattr(settings, "elevenlabs_api_key") else None
    if not api_key:
        logger.warning("ElevenLabs API key not configured, falling back to edge_tts")
        return await _edge_synthesize(text, config)

    voice_id = config.elevenlabs_voice_id or "21m00Tcm4TlvDq8ikWAM"  # Rachel default
    model_id = config.elevenlabs_model_id

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                headers={
                    "xi-api-key": api_key,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                json={
                    "text": text,
                    "model_id": model_id,
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.75,
                    },
                },
            )
            resp.raise_for_status()
            return resp.content
    except Exception:
        logger.exception("ElevenLabs TTS failed, falling back to edge_tts")
        return await _edge_synthesize(text, config)


async def _openai_synthesize(text: str, config: TTSConfig) -> Optional[bytes]:
    settings = load_settings()
    api_key = settings.openai_api_key if hasattr(settings, "openai_api_key") else None
    if not api_key:
        logger.warning("OpenAI API key not configured, falling back to edge_tts")
        return await _edge_synthesize(text, config)

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://api.openai.com/v1/audio/speech",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "tts-1",
                    "input": text,
                    "voice": config.openai_voice,
                    "response_format": "mp3",
                },
            )
            resp.raise_for_status()
            return resp.content
    except Exception:
        logger.exception("OpenAI TTS failed, falling back to edge_tts")
        return await _edge_synthesize(text, config)


async def _edge_synthesize(text: str, config: TTSConfig) -> Optional[bytes]:
    """Free fallback TTS via Microsoft Edge neural voices. No API key needed."""
    try:
        import edge_tts
        import tempfile
        import os

        communicate = edge_tts.Communicate(text, "en-US-JennyNeural")
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            tmp_path = f.name

        await communicate.save(tmp_path)
        with open(tmp_path, "rb") as f:
            audio = f.read()
        os.unlink(tmp_path)
        return audio
    except Exception:
        logger.exception("Edge TTS failed")
        return None
