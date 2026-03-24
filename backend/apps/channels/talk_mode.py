"""Browser-based Talk Mode — continuous voice conversation via WebSocket.

Pipeline: Mic → WebSocket → STT → Agent → TTS → WebSocket → Speaker

This runs as a separate WebSocket endpoint /ws/talk/{session_id} that
streams audio bidirectionally between the browser and the STT/TTS services.
"""
import asyncio
import json
import logging
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from backend.apps.channels import stt_service, tts_service
from backend.apps.channels.models import STTConfig, TTSConfig
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)

# Default configs for talk mode
DEFAULT_STT = STTConfig(
    provider="openai_whisper",
    fallback_chain=["openai_whisper", "deepgram"],
)
DEFAULT_TTS = TTSConfig(
    provider="elevenlabs",
    skip_short_text=False,
)


async def handle_talk_session(websocket: WebSocket, session_id: str):
    """Handle a talk-mode WebSocket connection.

    Protocol:
    - Client sends: {"type": "audio", "data": "<base64 audio>", "format": "webm"}
    - Client sends: {"type": "config", "stt": {...}, "tts": {...}}
    - Client sends: {"type": "end_utterance"} when silence detected
    - Server sends: {"type": "transcript", "text": "..."}
    - Server sends: {"type": "audio", "data": "<base64 audio>", "format": "mp3"}
    - Server sends: {"type": "agent_response", "text": "..."}
    - Server sends: {"type": "status", "status": "listening|processing|speaking"}
    """
    await websocket.accept()

    stt_config = DEFAULT_STT
    tts_config = DEFAULT_TTS
    audio_buffer = bytearray()

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            msg_type = msg.get("type", "")

            if msg_type == "config":
                if msg.get("stt"):
                    stt_config = STTConfig(**msg["stt"])
                if msg.get("tts"):
                    tts_config = TTSConfig(**msg["tts"])
                await websocket.send_text(json.dumps({"type": "status", "status": "listening"}))

            elif msg_type == "audio":
                import base64
                chunk = base64.b64decode(msg.get("data", ""))
                audio_buffer.extend(chunk)

            elif msg_type == "end_utterance":
                if not audio_buffer:
                    continue

                await websocket.send_text(json.dumps({"type": "status", "status": "processing"}))

                audio_bytes = bytes(audio_buffer)
                audio_buffer.clear()

                audio_format = msg.get("format", "webm")
                content_type = f"audio/{audio_format}"

                # STT
                transcript = await stt_service.transcribe(
                    audio_bytes, stt_config, content_type
                )

                if not transcript:
                    await websocket.send_text(json.dumps({"type": "status", "status": "listening"}))
                    continue

                await websocket.send_text(json.dumps({
                    "type": "transcript", "text": transcript,
                }))

                # Route to agent
                agent_response = await _get_agent_response(session_id, transcript)

                if agent_response:
                    await websocket.send_text(json.dumps({
                        "type": "agent_response", "text": agent_response,
                    }))

                    # TTS
                    await websocket.send_text(json.dumps({"type": "status", "status": "speaking"}))

                    audio = await tts_service.synthesize(agent_response, tts_config)
                    if audio:
                        import base64 as b64
                        await websocket.send_text(json.dumps({
                            "type": "audio",
                            "data": b64.b64encode(audio).decode(),
                            "format": "mp3",
                        }))

                await websocket.send_text(json.dumps({"type": "status", "status": "listening"}))

            elif msg_type == "stop":
                break

    except WebSocketDisconnect:
        logger.info("Talk mode disconnected for session %s", session_id)
    except Exception:
        logger.exception("Talk mode error for session %s", session_id)


async def _get_agent_response(session_id: str, text: str) -> Optional[str]:
    """Send text to agent and wait for response."""
    session = agent_manager.get_session(session_id)
    if not session:
        return None

    response_future: asyncio.Future[str] = asyncio.get_event_loop().create_future()

    original_send = ws_manager.send_to_session

    async def _hooked_send(sid: str, event: str, data: dict):
        await original_send(sid, event, data)
        if sid == session_id and not response_future.done():
            if event == "agent:message":
                msg = data.get("message", {})
                if msg.get("role") == "assistant":
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        parts = [
                            b.get("text", "")
                            for b in content
                            if isinstance(b, dict) and b.get("type") == "text"
                        ]
                        content = "\n".join(parts)
                    if content:
                        response_future.set_result(content)
            elif event == "agent:status":
                if data.get("status") in ("completed", "error", "stopped"):
                    response_future.set_result("")

    ws_manager.send_to_session = _hooked_send
    try:
        await agent_manager.send_message(session_id, text)
        return await asyncio.wait_for(response_future, timeout=120) or None
    except asyncio.TimeoutError:
        return None
    finally:
        ws_manager.send_to_session = original_send
