"""Channels SubApp — REST endpoints and Twilio/Telnyx webhooks."""
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from backend.config.Apps import SubApp
from backend.apps.channels.models import (
    ChannelConfig, ChannelCreate, ChannelUpdate, VoiceConfig, TTSConfig, STTConfig,
)
from backend.apps.channels.orchestrator import channel_orchestrator
from backend.apps.channels import ws_events

logger = logging.getLogger(__name__)


@asynccontextmanager
async def channels_lifespan():
    logger.info("Channels sub-app starting")
    await channel_orchestrator.restore_all()
    yield
    logger.info("Channels sub-app shutting down")
    await channel_orchestrator.persist_all()


channels = SubApp("channels", channels_lifespan)


# ─── CRUD Endpoints ──────────────────────────────────────────────


@channels.router.get("/list")
async def list_channels():
    configs = list(channel_orchestrator.configs.values())
    return {
        "channels": [c.model_dump(mode="json") for c in configs],
    }


@channels.router.get("/{channel_id}")
async def get_channel(channel_id: str):
    config = channel_orchestrator.configs.get(channel_id)
    if not config:
        raise HTTPException(404, "Channel not found")
    return config.model_dump(mode="json")


@channels.router.post("/create")
async def create_channel(body: ChannelCreate):
    config = ChannelConfig(
        name=body.name,
        channel_type=body.channel_type,
        provider=body.provider,
        phone_number=body.phone_number,
        credentials=body.credentials,
    )
    if body.agent_config:
        config.agent_config = body.agent_config
    if body.security:
        config.security = body.security
    if body.voice_config:
        config.voice_config = body.voice_config
    if body.tts_config:
        config.tts_config = body.tts_config
    if body.stt_config:
        config.stt_config = body.stt_config

    channel_orchestrator.save_config(config)
    return {"channel": config.model_dump(mode="json")}


@channels.router.put("/{channel_id}")
async def update_channel(channel_id: str, body: ChannelUpdate):
    config = channel_orchestrator.configs.get(channel_id)
    if not config:
        raise HTTPException(404, "Channel not found")

    updates = body.model_dump(exclude_none=True)
    for key, val in updates.items():
        setattr(config, key, val)

    # Re-create adapter if credentials changed
    if "credentials" in updates or "provider" in updates:
        channel_orchestrator.adapters.pop(channel_id, None)

    channel_orchestrator.save_config(config)
    return {"channel": config.model_dump(mode="json")}


@channels.router.delete("/{channel_id}")
async def delete_channel(channel_id: str):
    if channel_id not in channel_orchestrator.configs:
        raise HTTPException(404, "Channel not found")
    channel_orchestrator.delete_config(channel_id)
    return {"ok": True}


# ─── Enable / Disable / Test ─────────────────────────────────────


@channels.router.post("/{channel_id}/enable")
async def enable_channel(channel_id: str):
    config = channel_orchestrator.configs.get(channel_id)
    if not config:
        raise HTTPException(404, "Channel not found")

    try:
        channel_orchestrator.get_adapter(config)
        config.enabled = True
        config.status = "active"
        config.status_message = None
        channel_orchestrator.save_config(config)
        await ws_events.emit_channel_status(channel_id, "active")
        return {"ok": True, "status": "active"}
    except Exception as e:
        config.status = "error"
        config.status_message = str(e)
        channel_orchestrator.save_config(config)
        raise HTTPException(400, f"Failed to enable channel: {e}")


@channels.router.post("/{channel_id}/disable")
async def disable_channel(channel_id: str):
    config = channel_orchestrator.configs.get(channel_id)
    if not config:
        raise HTTPException(404, "Channel not found")

    config.enabled = False
    config.status = "inactive"
    channel_orchestrator.adapters.pop(channel_id, None)
    channel_orchestrator.save_config(config)
    await ws_events.emit_channel_status(channel_id, "inactive")
    return {"ok": True}


@channels.router.post("/{channel_id}/test")
async def test_channel(channel_id: str, body: dict | None = None):
    config = channel_orchestrator.configs.get(channel_id)
    if not config:
        raise HTTPException(404, "Channel not found")

    to_number = (body or {}).get("to_number", "")
    if not to_number:
        raise HTTPException(400, "to_number is required for test")

    try:
        adapter = channel_orchestrator.get_adapter(config)
        if config.channel_type == "whatsapp":
            result = await adapter.send_whatsapp(to_number, config.phone_number, "Test message from Open Swarm")
        elif config.channel_type == "voice":
            result = {"message": "Voice test: configure webhook and call the number"}
        else:
            result = await adapter.send_sms(to_number, config.phone_number, "Test message from Open Swarm")
        return {"ok": True, "result": result}
    except Exception as e:
        raise HTTPException(400, f"Test failed: {e}")


# ─── Conversations ────────────────────────────────────────────────


@channels.router.get("/{channel_id}/conversations")
async def list_conversations(channel_id: str):
    convs = [
        c.model_dump(mode="json")
        for c in channel_orchestrator.conversations.values()
        if c.channel_id == channel_id
    ]
    return {"conversations": convs}


@channels.router.get("/{channel_id}/conversations/{conversation_id}")
async def get_conversation(channel_id: str, conversation_id: str):
    for conv in channel_orchestrator.conversations.values():
        if conv.id == conversation_id and conv.channel_id == channel_id:
            return conv.model_dump(mode="json")
    raise HTTPException(404, "Conversation not found")


# ─── Outbound ─────────────────────────────────────────────────────


@channels.router.post("/{channel_id}/send")
async def send_outbound(channel_id: str, body: dict):
    to_number = body.get("to_number", "")
    message = body.get("message", "")
    if not to_number or not message:
        raise HTTPException(400, "to_number and message are required")
    try:
        result = await channel_orchestrator.send_outbound(channel_id, to_number, message)
        return result
    except ValueError as e:
        raise HTTPException(404, str(e))


@channels.router.post("/{channel_id}/call")
async def initiate_call(channel_id: str, body: dict):
    to_number = body.get("to_number", "")
    if not to_number:
        raise HTTPException(400, "to_number is required")
    try:
        result = await channel_orchestrator.initiate_outbound_call(channel_id, to_number)
        return result
    except ValueError as e:
        raise HTTPException(404, str(e))


# ─── Twilio Webhooks ─────────────────────────────────────────────


@channels.router.post("/webhooks/twilio/sms")
async def twilio_sms_webhook(request: Request):
    """Inbound SMS webhook from Twilio."""
    form = await request.form()
    channel_id = request.query_params.get("channel_id", "")

    # Find channel by phone number if channel_id not provided
    if not channel_id:
        to_number = form.get("To", "")
        for cfg in channel_orchestrator.configs.values():
            if cfg.phone_number == to_number and cfg.channel_type == "sms":
                channel_id = cfg.id
                break

    config = channel_orchestrator.configs.get(channel_id)
    if not config:
        return Response(status_code=404)

    # Verify signature
    if config.security.verify_signatures:
        adapter = channel_orchestrator.get_adapter(config)
        sig = request.headers.get("X-Twilio-Signature", "")
        url = str(request.url)
        if not adapter.verify_webhook_signature(url, dict(form), sig, config.credentials.get("auth_token", "")):
            logger.warning("Invalid Twilio signature for channel %s", channel_id)
            return Response(status_code=403)

    from_number = form.get("From", "")
    body = form.get("Body", "")
    num_media = int(form.get("NumMedia", "0"))
    media_urls = [form.get(f"MediaUrl{i}", "") for i in range(num_media)]
    media_urls = [u for u in media_urls if u]

    await channel_orchestrator.handle_inbound_sms(channel_id, from_number, body, media_urls)

    # Return empty TwiML (Twilio expects XML response)
    return Response(
        content='<?xml version="1.0"?><Response></Response>',
        media_type="application/xml",
    )


@channels.router.post("/webhooks/twilio/whatsapp")
async def twilio_whatsapp_webhook(request: Request):
    """Inbound WhatsApp webhook from Twilio."""
    form = await request.form()
    channel_id = request.query_params.get("channel_id", "")

    if not channel_id:
        to_number = form.get("To", "").replace("whatsapp:", "")
        for cfg in channel_orchestrator.configs.values():
            if cfg.phone_number == to_number and cfg.channel_type == "whatsapp":
                channel_id = cfg.id
                break

    config = channel_orchestrator.configs.get(channel_id)
    if not config:
        return Response(status_code=404)

    if config.security.verify_signatures:
        adapter = channel_orchestrator.get_adapter(config)
        sig = request.headers.get("X-Twilio-Signature", "")
        if not adapter.verify_webhook_signature(str(request.url), dict(form), sig, config.credentials.get("auth_token", "")):
            return Response(status_code=403)

    from_number = form.get("From", "").replace("whatsapp:", "")
    body = form.get("Body", "")
    num_media = int(form.get("NumMedia", "0"))
    media_urls = [form.get(f"MediaUrl{i}", "") for i in range(num_media)]

    await channel_orchestrator.handle_inbound_sms(channel_id, from_number, body, media_urls or None)

    return Response(
        content='<?xml version="1.0"?><Response></Response>',
        media_type="application/xml",
    )


@channels.router.post("/webhooks/twilio/voice")
async def twilio_voice_webhook(request: Request):
    """Inbound voice call webhook from Twilio."""
    form = await request.form()
    channel_id = request.query_params.get("channel_id", "")

    if not channel_id:
        to_number = form.get("To", "")
        for cfg in channel_orchestrator.configs.values():
            if cfg.phone_number == to_number and cfg.channel_type == "voice":
                channel_id = cfg.id
                break

    call_sid = form.get("CallSid", "")
    from_number = form.get("From", "")
    to_number = form.get("To", "")

    twiml = await channel_orchestrator.handle_inbound_call(
        channel_id, call_sid, from_number, to_number
    )

    return Response(content=twiml, media_type="application/xml")


@channels.router.post("/webhooks/twilio/voice/gather")
async def twilio_voice_gather_webhook(request: Request):
    """Speech gathered from a voice call."""
    form = await request.form()
    channel_id = request.query_params.get("channel_id", "")
    call_sid = request.query_params.get("call_sid", "") or form.get("CallSid", "")

    speech_result = form.get("SpeechResult", "")

    if not speech_result:
        # No speech detected, ask again or hang up
        config = channel_orchestrator.configs.get(channel_id)
        if config:
            adapter = channel_orchestrator.get_adapter(config)
            voice_cfg = config.voice_config or VoiceConfig()
            twiml = adapter.generate_twiml_say(
                "I didn't catch that. Goodbye.", voice=voice_cfg.voice
            )
        else:
            twiml = '<?xml version="1.0"?><Response><Say>Goodbye.</Say><Hangup/></Response>'
        return Response(content=twiml, media_type="application/xml")

    twiml = await channel_orchestrator.handle_voice_gather(
        channel_id, call_sid, speech_result
    )

    return Response(content=twiml, media_type="application/xml")


@channels.router.post("/webhooks/twilio/voice/status")
async def twilio_voice_status_webhook(request: Request):
    """Call status update from Twilio."""
    form = await request.form()
    call_sid = form.get("CallSid", "")
    status = form.get("CallStatus", "")

    channel_orchestrator.handle_call_status(call_sid, status)
    return Response(status_code=204)


# ─── Telnyx Webhook ───────────────────────────────────────────────


@channels.router.post("/webhooks/telnyx")
async def telnyx_webhook(request: Request):
    """Unified Telnyx webhook for SMS and Voice events."""
    body = await request.json()
    event_type = body.get("data", {}).get("event_type", "")
    payload = body.get("data", {}).get("payload", {})

    channel_id = request.query_params.get("channel_id", "")

    if event_type == "message.received":
        from_number = payload.get("from", {}).get("phone_number", "")
        text = payload.get("text", "")
        await channel_orchestrator.handle_inbound_sms(channel_id, from_number, text)
    elif event_type in ("call.initiated", "call.answered"):
        call_sid = payload.get("call_control_id", "")
        from_number = payload.get("from", "")
        to_number = payload.get("to", "")
        # Telnyx voice uses Call Control commands rather than TwiML
        logger.info("Telnyx call event: %s for %s", event_type, call_sid)

    return JSONResponse({"ok": True})


# ─── Active Calls ─────────────────────────────────────────────────


@channels.router.get("/calls/active")
async def list_active_calls():
    return {"calls": channel_orchestrator.call_manager.get_active_calls()}
