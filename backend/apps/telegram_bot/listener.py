"""Telegram-as-control-plane listener.

Sister of backend.apps.telegram_mcp. Where the MCP server is the
agent's *outbound* channel to Telegram, this listener is the
*inbound* channel: you DM yourself in Saved Messages with a command
prefix (/task ...), the backend dispatches it to an agent, and the
final response comes back to the same chat.

Design tenets:
  - Only `from_users='me'` in Saved Messages is honored. Nobody else
    can drive your agent, not even someone with your phone in their
    contacts.
  - The listener uses a *copy* of the Telethon session
    (<phone>.listener.session) so it can stay connected without
    fighting the MCP server's SQLite lock when the agent calls a
    Telegram tool mid-task.
  - Lifespan is a SubApp so the listener starts with the backend and
    shuts down cleanly on Ctrl+C. If Telegram isn't connected, the
    listener idles instead of erroring.
  - Long-lived dispatch is poll-based (no WS subscription yet); we
    just check session.status every 2s up to a 30-minute cap. Good
    enough for the MVP.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from telethon import TelegramClient, events

from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)

_SESSION_DIR = Path.home() / ".telegram_mcp" / "sessions"
_MAX_REPLY_CHARS = 3500
_POLL_INTERVAL_S = 2.0
_TASK_TIMEOUT_S = 30 * 60

_listener_task: Optional[asyncio.Task] = None
_client: Optional[TelegramClient] = None


def _connected_phone() -> Optional[str]:
    """Read which Telegram is currently connected, from the tool config."""
    try:
        from backend.apps.tools_lib.tools_lib import _load_all
        for tool in _load_all():
            if (tool.name or "").lower() == "telegram" and tool.auth_status == "connected":
                phone = (tool.credentials or {}).get("TELEGRAM_PHONE", "").strip()
                if phone:
                    return phone
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"telegram-bot: could not read tool config: {exc}")
    return None


def _api_creds() -> tuple[Optional[int], Optional[str]]:
    api_id_raw = os.environ.get("OPENSWARM_TELEGRAM_API_ID", "").strip()
    api_hash = os.environ.get("OPENSWARM_TELEGRAM_API_HASH", "").strip()
    if not api_id_raw or not api_hash:
        return (None, None)
    try:
        return (int(api_id_raw), api_hash)
    except ValueError:
        return (None, None)


def _digits(phone: str) -> str:
    return re.sub(r"\D", "", phone or "")


def _ensure_listener_session(phone: str) -> Path:
    """Copy the main MCP session file to a side .listener.session path so the
    two processes don't fight over the SQLite lock. Re-copy if main is newer."""
    _SESSION_DIR.mkdir(parents=True, exist_ok=True)
    main = _SESSION_DIR / f"{_digits(phone)}.session"
    side = _SESSION_DIR / f"{_digits(phone)}.listener.session"
    if main.exists() and (not side.exists() or main.stat().st_mtime > side.stat().st_mtime + 1):
        try:
            shutil.copy2(main, side)
            logger.info(f"telegram-bot: copied main session to {side.name}")
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"telegram-bot: session copy failed: {exc}")
    # Telethon takes the path without .session suffix.
    return side.with_suffix("")


HELP_TEXT = (
    "*OpenSwarm Telegram bot*\n\n"
    "Commands:\n"
    "  `/task <prompt>` — run an agent task\n"
    "  `/status` — list running sessions\n"
    "  `/help` — this message\n\n"
    "Messages without a `/` prefix are ignored, so you can keep using "
    "Saved Messages normally."
)


async def _route(event, text: str) -> None:
    """Dispatch a recognized command."""
    if text.startswith("/help"):
        await event.respond(HELP_TEXT)
        return
    if text.startswith("/status"):
        await _handle_status(event)
        return
    if text.startswith("/task "):
        prompt = text[len("/task "):].strip()
        if not prompt:
            await event.respond("Usage: `/task <prompt>`")
            return
        await _handle_task(event, prompt)
        return
    if text.startswith("/"):
        await event.respond(f"Unknown command. /help for the list.")


async def _handle_status(event) -> None:
    try:
        from backend.apps.agents.agent_manager import agent_manager
        sessions = [s for s in agent_manager.get_all_sessions() if s.status == "running"]
    except Exception as exc:  # noqa: BLE001
        await event.respond(f"Could not read sessions: {exc}")
        return
    if not sessions:
        await event.respond("No running sessions.")
        return
    lines = [f"• `{s.id[:8]}` — {s.name or '(no name)'}" for s in sessions[:10]]
    await event.respond("Running:\n" + "\n".join(lines))


async def _handle_task(event, prompt: str) -> None:
    """Spawn an agent, poll until it stops, send the final assistant reply."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.models import AgentConfig

    config = AgentConfig(
        name=f"telegram: {prompt[:48]}",
        mode="agent",
        # Default allowed_tools (Read/Edit/Write/Bash/Glob/Grep/AskUserQuestion)
        # plus the connected MCPs so the agent can use Telegram, Instagram,
        # LinkedIn, GitHub as needed when invoked from this entry point.
        allowed_tools=[
            "Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion",
            "mcp:Telegram", "mcp:Instagram", "mcp:LinkedIn", "mcp:GitHub",
        ],
    )
    try:
        session = await agent_manager.launch_agent(config)
    except Exception as exc:  # noqa: BLE001
        await event.respond(f"Could not launch agent: {exc}")
        return

    await event.respond(f"⏳ Starting task — session `{session.id[:8]}`")

    try:
        await agent_manager.send_message(session.id, prompt)
    except Exception as exc:  # noqa: BLE001
        await event.respond(f"Send failed: {exc}")
        return

    # Poll until the session reports a terminal status, with a hard cap.
    deadline = asyncio.get_event_loop().time() + _TASK_TIMEOUT_S
    final = None
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(_POLL_INTERVAL_S)
        s = agent_manager.get_session(session.id)
        if s is None:
            break
        if s.status in ("completed", "stopped", "error"):
            final = s
            break

    if final is None:
        await event.respond(
            f"Task `{session.id[:8]}` is still running after {_TASK_TIMEOUT_S // 60}m. "
            f"Check OpenSwarm UI for progress."
        )
        return

    reply = _extract_last_assistant_text(final.id) or f"Task `{session.id[:8]}` finished with no text reply."
    if final.status == "error":
        reply = f"❌ Task errored.\n\n{reply}"
    await event.respond(reply[:_MAX_REPLY_CHARS])


def _extract_last_assistant_text(session_id: str) -> str:
    """Pull the last assistant text from the persisted session transcript.

    Sessions are stored at backend/data/sessions/<id>.json. Each line of the
    transcript is a Message; we want the last role=assistant message whose
    content is a plain string or has a text-content block.
    """
    try:
        from backend.config.paths import SESSIONS_DIR
        import json
        path = Path(SESSIONS_DIR) / f"{session_id}.json"
        if not path.exists():
            return ""
        with open(path) as f:
            data = json.load(f)
        messages = data.get("messages") or data.get("transcript") or []
        for msg in reversed(messages):
            if msg.get("role") != "assistant":
                continue
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                joined = "\n".join(t for t in texts if t).strip()
                if joined:
                    return joined
        return ""
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"telegram-bot: could not extract assistant text: {exc}")
        return ""


async def _listener_main() -> None:
    """Run-forever loop. Tolerates the no-Telegram-connected case by idling."""
    global _client

    phone = _connected_phone()
    if not phone:
        logger.info("telegram-bot: no connected Telegram — listener idle.")
        return

    api_id, api_hash = _api_creds()
    if api_id is None:
        logger.warning(
            "telegram-bot: OPENSWARM_TELEGRAM_API_ID/_API_HASH not set in backend env — listener idle."
        )
        return

    session_base = _ensure_listener_session(phone)
    _client = TelegramClient(str(session_base), api_id, api_hash)
    try:
        await _client.connect()
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"telegram-bot: connect failed, listener idle: {exc}")
        return

    if not await _client.is_user_authorized():
        logger.warning(
            "telegram-bot: listener session not authorized — disconnect and reconnect Telegram in OpenSwarm. Idling."
        )
        try: await _client.disconnect()
        except Exception: pass
        return

    me = await _client.get_me()
    my_id = me.id
    logger.info(
        f"telegram-bot: listener active for @{me.username or me.phone} (id={my_id}). "
        f"DM yourself in Saved Messages with /help to start."
    )

    @_client.on(events.NewMessage(from_users="me"))
    async def _on_message(event):
        # Hard authorization: only your own Saved Messages chat. event.chat_id
        # for Saved Messages equals your own user id, and from_users='me' is
        # already enforced by the decorator. Defense in depth here.
        if event.chat_id != my_id:
            return
        text = (event.message.message or "").strip()
        if not text or not text.startswith("/"):
            return
        try:
            await _route(event, text)
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"telegram-bot: route failed: {exc}")
            try: await event.respond(f"Listener error: {exc}")
            except Exception: pass

    try:
        await _client.run_until_disconnected()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception(f"telegram-bot: listener crashed: {exc}")


@asynccontextmanager
async def telegram_bot_lifespan():
    """Boot the listener when the backend starts; tear it down on shutdown."""
    global _listener_task
    _listener_task = asyncio.create_task(_listener_main(), name="telegram-bot-listener")
    try:
        yield
    finally:
        if _listener_task and not _listener_task.done():
            _listener_task.cancel()
            try:
                await _listener_task
            except asyncio.CancelledError:
                pass
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"telegram-bot: listener task error during shutdown: {exc}")
        if _client is not None:
            try:
                await _client.disconnect()
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"telegram-bot: client disconnect error: {exc}")


telegram_bot = SubApp("telegram-bot", telegram_bot_lifespan)
