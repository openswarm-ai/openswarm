from abc import ABC, abstractmethod
from typing import Optional


class BaseChannelAdapter(ABC):
    """Provider-agnostic interface for telephony operations."""

    @abstractmethod
    async def send_sms(self, to: str, from_: str, body: str) -> dict:
        """Send an SMS message. Returns provider response dict."""
        ...

    @abstractmethod
    async def send_whatsapp(self, to: str, from_: str, body: str) -> dict:
        """Send a WhatsApp message. Returns provider response dict."""
        ...

    @abstractmethod
    async def initiate_call(
        self, to: str, from_: str, webhook_url: str, greeting: str = ""
    ) -> dict:
        """Initiate an outbound voice call. Returns provider response dict."""
        ...

    @abstractmethod
    def verify_webhook_signature(
        self, request_url: str, params: dict, signature: str, auth_token: str
    ) -> bool:
        """Verify that an inbound webhook is authentic."""
        ...

    @abstractmethod
    def generate_twiml_gather(
        self,
        prompt: str,
        action_url: str,
        voice: str = "Polly.Joanna",
        language: str = "en-US",
        timeout: int = 10,
    ) -> str:
        """Generate TwiML (or equivalent) to play a prompt and gather speech."""
        ...

    @abstractmethod
    def generate_twiml_say(
        self, text: str, voice: str = "Polly.Joanna", language: str = "en-US"
    ) -> str:
        """Generate TwiML (or equivalent) to speak text."""
        ...

    @abstractmethod
    def generate_twiml_hangup(self) -> str:
        """Generate TwiML (or equivalent) to end a call."""
        ...

    @abstractmethod
    async def get_recording_audio(self, recording_url: str, auth_token: str) -> bytes:
        """Download audio from a recording URL."""
        ...

    def chunk_message(self, text: str, max_length: int = 1600) -> list[str]:
        """Split a long message into chunks respecting sentence boundaries."""
        if len(text) <= max_length:
            return [text]

        chunks: list[str] = []
        remaining = text

        while remaining:
            if len(remaining) <= max_length:
                chunks.append(remaining)
                break

            # Try to split at sentence boundary
            split_at = -1
            for sep in [". ", "! ", "? ", "\n\n", "\n", " "]:
                idx = remaining.rfind(sep, 0, max_length)
                if idx > 0:
                    split_at = idx + len(sep)
                    break

            if split_at <= 0:
                split_at = max_length

            chunks.append(remaining[:split_at].rstrip())
            remaining = remaining[split_at:].lstrip()

        return chunks
