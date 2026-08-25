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
    is_context_overflow_error,
    is_long_context_error,
    is_transient_capacity_error,
    is_free_trial_exhausted,
    is_out_of_tokens,
    has_auth_status,
    is_auth_error,
    is_content_policy_block,
    is_cert_failure,
    is_cli_binary_missing,
    is_connection_lost,
    is_unknown_model_error,
    parse_retry_after,
)
from backend.apps.agents.core.is_router_unavailable_error import is_router_unavailable_error
from backend.apps.agents.core.extract_reset_hint import extract_reset_hint
from backend.apps.agents.core.redact_for_telemetry import redact_for_telemetry
from backend.apps.agents.core import flight_recorder
from backend.apps.agents.manager.run.empty_finish import count_tool_calls
from backend.apps.agents.session_credential import api_key_twin_model

logger = logging.getLogger(__name__)



@typechecked
def p_renders_as_nothing(msg: Message) -> bool:
    """An empty thinking pill occupies the tail while showing the user nothing, which silently broke the dedup below (live drill 2026-08-20: three identical cards)."""
    return msg.role == "thinking" and not str(msg.content or "").strip()


@typechecked
def absorb_repeat_card(session: AgentSession, error_msg: Message) -> None:
    """Append the error card, unless the branch tail is already the IDENTICAL card with nothing
    after it: a retry ladder re-failing the same way then bumps the existing card instead of
    stacking a wall of clones (field screenshot 2026-08-19). A user message in between always
    yields a fresh card, each ask deserves its own honest answer.

    HIDDEN messages do not count as that user message. Our own self-heal continuations are hidden
    user-role sends, so counting them re-opened the exact clone wall this exists to stop: a live
    codex drill on 2026-08-20 produced FIVE identical "still refreshing" cards, one per retry,
    because each retry's hidden prompt had displaced the previous card from the tail."""
    p_tail = [m for m in session.messages
              if getattr(m, "branch_id", None) in (None, session.active_branch_id)
              and not getattr(m, "hidden", False)
              and not p_renders_as_nothing(m)]
    if p_tail and p_tail[-1].role == "system" and p_tail[-1].content == error_msg.content:
        error_msg.id = p_tail[-1].id
        p_tail[-1].timestamp = error_msg.timestamp
        return
    session.messages.append(error_msg)


# Blocked chats were measured ~4.8x more likely to use InvokeAgent/SpawnAgent, and a delegated
# child's answer lands in the parent's context as another model's output, which is the literal
# wording of the clause being enforced. Recorded so that correlation can finally be tested.
P_DELEGATION_TOOLS = ("InvokeAgent", "SpawnAgent", "CreateBrowserAgent")


@typechecked
def p_used_delegation(session: AgentSession) -> bool:
    for msg in session.messages:
        content = msg.content
        if isinstance(content, dict) and any(t in str(content.get("tool", "")) for t in P_DELEGATION_TOOLS):
            return True
    return False


@typechecked
def p_report_model_error(subkind: str, session_id: str, session: AgentSession, turn: TurnState,
                         e: BaseException, stderr_tail: str) -> None:
    """The three terminal model_error rungs differ only by subkind, so they share one submitter."""
    try:
        from backend.apps.service.client import submit_diagnostic
        submit_diagnostic({
            "kind": "model_error",
            "subkind": subkind,
            "flight": flight_recorder.build_envelope(session_id, "model_error", subkind, session.model, "stream" if turn.current_turn_emitted else "spawn", -1),
            "model": session.model,
            "provider": session.provider,
            "connection_mode": getattr(load_settings(), "connection_mode", "own_key"),
            "error_preview": redact_for_telemetry(str(e), limit=400),
            "stderr_tail": redact_for_telemetry(stderr_tail),
            # The SHAPE of what was refused. Without these, a content theory about the policy block
            # is untestable: model_error was the ONE envelope kind carrying no session_id at all
            # (1,028 of 1,028 null, while empty_finish_nudge was 0 of 4,001), so no block could ever
            # be tied back to the conversation that produced it, and the class stayed unexplained
            # while the theories were argued from inference (ENG-396).
            "session_id": session_id,
            "input_tokens": int((session.tokens or {}).get("input", 0) or 0),
            "tool_calls": count_tool_calls(session),
            "compacted": bool(session.needs_fresh_session),
            "history_prefix_sent": session.history_prefix_sent,
            "delegated": p_used_delegation(session),
        })
    except Exception:
        logger.debug(f"submit_diagnostic {subkind} failed", exc_info=True)

async def handle_run_error(e: Exception, session: AgentSession, session_id: str, turn: TurnState, p_stderr_buffer: List[str]) -> None:
    logger.exception(f"Agent {session_id} error: {e}")
    session.status = "error"

    # Long-context-required 429 fork: surface a friendly overflow event so the frontend can render an actionable card ("Switch to Chat mode" / "Start a fresh chat") instead of a raw error blob. The user can't recover by waiting, this is a tier-gate, not a rate limit, so the UX matters.
    try:
        p_stderr_tail = "\n".join(p_stderr_buffer[-50:])
    except Exception:
        p_stderr_tail = ""
    # No completed-mask here anymore: current_turn_emitted stays True until a ResultMessage lands, so the old "already answered" early-return fired on every MID-TASK death (models narrate between tool calls) and converted a dead run into a fake "completed". Reaching this handler with an overflow means the valve's compact-and-retry already failed once; the user must see the card.
    if is_context_overflow_error(e, extra_text=p_stderr_tail):
        p_tier_gate = is_long_context_error(e, extra_text=p_stderr_tail)
        friendly_msg = (
            "This conversation has grown too large for your account's "
            "standard context window. Long-context requests require an "
            "upgraded tier, switch to Chat mode or start a fresh chat "
            "to continue."
        ) if p_tier_gate else (
            "This conversation outgrew the model's context window, and "
            "automatic compaction couldn't shrink it enough. Start a fresh "
            "chat (your recent context carries over) or switch to a model "
            "with a larger window."
        )
        error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
        absorb_repeat_card(session, error_msg)
        p_ovf_payload = {
            "session_id": session_id,
            "reason": "long_context_required" if p_tier_gate else "context_overflow",
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
                "flight": flight_recorder.build_envelope(session_id, "context_overflow", "overflow", session.model, "stream" if turn.current_turn_emitted else "spawn", -1),
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
    elif is_cert_failure(e, extra_text=p_stderr_tail):
        # Deterministic per host: corporate TLS-inspection proxy, clock skew, or a stale CA bundle. Waiting can't fix any of them, so name the real remedies instead of a rate-limit-shaped pill (ENG-218).
        friendly_msg = (
            "OpenSwarm couldn't verify the AI provider's security certificate, so the "
            "connection was refused. This usually means a corporate proxy or security "
            "tool (Zscaler, Netskope) is inspecting your traffic, or your system clock "
            "is wrong. Check the clock, try a different network, or ask IT to allow "
            "api.anthropic.com; retrying won't help until one of those changes."
        )
        error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
        absorb_repeat_card(session, error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
        p_report_model_error("cert_failure", session_id, session, turn, e, p_stderr_tail)
    elif is_cli_binary_missing(e, extra_text=p_stderr_tail):
        # The bundled CLI vanished from an installed app (Windows AV quarantine class; 22 of 25 field installs never recovered). The raw "not found at: C:\..." card is unactionable; name the likely cause and the two real fixes.
        friendly_msg = (
            "A core OpenSwarm component (the bundled agent runtime) is missing from "
            "this install, which usually means antivirus software quarantined it. "
            "Restore it from your antivirus quarantine and add an exclusion for "
            "OpenSwarm, or reinstall from openswarm.com. Your chats and settings "
            "are kept either way."
        )
        error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
        absorb_repeat_card(session, error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
        try:
            from backend.apps.service.client import submit_diagnostic
            submit_diagnostic({
                "kind": "cli_binary_missing",
                "where": "manager.run.handle_run_error",
                "flight": flight_recorder.build_envelope(session_id, "cli_binary_missing", "missing", session.model, "stream" if turn.current_turn_emitted else "spawn", -1),
                "session_id": session_id,
                "model": session.model,
                "error_preview": redact_for_telemetry(str(e), limit=400),
            })
        except Exception:
            logger.debug("submit_diagnostic cli_binary_missing failed", exc_info=True)
    elif is_transient_capacity_error(e, extra_text=p_stderr_tail):
        # A genuine throttle (429/overload/capacity) that already burned the whole silent-backoff budget (the only way one reaches here). It's a limit, not a failure, so don't append a system-message card; emit a transient signal for the muted pill and mark the turn completed so it doesn't read as an error.
        # 335s of ladder is a blip's worth of patience, and a closed lid or switched network outlasts it, so park and retry before conceding a turn the user never chose to end.
        from backend.apps.agents.manager.run.reconnect_resume import arm_reconnect_resume
        p_delay = arm_reconnect_resume(session, parse_retry_after(e, p_stderr_tail), is_connection_lost(e))
        if p_delay is None:
            # Budget spent: this turn is OVER, not parked. Leaving the flag set muzzles the
            # terminal floor (which stays quiet for parked turns) and the ask ends in silence,
            # which is the exact failure the floor exists to prevent. Caught live on a rate-limited
            # Gemini run, 2026-08-20: status=completed, awaiting_reconnect=True, attempts=3, and
            # not one word to the user.
            from backend.apps.agents.manager.run.reconnect_resume import clear_reconnect_wait
            clear_reconnect_wait(session)
        if p_delay is not None:
            p_why = "connection lost" if is_connection_lost(e) else "provider unavailable"
            logger.info(f"Agent {session_id}: {p_why} past the in-turn budget; retrying in {p_delay}s")
            await ws_manager.send_to_session(session_id, "agent:reconnect_wait", {
                "session_id": session_id,
                "retry_in_s": p_delay,
                "attempt": session.reconnect_attempts,
            })
            return
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
        absorb_repeat_card(session, error_msg)
        await ws_manager.send_to_session(session_id, "agent:free_trial_exhausted", {
            "session_id": session_id,
            "message": friendly_msg,
        })
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
    elif is_content_policy_block(f"{e!s}\n{p_stderr_tail}"):
        # The provider's abuse classifier declined the REQUEST, and on the subscription lane what it reads as "duplicating model outputs" is OUR recap of the chat on a fresh CLI session (192 blocks in 14 days, 0 on API keys); deterministic, so the one retry that can pass carries no history at all, the session stays that way, and every block is reported with the shape it sent.
        p_sent = session.history_prefix_sent
        p_report_model_error(f"policy_block:{p_sent}", session_id, session, turn, e, p_stderr_tail)
        if p_sent != "none":
            session.history_prefix_mode = "none"
            session.needs_fresh_session = True
            session.pending_continuation = True
            session.pending_continuation_prompt = (
                "Continue the task exactly where you left off; the session summary was reduced "
                "this turn, rely on the visible conversation.")
            logger.warning(f"Agent {session_id}: provider content-policy block on a turn carrying a {p_sent} history prefix; retrying with {session.history_prefix_mode}")
            return
        # The subscription lane declined and nothing is left to strip; fleet data says the same request passes on an API key (0 of 328 vs 4.4%), so a user who connected their own Anthropic key continues there, told in one line, instead of losing the ask (ENG-383).
        p_twin = api_key_twin_model(session.model or "", load_settings())
        if p_twin:
            p_from = session.model
            session.model = p_twin
            session.needs_fresh_session = True
            session.pending_continuation = True
            session.pending_continuation_prompt = "Continue where you left off and finish the task, then answer in plain text."
            p_notice = Message(
                role="system",
                content="Claude declined this request on your subscription; continuing on your Anthropic API key.",
                branch_id=session.active_branch_id,
            )
            absorb_repeat_card(session, p_notice)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id, "message": p_notice.model_dump(mode="json"),
            })
            flight_recorder.record_recovery(session_id, "lane_failover", session.model, 1)
            logger.warning(f"Agent {session_id}: policy block on the subscription lane; failing over {p_from} -> {p_twin}")
            return
        p_retried = session.history_prefix_mode == "none"
        friendly_msg = (
            "The model provider declined this request (its automated policy filter flagged the "
            "conversation's content)"
            + (", even after OpenSwarm retried without the session summary" if p_retried else "")
            + ". Retrying the same request won't change that. Rephrase your last message, or "
            "start a fresh chat about this topic."
        )
        error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
        absorb_repeat_card(session, error_msg)
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
        absorb_repeat_card(session, error_msg)
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
        p_codex_rotation = (
            ("codex/" in p_combined or "[codex/" in p_combined or p_model.startswith(("cx/", "gpt-")))
            and ("authentication token is expired" in p_combined or "authentication token has expired" in p_combined or has_auth_status(p_combined))
        )
        # Every sub lane gets ONE silent self-heal before any card; only a missing credential (config problem, retry fails identically) goes straight to the card. Codex waits out its rotation window first.
        # A lane the router had ALREADY given up on before this turn is a dead credential, so the
        # rotation story is false and the wait is doomed; say the true thing straight away.
        if getattr(session, "lane_credential_dead", False):
            from backend.apps.agents.manager.run.lane_preflight import RECONNECT_COPY
            p_prov = (session.provider or "").lower()
            friendly_msg = RECONNECT_COPY.get(
                p_prov,
                "This model's sign-in expired and could not be renewed. Reconnect it in Settings, "
                "then Models. Waiting will not clear this one.")
            error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
            absorb_repeat_card(session, error_msg)
            await ws_manager.send_to_session(session_id, "agent:auth_error", {
                "session_id": session_id, "reason": "credential_expired",
                "message": friendly_msg, "model": session.model,
            })
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id, "message": error_msg.model_dump(mode="json"),
            })
            return
        if "no credentials for provider" not in p_combined:
            from backend.apps.agents.manager.streaming.auth_retry import try_auth_self_heal
            if try_auth_self_heal(session, delay_s=75 if p_codex_rotation else 5):
                if p_codex_rotation:
                    p_notice = Message(
                        role="system",
                        content="GPT subscription token just rotated (automatic, every couple minutes). Retrying your request automatically in about a minute, no action needed.",
                        branch_id=session.active_branch_id,
                    )
                    session.messages.append(p_notice)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": p_notice.model_dump(mode="json"),
                    })
                logger.info(f"auth self-heal armed for {session_id} (codex_rotation={p_codex_rotation})")
                return
        # Codex/OpenAI subscription tokens rotate every ~2-3 minutes, the user sees the rotation window as a 401 with "reset after 1m 59s" or similar. Don't ask them to reconnect; just tell them to wait it out and retry.
        if (
            ("codex/" in p_combined or "[codex/" in p_combined or p_model.startswith(("cx/", "gpt-")))
            and ("authentication token is expired" in p_combined or "authentication token has expired" in p_combined or has_auth_status(p_combined))
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
        absorb_repeat_card(session, error_msg)
        try:
            from backend.apps.service.client import submit_diagnostic
            submit_diagnostic({
                "kind": "model_error",
                "subkind": "auth",
                "model": session.model,
                "provider": session.provider,
                "error_preview": redact_for_telemetry(str(e), limit=400),
                "flight": flight_recorder.build_envelope(session_id, "model_error", reason, session.model, "stream" if turn.current_turn_emitted else "spawn", -1),
            })
        except Exception:
            logger.debug("submit_diagnostic auth failed", exc_info=True)
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
        p_report_model_error("unknown_model", session_id, session, turn, e, p_stderr_tail)
        error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
        absorb_repeat_card(session, error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
    elif is_router_unavailable_error(f"{e} {p_stderr_tail}"):
        # Our own router is down. Naming it beats "unclassified": this is the one failure family
        # where the fix is entirely on our side of the wire.
        p_report_model_error("router_unavailable", session_id, session, turn, e, p_stderr_tail)
        error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
        absorb_repeat_card(session, error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
    else:
        # Track unclassified agent failures too so we stop flying blind on them.
        p_report_model_error("unclassified", session_id, session, turn, e, p_stderr_tail)
        # Every classified branch above is an EXTERNAL fact (auth, credits, capacity, certs) that a
        # respawn cannot fix. Landing here instead means the failure may live in this session's own
        # CLI state, and that state is replayed verbatim on every retry, which is how one chat bricks
        # forever on "hit a snag" while its siblings are fine (ENG-258). Arm the proven fresh-session
        # rebuild so the next ordinary send drops the resume transcript and respawns the client; the
        # user's own retry becomes the cure instead of needing a manual branch.
        session.needs_fresh_session = True
        logger.info(f"Agent {session_id}: unclassified failure, next turn rebuilds on a fresh CLI session")
        # The SDK's ProcessError masks the cause behind "Check stderr output for details"; append the scrubbed stderr tail so the card (and its analytics copy) names what actually broke instead of shipping a dead end.
        p_card_text = f"Error: {str(e)}"
        p_cause = redact_for_telemetry(p_stderr_tail, limit=400).strip()
        if p_cause and "check stderr" in str(e).lower():
            p_card_text += f"\n\nRuntime log tail:\n{p_cause}"
        error_msg = Message(role="system", content=p_card_text, branch_id=session.active_branch_id)
        absorb_repeat_card(session, error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
