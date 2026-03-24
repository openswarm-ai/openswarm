from pydantic import BaseModel, Field
from typing import Optional, Literal, Any
from datetime import datetime
from uuid import uuid4


class ChannelAgentConfig(BaseModel):
    mode: str = "agent"
    model: str = "sonnet"
    system_prompt: Optional[str] = None
    max_turns: int = 10
    allowed_tools: Optional[list[str]] = None


class ChannelSecurityConfig(BaseModel):
    verify_signatures: bool = True
    allowlist: list[str] = Field(default_factory=list)
    blocklist: list[str] = Field(default_factory=list)
    rate_limit_per_minute: int = 10
    rate_limit_per_hour: int = 60


class VoiceConfig(BaseModel):
    mode: Literal["conversation", "notify"] = "conversation"
    greeting_message: str = "Hello, how can I help you?"
    silence_timeout_ms: int = 700
    max_call_duration_seconds: int = 600
    gather_timeout_seconds: int = 10
    voice: str = "Polly.Joanna"
    language: str = "en-US"


class TTSConfig(BaseModel):
    provider: Literal["twilio_say", "elevenlabs", "openai_tts", "edge_tts"] = "twilio_say"
    auto_tts_mode: Literal["off", "always", "inbound", "tagged"] = "off"
    elevenlabs_voice_id: Optional[str] = None
    elevenlabs_model_id: str = "eleven_v3"
    openai_voice: str = "alloy"
    skip_short_text: bool = True
    summarize_long_replies: bool = True
    max_tts_chars: int = 4000


class STTConfig(BaseModel):
    provider: Literal["twilio_builtin", "deepgram", "openai_whisper"] = "twilio_builtin"
    deepgram_model: str = "nova-3"
    language: str = "en-US"
    fallback_chain: list[str] = Field(default_factory=lambda: ["twilio_builtin"])


class ChannelConfig(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = ""
    channel_type: Literal["sms", "whatsapp", "voice"] = "sms"
    provider: Literal["twilio", "telnyx"] = "twilio"
    enabled: bool = False
    phone_number: str = ""
    credentials: dict[str, str] = Field(default_factory=dict)
    agent_config: ChannelAgentConfig = Field(default_factory=ChannelAgentConfig)
    security: ChannelSecurityConfig = Field(default_factory=ChannelSecurityConfig)
    voice_config: Optional[VoiceConfig] = None
    tts_config: Optional[TTSConfig] = None
    stt_config: Optional[STTConfig] = None
    status: Literal["inactive", "active", "error"] = "inactive"
    status_message: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    last_message_at: Optional[str] = None
    message_count: int = 0


class ChannelMessage(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    direction: Literal["inbound", "outbound"] = "inbound"
    content: str = ""
    media_urls: list[str] = Field(default_factory=list)
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())
    channel_type: str = ""
    provider_message_id: Optional[str] = None


class ChannelConversation(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    channel_id: str = ""
    phone_number: str = ""
    agent_session_id: Optional[str] = None
    messages: list[ChannelMessage] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    status: Literal["active", "closed"] = "active"


class ChannelCreate(BaseModel):
    name: str
    channel_type: Literal["sms", "whatsapp", "voice"] = "sms"
    provider: Literal["twilio", "telnyx"] = "twilio"
    phone_number: str = ""
    credentials: dict[str, str] = Field(default_factory=dict)
    agent_config: Optional[ChannelAgentConfig] = None
    security: Optional[ChannelSecurityConfig] = None
    voice_config: Optional[VoiceConfig] = None
    tts_config: Optional[TTSConfig] = None
    stt_config: Optional[STTConfig] = None


class ChannelUpdate(BaseModel):
    name: Optional[str] = None
    channel_type: Optional[Literal["sms", "whatsapp", "voice"]] = None
    provider: Optional[Literal["twilio", "telnyx"]] = None
    phone_number: Optional[str] = None
    credentials: Optional[dict[str, str]] = None
    agent_config: Optional[ChannelAgentConfig] = None
    security: Optional[ChannelSecurityConfig] = None
    voice_config: Optional[VoiceConfig] = None
    tts_config: Optional[TTSConfig] = None
    stt_config: Optional[STTConfig] = None
