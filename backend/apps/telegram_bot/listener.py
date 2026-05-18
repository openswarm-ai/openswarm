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
_mode: Optional[str] = None  # "bot" or "user"
_bot_tool_id: Optional[str] = None  # set when running in bot mode, for /authorize persistence


def _connection() -> Optional[tuple[str, dict]]:
    """Pick which Telegram tile drives the listener.

    Bot mode preferred when connected — cleaner UX (plain text = task,
    no Saved Messages pollution, multi-user via /authorize).
    Falls back to user-account/Saved Messages mode if only that tile is
    connected. Returns (mode, tool_dict_subset) or None.
    """
    try:
        from backend.apps.tools_lib.tools_lib import _load_all
        bot_tool = None
        user_tool = None
        for tool in _load_all():
            name = (tool.name or "").lower()
            if tool.auth_status != "connected":
                continue
            if name == "telegram bot" or name == "telegram-bot":
                bot_tool = tool
            elif name == "telegram":
                user_tool = tool
        if bot_tool:
            token = (bot_tool.credentials or {}).get("TELEGRAM_BOT_TOKEN", "").strip()
            if token:
                return ("bot", {"token": token, "tool_id": bot_tool.id, "tool": bot_tool})
        if user_tool:
            phone = (user_tool.credentials or {}).get("TELEGRAM_PHONE", "").strip()
            if phone:
                return ("user", {"phone": phone})
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"telegram-bot: could not read tool config: {exc}")
    return None


def _connected_phone() -> Optional[str]:
    """Backwards-compat helper used by the user-account path."""
    conn = _connection()
    if conn and conn[0] == "user":
        return conn[1].get("phone")
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


HELP_TEXT_USER_MODE = (
    "*OpenSwarm — Saved Messages mode*\n\n"
    "Commands:\n"
    "  `/task <prompt>` — run an agent task\n"
    "  `/status` — list running sessions\n"
    "  `/help` — this message\n\n"
    "Messages without a `/` prefix are ignored so you can keep using "
    "Saved Messages normally."
)

HELP_TEXT_BOT_MODE = (
    "*OpenSwarm bot*\n\n"
    "Just type any task in plain English — no slash needed:\n"
    "  _'summarize my LinkedIn inbox'_\n"
    "  _'DM @joe on telegram saying running late'_\n"
    "  _'what's in my GitHub notifications?'_\n\n"
    "Commands:\n"
    "  `/status` — list running sessions\n"
    "  `/authorize <user_id>` — let another Telegram user drive this bot\n"
    "  `/help` — this message"
)


def _authorized_ids(tool) -> set[int]:
    raw = (tool.credentials or {}).get("AUTHORIZED_USER_IDS", "") or ""
    out: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if part:
            try: out.add(int(part))
            except ValueError: pass
    return out


def _save_authorized(tool, ids: set[int]) -> None:
    from backend.apps.tools_lib.tools_lib import _save
    tool.credentials["AUTHORIZED_USER_IDS"] = ",".join(str(i) for i in sorted(ids))
    _save(tool)


async def _route(event, text: str, mode: str) -> None:
    """Dispatch a recognized command.

    In bot mode, plain text (no slash) is treated as `/task <text>` so users
    can DM the bot naturally. In user-account mode (Saved Messages), only
    slash-prefixed commands are honored to avoid hijacking note-taking.
    """
    if text.startswith("/help"):
        await event.respond(HELP_TEXT_BOT_MODE if mode == "bot" else HELP_TEXT_USER_MODE)
        return
    if text.startswith("/status"):
        await _handle_status(event)
        return
    if text.startswith("/authorize "):
        if mode != "bot":
            await event.respond("`/authorize` is only available in bot mode.")
            return
        await _handle_authorize(event, text[len("/authorize "):].strip())
        return
    if text.startswith("/task "):
        prompt = text[len("/task "):].strip()
        if not prompt:
            await event.respond("Usage: `/task <prompt>`")
            return
        await _handle_task(event, prompt)
        return
    if text.startswith("/"):
        await event.respond("Unknown command. /help for the list.")
        return
    # Plain text path
    if mode == "bot":
        await _handle_task(event, text)


async def _handle_authorize(event, arg: str) -> None:
    """Add a Telegram user ID (or @username) to the bot's authorized list."""
    global _bot_tool_id
    if not _bot_tool_id:
        await event.respond("No bot tool id loaded — restart OpenSwarm.")
        return
    from backend.apps.tools_lib.tools_lib import _load
    tool = _load(_bot_tool_id)

    target_id: Optional[int] = None
    if arg.startswith("@"):
        try:
            entity = await _client.get_entity(arg)
            target_id = getattr(entity, "id", None)
        except Exception as exc:  # noqa: BLE001
            await event.respond(f"Couldn't resolve {arg}: {exc}")
            return
    else:
        try: target_id = int(arg)
        except ValueError:
            await event.respond("Usage: `/authorize <numeric_user_id>` or `/authorize @username`")
            return

    if not target_id:
        await event.respond("Could not resolve target user.")
        return
    ids = _authorized_ids(tool)
    if target_id in ids:
        await event.respond(f"User `{target_id}` is already authorized.")
        return
    ids.add(target_id)
    _save_authorized(tool, ids)
    await event.respond(f"Authorized `{target_id}`. They can now message this bot.")


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
    """Run-forever loop. Picks bot mode if connected, else user-account mode,
    else idles. Tolerates no-Telegram-connected case by logging once."""
    global _client, _mode, _bot_tool_id

    conn = _connection()
    if not conn:
        logger.info("telegram-bot: no connected Telegram tile — listener idle.")
        return

    api_id, api_hash = _api_creds()
    if api_id is None:
        logger.warning(
            "telegram-bot: OPENSWARM_TELEGRAM_API_ID/_API_HASH not set in backend/.env — listener idle."
        )
        return

    mode, payload = conn
    _mode = mode

    if mode == "bot":
        await _run_bot_mode(api_id, api_hash, payload)
    else:
        await _run_user_mode(api_id, api_hash, payload["phone"])


async def _run_bot_mode(api_id: int, api_hash: str, payload: dict) -> None:
    """Bot listener: any message to @YourBot becomes a task (no slash)."""
    global _client, _bot_tool_id

    from telethon.sessions import StringSession

    _bot_tool_id = payload["tool_id"]
    tool = payload["tool"]
    bot_token = payload["token"]

    _client = TelegramClient(StringSession(), api_id, api_hash)
    try:
        await _client.start(bot_token=bot_token)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"telegram-bot: bot.start failed, listener idle: {exc}")
        return

    me = await _client.get_me()
    logger.info(
        f"telegram-bot: bot listener active for @{me.username} (id={me.id}). "
        f"DM the bot in Telegram to drive OpenSwarm. First message auto-authorizes the sender."
    )

    @_client.on(events.NewMessage(incoming=True))
    async def _on_message(event):
        sender = await event.get_sender()
        sender_id = getattr(sender, "id", None)
        if not sender_id:
            return
        # Reload tool each tick so /authorize-added users take effect without a restart.
        try:
            from backend.apps.tools_lib.tools_lib import _load
            current_tool = _load(_bot_tool_id) if _bot_tool_id else tool
        except Exception:  # noqa: BLE001
            current_tool = tool
        authorized = _authorized_ids(current_tool)
        if not authorized:
            # Trust-on-first-use: first message becomes the owner.
            authorized.add(sender_id)
            _save_authorized(current_tool, authorized)
            await event.respond(
                f"👋 Hi! You're now authorized as the owner of this OpenSwarm bot (id `{sender_id}`).\n\n"
                f"Send any message in plain English to run an agent task, or `/help` for commands."
            )
            return
        if sender_id not in authorized:
            await event.respond(
                "This bot is private. The owner has to `/authorize` you before you can use it."
            )
            return
        text = (event.message.message or "").strip()
        if not text:
            return
        try:
            await _route(event, text, mode="bot")
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"telegram-bot: route failed: {exc}")
            try: await event.respond(f"Listener error: {exc}")
            except Exception: pass

    try:
        await _client.run_until_disconnected()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception(f"telegram-bot: bot listener crashed: {exc}")


async def _run_user_mode(api_id: int, api_hash: str, phone: str) -> None:
    """Legacy listener: own Saved Messages, slash-prefixed commands only."""
    global _client

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
        f"telegram-bot: user-mode listener active for @{me.username or me.phone} (id={my_id}). "
        f"DM yourself in Saved Messages with /help to start."
    )

    @_client.on(events.NewMessage(from_users="me"))
    async def _on_message(event):
        if event.chat_id != my_id:
            return
        text = (event.message.message or "").strip()
        if not text:
            return
        try:
            await _route(event, text, mode="user")
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
