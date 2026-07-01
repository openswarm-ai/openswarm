"""Onboarding profiling: a scoped, read-only, one-shot agent that skims the user's connected
Google account and returns a plain-English observation + a few concrete task options.

Fail-safe by construction: consent-gated, hard timeout, and every failure path returns None so the
onboarding payoff simply stays on its persona floor (never a spinner, never a fabricated observation).
Rides the free-trial tier automatically (the run is tagged by session.id in configure_provider_env).

NOT yet verified against a live connected Google account: the write-denial guarantee here is
prompt-level ("read only, never send/change"); hardening it to a per-tool deny-list (so writes are
undispatchable) is a follow-up that needs a connected account to confirm it sticks past the gate's
disk re-read, plus the read tools' ask-policy must not stall a headless run. The hard timeout bounds
both risks for now.
"""

import asyncio
import json
import logging
import re
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field
from typeguard import typechecked

from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession
from backend.apps.settings.settings import get_settings
from backend.apps.tools_lib.mcp_config import sanitize_server_name
from backend.apps.tools_lib.tools_lib import load_all_tools

logger = logging.getLogger(__name__)

GOOGLE_TOOL_NAME = "Google Workspace"
PROFILE_TIMEOUT_S = 25.0
PROFILE_MAX_TURNS = 4


class ProfileOption(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    label: str
    prompt: str


class ProfileResult(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    # "" means "couldn't tell" — the frontend then shows no "I see you're..." line (truthful-or-silent).
    observation: str = ""
    options: List[ProfileOption] = Field(default_factory=list)


def p_system_prompt(name: str) -> str:
    who = name.strip() or "this person"
    return (
        f"You are quietly getting to know {who} so OpenSwarm can be useful on day one. You have "
        "READ-ONLY access to their connected Google account (Gmail, Calendar, Drive). Take a quick, "
        "shallow look at recent items, then do two things.\n"
        "1) In ONE short, plain, warm sentence, say what they seem to be dealing with right now, "
        "like a sharp assistant who just glanced at their desk. No jargon, no numbers-flexing, never "
        "say 'I analyzed' and never mention tools or counts.\n"
        "2) Offer 3-4 concrete things you could do about it, each a short verb-first phrase a busy "
        "person instantly gets.\n"
        "HARD RULES: read only. Never send, reply, draft, delete, or change anything. If you cannot "
        "see enough to say something TRUE, return an empty observation rather than guessing.\n"
        "End your reply with ONLY a JSON object and nothing else around it:\n"
        '{"observation": "<one sentence, or empty string if you truly cannot tell>", '
        '"options": [{"label": "<short phrase>", "prompt": "<a clear instruction I can run to do it>"}]}'
    )


def p_task_prompt(name: str) -> str:
    who = name.strip() or "them"
    return (
        f"Take a quick, read-only skim of {who}'s recent email and calendar (just the last few days), "
        "then give me the observation and options exactly as specified. Keep it fast and shallow."
    )


@typechecked
def p_connected_google_enabled() -> bool:
    """True only when the Google Workspace connector is actually connected AND enabled (both flags;
    a 'connected' tool with enabled=false still won't build MCP servers)."""
    try:
        for tool in load_all_tools():
            if tool.name == GOOGLE_TOOL_NAME and tool.enabled and tool.auth_status == "connected":
                return True
    except Exception:
        logger.exception("onboarding-profile: load_all_tools failed")
    return False


@typechecked
def p_extract_json(text: str) -> Optional[dict]:
    """Pull the last JSON object out of a tool-using model's final message (it may wrap prose or
    fences around it). Fence-strip, then take the last balanced {...}; fail returns None."""
    if not text:
        return None
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    depth = 0
    end = -1
    start = -1
    for i in range(len(cleaned) - 1, -1, -1):
        c = cleaned[i]
        if c == "}":
            if depth == 0:
                end = i
            depth += 1
        elif c == "{":
            depth -= 1
            if depth == 0:
                start = i
                break
    if start < 0 or end < 0 or end < start:
        return None
    try:
        parsed = json.loads(cleaned[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


@typechecked
def p_parse_profile(text: str) -> Optional[ProfileResult]:
    raw = p_extract_json(text)
    if raw is None:
        return None
    observation = raw.get("observation")
    options_raw = raw.get("options")
    if not isinstance(observation, str) or not isinstance(options_raw, list):
        return None
    options: List[ProfileOption] = []
    for opt in options_raw:
        if isinstance(opt, dict) and isinstance(opt.get("label"), str) and isinstance(opt.get("prompt"), str):
            options.append(ProfileOption(label=opt["label"], prompt=opt["prompt"]))
    return ProfileResult(observation=observation.strip(), options=options)


def p_last_assistant_text(session: AgentSession) -> str:
    for msg in reversed(session.messages):
        if msg.role == "assistant":
            content = msg.content
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "\n".join(
                    b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
                )
            return str(content)
    return ""


@typechecked
async def profile_user(name: str, consent: bool) -> Optional[ProfileResult]:
    """Run the scoped read-only profiling agent. Returns None on ANY miss (no consent, no connected
    Google, timeout, empty/garbled output) so the caller falls back to the persona floor."""
    if not consent or not p_connected_google_enabled():
        return None

    server = sanitize_server_name(GOOGLE_TOOL_NAME)
    try:
        settings = await get_settings()
        model = settings.get("default_model") if isinstance(settings, dict) else getattr(settings, "default_model", "sonnet")
    except Exception:
        model = "sonnet"

    # Built invisibly (no launch broadcast -> no dashboard card). allowed_tools activates ONLY the
    # Google server; active_mcps is the non-bypassable gate; read-only is prompt-enforced (see module note).
    session = AgentSession(
        name="__onboarding_profile__",
        model=model or "sonnet",
        mode="agent",
        system_prompt=p_system_prompt(name),
        allowed_tools=[f"mcp:{GOOGLE_TOOL_NAME}"],
        max_turns=PROFILE_MAX_TURNS,
        active_mcps=[server],
    )
    agent_manager.sessions[session.id] = session
    try:
        await asyncio.wait_for(
            agent_manager.run_agent_loop(session.id, p_task_prompt(name)),
            timeout=PROFILE_TIMEOUT_S,
        )
        return p_parse_profile(p_last_assistant_text(session))
    except asyncio.TimeoutError:
        logger.info("onboarding-profile: timed out after %.0fs, falling back to floor", PROFILE_TIMEOUT_S)
        return None
    except Exception:
        logger.exception("onboarding-profile: run failed, falling back to floor")
        return None
    finally:
        task = agent_manager.tasks.get(session.id) if hasattr(agent_manager, "tasks") else None
        if task and not task.done():
            task.cancel()
        agent_manager.sessions.pop(session.id, None)
        if hasattr(agent_manager, "tasks"):
            agent_manager.tasks.pop(session.id, None)
