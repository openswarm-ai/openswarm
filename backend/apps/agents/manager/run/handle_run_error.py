"""Friendly error cards for a failed agent run. The run_agent_loop except-handler classifies
the exception (long-context / capacity / free-trial / auth / unknown-model / unclassified) and
emits the matching system message + WS event. Pulled out of agent_manager so the loop stays under
the file ceiling; pure relocation, no self (operates on the passed run state)."""

import logging
from typing import List
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.agents.manager.streaming.state import TurnState
from backend.apps.agents.core.error_classify import (
    is_long_context_error,
    is_transient_capacity_error,
    is_free_trial_exhausted,
    is_out_of_tokens,
    extract_reset_hint,
    is_auth_error,
    is_unknown_model_error,
    parse_retry_after,
    redact_for_telemetry,
)

logger = logging.getLogger(__name__)


@typechecked
async def handle_run_error(e: Exception, session: AgentSession, session_id: str, turn: TurnState, p_stderr_buffer: List[str]) -> None:
    logger.exception(f"Agent {session_id} error: {e}")
    session.status = "error"

    # Long-context-required 429 fork: surface a friendly overflow event so the frontend can render an actionable card ("Switch to Chat mode" / "Start a fresh chat") instead of a raw error blob. The user can't recover by waiting, this is a tier-gate, not a rate limit, so the UX matters.
    try:
        p_stderr_tail = "\n".join(p_stderr_buffer[-50:])
    except Exception:
        p_stderr_tail = ""
    # If we already streamed a substantive assistant response this turn, the user got their answer; the error fired on a subsequent step (title gen, follow-up tool turn, etc.). Don't blast a "context exceeded" card over a completed reply.
    p_streamed_substantive = bool(turn.stream_text_msg_id) and turn.current_turn_emitted
    if p_streamed_substantive and is_long_context_error(e, extra_text=p_stderr_tail):
        # Mark the session completed (not error), keep the assistant reply visible, and skip the overflow card. The next user turn will properly hit the pre-send guard if the chat is still over cap.
        session.status = "completed"
        if turn.stream_text_msg_id:
            try:
                await ws_manager.send_to_session(session_id, "agent:stream_end", {
                    "session_id": session_id,
                    "message_id": turn.stream_text_msg_id,
                })
            except Exception:
                pass
        return
    if is_long_context_error(e, extra_text=p_stderr_tail):
        friendly_msg = (
            "This conversation has grown too large for your account's "
            "standard context window. Long-context requests require an "
            "upgraded tier, switch to Chat mode or start a fresh chat "
            "to continue."
        )
        error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
        session.messages.append(error_msg)
        p_ovf_payload = {
            "session_id": session_id,
            "reason": "long_context_required",
            "message": friendly_msg,
            "model": session.model,
            "provider": session.provider,
            "context_window": session.context_window,
            "framework_overhead_tokens": session.framework_overhead_tokens,
            "input_tokens": session.tokens.get("input", 0),
            "active_mcps": list(session.active_mcps),
            "compact_threshold_pct": session.compact_threshold_pct,
            "context_soft_cap_pct": session.context_soft_cap_pct,
        }
        await ws_manager.send_to_session(session_id, "agent:context_overflow", p_ovf_payload)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
        try:
            from backend.apps.service.client import submit_diagnostic
            submit_diagnostic({
                "kind": "context_overflow",
                "where": "manager.run.handle_run_error",
                "session_id": session_id,
                "model": session.model,
                "provider": session.provider,
                "context_window": session.context_window,
                "input_tokens": session.tokens.get("input", 0),
                "framework_overhead_tokens": session.framework_overhead_tokens,
                "active_mcps_count": len(session.active_mcps),
                "messages_count": len(session.messages),
                "error_preview": redact_for_telemetry(str(e), limit=500),
            })
        except Exception:
            logger.debug("submit_diagnostic for context_overflow failed", exc_info=True)
    elif is_transient_capacity_error(e, extra_text=p_stderr_tail):
        # A genuine throttle (429/overload/capacity) that already burned the whole silent-backoff budget (the only way one reaches here). It's a limit, not a failure, so don't append a system-message card; emit a transient signal for the muted pill and mark the turn completed so it doesn't read as an error.
        session.status = "completed"
        if turn.stream_text_msg_id:
            try:
                await ws_manager.send_to_session(session_id, "agent:stream_end", {
                    "session_id": session_id,
                    "message_id": turn.stream_text_msg_id,
                })
            except Exception:
                pass
        await ws_manager.send_to_session(session_id, "agent:rate_limited", {
            "session_id": session_id,
            "retry_after_s": parse_retry_after(e, p_stderr_tail),
        })
    elif is_free_trial_exhausted(e, extra_text=p_stderr_tail):
        # Free runs spent. Flip back to own_key and show a friendly "connect a model" upsell instead of a raw 402.
        try:
            from backend.apps.subscription.free_trial import clear_free_trial
            await clear_free_trial(load_settings())
        except Exception:
            logger.debug("clear_free_trial after exhaustion failed", exc_info=True)
        friendly_msg = (
            "You've used your free runs. Connect a model to keep going: "
            "your own API key, an AI subscription you already pay for, or "
            "OpenSwarm Pro."
        )
        error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:free_trial_exhausted", {
            "session_id": session_id,
            "message": friendly_msg,
        })
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
    elif is_out_of_tokens(e, extra_text=p_stderr_tail):
        # The user's PROVIDER account is out of credits / over quota, distinct from OpenSwarm free-trial exhaustion above and from a 401 below ("credit balance too low", "insufficient_quota", "usage cap exceeded", OpenSwarm plan limit). Show a friendly card with the provider's reset hint when it gave one, instead of dropping to the raw-error blob in the else branch.
        p_reset_hint = extract_reset_hint(f"{e!s}\n{p_stderr_tail}")
        friendly_msg = (
            "Your model provider reports you're out of credits or over your usage "
            "limit" + (f" (resets {p_reset_hint})" if p_reset_hint else "") + ". Add "
            "credits with your provider, switch to a different model, or connect "
            "another option in Settings → Models."
        )
        error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:out_of_credits", {
            "session_id": session_id,
            "message": friendly_msg,
            "reset_hint": p_reset_hint,
            "model": session.model,
        })
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
    elif is_auth_error(e, extra_text=p_stderr_tail):
        # Three sub-cases the user can hit, with distinct fixes: 1. "No credentials for provider: claude", user picked a -cc route but doesn't have Claude Pro/Max connected via 9Router. Tell them to either connect Claude Pro/Max OR pick a non--cc model. 2. OpenSwarm Pro 401, bearer expired. Reconnect. 3. Anthropic API key 401, wrong key. Re-enter.
        p_model = (session.model or "").lower()
        p_combined = f"{e!s}\n{p_stderr_tail}".lower()
        # Codex/OpenAI subscription tokens rotate every ~2-3 minutes, the user sees the rotation window as a 401 with "reset after 1m 59s" or similar. Don't ask them to reconnect; just tell them to wait it out and retry.
        if (
            ("codex/" in p_combined or "[codex/" in p_combined or p_model.startswith(("cx/", "gpt-")))
            and ("authentication token is expired" in p_combined or "authentication token has expired" in p_combined or "401" in p_combined)
        ):
            friendly_msg = (
                "GPT subscription token just rotated, this is "
                "automatic and resets every couple minutes. Send "
                "your message again in ~1 minute and it'll go "
                "through. (No need to reconnect anything.)"
            )
            reason = "codex_token_rotating"
        elif "no credentials for provider" in p_combined:
            friendly_msg = (
                "Selected route requires Claude Pro / Max, but it's "
                "not connected. Open Settings → Models and either "
                "connect Claude Pro / Max, or switch the model to a "
                "non-`-cc` variant (e.g. Claude Sonnet 4.6 instead "
                "of Sonnet 4.6 -cc)."
            )
            reason = "claude_sub_not_connected"
        elif (
            "-cc" not in p_model
            and getattr(load_settings(), "connection_mode", "own_key") == "openswarm-pro"
        ):
            friendly_msg = (
                "OpenSwarm Pro authentication failed. Your subscription "
                "token may have expired even though the connection still "
                "shows green. Open Settings → Models and click "
                "Disconnect / Reconnect on Claude Pro / Max to refresh "
                "the token."
            )
            reason = "openswarm_pro_auth_expired"
        else:
            friendly_msg = (
                "Anthropic authentication failed. The API key or "
                "subscription token for this model is invalid. Open "
                "Settings → Models and re-enter the API key, or "
                "reconnect Claude Pro / Max."
            )
            reason = "anthropic_auth_invalid"
        error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:auth_error", {
            "session_id": session_id,
            "reason": reason,
            "message": friendly_msg,
            "model": session.model,
        })
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
    elif is_unknown_model_error(e, extra_text=p_stderr_tail):
        # Upstream rejected the model code itself (e.g. Codex 1211 on a ChatGPT plan that lacks our GPT ids). Track it; the friendly "add an API key / pick another model" card is rendered frontend-side.
        try:
            from backend.apps.service.client import submit_diagnostic
            submit_diagnostic({
                "kind": "model_error",
                "subkind": "unknown_model",
                "model": session.model,
                "provider": session.provider,
                "connection_mode": getattr(load_settings(), "connection_mode", "own_key"),
                "error_preview": redact_for_telemetry(str(e), limit=400),
                "stderr_tail": redact_for_telemetry(p_stderr_tail),
            })
        except Exception:
            logger.debug("submit_diagnostic model_error failed", exc_info=True)
        error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
    else:
        # Track unclassified agent failures too so we stop flying blind on them.
        try:
            from backend.apps.service.client import submit_diagnostic
            submit_diagnostic({
                "kind": "model_error",
                "subkind": "unclassified",
                "model": session.model,
                "provider": session.provider,
                "connection_mode": getattr(load_settings(), "connection_mode", "own_key"),
                "error_preview": redact_for_telemetry(str(e), limit=400),
                "stderr_tail": redact_for_telemetry(p_stderr_tail),
            })
        except Exception:
            logger.debug("submit_diagnostic model_error failed", exc_info=True)
        error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
