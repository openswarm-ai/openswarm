"""Telegram MCP server (vendored into OpenSwarm).

MTProto user-account access via Telethon. Auth is driven by the OpenSwarm
backend's /credentials/telegram/* endpoints before this server ever starts;
this process just loads the prebuilt session.

Tools target four use cases:
  - send DMs and channel messages (send_message, send_file, send_voice)
  - read and summarize inbox       (list_dialogs, get_messages, search_messages)
  - forward / filter rules         (forward_message)
  - diagnostics                    (get_me, close_session)

Rate limiting is enforced per-tool via @rate_limited from .rate_limiter so
no single agent run can exceed the daily caps that keep Telegram from
flagging the connected account.

Env contract (set by OpenSwarm at spawn time):
  TELEGRAM_PHONE                 E.164 phone identifying which session to load
  OPENSWARM_TELEGRAM_API_ID      app credentials (registered once by the team
  OPENSWARM_TELEGRAM_API_HASH    at https://my.telegram.org/apps)
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP
from telethon import TelegramClient
from telethon.tl.types import Message

from .rate_limiter import rate_limited

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

SESSION_DIR = Path.home() / ".telegram_mcp" / "sessions"

INSTRUCTIONS = """
Telegram via Telethon (MTProto user account). 9 tools cover send, read,
search, forward, and diagnostics. Per-category rate limits are enforced
server-side to protect the connected account from spam bans.
"""

mcp = FastMCP(name="Telegram", instructions=INSTRUCTIONS)


def _sanitize_phone(phone: str) -> str:
    """Phone-as-filename: strip leading + and any non-digit so the SQLite
    session file is always a portable bare-digits name."""
    return re.sub(r"\D", "", phone or "")


def _session_path(phone: str) -> Path:
    return SESSION_DIR / _sanitize_phone(phone)  # Telethon appends .session


_client: Optional[TelegramClient] = None
_loop: Optional[asyncio.AbstractEventLoop] = None


def _get_client() -> TelegramClient:
    """Lazy-init the singleton client. Tools run synchronously and share one
    background event loop so we don't pay the connect cost on every call."""
    global _client
    if _client is not None:
        return _client

    phone = os.getenv("TELEGRAM_PHONE", "").strip()
    api_id_raw = os.getenv("OPENSWARM_TELEGRAM_API_ID", "").strip()
    api_hash = os.getenv("OPENSWARM_TELEGRAM_API_HASH", "").strip()
    if not phone or not api_id_raw or not api_hash:
        raise RuntimeError(
            "Telegram MCP missing env: TELEGRAM_PHONE, OPENSWARM_TELEGRAM_API_ID, OPENSWARM_TELEGRAM_API_HASH "
            "must all be set. Connect Telegram via the OpenSwarm Tools page first."
        )
    try:
        api_id = int(api_id_raw)
    except ValueError as exc:
        raise RuntimeError(f"OPENSWARM_TELEGRAM_API_ID must be an integer, got {api_id_raw!r}") from exc

    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    session_file = _session_path(phone)
    if not session_file.with_suffix(".session").exists():
        raise RuntimeError(
            f"No Telegram session at {session_file}.session. Connect Telegram via the OpenSwarm Tools page first."
        )

    _client = TelegramClient(str(session_file), api_id, api_hash)
    return _client


def _run(coro):
    """Run an async Telethon coroutine from a sync MCP tool body."""
    global _loop
    if _loop is None or _loop.is_closed():
        _loop = asyncio.new_event_loop()
    return _loop.run_until_complete(coro)


async def _ensure_connected() -> None:
    client = _get_client()
    if not client.is_connected():
        await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError(
            "Telegram session exists but is not authorized. Disconnect and reconnect via the OpenSwarm Tools page."
        )


def _message_summary(m: Message) -> Dict[str, Any]:
    return {
        "id": m.id,
        "date": m.date.isoformat() if m.date else None,
        "from_id": getattr(m.from_id, "user_id", None) if m.from_id else None,
        "text": (m.message or "")[:2000],
        "has_media": bool(m.media),
        "reply_to": m.reply_to_msg_id,
    }


def _dialog_summary(d: Any) -> Dict[str, Any]:
    entity = d.entity
    return {
        "id": d.id,
        "name": d.name,
        "is_user": d.is_user,
        "is_group": d.is_group,
        "is_channel": d.is_channel,
        "unread_count": d.unread_count,
        "username": getattr(entity, "username", None),
        "last_message": (d.message.message or "")[:500] if d.message and d.message.message else None,
    }


# ---- send -------------------------------------------------------------------


@mcp.tool()
@rate_limited("send")
def send_message(chat: str, message: str, reply_to: Optional[int] = None) -> Dict[str, Any]:
    """Send a text message to a Telegram user, group, or channel.

    Args:
        chat: Username (with or without leading @), phone number, or numeric
            chat ID. "me" sends to your own Saved Messages.
        message: Text body. Telegram-flavored markdown is supported.
        reply_to: Optional message ID to reply to in the target chat.
    Returns:
        Dictionary with success flag and the sent message's id.
    """
    async def _do():
        await _ensure_connected()
        client = _get_client()
        sent = await client.send_message(chat, message, reply_to=reply_to)
        return {"success": True, "message_id": sent.id, "chat": chat}
    try:
        return _run(_do())
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


@mcp.tool()
@rate_limited("send")
def send_file(chat: str, file_path: str, caption: Optional[str] = None) -> Dict[str, Any]:
    """Send a photo, video, document, or any file to a Telegram chat.

    Args:
        chat: Same identifier shape as send_message.
        file_path: Absolute path to a file on disk.
        caption: Optional caption shown under the media.
    Returns:
        Dictionary with success flag and the sent message's id.
    """
    if not os.path.exists(file_path):
        return {"success": False, "message": f"File not found: {file_path}"}
    async def _do():
        await _ensure_connected()
        client = _get_client()
        sent = await client.send_file(chat, file_path, caption=caption)
        return {"success": True, "message_id": sent.id, "chat": chat}
    try:
        return _run(_do())
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


@mcp.tool()
@rate_limited("send")
def send_voice(chat: str, file_path: str, caption: Optional[str] = None) -> Dict[str, Any]:
    """Send a voice note (.ogg, .opus, .mp3) to a Telegram chat.

    Args:
        chat: Same identifier shape as send_message.
        file_path: Absolute path to an audio file.
        caption: Optional caption.
    Returns:
        Dictionary with success flag and the sent message's id.
    """
    if not os.path.exists(file_path):
        return {"success": False, "message": f"File not found: {file_path}"}
    async def _do():
        await _ensure_connected()
        client = _get_client()
        sent = await client.send_file(chat, file_path, caption=caption, voice_note=True)
        return {"success": True, "message_id": sent.id, "chat": chat}
    try:
        return _run(_do())
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


# ---- forward ---------------------------------------------------------------


@mcp.tool()
@rate_limited("forward")
def forward_message(from_chat: str, message_id: int, to_chat: str) -> Dict[str, Any]:
    """Forward a single message from one chat to another.

    Args:
        from_chat: Source chat identifier.
        message_id: Numeric message ID in the source chat.
        to_chat: Destination chat identifier.
    Returns:
        Dictionary with success flag and the forwarded message id.
    """
    async def _do():
        await _ensure_connected()
        client = _get_client()
        sent = await client.forward_messages(to_chat, message_id, from_chat)
        new_id = sent.id if not isinstance(sent, list) else (sent[0].id if sent else None)
        return {"success": True, "new_message_id": new_id, "to": to_chat}
    try:
        return _run(_do())
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


# ---- read / inbox ----------------------------------------------------------


@mcp.tool()
@rate_limited("lookup")
def list_dialogs(limit: int = 20, archived: bool = False) -> Dict[str, Any]:
    """List your recent Telegram dialogs (chats, groups, channels).

    Args:
        limit: Max number of dialogs to return (default 20).
        archived: If True, fetch from the archive folder instead of the main inbox.
    Returns:
        Dictionary with success flag and a list of dialog summaries.
    """
    async def _do():
        await _ensure_connected()
        client = _get_client()
        dialogs = await client.get_dialogs(limit=limit, archived=archived)
        return {"success": True, "dialogs": [_dialog_summary(d) for d in dialogs]}
    try:
        return _run(_do())
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


@mcp.tool()
@rate_limited("lookup")
def get_messages(chat: str, limit: int = 20, offset_id: int = 0) -> Dict[str, Any]:
    """Read recent messages from a Telegram chat.

    Args:
        chat: Same identifier shape as send_message.
        limit: Max number of messages (default 20, max ~100 per call).
        offset_id: Pagination cursor (message id); 0 means newest.
    Returns:
        Dictionary with success flag and a list of message summaries
        (newest first).
    """
    async def _do():
        await _ensure_connected()
        client = _get_client()
        messages = await client.get_messages(chat, limit=limit, offset_id=offset_id)
        return {"success": True, "messages": [_message_summary(m) for m in messages]}
    try:
        return _run(_do())
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


@mcp.tool()
@rate_limited("search")
def search_messages(query: str, chat: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
    """Full-text search across messages.

    Args:
        query: Search string (Telegram's server-side text search).
        chat: Optional chat to scope the search to. Omit to search global inbox.
        limit: Max results (default 20).
    Returns:
        Dictionary with success flag and a list of matching message summaries.
    """
    async def _do():
        await _ensure_connected()
        client = _get_client()
        messages = await client.get_messages(chat, search=query, limit=limit)
        return {"success": True, "messages": [_message_summary(m) for m in messages]}
    try:
        return _run(_do())
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


# ---- plumbing --------------------------------------------------------------


@mcp.tool()
@rate_limited("lookup")
def get_me() -> Dict[str, Any]:
    """Return profile info for the currently signed-in Telegram account.

    Useful as a connectivity check before running other tools.
    """
    async def _do():
        await _ensure_connected()
        client = _get_client()
        me = await client.get_me()
        return {
            "success": True,
            "user_id": me.id,
            "username": me.username,
            "first_name": me.first_name,
            "last_name": me.last_name,
            "phone": me.phone,
            "is_bot": me.bot,
            "is_premium": getattr(me, "premium", False),
        }
    try:
        return _run(_do())
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


@mcp.tool()
def close_session() -> Dict[str, Any]:
    """Cleanly disconnect the Telegram client. Good agent hygiene at end of task."""
    global _client, _loop
    try:
        if _client and _client.is_connected():
            _run(_client.disconnect())
        _client = None
        if _loop and not _loop.is_closed():
            _loop.close()
        _loop = None
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "message": str(e)}


def main() -> None:
    """Spawn entrypoint. Validate session presence then start stdio loop."""
    try:
        # Trigger lazy-init's preflight checks (env vars + session file) so
        # we fail fast at startup instead of mid-tool-call.
        _get_client()
    except RuntimeError as e:
        logger.error(str(e))
        sys.exit(1)
    logger.info(f"Telegram MCP ready for phone ending …{(os.getenv('TELEGRAM_PHONE','') or '')[-4:]}")
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
