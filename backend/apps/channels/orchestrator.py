"""Channel orchestrator — routes inbound messages/calls to agent sessions.

This is the central routing layer that bridges telephony events to the
existing AgentManager. Each phone number gets its own ChannelConversation
which maps to an AgentSession.
"""
import asyncio
import json
import logging
import os
import time
from datetime import datetime
from typing import Optional

from backend.apps.channels.models import (
    ChannelConfig, ChannelConversation, ChannelMessage,
)
from backend.apps.channels.call_state import CallManager, CallState
from backend.apps.channels.base_adapter import BaseChannelAdapter
from backend.apps.channels import ws_events
from backend.apps.agents.models import AgentConfig
from backend.config.paths import DATA_ROOT

logger = logging.getLogger(__name__)

CHANNELS_DIR = os.path.join(DATA_ROOT, "channels")
CHANNELS_SESSIONS_DIR = os.path.join(DATA_ROOT, "channels", "sessions")

PLATFORM_MAX_LENGTH = {
    "sms": 1600,
    "whatsapp": 4096,
    "voice": 100000,
}


class RateLimiter:
    """Simple token-bucket rate limiter per phone number."""

    def __init__(self):
        self._buckets: dict[str, list[float]] = {}

    def check(self, key: str, per_minute: int, per_hour: int) -> bool:
        now = time.time()
        if key not in self._buckets:
            self._buckets[key] = []

        # Prune old entries
        self._buckets[key] = [t for t in self._buckets[key] if now - t < 3600]

        recent_minute = sum(1 for t in self._buckets[key] if now - t < 60)
        recent_hour = len(self._buckets[key])

        if recent_minute >= per_minute or recent_hour >= per_hour:
            return False

        self._buckets[key].append(now)
        return True


class ChannelOrchestrator:
    """Manages channel configs, conversations, and message routing."""

    def __init__(self):
        self.configs: dict[str, ChannelConfig] = {}
        self.conversations: dict[str, ChannelConversation] = {}  # key: "{channel_id}:{phone}"
        self.adapters: dict[str, BaseChannelAdapter] = {}
        self.call_manager = CallManager()
        self.rate_limiter = RateLimiter()
        self._agent_listeners: dict[str, asyncio.Task] = {}

    # ─── Config persistence ───────────────────────────────────────

    def _ensure_dirs(self):
        os.makedirs(CHANNELS_DIR, exist_ok=True)
        os.makedirs(CHANNELS_SESSIONS_DIR, exist_ok=True)

    def _config_path(self, channel_id: str) -> str:
        return os.path.join(CHANNELS_DIR, f"{channel_id}.json")

    def _conv_path(self, channel_id: str) -> str:
        return os.path.join(CHANNELS_SESSIONS_DIR, f"{channel_id}.json")

    def save_config(self, config: ChannelConfig):
        self._ensure_dirs()
        config.updated_at = datetime.now().isoformat()
        self.configs[config.id] = config
        with open(self._config_path(config.id), "w") as f:
            json.dump(config.model_dump(mode="json"), f, indent=2)

    def delete_config(self, channel_id: str):
        self.configs.pop(channel_id, None)
        self.adapters.pop(channel_id, None)
        path = self._config_path(channel_id)
        if os.path.exists(path):
            os.remove(path)

    def load_all_configs(self):
        self._ensure_dirs()
        self.configs.clear()
        for fname in os.listdir(CHANNELS_DIR):
            if fname.endswith(".json"):
                try:
                    with open(os.path.join(CHANNELS_DIR, fname)) as f:
                        data = json.load(f)
                    config = ChannelConfig(**data)
                    self.configs[config.id] = config
                except Exception:
                    logger.exception("Failed to load channel config: %s", fname)

    # ─── Conversation persistence ─────────────────────────────────

    def save_conversations(self, channel_id: str):
        self._ensure_dirs()
        convs = [
            c.model_dump(mode="json")
            for c in self.conversations.values()
            if c.channel_id == channel_id
        ]
        with open(self._conv_path(channel_id), "w") as f:
            json.dump(convs, f, indent=2)

    def load_all_conversations(self):
        self._ensure_dirs()
        self.conversations.clear()
        for fname in os.listdir(CHANNELS_SESSIONS_DIR):
            if fname.endswith(".json"):
                try:
                    with open(os.path.join(CHANNELS_SESSIONS_DIR, fname)) as f:
                        convs = json.load(f)
                    for data in convs:
                        conv = ChannelConversation(**data)
                        key = f"{conv.channel_id}:{conv.phone_number}"
                        self.conversations[key] = conv
                except Exception:
                    logger.exception("Failed to load conversations: %s", fname)

    # ─── Adapter management ───────────────────────────────────────

    def get_adapter(self, config: ChannelConfig) -> BaseChannelAdapter:
        if config.id not in self.adapters:
            self.adapters[config.id] = self._create_adapter(config)
        return self.adapters[config.id]

    def _create_adapter(self, config: ChannelConfig) -> BaseChannelAdapter:
        if config.provider == "twilio":
            from backend.apps.channels.adapters.twilio_adapter import TwilioAdapter
            return TwilioAdapter(
                account_sid=config.credentials.get("account_sid", ""),
                auth_token=config.credentials.get("auth_token", ""),
            )
        elif config.provider == "telnyx":
            from backend.apps.channels.adapters.telnyx_adapter import TelnyxAdapter
            return TelnyxAdapter(
                api_key=config.credentials.get("api_key", ""),
                public_key=config.credentials.get("public_key", ""),
            )
        raise ValueError(f"Unknown provider: {config.provider}")

    # ─── Security checks ─────────────────────────────────────────

    def _check_allowlist(self, config: ChannelConfig, phone: str) -> bool:
        sec = config.security
        if phone in sec.blocklist:
            return False
        if sec.allowlist and phone not in sec.allowlist:
            return False
        return True

    def _check_rate_limit(self, config: ChannelConfig, phone: str) -> bool:
        sec = config.security
        return self.rate_limiter.check(
            phone, sec.rate_limit_per_minute, sec.rate_limit_per_hour
        )

    # ─── Inbound SMS / WhatsApp ───────────────────────────────────

    async def handle_inbound_sms(
        self,
        channel_id: str,
        from_number: str,
        body: str,
        media_urls: list[str] | None = None,
    ) -> Optional[str]:
        """Handle an inbound SMS or WhatsApp message. Returns agent response or None."""
        config = self.configs.get(channel_id)
        if not config or not config.enabled:
            logger.warning("Channel %s not found or disabled", channel_id)
            return None

        if not self._check_allowlist(config, from_number):
            logger.info("Blocked message from %s (not in allowlist)", from_number)
            return None

        if not self._check_rate_limit(config, from_number):
            logger.info("Rate limited: %s", from_number)
            return None

        # Process media attachments (voice notes)
        if media_urls and config.stt_config:
            from backend.apps.channels.media_handler import process_audio_attachment
            for url in media_urls:
                transcript = await process_audio_attachment(
                    url, "audio/ogg", config.stt_config,
                    auth=(
                        config.credentials.get("account_sid", ""),
                        config.credentials.get("auth_token", ""),
                    ) if config.provider == "twilio" else None,
                )
                if transcript:
                    body = f"{body}\n\n[Voice Note Transcript]: {transcript}" if body else transcript

        # Get or create conversation
        conv_key = f"{channel_id}:{from_number}"
        conv = self.conversations.get(conv_key)
        if not conv:
            conv = ChannelConversation(
                channel_id=channel_id,
                phone_number=from_number,
            )
            self.conversations[conv_key] = conv

        # Record inbound message
        inbound_msg = ChannelMessage(
            direction="inbound",
            content=body,
            media_urls=media_urls or [],
            channel_type=config.channel_type,
        )
        conv.messages.append(inbound_msg)
        conv.updated_at = datetime.now().isoformat()

        await ws_events.emit_channel_message(
            channel_id, conv.id, inbound_msg.model_dump(mode="json")
        )

        # Launch or reuse agent session
        agent_response = await self._route_to_agent(config, conv, body)

        if agent_response:
            # Send response back via SMS/WhatsApp
            adapter = self.get_adapter(config)
            max_len = PLATFORM_MAX_LENGTH.get(config.channel_type, 1600)
            chunks = adapter.chunk_message(agent_response, max_len)

            for chunk in chunks:
                if config.channel_type == "whatsapp":
                    await adapter.send_whatsapp(from_number, config.phone_number, chunk)
                else:
                    await adapter.send_sms(from_number, config.phone_number, chunk)

            outbound_msg = ChannelMessage(
                direction="outbound",
                content=agent_response,
                channel_type=config.channel_type,
            )
            conv.messages.append(outbound_msg)
            conv.updated_at = datetime.now().isoformat()
            config.message_count += 1
            config.last_message_at = datetime.now().isoformat()

            await ws_events.emit_channel_message(
                channel_id, conv.id, outbound_msg.model_dump(mode="json")
            )

            self.save_conversations(channel_id)
            self.save_config(config)

        return agent_response

    # ─── Inbound Voice ────────────────────────────────────────────

    async def handle_inbound_call(
        self, channel_id: str, call_sid: str, from_number: str, to_number: str
    ) -> str:
        """Handle an inbound voice call. Returns initial TwiML."""
        config = self.configs.get(channel_id)
        if not config or not config.enabled:
            adapter = self._fallback_adapter(config)
            return adapter.generate_twiml_hangup()

        if not self._check_allowlist(config, from_number):
            adapter = self.get_adapter(config)
            return adapter.generate_twiml_say("Sorry, you are not authorized to call this number.")

        voice_cfg = config.voice_config or VoiceConfig()
        adapter = self.get_adapter(config)

        # Create call state
        call = self.call_manager.create_call(call_sid, channel_id, from_number, to_number)
        call.transition("connected")
        call.transition("gathering")

        await ws_events.emit_call_event(channel_id, call_sid, "call_started", {
            "from": from_number, "to": to_number,
        })

        # Return TwiML to greet and gather speech
        from backend.apps.settings.settings import load_settings
        settings = load_settings()
        webhook_base = getattr(settings, "webhook_base_url", "") or ""
        gather_url = f"{webhook_base}/api/channels/webhooks/twilio/voice/gather?channel_id={channel_id}&call_sid={call_sid}"

        return adapter.generate_twiml_gather(
            prompt=voice_cfg.greeting_message,
            action_url=gather_url,
            voice=voice_cfg.voice,
            language=voice_cfg.language,
            timeout=voice_cfg.gather_timeout_seconds,
        )

    async def handle_voice_gather(
        self, channel_id: str, call_sid: str, speech_result: str
    ) -> str:
        """Handle gathered speech from a voice call. Returns response TwiML."""
        config = self.configs.get(channel_id)
        if not config:
            return '<?xml version="1.0"?><Response><Hangup/></Response>'

        call = self.call_manager.get_call(call_sid)
        if not call or not call.is_active:
            adapter = self.get_adapter(config)
            return adapter.generate_twiml_hangup()

        call.transition("processing")
        call.add_turn("user", speech_result)

        voice_cfg = config.voice_config or VoiceConfig()
        adapter = self.get_adapter(config)

        # Route speech to agent
        conv_key = f"{channel_id}:{call.from_number}"
        conv = self.conversations.get(conv_key)
        if not conv:
            conv = ChannelConversation(
                channel_id=channel_id,
                phone_number=call.from_number,
            )
            self.conversations[conv_key] = conv

        agent_response = await self._route_to_agent(config, conv, speech_result)

        if not agent_response:
            agent_response = "I'm sorry, I couldn't process that. Could you try again?"

        call.transition("responding")
        call.add_turn("assistant", agent_response)

        await ws_events.emit_call_event(channel_id, call_sid, "turn_complete", {
            "user": speech_result, "assistant": agent_response,
        })

        # Check if we should continue or end
        if voice_cfg.mode == "notify":
            call.transition("completed")
            return adapter.generate_twiml_say(agent_response, voice=voice_cfg.voice)

        # Conversation mode: say response then gather again
        from backend.apps.settings.settings import load_settings
        settings = load_settings()
        webhook_base = getattr(settings, "webhook_base_url", "") or ""
        gather_url = f"{webhook_base}/api/channels/webhooks/twilio/voice/gather?channel_id={channel_id}&call_sid={call_sid}"

        call.transition("gathering")

        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Say voice="{voice_cfg.voice}">{_escape_xml(agent_response)}</Say>'
            f'<Gather input="speech" action="{gather_url}" '
            f'language="{voice_cfg.language}" speechTimeout="{voice_cfg.gather_timeout_seconds}">'
            "</Gather>"
            f'<Say voice="{voice_cfg.voice}">Are you still there? Goodbye.</Say>'
            "</Response>"
        )

    def handle_call_status(self, call_sid: str, status: str):
        """Handle Twilio call status callback."""
        call = self.call_manager.get_call(call_sid)
        if not call:
            return
        if status in ("completed", "busy", "no-answer", "canceled", "failed"):
            final = "failed" if status == "failed" else "completed"
            call.transition(final)
            asyncio.create_task(
                ws_events.emit_call_event(call.channel_id, call_sid, "call_ended", {
                    "status": status,
                })
            )

    # ─── Agent routing ────────────────────────────────────────────

    async def _route_to_agent(
        self, config: ChannelConfig, conv: ChannelConversation, text: str
    ) -> Optional[str]:
        """Send a message to an agent session and wait for the response."""
        from backend.apps.agents.agent_manager import agent_manager
        from backend.apps.agents.ws_manager import ws_manager

        # Launch agent if no session exists
        if not conv.agent_session_id or not agent_manager.get_session(conv.agent_session_id):
            ac = config.agent_config
            agent_cfg = AgentConfig(
                name=f"{config.channel_type}: {conv.phone_number}",
                model=ac.model,
                mode=ac.mode,
                system_prompt=ac.system_prompt,
                max_turns=ac.max_turns,
            )
            if ac.allowed_tools:
                agent_cfg.allowed_tools = ac.allowed_tools

            session = await agent_manager.launch_agent(agent_cfg)
            conv.agent_session_id = session.id

        session_id = conv.agent_session_id

        # Set up a future to capture the agent's response
        response_future: asyncio.Future[str] = asyncio.get_event_loop().create_future()

        async def _on_agent_event(event: str, data: dict):
            if response_future.done():
                return
            if event == "agent:message":
                msg = data.get("message", {})
                if msg.get("role") == "assistant":
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        # Extract text from content blocks
                        parts = [
                            b.get("text", "")
                            for b in content
                            if isinstance(b, dict) and b.get("type") == "text"
                        ]
                        content = "\n".join(parts)
                    if content and not response_future.done():
                        response_future.set_result(content)
            elif event == "agent:status":
                status = data.get("status", "")
                if status in ("completed", "error", "stopped") and not response_future.done():
                    response_future.set_result("")

        # Register listener for this session's events
        # We tap into ws_manager's send_to_session by monkey-patching temporarily
        original_send = ws_manager.send_to_session

        async def _hooked_send(sid: str, event: str, data: dict):
            await original_send(sid, event, data)
            if sid == session_id:
                await _on_agent_event(event, data)

        ws_manager.send_to_session = _hooked_send

        try:
            await agent_manager.send_message(session_id, text)
            response = await asyncio.wait_for(response_future, timeout=120)
            return response if response else None
        except asyncio.TimeoutError:
            logger.warning("Agent response timed out for session %s", session_id)
            return None
        except Exception:
            logger.exception("Error routing to agent")
            return None
        finally:
            ws_manager.send_to_session = original_send

    def _fallback_adapter(self, config: Optional[ChannelConfig] = None) -> BaseChannelAdapter:
        """Return a minimal adapter for generating hangup TwiML."""
        from backend.apps.channels.adapters.twilio_adapter import TwilioAdapter
        return TwilioAdapter("", "")

    # ─── Outbound ─────────────────────────────────────────────────

    async def send_outbound(
        self, channel_id: str, to_number: str, message: str
    ) -> dict:
        config = self.configs.get(channel_id)
        if not config:
            raise ValueError(f"Channel {channel_id} not found")

        adapter = self.get_adapter(config)
        max_len = PLATFORM_MAX_LENGTH.get(config.channel_type, 1600)
        chunks = adapter.chunk_message(message, max_len)
        results = []

        for chunk in chunks:
            if config.channel_type == "whatsapp":
                r = await adapter.send_whatsapp(to_number, config.phone_number, chunk)
            else:
                r = await adapter.send_sms(to_number, config.phone_number, chunk)
            results.append(r)

        # Record outbound
        conv_key = f"{channel_id}:{to_number}"
        conv = self.conversations.get(conv_key)
        if not conv:
            conv = ChannelConversation(channel_id=channel_id, phone_number=to_number)
            self.conversations[conv_key] = conv

        conv.messages.append(ChannelMessage(
            direction="outbound", content=message, channel_type=config.channel_type,
        ))
        conv.updated_at = datetime.now().isoformat()
        self.save_conversations(channel_id)

        return {"sent": len(chunks), "results": results}

    async def initiate_outbound_call(
        self, channel_id: str, to_number: str
    ) -> dict:
        config = self.configs.get(channel_id)
        if not config:
            raise ValueError(f"Channel {channel_id} not found")

        from backend.apps.settings.settings import load_settings
        settings = load_settings()
        webhook_base = getattr(settings, "webhook_base_url", "") or ""
        voice_webhook = f"{webhook_base}/api/channels/webhooks/twilio/voice?channel_id={channel_id}"

        adapter = self.get_adapter(config)
        result = await adapter.initiate_call(
            to=to_number,
            from_=config.phone_number,
            webhook_url=voice_webhook,
        )
        return result

    # ─── Lifecycle ────────────────────────────────────────────────

    async def restore_all(self):
        self.load_all_configs()
        self.load_all_conversations()
        for config in self.configs.values():
            if config.enabled:
                try:
                    self.get_adapter(config)
                    config.status = "active"
                except Exception:
                    config.status = "error"
                    config.status_message = "Failed to initialize adapter"

    async def persist_all(self):
        for config in self.configs.values():
            self.save_config(config)
            self.save_conversations(config.id)


def _escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


# Singleton
from backend.apps.channels.models import VoiceConfig  # noqa: E402
channel_orchestrator = ChannelOrchestrator()
