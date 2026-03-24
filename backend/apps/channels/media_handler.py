"""Audio attachment processing for WhatsApp voice notes and media messages."""
import logging
from typing import Optional

import httpx

from backend.apps.channels.models import STTConfig
from backend.apps.channels import stt_service

logger = logging.getLogger(__name__)

SUPPORTED_FORMATS = {
    "audio/ogg", "audio/mpeg", "audio/wav", "audio/mp4",
    "audio/flac", "audio/webm", "audio/x-wav",
}
MAX_MEDIA_BYTES = 20 * 1024 * 1024


async def process_audio_attachment(
    url: str,
    content_type: str,
    stt_config: STTConfig,
    auth: tuple[str, str] | None = None,
) -> Optional[str]:
    """Download an audio attachment and return its transcript.

    Args:
        url: URL to download the audio from.
        content_type: MIME type of the audio.
        stt_config: STT configuration for transcription.
        auth: Optional (username, password) tuple for basic auth (e.g. Twilio).

    Returns:
        Transcript string, or None on failure.
    """
    if content_type not in SUPPORTED_FORMATS:
        logger.warning("Unsupported audio format: %s", content_type)
        return None

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            kwargs = {"follow_redirects": True}
            if auth:
                kwargs["auth"] = auth
            resp = await client.get(url, **kwargs)
            resp.raise_for_status()
            audio_bytes = resp.content
    except Exception:
        logger.exception("Failed to download audio from %s", url)
        return None

    if len(audio_bytes) > MAX_MEDIA_BYTES:
        logger.warning("Audio attachment exceeds %d bytes", MAX_MEDIA_BYTES)
        return None

    if len(audio_bytes) < 1024:
        logger.debug("Audio attachment too small, skipping")
        return None

    return await stt_service.transcribe(audio_bytes, stt_config, content_type)
