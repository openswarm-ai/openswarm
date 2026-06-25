"""Handle the SDK ResultMessage that closes a turn: fold in authoritative output tokens, write
the session's token + cost totals (recomputing cost off-Anthropic-rate routes), emit the final
consolidated thinking pill, broadcast the context-usage update, and reset the per-turn TurnState
/ ThinkingState. Lifted out of the agent loop; mutates the passed state by reference exactly as
inline. resolved_model / api_type / global_settings are the loop's per-run config, threaded in."""

import asyncio
import logging
from typing import Dict, Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.streaming import thinking as thinking_mod

try:
    from claude_agent_sdk import ResultMessage
except ImportError:  # the SDK is optional at runtime (mock mode); keep this module importable
    ResultMessage = object  # type: ignore

logger = logging.getLogger(__name__)


@typechecked
async def handle_result_message(
    message: ResultMessage,
    session: AgentSession,
    session_id: str,
    turn: TurnState,
    thinking: ThinkingState,
    sessions: Dict[str, AgentSession],
    resolved_model: object,
    api_type: Optional[str],
    global_settings: object,
) -> None:
    # ResultMessage carries the AUTHORITATIVE per-turn output_tokens count. Some providers (notably OpenAI/Gemini through 9Router) only populate `usage.output_tokens` here, not on individual AssistantMessages. Fold this into the running turn aggregate BEFORE emitting the final consolidated thinking message, so the bubble's tokens segment reflects ground truth on those providers too.
    try:
        result_usage = getattr(message, "usage", None) or {}
        if isinstance(result_usage, dict):
            result_out = int(result_usage.get("output_tokens", 0) or 0)
            # Take the max, if individual AssistantMessages already summed to a larger number we trust that; otherwise ResultMessage's count fills the gap.
            if result_out > turn.output_tokens:
                turn.output_tokens = result_out
    except Exception:
        pass

    # Pre-populate session.tokens BEFORE emitting the final consolidated thinking pill. Order matters: emit_consolidated_thinking reads session.tokens["input"]/["output"] for the combined-total stamp on the pill. If we emit first, the pill freezes with input=0 because the ResultMessage hasn't been consumed yet (the writes below at line ~2918 wouldn't land until after the pill is already broadcast).
    try:
        pre_usage = getattr(message, "usage", None) or {}
        if isinstance(pre_usage, dict):
            pre_in = int(pre_usage.get("input_tokens", 0) or 0)
            pre_create = int(pre_usage.get("cache_creation_input_tokens", 0) or 0)
            pre_read = int(pre_usage.get("cache_read_input_tokens", 0) or 0)
            pre_total_in = pre_in + pre_create + pre_read
            pre_out = int(pre_usage.get("output_tokens", 0) or 0)
            if pre_total_in > 0:
                session.tokens["input"] = pre_total_in
            # Pill reads the fresh lane: uncached input only, so re-read/cached context doesn't inflate it.
            session.tokens["input_fresh"] = pre_in
            if pre_out > 0:
                session.tokens["output"] = pre_out
    except Exception:
        pass

    # Final consolidated emission with the full duration + authoritative tokens. The frontend bubble freezes on this final value. For routes whose translator strips reasoning content (cx/ for OpenAI, gc/ for Gemini), force-emit a pill even when no text or upstream token count was captured. Without this, GPT/ Gemini turns show no thinking bubble at all because 9Router's translator doesn't carry reasoning_content across the Anthropic-shape round-trip. The frontend's ThinkingBubble detects empty content and renders a friendly "provider doesn't expose reasoning text" explanation instead of a blank panel.
    route_strips_reasoning = (
        isinstance(resolved_model, str)
        and resolved_model.startswith(("cx/", "gc/", "ag/", "gemini/"))
    )
    if thinking.text_parts or route_strips_reasoning:
        try:
            await thinking_mod.emit_consolidated_thinking(
                thinking, turn, session, session_id, sessions,
                force_provider_unavailable=route_strips_reasoning,
            )
        except Exception:
            pass
    if thinking.ticker_task is not None and not thinking.ticker_task.done():
        thinking.ticker_task.cancel()
        try:
            await thinking.ticker_task
        except (asyncio.CancelledError, Exception):
            pass
    thinking.ticker_task = None
    thinking.msg_id = None
    thinking.text_parts = []
    turn.tool_count = 0
    turn.started_ts = None
    turn.total_ms = 0
    turn.output_tokens = 0
    turn.assistant_text_chars = 0
    turn.tool_input_chars = 0
    thinking.thought_signature = None
    turn.baseline_session_in = 0
    turn.baseline_session_out = 0
    turn.baseline_children_in = 0
    turn.baseline_children_out = 0
    turn.baseline_captured = False
    thinking.total_ms = 0
    thinking.block_starts = {}

    session.sdk_session_id = getattr(message, "session_id", None)
    # Pull usage first; SDK's total_cost_usd is wrong for OR (assumes Anthropic rates) and we recompute below.
    usage = getattr(message, "usage", None) or {}
    inp = out = cache_create = cache_read = total_input = 0
    if isinstance(usage, dict):
        inp = usage.get("input_tokens", 0) or 0
        out = usage.get("output_tokens", 0) or 0
        cache_create = usage.get("cache_creation_input_tokens", 0) or 0
        cache_read = usage.get("cache_read_input_tokens", 0) or 0
        total_input = inp + cache_create + cache_read
        session.tokens["input"] = total_input
        session.tokens["input_fresh"] = inp
        session.tokens["output"] = out

    cost = getattr(message, "total_cost_usd", None)
    if cost is not None:
        free_route = False
        if isinstance(resolved_model, str):
            if resolved_model.startswith(("cc/", "cx/", "gc/", "ag/")):
                free_route = True
            elif resolved_model.startswith("openrouter/") and ":free" in resolved_model:
                free_route = True
            elif resolved_model.startswith("cp-"):
                # User-configured custom OpenAI-compatible provider (Ollama Cloud, Together, Groq, local LMs, etc.). Pricing is unknowable without per-provider rate tables that would rot fast, zero out instead of showing the SDK's Anthropic-rate estimate, which is meaningless here.
                free_route = True
        if api_type == "anthropic":
            from backend.apps.settings.credentials import proxy_auth as proxy_auth
            pa_tok, _ = proxy_auth(global_settings)
            # Pro and free-trial both run server-funded, so per-token cost to the user is 0.
            if pa_tok:
                free_route = True

        if free_route:
            cost = 0.0
        elif isinstance(resolved_model, str) and resolved_model.startswith("openrouter/"):
            # SDK assumes Anthropic rates → 50-100× off for OR.
            from backend.apps.agents.providers.registry import get_openrouter_pricing
            pricing = get_openrouter_pricing(resolved_model)
            if pricing:
                in_rate, out_rate = pricing
                cost = (
                    (inp + cache_create + cache_read) * in_rate
                    + out * out_rate
                ) / 1_000_000
        elif api_type in ("openai", "gemini") or (
            isinstance(resolved_model, str)
            and (resolved_model.startswith("cp-openai/")
                 or resolved_model.startswith("cp-gemini/")
                 or resolved_model.startswith("cp-google/"))
        ):
            # Direct OpenAI/Gemini API key lane. SDK's total_cost_usd is computed at Anthropic rates (Opus pricing), for GPT-5.4-Mini at $0.25/M input that's a 60x overcount ($30 instead of $0.04 per Mehmet-style 4-PDF turn). Use the published per-model rates instead.
            from backend.apps.agents.providers.registry import get_direct_pricing
            pricing = get_direct_pricing(resolved_model) or get_direct_pricing(session.model)
            if pricing:
                in_rate, out_rate = pricing
                cost = (
                    (inp + cache_create + cache_read) * in_rate
                    + out * out_rate
                ) / 1_000_000
            else:
                # Unknown model in this family: zero out rather than ship an Anthropic-rate estimate that's wildly wrong.
                cost = 0.0

        session.cost_usd = cost
        await ws_manager.send_to_session(session_id, "agent:cost_update", {
            "session_id": session_id,
            "cost_usd": session.cost_usd,
        })

    if isinstance(usage, dict):
        # Per-turn context-usage broadcast. Drives the UI status pill and the auto-compact threshold. The denominator is the session's real model cap, populated from registry.get_context_window at session creation, restore, and model-switch (see apply_context_window). max(1, ...) is a belt-and-braces guard against zero/None drift from any future restore-from-disk corner case.
        ctx_window = max(1, getattr(session, "context_window", 0) or 200_000)
        ctx_used_pct = round(total_input / ctx_window, 4) if total_input else 0.0
        cache_read_pct = round(cache_read / total_input, 4) if total_input else 0.0
        try:
            await ws_manager.send_to_session(session_id, "agent:context_update", {
                "session_id": session_id,
                "input_tokens": total_input,
                "output_tokens": out,
                "cache_read_tokens": cache_read,
                "cache_read_pct": cache_read_pct,
                "ctx_used_pct": ctx_used_pct,
                "context_window": ctx_window,
                "framework_overhead_tokens": session.framework_overhead_tokens,
                "active_mcps": list(session.active_mcps),
            })
        except Exception:
            logger.exception("Failed to emit agent:context_update")
