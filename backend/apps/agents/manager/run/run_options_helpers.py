"""Self-contained sub-steps of the per-turn options build, pulled out of run_agent_loop's options
assembly so each file stays under the ceiling. Free functions taking the manager (for maybe_compact /
emit_context_update); pure relocation."""

import logging
from typing import Dict, List, Optional
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.history_compaction import estimate_post_compact_input, wrap_platform_note

logger = logging.getLogger(__name__)


# `manager` is the AgentManager; it isn't annotated because typing it would import agent_manager back into a module agent_manager already imports (a cycle). Same reason self is never annotated.
@typechecked
async def pre_send_context_guard(manager, session: AgentSession, session_id: str) -> None:
    try:
        if manager.maybe_compact(session):
            new_input = estimate_post_compact_input(session)
            await ws_manager.send_to_session(session_id, "agent:context_status", {
                "session_id": session_id,
                "reason": "compacted",
                "compacted_through_msg_id": session.compacted_through_msg_id,
            })
            await manager.emit_context_update(
                session_id,
                session,
                input_tokens=new_input,
                output_tokens=session.tokens.get("output", 0),
            )
    except Exception:
        logger.exception("compaction failed; proceeding without it")

    # Pre-send hard guard (Phase 2). After compaction, if the session is still over context_soft_cap_pct of the window, LRU-trim oldest active_mcps. Stops the 429 from ever firing on predictable overflow paths.
    try:
        # Use the most recent measurement (the prior turn's input_tokens) as the estimate. Conservative because the current turn's user prompt + any new history adds on top, but the first turn of a fresh session has tokens=0 so we only act once we've seen real numbers.
        p_est_tokens = session.tokens.get("input", 0)
        p_hard_cap = int(session.context_window * session.context_soft_cap_pct)
        if p_est_tokens >= p_hard_cap:
            trimmed: List[str] = []
            while p_est_tokens >= p_hard_cap and len(session.active_mcps) > 1:
                # Keep at least one MCP active so the model can finish whatever it was doing; trim from oldest which is FIFO order in the list.
                trimmed.append(f"mcp:{session.active_mcps.pop(0)}")
                p_est_tokens -= 8_000  # rough per-MCP schema cost
            if trimmed:
                await ws_manager.send_to_session(session_id, "agent:context_status", {
                    "session_id": session_id,
                    "reason": "trimmed",
                    "trimmed": trimmed,
                    "estimate_after": p_est_tokens,
                })
                # Surface a visible system breadcrumb in the chat so the user (and the model on the next turn) know which MCPs got dropped. Without this, the model may keep trying to call a now-missing tool and the user has no idea why.
                try:
                    p_names = ", ".join(t.replace("mcp:", "") for t in trimmed)
                    p_trim_msg = Message(
                        role="system",
                        content=wrap_platform_note(
                            f"Trimmed {len(trimmed)} app{'s' if len(trimmed) != 1 else ''} from this session to fit "
                            f"the model's context: {p_names}. Re-activate via MCPSearch + MCPActivate "
                            "if you still need them."
                        ),
                        branch_id=session.active_branch_id,
                    )
                    session.messages.append(p_trim_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": p_trim_msg.model_dump(mode="json"),
                    })
                except Exception:
                    logger.exception("failed to emit MCP-trimmed breadcrumb")
                # Trimming changes mcp_servers / outputs context → rebuild options. The cheapest correct path is to flag for fork on next turn via needs_fork and let the existing fork path handle it.
                session.needs_fork = True
    except Exception:
        logger.exception("pre-send token guard failed; proceeding")


@typechecked
def set_framework_overhead(session: AgentSession, composed_prompt: Optional[str]) -> None:
    """Per-turn estimate of framework overhead (subtracted from displayed input). Conservative on
    purpose so honest over-shows beat lies: 16K Claude Code preset, 12K base+deferred tools, ~3K/MCP
    (real defs span 1-10K; 3K median keeps the meter honest), char/4 of the composed prompt."""
    p_PRESET_OVERHEAD = 16_000
    p_TOOL_DEFS_OVERHEAD = 12_000
    p_PER_MCP_OVERHEAD = 3_000
    p_composed_tokens = len(composed_prompt or "") // 4
    p_mcp_tokens = len(session.active_mcps) * p_PER_MCP_OVERHEAD
    session.framework_overhead_tokens = (
        p_PRESET_OVERHEAD + p_TOOL_DEFS_OVERHEAD + p_composed_tokens + p_mcp_tokens
    )


@typechecked
def register_web_mcp_server(mcp_servers: Dict, p_m: str) -> None:
    """Register the DDG-backed openswarm-web stdio MCP into the server set when the primary has no
    reliable native web path. The server script lives in the agents package (not here), so resolve
    it off that package dir, not __file__."""
    import os
    import sys
    import backend.apps.agents as p_agents_pkg
    web_mcp_server_path = os.path.join(os.path.dirname(p_agents_pkg.__file__), "web_mcp_server.py")
    # Tell the MCP which primary the session is using so it can route to that provider's native search tool.
    if p_m.startswith(("gc/", "gemini/", "ag/")):
        p_primary_hint = "gemini"
    elif p_m.startswith("cx/"):
        p_primary_hint = "openai"
    else:
        p_primary_hint = ""
    from backend.auth import get_auth_token as p_get_auth_token3
    mcp_servers["openswarm-web"] = {
        "command": sys.executable,
        "args": [web_mcp_server_path],
        "env": {
            "OPENSWARM_PORT": os.environ.get("OPENSWARM_PORT", "8324"),
            "OPENSWARM_AUTH_TOKEN": p_get_auth_token3(),
            "OPENSWARM_PRIMARY_API": p_primary_hint,
        },
        "type": "stdio",
    }
    logger.info(
        f"[MCP-DEBUG] Primary {p_m} has no reliable native web search, "
        f"registering openswarm-web (DDG search + trafilatura fetch, free)"
    )


@typechecked
def append_web_tools_hint(composed_prompt: Optional[str], need_web_mcp: bool, effective_allowed: List[str]) -> str:
    """Append a <web_tools> block naming the MCP-backed WebSearch/WebFetch when the deferred bare
    WebSearch tool isn't usable on this session, so smaller models don't thrash on ToolSearch."""
    p_web_tools_available = need_web_mcp and (
        "mcp__openswarm-web__WebSearch" in effective_allowed
        or "mcp__openswarm-web__WebFetch" in effective_allowed
    )
    if not p_web_tools_available:
        return composed_prompt
    p_hint_lines = ["<web_tools>"]
    p_hint_lines.append(
        "This session does NOT have the built-in `WebSearch` / "
        "`WebFetch` tools (they delegate to Anthropic Haiku, which "
        "isn't reachable on this primary). Use the MCP-backed "
        "equivalents instead, call them DIRECTLY, no ToolSearch "
        "step needed:"
    )
    if "mcp__openswarm-web__WebSearch" in effective_allowed:
        p_hint_lines.append(
            "- `mcp__openswarm-web__WebSearch(query: str, "
            "num_results?: int)`, DuckDuckGo search."
        )
    if "mcp__openswarm-web__WebFetch" in effective_allowed:
        p_hint_lines.append(
            "- `mcp__openswarm-web__WebFetch(url: str, prompt?: "
            "str)`, fetch a URL and return readable text."
        )
    p_hint_lines.append(
        "Do not call `ToolSearch(select:WebSearch)`, bare "
        "`WebSearch` is unavailable on this session and that path "
        "will return empty matches."
    )
    p_hint_lines.append("</web_tools>")
    p_web_hint = "\n".join(p_hint_lines)
    return f"{composed_prompt}\n\n{p_web_hint}" if composed_prompt else p_web_hint


@typechecked
def inject_thinking_options(options_kwargs: Dict, session: AgentSession, prompt: str, resolved_model: str, api_type: str) -> None:
    """Map the session's thinking_level onto the SDK options (anthropic thinking/effort, openai/codex
    reasoning_effort), with the short-prompt + gc/gemini-3 force-off overrides. Best-effort."""
    try:
        level = getattr(session, "thinking_level", "auto") or "auto"
        # Trivially short prompts ("hi", "thanks") don't benefit from 5-30s of hidden reasoning.
        p_prompt_len = len((prompt or "").strip())
        if 0 < p_prompt_len < 50 and level != "off":
            level = "off"
        # gc/gemini-3* without Antigravity 400s every multi-step turn on thoughtSignature continuity.
        if (
            isinstance(resolved_model, str)
            and resolved_model.startswith("gc/gemini-3")
            and level != "off"
        ):
            logger.info(
                "Forcing thinking_level=off for %s (gc/ thoughtSignature isn't roundtrippable; connect Antigravity for reasoning).",
                resolved_model,
            )
            level = "off"
        if api_type == "anthropic":
            if level == "off":
                # Fable 5 400s on an explicit thinking:disabled; off is its default (omit the param).
                if not (isinstance(resolved_model, str) and "fable" in resolved_model):
                    options_kwargs["thinking"] = {"type": "disabled"}
            elif level in ("low", "medium", "high"):
                options_kwargs["effort"] = level
        elif api_type in ("openai", "codex"):
            # GPT-5 + Codex take reasoning_effort; 9Router carries the Anthropic-shaped `effort`.
            if level in ("low", "medium", "high"):
                options_kwargs["effort"] = level
    except Exception as e:
        logger.debug(f"thinking_level param injection skipped: {e}")
