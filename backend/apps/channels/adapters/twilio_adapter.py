"""Twilio implementation of BaseChannelAdapter.

Handles SMS, WhatsApp, and Voice via the Twilio Python SDK.
"""
import asyncio
import logging
from typing import Optional
from functools import partial

from backend.apps.channels.base_adapter import BaseChannelAdapter

logger = logging.getLogger(__name__)


class TwilioAdapter(BaseChannelAdapter):

    def __init__(self, account_sid: str, auth_token: str):
        self._account_sid = account_sid
        self._auth_token = auth_token
        self._client = None

    def _get_client(self):
        if self._client is None:
            from twilio.rest import Client
            self._client = Client(self._account_sid, self._auth_token)
        return self._client

    async def send_sms(self, to: str, from_: str, body: str) -> dict:
        client = self._get_client()
        loop = asyncio.get_event_loop()
        msg = await loop.run_in_executor(
            None,
            partial(
                client.messages.create,
                to=to,
                from_=from_,
                body=body,
            ),
        )
        return {"sid": msg.sid, "status": msg.status}

    async def send_whatsapp(self, to: str, from_: str, body: str) -> dict:
        wa_to = to if to.startswith("whatsapp:") else f"whatsapp:{to}"
        wa_from = from_ if from_.startswith("whatsapp:") else f"whatsapp:{from_}"
        client = self._get_client()
        loop = asyncio.get_event_loop()
        msg = await loop.run_in_executor(
            None,
            partial(
                client.messages.create,
                to=wa_to,
                from_=wa_from,
                body=body,
            ),
        )
        return {"sid": msg.sid, "status": msg.status}

    async def initiate_call(
        self, to: str, from_: str, webhook_url: str, greeting: str = ""
    ) -> dict:
        client = self._get_client()
        loop = asyncio.get_event_loop()
        call = await loop.run_in_executor(
            None,
            partial(
                client.calls.create,
                to=to,
                from_=from_,
                url=webhook_url,
            ),
        )
        return {"sid": call.sid, "status": call.status}

    def verify_webhook_signature(
        self, request_url: str, params: dict, signature: str, auth_token: str
    ) -> bool:
        try:
            from twilio.request_validator import RequestValidator
            validator = RequestValidator(auth_token)
            return validator.validate(request_url, params, signature)
        except Exception:
            logger.exception("Twilio signature verification failed")
            return False

    def generate_twiml_gather(
        self,
        prompt: str,
        action_url: str,
        voice: str = "Polly.Joanna",
        language: str = "en-US",
        timeout: int = 10,
    ) -> str:
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
                auth=(self._account_sid, auth_token),
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
