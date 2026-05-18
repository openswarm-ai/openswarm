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
import collections
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
# Tight poll interval: cheap dict lookup + we want to ack the user as soon
# as the agent stops. At 2s we were leaving ~1s on the table per task on
# average. 250ms is barely measurable CPU and feels snappy.
_POLL_INTERVAL_S = 0.25
_TASK_TIMEOUT_S = 30 * 60

# Telegram is a phone-first messaging app. Agent output that's appropriate
# for the OpenSwarm desktop UI (markdown tables, code blocks, long
# structured reports) looks like garbage on mobile. This system prompt
# resets the agent into "texting a friend" mode for the duration of the
# Telegram-driven task. The same agent still has full tool access; only
# the rendering style changes.
TELEGRAM_SYSTEM_PROMPT = """You are responding to a user via the Telegram messaging app on their phone.
Every word you write goes into a chat bubble, like texting a friend.

Hard rules:
- NEVER produce markdown tables, pipe-separated columns, or CSV-like rows. Telegram does not render them.
- NEVER include session IDs, internal agent metadata, or "Task X started" status banners.
- NEVER use ASCII art, code fences (```), or headers (#, ##) unless the user explicitly asked for code.
- Keep replies SHORT. Aim for 1-4 sentences for simple questions. If listing items, use 2-6 plain bullets max (use "- " or "•").
- Conversational tone. Write like a friend texting, not a report generator.
- No "Let me know if you need anything else" boilerplate. End naturally.
- If you need to show data with multiple fields per row (e.g. inbox messages), use a short natural sentence per item like:
    "- Jing Wu: 'Hi, nice to meet you today' (unread)"
  NOT: "| May 16 | Jing Wu | unread | ..."
- Bold sparingly with *single asterisks* if you must emphasize. Never use **double asterisks**.
- When summarizing many items, group and summarize aggressively. The user can ask "show me more" if they want detail.
- Total reply should fit comfortably on one phone screen. Hard cap: 2000 chars. Prefer 500.

If you complete a tool call and the result is structured data, you must reformat it conversationally before replying. Do not dump raw tool output."""

_listener_task: Optional[asyncio.Task] = None
_client: Optional[TelegramClient] = None
_mode: Optional[str] = None  # "bot" or "user"
_bot_tool_id: Optional[str] = None  # set when running in bot mode, for /authorize persistence

# IDs of messages the listener itself just sent. In Saved Messages every
# reply is from your own account, so without this guard the bot's reply
# would re-trigger the handler and loop forever. Bounded deque so memory
# stays flat over long-running sessions.
_recent_self_sent: collections.deque[int] = collections.deque(maxlen=64)

# Per-chat agent session reuse for conversational continuity. When the user
# follows up in the same chat, the same agent picks up the thread — saves
# the ~1-2s cold-start tax and gives the agent memory of the prior turn.
# Sessions expire after 10 minutes of inactivity so memory doesn't grow.
_chat_sessions: dict[int, dict] = {}
_SESSION_IDLE_TTL_S = 10 * 60


async def _respond(event_or_client, text: str, chat_id=None):
    """Wrapper around respond/send_message that records the message id so the
    self-message echo doesn't get re-routed as a new task."""
    try:
        if chat_id is None:
            sent = await event_or_client.respond(text)
        else:
            sent = await event_or_client.send_message(chat_id, text)
        if sent and hasattr(sent, "id"):
            _recent_self_sent.append(sent.id)
        return sent
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"telegram-bot: _respond failed: {exc}")
        return None


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
    "*OpenSwarm — Saved Messages*\n\n"
    "Type any task in plain English — no slash needed:\n"
    "  _'summarize my LinkedIn inbox'_\n"
    "  _'DM @joe on telegram saying running late'_\n"
    "  _'what's in my GitHub notifications?'_\n\n"
    "Commands:\n"
    "  `/status` — list running sessions\n"
    "  `/help` — this message\n\n"
    "⚠ Every plain-text message here will spawn an agent. Use a different "
    "chat for notes you don't want OpenSwarm to act on."
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
        await _respond(event,HELP_TEXT_BOT_MODE if mode == "bot" else HELP_TEXT_USER_MODE)
        return
    if text.startswith("/status"):
        await _handle_status(event)
        return
    if text.startswith("/authorize "):
        if mode != "bot":
            await _respond(event,"`/authorize` is only available in bot mode.")
            return
        await _handle_authorize(event, text[len("/authorize "):].strip())
        return
    if text.startswith("/task "):
        prompt = text[len("/task "):].strip()
        if not prompt:
            await _respond(event,"Usage: `/task <prompt>`")
            return
        await _handle_task(event, prompt)
        return
    if text.startswith("/"):
        await _respond(event, "Unknown command. /help for the list.")
        return
    # Plain text path — applies in BOTH modes. Users type tasks in plain
    # English; the slash prefix is only needed for explicit commands.
    await _handle_task(event, text)


async def _handle_authorize(event, arg: str) -> None:
    """Add a Telegram user ID (or @username) to the bot's authorized list."""
    global _bot_tool_id
    if not _bot_tool_id:
        await _respond(event,"No bot tool id loaded — restart OpenSwarm.")
        return
    from backend.apps.tools_lib.tools_lib import _load
    tool = _load(_bot_tool_id)

    target_id: Optional[int] = None
    if arg.startswith("@"):
        try:
            entity = await _client.get_entity(arg)
            target_id = getattr(entity, "id", None)
        except Exception as exc:  # noqa: BLE001
            await _respond(event,f"Couldn't resolve {arg}: {exc}")
            return
    else:
        try: target_id = int(arg)
        except ValueError:
            await _respond(event,"Usage: `/authorize <numeric_user_id>` or `/authorize @username`")
            return

    if not target_id:
        await _respond(event,"Could not resolve target user.")
        return
    ids = _authorized_ids(tool)
    if target_id in ids:
        await _respond(event,f"User `{target_id}` is already authorized.")
        return
    ids.add(target_id)
    _save_authorized(tool, ids)
    await _respond(event,f"Authorized `{target_id}`. They can now message this bot.")


async def _handle_status(event) -> None:
    try:
        from backend.apps.agents.agent_manager import agent_manager
        sessions = [s for s in agent_manager.get_all_sessions() if s.status == "running"]
    except Exception as exc:  # noqa: BLE001
        await _respond(event,f"Could not read sessions: {exc}")
        return
    if not sessions:
        await _respond(event,"No running sessions.")
        return
    lines = [f"• `{s.id[:8]}` — {s.name or '(no name)'}" for s in sessions[:10]]
    await _respond(event,"Running:\n" + "\n".join(lines))


def _gc_chat_sessions(now: float) -> None:
    """Drop chat sessions idle past the TTL so memory stays bounded."""
    stale = [cid for cid, info in _chat_sessions.items() if now - info["last_activity"] > _SESSION_IDLE_TTL_S]
    for cid in stale:
        _chat_sessions.pop(cid, None)


def _count_assistant_messages(session_id: str) -> int:
    """Count assistant-role messages in the persisted session transcript.
    Used as a turn-completion signal — when this number increases past the
    pre-send snapshot, we know the agent finished THIS message's turn."""
    try:
        from backend.config.paths import SESSIONS_DIR
        import json as _json
        path = Path(SESSIONS_DIR) / f"{session_id}.json"
        if not path.exists():
            return 0
        with open(path) as f:
            data = _json.load(f)
        messages = data.get("messages") or data.get("transcript") or []
        return sum(1 for m in messages if m.get("role") == "assistant" and m.get("content"))
    except Exception:
        return 0


async def _handle_task(event, prompt: str) -> None:
    """Send the user's prompt to an agent — reusing the per-chat session if
    one is alive, else launching fresh. Native Telegram typing indicator
    while the turn runs; the agent's reply comes back as a normal-looking
    chat message. No session IDs, no status banners."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.models import AgentConfig

    chat_id = event.chat_id
    now = asyncio.get_event_loop().time()
    _gc_chat_sessions(now)

    # Try to reuse an existing agent for this chat. Skip reuse if the prior
    # session errored — start fresh so the user gets out of the failure mode.
    session_id: Optional[str] = None
    existing = _chat_sessions.get(chat_id)
    if existing:
        prior = agent_manager.get_session(existing["session_id"])
        if prior is not None and prior.status != "error":
            session_id = existing["session_id"]

    if session_id is None:
        config = AgentConfig(
            name=f"telegram: {prompt[:48]}",
            mode="agent",
            # Sonnet is 2-3x faster than Opus and easily handles "summarize my
            # inbox" / "send a quick DM" style chat tasks. Telegram-from-phone
            # users are expecting text-message snappiness, not deep reasoning.
            model="sonnet",
            system_prompt=TELEGRAM_SYSTEM_PROMPT,
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
            session_id = session.id
        except Exception as exc:  # noqa: BLE001
            await _respond(event, f"Sorry, I couldn't get started: {exc}")
            return

    _chat_sessions[chat_id] = {"session_id": session_id, "last_activity": now}

    # Snapshot assistant message count so we can tell when THIS turn's reply
    # has actually been written to the transcript (not the previous turn's).
    pre_count = _count_assistant_messages(session_id)

    try:
        await agent_manager.send_message(session_id, prompt)
    except Exception as exc:  # noqa: BLE001
        await _respond(event, f"Sorry, I couldn't pass that to the agent: {exc}")
        return

    # Telegram-native "typing..." indicator while the agent works. Telethon's
    # action() context manager auto-refreshes every 5s so the indicator stays
    # alive for long-running tasks. The poll watches BOTH session status AND
    # assistant message count — needed because reused sessions are already
    # in a terminal status at send time, so status alone can't tell us
    # whether THIS turn finished.
    final = None

    async def _poll_for_turn():
        nonlocal final
        deadline = asyncio.get_event_loop().time() + _TASK_TIMEOUT_S
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(_POLL_INTERVAL_S)
            s = agent_manager.get_session(session_id)
            if s is None:
                return
            if s.status == "error":
                final = s
                return
            # Turn is done when (a) status is terminal AND (b) assistant
            # message count grew past the pre-send snapshot.
            if s.status in ("completed", "stopped"):
                if _count_assistant_messages(session_id) > pre_count:
                    final = s
                    return

    try:
        async with _client.action(chat_id, "typing"):
            await _poll_for_turn()
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"telegram-bot: typing action failed, polling without indicator: {exc}")
        await _poll_for_turn()

    # Refresh activity timestamp so the session stays alive for follow-ups.
    _chat_sessions[chat_id] = {
        "session_id": session_id,
        "last_activity": asyncio.get_event_loop().time(),
    }

    if final is None:
        await _respond(
            event,
            "I'm taking longer than expected on this one. You can check progress in the OpenSwarm "
            "app on your computer, or send me a new task and I'll start fresh."
        )
        return

    reply = _extract_last_assistant_text(final.id)
    if not reply:
        reply = "I worked on that but didn't get a clear response. Try rephrasing?"
    elif final.status == "error":
        reply = f"I ran into a problem:\n\n{reply}"
    reply = _conversational(reply)
    await _respond(event, reply[:_MAX_REPLY_CHARS])


def _conversational(text: str) -> str:
    """Last-mile safety net: even with the system prompt, the agent sometimes
    slips a markdown table or a code-fenced block back in. Strip the worst
    offenders so Telegram users don't see CSV-pipe-soup or ``` markers."""
    import re as _re
    lines = []
    in_code_fence = False
    for raw in text.splitlines():
        line = raw.rstrip()
        # Drop code-fence markers entirely; keep the code inside as plain text.
        if line.strip().startswith("```"):
            in_code_fence = not in_code_fence
            continue
        # Convert pipe-rows to readable bullets: "| A | B | C |" -> "- A — B — C".
        # Skip rows where every cell is just dashes (markdown table separator).
        if line.count("|") >= 2 and line.strip().startswith("|") and line.strip().endswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|") if c.strip()]
            if all(_re.fullmatch(r"[-:]+", c) for c in cells):
                continue  # separator row, drop entirely
            if cells:
                line = "- " + " — ".join(cells)
        # Telegram doesn't render **bold**; collapse to *bold* (or just text).
        line = _re.sub(r"\*\*([^*\n]+)\*\*", r"*\1*", line)
        # Drop heavy markdown headers (#, ##, ###).
        line = _re.sub(r"^\s*#{1,6}\s+", "", line)
        lines.append(line)
    cleaned = "\n".join(lines)
    # Collapse 3+ blank lines down to a paragraph break.
    cleaned = _re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned


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
            await _respond(event,
                f"👋 Hi! You're now authorized as the owner of this OpenSwarm bot (id `{sender_id}`).\n\n"
                f"Send any message in plain English to run an agent task, or `/help` for commands."
            )
            return
        if sender_id not in authorized:
            await _respond(event,
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
            try: await _respond(event,f"Listener error: {exc}")
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
        # Skip the listener's own replies. In Saved Messages every message
        # is from-self-to-self, so without this guard the bot's reply would
        # re-trigger the handler and recurse forever once we treat plain
        # text as task (no slash needed).
        if event.message.id in _recent_self_sent:
            return
        text = (event.message.message or "").strip()
        if not text:
            return
        try:
            await _route(event, text, mode="user")
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"telegram-bot: route failed: {exc}")
            try: await _respond(event, f"Listener error: {exc}")
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
