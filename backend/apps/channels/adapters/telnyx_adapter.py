"""Telnyx implementation of BaseChannelAdapter.

Uses Telnyx Call Control v2 for voice and Messaging API for SMS.
"""
import asyncio
import hashlib
import hmac
import logging
from typing import Optional
from functools import partial

from backend.apps.channels.base_adapter import BaseChannelAdapter

logger = logging.getLogger(__name__)


class TelnyxAdapter(BaseChannelAdapter):

    def __init__(self, api_key: str, public_key: str = ""):
        self._api_key = api_key
        self._public_key = public_key
        self._telnyx = None

    def _get_telnyx(self):
        if self._telnyx is None:
            import telnyx
            telnyx.api_key = self._api_key
            self._telnyx = telnyx
        return self._telnyx

    async def send_sms(self, to: str, from_: str, body: str) -> dict:
        telnyx = self._get_telnyx()
        loop = asyncio.get_event_loop()
        msg = await loop.run_in_executor(
            None,
            partial(
                telnyx.Message.create,
                to=to,
                from_=from_,
                text=body,
            ),
        )
        return {"id": msg.id, "status": getattr(msg, "status", "queued")}

    async def send_whatsapp(self, to: str, from_: str, body: str) -> dict:
        # Telnyx WhatsApp uses the same messaging API with messaging_profile_id
        return await self.send_sms(to, from_, body)

    async def initiate_call(
        self, to: str, from_: str, webhook_url: str, greeting: str = ""
    ) -> dict:
        telnyx = self._get_telnyx()
        loop = asyncio.get_event_loop()
        call = await loop.run_in_executor(
            None,
            partial(
                telnyx.Call.create,
                to=to,
                from_=from_,
                connection_id=self._api_key,  # connection_id should be set separately
                webhook_url=webhook_url,
            ),
        )
        return {"call_control_id": call.call_control_id, "status": "initiated"}

    def verify_webhook_signature(
        self, request_url: str, params: dict, signature: str, auth_token: str
    ) -> bool:
        if not self._public_key:
            # Fail closed: no public key means reject
            logger.error("Telnyx public key not configured — rejecting webhook")
            return False
        try:
            # Telnyx uses Ed25519 signature verification
            # The signature and timestamp are in webhook headers
            import base64
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
            from cryptography.hazmat.primitives.serialization import load_pem_public_key

            public_key = load_pem_public_key(self._public_key.encode())
            sig_bytes = base64.b64decode(signature)
            payload = params.get("_raw_body", "")
            timestamp = params.get("_timestamp", "")
            signed_payload = f"{timestamp}|{payload}"
            public_key.verify(sig_bytes, signed_payload.encode())
            return True
        except Exception:
            logger.exception("Telnyx signature verification failed")
            return False

    def generate_twiml_gather(
        self,
        prompt: str,
        action_url: str,
        voice: str = "Polly.Joanna",
        language: str = "en-US",
        timeout: int = 10,
    ) -> str:
        # Telnyx uses TeXML (Twilio-compatible XML)
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Gather input="speech" action="{action_url}" '
            f'language="{language}" speechTimeout="{timeout}">'
            f'<Say voice="{voice}">{_escape_xml(prompt)}</Say>'
            "</Gather>"
            f'<Say voice="{voice}">I didn\'t hear anything. Goodbye.</Say>'
            "</Response>"
        )

    def generate_twiml_say(
        self, text: str, voice: str = "Polly.Joanna", language: str = "en-US"
    ) -> str:
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Say voice="{voice}">{_escape_xml(text)}</Say>'
            "</Response>"
        )

    def generate_twiml_hangup(self) -> str:
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response><Hangup/></Response>"
        )

    async def get_recording_audio(self, recording_url: str, auth_token: str) -> bytes:
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                recording_url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                follow_redirects=True,
            )
            resp.raise_for_status()
            return resp.content


def _escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )
