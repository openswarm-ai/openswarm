"""
Browser sub-agent runner.

Provides a lightweight Anthropic API tool-use loop that drives browser
interactions directly through ws_manager (no MCP subprocess needed).
Sub-agents appear as visible AgentSession cards on the dashboard.
"""

import asyncio
import json
import logging
import re
import time
from datetime import datetime
from uuid import uuid4

import anthropic

from backend.apps.agents.browser import browser_history
from backend.apps.agents.browser.browser_history import (
    _MAX_HISTORY_MESSAGES,
    _trim_history_by_turns,
    _validate_message_pairing,
    clear_browser_history,
    PAGE_STATE_MARKER,
)
from backend.apps.agents.browser.browser_loop import (
    _LOOP_DETECTION_EXCLUDED_TOOLS,
    _LOOP_HARD_CAP,
    _LOOP_WARNING_TEXT,
    _LOOP_WINDOW_SIZE,
    _detect_loop,
    _hash_tool_call,
    _CARD_GONE_LIMIT,
    advance_stagnation,
    card_is_unavailable,
    completion_is_honest,
    deliverable_is_informational,
    interstitial_dismiss_target,
    recoverable_tool_error,
    replay_recheck_is_safe,
    stagnation_exhausted,
)
from backend.apps.agents.browser.browser_validator import adjudicate_stuck

# Send-skill PREFIX replay: replay the learned steps UP TO the irreversible Send
# mechanically, then hand the gated Send to the live model (the Send is NEVER
# replayed). Unlocked by first_unsafe_step now using is_replay_boundary, a
# composer OPENER ("Message"/"DM" click) is reversible and no longer ends the
# prefix (the r93/r94 blocker), so a clean skill replays [open composer ...] and
# only the real Send crosses to the live agent. A still-brittle recorded name
# self-heals: the prefix step fails, the skill quarantines, and the run falls
# back to the full agent (send still verified). Both fixes that parked it
# (settle-before-step, detour-pruning) already landed.
_PREFIX_REPLAY_ENABLED = True

# Single actions the model could have folded into one BrowserBatch turn;
# reads, waits, and the batch tools themselves don't count toward the streak.
_BATCHABLE_ACTION_TOOLS = {
    "BrowserNavigate", "BrowserClick", "BrowserClickIndex", "BrowserClickByName",
    "BrowserType", "BrowserPressKey", "BrowserScroll",
}
from backend.apps.agents.browser import browser_batch_replay
from backend.apps.agents.browser import browser_extract
from backend.apps.agents.browser import browser_metrics
from backend.apps.agents.browser import browser_playbook
from backend.apps.agents.browser import browser_skills
from backend.apps.agents.browser import browser_wait
from backend.apps.agents.browser import browser_schema
from backend.apps.agents.browser.browser_schema import (
    _ACTION_TOOLS_REQUIRING_REPORT,
    ACTION_MAP,
    BROWSER_TOOLS_SCHEMA,
    MAX_TURNS,
    MODEL_MAP,
    SYSTEM_PROMPT,
)
from backend.apps.agents.core.models import AgentSession, ApprovalRequest, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.tools_lib.tools_lib import load_builtin_permissions

logger = logging.getLogger(__name__)

# Mutating actions that can carry an `expect` (the change they should cause) and be
# confirmed after running. Reads/waits aren't here, there's nothing to confirm.
_CONFIRM_TOOLS = {
    "BrowserClick", "BrowserClickIndex", "BrowserClickByName",
    "BrowserType", "BrowserNavigate", "BrowserPressKey", "BrowserBatch",
}


async def execute_browser_tool(
    tool_name: str, tool_input: dict, browser_id: str, tab_id: str = "",
) -> dict:
    """Execute a browser tool via ws_manager directly (no MCP/HTTP round-trip)."""
    action = ACTION_MAP.get(tool_name)
    if not action:
        return {"error": f"Unknown browser tool: {tool_name}"}

    params = {k: v for k, v in tool_input.items()}
    request_id = uuid4().hex
    result = await ws_manager.send_browser_command(
        request_id, action, browser_id, params, tab_id=tab_id,
    )
    return result


def _extract_domain(url: str) -> str | None:
    """Extract the apex domain from a URL (acme-corp.notion.so → notion.so).
    Returns None for non-http URLs."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        host = parsed.hostname or ""
        if not host or host in ("localhost", "127.0.0.1", ""):
            return None
        parts = host.split(".")
        if len(parts) >= 2:
            return ".".join(parts[-2:])
        return host
    except Exception:
        return None


def _strip_lone_surrogates(s: str) -> str:
    # The JS/webview hands us page text as UTF-16, so an emoji can arrive as half
    # of its surrogate pair; Python carries the orphan but .encode('utf-8') later
    # (the SDK serializing the request to the LLM) detonates with "surrogates not
    # allowed" and kills the turn. Swap any orphan for the replacement char.
    return re.sub(r"[\ud800-\udfff]", "�", s) if s else s


def _format_tool_result(result: dict, tool_name: str) -> list[dict]:
    """Convert a browser command result dict into Anthropic API content blocks."""
    if "error" in result:
        return [{"type": "text", "text": _strip_lone_surrogates(f"Error: {result['error']}")}]

    if tool_name == "BrowserScreenshot" and result.get("image"):
        blocks = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": result.get("image_mime", "image/png"),
                    "data": result["image"],
                },
            },
            {"type": "text", "text": f"Screenshot captured. URL: {result.get('url', 'unknown')}"},
        ]
        return blocks

    text = result.get("text", json.dumps(result))
    return [{"type": "text", "text": _strip_lone_surrogates(str(text))}]


# Mutating tools whose results get fresh page state attached (the browser-use
# loop shape: act, settle, see), so acting and seeing are one turn, not two.
_AUTO_STATE_TOOLS = {
    "BrowserNavigate", "BrowserClick", "BrowserClickIndex", "BrowserClickByName",
    "BrowserType", "BrowserPressKey", "BrowserScroll", "BrowserBatch",
}
_AUTO_STATE_MAX_LINES = 35
_AUTO_SETTLE_CAPS_MS = {"BrowserNavigate": 2500, "BrowserBatch": 1500}

# URL shapes that mean "a list of candidates to pick from" (auto candidate scan)
_RESULTS_URL_RE = re.compile(
    r"[?&](q|query|keywords|search|search_query|find|term)=|/search\b|/results\b", re.I,
)
_AUTO_SCAN_MAX_PER_RUN = 2


def _batch_ends_with_read(tool_input: dict) -> bool:
    actions = (tool_input or {}).get("actions") or []
    return bool(actions) and (actions[-1] or {}).get("type") == "list_interactives"


def _truncate_state(text: str, max_lines: int = _AUTO_STATE_MAX_LINES) -> str:
    lines = str(text).splitlines()
    if len(lines) <= max_lines:
        return str(text)
    return "\n".join(lines[:max_lines]) + (
        f"\n(+{len(lines) - max_lines} more rows; call BrowserListInteractives for the full list)"
    )


def _delta_state(text: str, seen_lines: set[str]) -> str:
    """Shrink an attached element list to the rows that changed since the last
    attach; stable indices make a line's identity meaningful, so re-sending 30
    unchanged rows every action is pure token burn. Mutates `seen_lines` to the
    new baseline. Small overlaps just resend the full list (a reshuffle)."""
    rows = [l for l in str(text).splitlines() if l.startswith("[")]
    cur = set(rows)
    prev = set(seen_lines)
    seen_lines.clear()
    seen_lines.update(cur)
    if not prev or not rows:
        return text
    fresh = [l for l in rows if l not in prev]
    unchanged = len(rows) - len(fresh)
    if unchanged < 6:
        return text
    if not fresh:
        return f"(all {unchanged} element rows unchanged since your last look; same numbers still valid)"
    return "\n".join(fresh) + (
        f"\n(+{unchanged} rows unchanged since your last look; their numbers are still valid)"
    )


async def _post_action_state(
    tool_name: str, tool_input: dict, result: dict,
    browser_id: str, tab_id: str, wait_exec, goal: str,
    seen_lines: set[str] | None = None,
) -> str:
    """Settle the page after a mutating action, then return a compact fresh
    interactives list to append to its result. Empty string = attach nothing."""
    if tool_name not in _AUTO_STATE_TOOLS or not isinstance(result, dict) or "error" in result:
        return ""
    if tool_name == "BrowserBatch" and _batch_ends_with_read(tool_input):
        return ""
    # an `expect` confirm already ran its own smart_wait; don't settle twice
    if not str((tool_input or {}).get("expect") or "").strip():
        settle = await browser_wait.smart_wait(
            wait_exec, browser_id, tab_id, _AUTO_SETTLE_CAPS_MS.get(tool_name, 1200),
        )
        if settle.get("hung"):
            return ""
    try:
        params = {"goal": goal} if goal else {}
        lst = await asyncio.wait_for(
            wait_exec("BrowserListInteractives", params, browser_id, tab_id), timeout=5.0,
        )
    except Exception:
        return ""
    if not isinstance(lst, dict) or "error" in lst or not lst.get("text"):
        return ""
    state = lst["text"] if seen_lines is None else _delta_state(lst["text"], seen_lines)
    return f"\n\n{PAGE_STATE_MARKER}\n{_truncate_state(state)}"


async def _request_browser_approval(
    session: AgentSession, tool_name: str, tool_input: dict,
) -> dict:
    """Send an approval request for a browser sub-agent tool and wait for the decision."""
    request_id = uuid4().hex
    approval_req = ApprovalRequest(
        id=request_id,
        session_id=session.id,
        tool_name=tool_name,
        tool_input=tool_input,
    )
    session.pending_approvals.append(approval_req)
    session.status = "waiting_approval"

    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id,
        "status": "waiting_approval",
    })

    try:
        decision = await asyncio.wait_for(
            ws_manager.send_approval_request(
                session.id, request_id, tool_name, tool_input,
            ),
            timeout=300.0,
        )
    except asyncio.TimeoutError:
        decision = {"behavior": "deny", "message": "Approval timed out"}

    session.pending_approvals = [
        a for a in session.pending_approvals if a.id != request_id
    ]
    session.status = "running"
    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id,
        "status": "running",
    })
    return decision


async def run_browser_agent(
    task: str,
    browser_id: str,
    model: str,
    dashboard_id: str | None = None,
    tab_id: str = "",
    pre_selected: bool = False,
    initial_url: str | None = None,
    parent_session_id: str | None = None,
) -> dict:
    """Run a browser sub-agent loop for a single browser card.

    Creates a visible AgentSession, streams progress via WebSocket,
    and returns the full action log + summary + final screenshot.
    """
    from backend.apps.agents.agent_manager import agent_manager

    _browser_perms = load_builtin_permissions()

    session_id = uuid4().hex
    cancel_event = asyncio.Event()
    session = AgentSession(
        id=session_id,
        name=f"Browser Agent",
        model=model,
        mode="browser-agent",
        status="running",
        dashboard_id=dashboard_id,
        browser_id=browser_id,
        system_prompt=SYSTEM_PROMPT,
        parent_session_id=parent_session_id,
    )
    session._cancel_event = cancel_event
    agent_manager.sessions[session_id] = session

    # If parent was already stopped before we registered, bail immediately
    if parent_session_id:
        parent = agent_manager.sessions.get(parent_session_id)
        if parent and parent.status == "stopped":
            cancel_event.set()

    await ws_manager.send_to_session(session_id, "agent:status", {
        "session_id": session_id,
        "status": "running",
        "session": session.model_dump(mode="json"),
    })

    # Perception we prefetch on a known starting page so the model can ACT on
    # turn 1 instead of spending turns 0-2 orienting (screenshot/get_elements).
    # Pure speed: it's the same reads the agent would do anyway, just front-loaded.
    async def _perceive(label_url: str) -> tuple[str, str]:
        """Cheap list+text perception of the CURRENT page. Returns
        (front_load_block, current_url, read_records). The read_records are real
        reads that ran (so the completion-honesty gate knows content WAS read,
        even when the agent then answers a read task with zero further tools, the
        whole point of front-loading). Best-effort; never raises."""
        recs = []
        try:
            li = await execute_browser_tool("BrowserListInteractives", {}, browser_id, tab_id)
            gt = await execute_browser_tool("BrowserGetText", {}, browser_id, tab_id)
            url = li.get("url") or gt.get("url") or label_url or ""
            parts = []
            if li.get("text") and "error" not in li:
                parts.append("Interactive elements already on the page:\n" + str(li["text"]))
                recs.append({"tool": "BrowserListInteractives", "input": {}, "ok": True,
                             "result_summary": str(li["text"])[:200], "elapsed_ms": 0})
            if gt.get("text") and "error" not in gt:
                parts.append("Visible page text (truncated):\n" + str(gt["text"])[:2000])
                recs.append({"tool": "BrowserGetText", "input": {}, "ok": True,
                             "result_summary": str(gt["text"])[:200], "elapsed_ms": 0})
            block = (
                "\n\n[Page already loaded and inspected for you, act directly; "
                "no need to screenshot or list elements again unless it changes]\n"
                + "\n\n".join(parts)
            ) if parts else ""
            return block, url, recs
        except Exception as e:
            logger.debug(f"[browser-perf] perception prefetch skipped: {e}")
            return "", (label_url or ""), recs

    # current_url is the live URL of the card. When the parent delegates to an
    # EXISTING browser (no initial_url), the backend has no record of where that
    # card navigated to, so we read it here. Without it, skill replay could never
    # resolve the host on a repeat task and the whole fast path stayed dead.
    preloaded_perception = ""
    current_url = ""
    preloaded_reads: list[dict] = []  # real front-loaded reads, seeded into action_log
    _resumed = bool(browser_history._browser_history.get(browser_id))
    if initial_url:
        nav_result = await execute_browser_tool(
            "BrowserNavigate", {"url": initial_url}, browser_id, tab_id,
        )
        logger.info(f"Browser agent {session_id}: navigated to {initial_url}: {nav_result.get('text', nav_result.get('error', ''))}")
        preloaded_perception, current_url, preloaded_reads = await _perceive(initial_url)
    elif not _resumed:
        # Fresh task on an existing card: perceive the current page to learn its
        # host (for replay) and front-load turn 1 (this path used to start cold).
        preloaded_perception, current_url, preloaded_reads = await _perceive("")

    from backend.apps.settings.settings import load_settings
    from backend.apps.settings.credentials import get_anthropic_client_for_model
    from backend.apps.agents.providers.registry import (
        _find_builtin_model,
        resolve_model_id_for_sdk,
        resolve_aux_model,
    )
    browser_settings = load_settings()
    # Resolve the model string to whatever the SDK / 9Router expects.
    # When the parent session is running on a non-Claude model (e.g. gpt-5.4),
    # the browser agent inherits it and we route through 9Router's prefix.
    # Tool-use fidelity for browser-specific tools (BrowserNavigate, click,
    # type, etc.) through 9Router's claude→openai translator is UNVERIFIED , 
    # if translation is poor, the user should manually switch this session
    # back to Claude in the model picker.
    if _find_builtin_model(model) is not None:
        api_model = resolve_model_id_for_sdk(model, browser_settings)
    else:
        # Unknown model string; fall back to whatever aux model is available
        try:
            api_model, _ = await resolve_aux_model(browser_settings, preferred_tier="haiku")
        except ValueError:
            # Nothing connected at all; surface a clear error so the caller
            # (parent agent) sees it in the tool result instead of crashing
            # on a 400 from 9Router.
            session.status = "error"
            error_text = (
                "Browser agent requires an active LLM subscription. "
                "Connect Claude, Codex, or Gemini in Settings."
            )
            err_msg = Message(role="system", content=f"Error: {error_text}")
            session.messages.append(err_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": err_msg.model_dump(mode="json"),
            })
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "error",
                "session": session.model_dump(mode="json"),
            })
            return {
                "session_id": session_id,
                "browser_id": browser_id,
                "summary": f"Error: {error_text}",
                "action_log": [],
                "final_screenshot": None,
            }
    # Route the client based on the resolved model id, not just
    # connection_mode. Without this, a pinned-route value like "sonnet-cc"
    # resolves to "cc/claude-sonnet-4-6" but the old get_anthropic_client()
    # still returned an OpenSwarm-proxy client (because connection_mode was
    # openswarm-pro), which then rejected the cc/ prefix and surfaced as a
    # misleading "OpenSwarm servers are busy" error.
    client = get_anthropic_client_for_model(browser_settings, api_model)

    # Resume prior conversation on this browser if we have one cached. This
    # lets the sub-agent skip the "take a screenshot to figure out where I am"
    # cycle every time the parent issues a new task. Defensively validate
    # the cache; if it's somehow corrupted (orphaned tool_use_ids), drop
    # it and start fresh rather than crash on the next API call.
    prior_messages = browser_history._browser_history.get(browser_id) or []
    if prior_messages and not _validate_message_pairing(prior_messages):
        logger.warning(
            f"[browser-agent {session_id}] cached history for {browser_id} has "
            f"orphaned tool_use_ids; dropping cache and starting fresh"
        )
        clear_browser_history(browser_id)
        prior_messages = []
    # Front-load the prefetched perception into the first user turn so the model
    # can act immediately (only when this is a fresh conversation; a resumed one
    # already knows the page). The visible task text stays clean.
    first_user_content = task + preloaded_perception if (preloaded_perception and not prior_messages) else task
    messages: list[dict] = list(prior_messages) + [{"role": "user", "content": first_user_content}]
    # Seed with the front-loaded reads: they really ran and returned content, so a
    # read task the agent answers straight from them is NOT a "did nothing" ghost.
    action_log: list[dict] = list(preloaded_reads)
    final_screenshot: str | None = None
    metrics_started_at = time.time()  # wall-clock start for per-task timing
    last_seen_url = initial_url or current_url or ""  # host source for skill record/replay

    # Loop detection state; sliding window of recent state-mutating tool calls
    recent_tool_calls: list[tuple[str, str, str]] = []
    loop_trigger_count = 0
    card_gone_streak = 0  # consecutive "card is gone" results -> fail fast, don't spin
    route_hinted_hosts: set[str] = set()  # surface the fast network tier once per host

    # Stagnation state: busy-but-stuck detection (no URL change + failures
    # across a run of actions), distinct from the exact-repeat loop above.
    stagnation_streak = 0
    stagnation_prev_url = ""
    stagnation_prev_text = ""
    aux_adjudicated = False  # the one-shot stuck-adjudication fires at most once per run

    # Lazily-resolved cheap aux client, used only for the rare stuck-adjudication
    # call once deterministic nudging is exhausted. Provider-agnostic.
    _aux_state = {"resolved": False, "client": None, "model": None}

    async def _get_aux_client():
        if not _aux_state["resolved"]:
            _aux_state["resolved"] = True
            try:
                aux_model, _ = await resolve_aux_model(browser_settings, preferred_tier="haiku")
                _aux_state["model"] = aux_model
                _aux_state["client"] = get_anthropic_client_for_model(browser_settings, aux_model)
            except Exception as e:
                logger.warning(f"[browser-agent {session_id}] no aux model for adjudication: {e}")
        return _aux_state["client"], _aux_state["model"]

    latest_working_mem = ""  # most recent ReportProgress memory, for the tier-2 playbook distill

    # auto candidate scan: aux-read results pages so pick-a-candidate happens in
    # the same turn as the landing, not a read-then-decide pair later
    auto_scanned_urls: set[str] = set()
    dismissed_popup_urls: set[str] = set()  # interstitials auto-closed, once per URL
    recovery_attaches = 0  # recoverable errors enriched with fresh state (saves a re-list turn)
    auto_scan_count = 0
    llm_ms_total = 0
    out_tokens_total = 0  # sum of per-turn output tokens (the latency driver)
    narration_turns = 0   # turns that emitted redundant prose next to an action

    async def _scan_results(scan_for: str) -> tuple[str, int]:
        """Aux-model read of the current results page scored against the task.
        Returns (json_or_empty, elapsed_ms); fail-silent by design."""
        _t0 = time.time()
        try:
            async def _inner():
                page = await _cancellable(execute_browser_tool("BrowserGetText", {}, browser_id, tab_id))
                if not isinstance(page, dict) or page.get("error") or not page.get("text"):
                    return ""
                aux_client, aux_model = await _get_aux_client()
                return await browser_extract.extract_structured(
                    aux_client, aux_model, str(page["text"]),
                    "These are search results. Identify which result(s) match this task: "
                    f"{scan_for[:400]}\nFor each plausible candidate give its exact displayed name, "
                    "the distinguishing details shown (role, company, location, etc), and why it "
                    "does or does not match. If none clearly match, say so in `best`.",
                    {"candidates": [{"name": "", "details": "", "match": ""}], "best": ""},
                )
            out = await asyncio.wait_for(_inner(), timeout=8.0)
        except Exception:
            out = ""
        return out or "", int((time.time() - _t0) * 1000)

    # Latest goal from ReportProgress; threaded into BrowserListInteractives so
    # the frontend floats goal-matching elements to the top of the list. Seeded
    # with the task so the first listing (before any ReportProgress) is boosted.
    current_next_goal = task

    # Advisory per-domain hints: seed the system prompt with what a prior agent
    # learned about this domain (if we know the domain at start), and keep the
    # store fresh from each ReportProgress. Re-verify, never blindly trust.
    start_domain = _extract_domain(initial_url) if initial_url else None
    run_system_prompt = SYSTEM_PROMPT
    if start_domain:
        prior_note = browser_history.get_domain_note(start_domain)
        if prior_note:
            run_system_prompt = (
                SYSTEM_PROMPT
                + f"\n\n## Notes from a previous visit to {start_domain}\n"
                + "Learned last time on this site. Use it as a head start, but "
                + "re-verify since the page may have changed:\n"
                + prior_note
            )

    # Tier-2 memory: seed the DURABLE strategy playbook for this host (distilled
    # from past successful runs) so the model skips re-discovery. Advisory text,
    # re-verified by the agent, never auto-run. Keyed by full host like skills.
    pb_seeded = False  # whether tier-2 strategy was injected, for measuring its effect
    _pb_host = browser_skills.host_of(initial_url or current_url or "")
    if _pb_host:
        _pb_block = browser_playbook.format_for_prompt(_pb_host)
        if _pb_block:
            run_system_prompt = run_system_prompt + _pb_block
            pb_seeded = True

    # Prompt-caching shapes built once: system as a single cached text block,
    # and the last tool carrying the cache_control marker (Anthropic keys on the
    # trailing marker, so one marker covers the whole tool array + system).
    _cached_system = [{
        "type": "text", "text": run_system_prompt,
        "cache_control": {"type": "ephemeral"},
    }]
    _cached_tools = [dict(t) for t in browser_schema.MODEL_VISIBLE_TOOLS]
    if _cached_tools:
        _cached_tools[-1] = {**_cached_tools[-1], "cache_control": {"type": "ephemeral"}}

    user_msg = Message(role="user", content=task)
    session.messages.append(user_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": user_msg.model_dump(mode="json"),
    })

    # Perceived value, zero clicks: one calm line so the user FEELS the agent is
    # picking up where it left off, not figuring the site out cold again. Only
    # when strategy was actually seeded, so it's honest, never noise.
    if pb_seeded and _pb_host:
        session.memory_recalled = True  # drives the subtle "Remembered" card chip
        _recall_msg = Message(role="assistant",
                              content=f"Picking up what I learned about {_pb_host} from a previous visit.")
        session.messages.append(_recall_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id, "message": _recall_msg.model_dump(mode="json"),
        })
        # Push the session so the "Remembered" chip shows WHILE it works (the
        # high-value moment), not just on the finished card.
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id, "status": session.status,
            "session": session.model_dump(mode="json"),
        })

    async def _cancellable(coro):
        """Race any awaitable against the cancel event. Returns None if cancelled."""
        task = asyncio.ensure_future(coro)
        cancel_wait = asyncio.ensure_future(cancel_event.wait())
        done, pending = await asyncio.wait(
            [task, cancel_wait], return_when=asyncio.FIRST_COMPLETED,
        )
        for p in pending:
            p.cancel()
        if cancel_event.is_set():
            return None
        return task.result()

    # Skill key: prefer the USER's original request over the orchestrator's
    # reformulation. The reformulation varies run-to-run ("click the search box"
    # vs "find the search box") and that variance silently breaks exact-key
    # replay (measured: two issuances of one request produced two skills). The
    # user's words are stable across repeats. Guard: if the message carries
    # multiple quoted values, several same-host sub-tasks could collide on one
    # key, so fall back to the (differentiated) delegated task; the verify gate
    # backs this up if a key is ever too loose.
    skill_key_task = task
    if parent_session_id:
        try:
            _psess = agent_manager.get_session(parent_session_id)
            if _psess:
                for _m in reversed(_psess.messages):
                    if _m.role == "user" and isinstance(_m.content, str) and _m.content.strip():
                        _orig = _m.content.strip()
                        if len(browser_skills.template_task(_orig)[1]) <= 1:
                            skill_key_task = _orig
                        break
        except Exception:
            pass

    # --- Fast path: replay a previously-learned skill with NO LLM round-trips.
    # This is what gets a REPEAT task from ~50s (full agent loop) down to ~1s,
    # i.e. faster than a human. Robust by construction: clicks re-resolve by
    # (role,name), every step is verified, and ANY miss aborts to the full LLM
    # agent below (which re-records), so a changed page can never ghost-succeed.
    replay_attempted = False

    # set by a prefix replay; appended to the first user message so the model
    # wakes up at the composer instead of redoing the navigation
    replay_prefix_note = ""

    async def _try_replay(host: str, turns_spent: int, allow_prefix: bool = False) -> dict | None:
        """Run a learned skill for the stable task key on `host` with zero LLM
        calls. Returns a completed-result dict on full success, or None to fall
        through to the LLM agent (no skill, unfillable slots, cancel, or any step
        miss). Updates skill trust on every attempt. Used at dispatch AND, when
        the card started on the wrong host, again after the first navigation
        lands us somewhere a skill exists (the deferred re-check). With
        allow_prefix, a send-gated skill replays its safe navigation prefix
        mechanically and hands the live agent just the irreversible tail."""
        nonlocal final_screenshot, last_seen_url, replay_attempted, replay_prefix_note
        if not host:
            return None

        async def _exec_step(step: dict) -> dict | None:
            """One replay step; settle on the click target first so a recorded
            click never fires before the page paints it (the premature-click miss
            that quarantined skills), then an off-screen click gets one
            scroll-and-retry (recorded elements often sit below the fold)."""
            _settle = browser_skills.replay_settle_target(step)
            if _settle:
                async def _w(t, p, b, tid):
                    return await _cancellable(execute_browser_tool(t, p, b, tid))
                await browser_wait.smart_wait(_w, browser_id, tab_id, 1500, until=_settle)
            res = await _cancellable(execute_browser_tool(step["tool"], step.get("params", {}), browser_id, tab_id))
            if res is not None and "box model" in str(res.get("error", "")):
                logger.info(f"[browser-skills] replay step off-screen ({step['tool']}); scrolling and retrying once")
                await _cancellable(execute_browser_tool("BrowserScroll", {"direction": "down"}, browser_id, tab_id))
                retry = await _cancellable(execute_browser_tool(step["tool"], step.get("params", {}), browser_id, tab_id))
                if retry is not None:
                    return retry
            return res

        sk_obj = browser_skills.find_skill(host, skill_key_task)
        steps = browser_skills.rehydrate(sk_obj, skill_key_task) if sk_obj else None
        if sk_obj and not steps:
            logger.info(f"[browser-skills] skill matched on {host} but slots unfillable from task; running full agent")
            return None
        if not (sk_obj and steps):
            logger.info(f"[browser-skills] no skill for host={host!r} after {turns_spent} turn(s)")
            return None
        # Audit finding: replay bypasses the per-tool gate and act-and-confirm,
        # so a recorded Send/Submit must never re-fire silently. Those flows
        # always run the live agent, which confirms before anything outward.
        unsafe_i, why = browser_skills.first_unsafe_step(steps)
        if unsafe_i >= 0:
            if not (allow_prefix and _PREFIX_REPLAY_ENABLED and unsafe_i >= 1):
                logger.info(f"[browser-skills] skill on {host} not replayed: {why}; running the full agent so the send is confirmed")
                return None
            prefix = steps[:unsafe_i]
            logger.info(
                f"[browser-skills] PREFIX replay: {len(prefix)}/{len(steps)} steps on {host}, "
                f"live agent confirms the tail ({why})"
            )
            _pst = time.time()
            for step in prefix:
                if cancel_event.is_set():
                    return None
                st = time.time()
                res = await _exec_step(step)
                if res is None:
                    return None
                el_ms = int((time.time() - st) * 1000)
                step_ok = "error" not in res
                browser_metrics.record_tool(
                    session_id, browser_id, -1, step["tool"], el_ms,
                    ok=step_ok, error=res.get("error", ""), is_loop=False,
                    stagnation_streak=0, result_len=len(str(res.get("text") or res.get("error") or "")),
                )
                logger.info(f"[browser-skills] prefix step {step['tool']} ok={step_ok} in {el_ms}ms")
                if not step_ok:
                    verdict = browser_skills.mark_replay_failed(host, skill_key_task)
                    logger.info(
                        f"[browser-skills] prefix step failed ({step['tool']}: {res.get('error')}); "
                        f"full agent from scratch (trust verdict: {verdict})"
                    )
                    return None
                if res.get("url"):
                    last_seen_url = res["url"]
            replay_attempted = True
            _fresh = ""
            try:
                lst = await execute_browser_tool("BrowserListInteractives", {}, browser_id, tab_id)
                if isinstance(lst, dict) and lst.get("text") and "error" not in lst:
                    _fresh = f"\nCurrent page state after the replayed prefix:\n{_truncate_state(lst['text'])}"
            except Exception:
                pass
            remaining = "; ".join(f"{s['tool']}({str(s.get('params', {}))[:80]})" for s in steps[unsafe_i:])
            replay_prefix_note = (
                f"\n\n[skill prefix replayed] A learned skill for this exact task already performed its "
                f"first {len(prefix)} step(s) mechanically in {int((time.time() - _pst) * 1000)}ms; the page is now at "
                f"{last_seen_url or 'the prepared state'}. Recorded remaining step(s) for reference: {remaining}. "
                f"Finish from HERE (do not redo the navigation), and confirm the irreversible step with "
                f"expect proof as usual.{_fresh}"
            )
            logger.info(f"[browser-skills] prefix handoff note attached ({len(replay_prefix_note)}ch)")
            return None
        replay_attempted = True
        logger.info(f"[browser-skills] REPLAY attempt: {len(steps)} steps on {host} (after {turns_spent} LLM turn(s))")
        rlog: list[dict] = []
        ok = True
        for step in steps:
            if cancel_event.is_set():
                return None
            st = time.time()
            res = await _exec_step(step)
            if res is None:
                return None
            el_ms = int((time.time() - st) * 1000)
            step_ok = "error" not in res
            rlog.append({
                "tool": step["tool"], "input": step.get("params", {}),
                "result_summary": str(res.get("text", res.get("error", "")))[:200],
                "elapsed_ms": el_ms, "ok": step_ok,
            })
            browser_metrics.record_tool(
                session_id, browser_id, -1, step["tool"], el_ms,
                ok=step_ok, error=res.get("error", ""), is_loop=False,
                stagnation_streak=0, result_len=len(str(res.get("text") or res.get("error") or "")),
            )
            if not step_ok:
                logger.info(f"[browser-skills] replay step failed ({step['tool']}: {res.get('error')}), falling back to full agent")
                ok = False
                break
            if res.get("url"):
                last_seen_url = res["url"]
        if ok and rlog:
            browser_skills.mark_replay_succeeded(host, skill_key_task)
            summary = browser_metrics.record_task(
                session_id, browser_id, task, "completed", metrics_started_at,
                turns_spent, rlog, session.tokens,
                path="replay", task_sig=browser_skills._sig(skill_key_task),
            )
            logger.info(f"[browser-skills] REPLAY SUCCEEDED in {summary['total_ms']}ms ({turns_spent} LLM turn(s))")
            try:
                ss = await execute_browser_tool("BrowserScreenshot", {}, browser_id, tab_id)
                if ss.get("image"):
                    final_screenshot = ss["image"]
            except Exception:
                pass
            session.status = "completed"
            agent_manager._sync_session_close(session)
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id, "status": "completed",
                "session": session.model_dump(mode="json"),
            })
            return {
                "session_id": session_id, "browser_id": browser_id,
                "summary": f"Completed via learned skill replay ({len(steps)} steps, no LLM).",
                "action_log": rlog, "final_screenshot": final_screenshot,
                "replayed": True,
            }
        # Replay didn't fully succeed. Update the skill's trust: an unproven skill
        # that failed gets quarantined (never replayed again -> pure-LLM baseline),
        # a proven one tolerates a transient miss. The full agent re-records edit-
        # aware (new steps -> new rev).
        if not cancel_event.is_set():
            verdict = browser_skills.mark_replay_failed(host, skill_key_task)
            logger.info(f"[browser-skills] replay fell back to full agent (trust verdict: {verdict})")
        return None

    replay_host = browser_skills.host_of(initial_url) if initial_url else ""
    if not replay_host and current_url:
        replay_host = browser_skills.host_of(current_url)  # live URL of an existing card
    if not replay_host:
        m = re.search(r"https?://\S+", task)
        if m:
            replay_host = browser_skills.host_of(m.group(0))
    # The card might have started on the WRONG host (the orchestrator often opens
    # a fresh card on google and only navigates to the target later); if so, this
    # dispatch check misses and the deferred re-check inside the loop catches it
    # after the first navigation.
    replay_rechecked = False
    logger.info(f"[browser-skills] dispatch replay check: host={replay_host!r}")
    _dispatch_replay = await _try_replay(replay_host, 0, allow_prefix=True)
    if _dispatch_replay is not None:
        return _dispatch_replay
    if replay_prefix_note:
        messages[-1]["content"] = f"{messages[-1]['content']}{replay_prefix_note}"

    # Route hint: replay declined (send-gated, no exact key, or different
    # wording), but a similar verified route may exist; hand it to the model as
    # advisory text so it follows a known path instead of re-exploring.
    route_hint_keys: list[tuple] = []
    if not replay_prefix_note:
        _h_skill, _h_score = browser_skills.find_similar_skill(replay_host, skill_key_task)
        if _h_skill:
            _hint, route_hint_keys = browser_skills.render_route_hint(_h_skill, skill_key_task, _h_score)
            if _hint:
                messages[-1]["content"] = f"{messages[-1]['content']}{_hint}"
                logger.info(
                    f"[browser-route {session_id}] hint attached at dispatch: host={replay_host} "
                    f"sim={_h_score:.2f} steps={len(route_hint_keys)} state={_h_skill.get('state')}"
                )

    # Pre-nav landed on a results page (the cold entry case): scan it NOW so the
    # model's very first turn can pick a candidate instead of read-then-decide.
    _start_url = (current_url or initial_url or "").split("#")[0]
    if _start_url and _RESULTS_URL_RE.search(_start_url):
        auto_scanned_urls.add(_start_url)
        _scan_json, _sc_ms = await _scan_results(task)
        if _scan_json:
            auto_scan_count += 1
            messages[-1]["content"] = (
                f"{messages[-1]['content']}\n\n[auto candidate scan] An assistant model read "
                f"this results page against the task:\n{_scan_json}\n"
                "Treat it as a hint; verify on the page before acting."
            )
            action_log.append({
                "tool": "BrowserExtract", "input": {"instruction": "(auto candidate scan)"},
                "result_summary": _scan_json[:200], "elapsed_ms": _sc_ms, "ok": True,
            })
            logger.info(
                f"[browser-cold {session_id}] dispatch candidate scan on {_start_url[:90]} "
                f"in {_sc_ms}ms ({len(_scan_json)}ch)"
            )
        else:
            logger.info(
                f"[browser-cold {session_id}] dispatch candidate scan empty on "
                f"{_start_url[:90]} after {_sc_ms}ms"
            )

    text_parts = []  # initialized before loop so post-loop summary (line ~1294) has a default
    # Circuit breaker for ReportProgress violations. Some models get stuck
    # in a loop where they keep calling action tools without the brain-
    # state preamble. Each iteration of this loop pumps websocket events
    # to the frontend, which fans out to every useSelector subscriber and
    # tanks UI responsiveness. After N consecutive violations the agent
    # gives up and surfaces an error instead of churning through all
    # MAX_TURNS doing the same broken thing.
    consecutive_violations = 0
    MAX_CONSECUTIVE_VIOLATIONS = 3
    # rows already shown to the model; attached state shrinks to the delta
    attached_state_seen: set[str] = set()
    # under-batching telemetry + nudge state
    single_action_streak = 0
    batching_nudges = 0
    redundant_read_nudges = 0
    # True after a mutating action attaches fresh state; a solo read next is waste
    fresh_state_pending = False
    multi_action_turns = 0
    batch_calls = 0
    batch_guard_blocks = 0
    try:
        for turn in range(MAX_TURNS):
            if cancel_event.is_set():
                break

            # Drop stale screenshots before each call: keep first + previous +
            # current, stub the rest. Images are ~1.3-2k tokens each and get
            # re-read every turn, so this is the biggest per-turn context win on
            # any visual task (measured ~2.9x fewer image tokens, ~5x less upload).
            browser_history.prune_old_screenshots(messages)
            browser_history.prune_stale_page_state(messages)
            browser_history.place_cache_marker(messages)
            _llm_t0 = time.monotonic()
            response = await _cancellable(client.messages.create(
                model=api_model,
                max_tokens=4096,
                # Cache the ~4k-token fixed prefix (system + tool schema) so it's
                # reprocessed once, not on every turn: big TTFT + cost win on the
                # first run, which is dominated by turns x per-turn prefill. The
                # trailing cache_control marker is what Anthropic keys on; on
                # non-Anthropic routes (9router) the marker is harmlessly ignored.
                system=_cached_system,
                tools=_cached_tools,
                messages=messages,
            ))
            if response is None:
                break
            _llm_ms = int((time.monotonic() - _llm_t0) * 1000)
            llm_ms_total += _llm_ms
            # Guard against empty content (e.g. upstream API error from
            # 9Router that the SDK parsed into a partial response object).
            if not response.content:
                logger.warning(f"Browser agent {session_id}: empty response content from {api_model}")
                break

            # Track token usage from browser agent API calls
            if hasattr(response, 'usage') and response.usage:
                _out = response.usage.output_tokens or 0
                _in = response.usage.input_tokens or 0
                out_tokens_total += _out
                session.tokens["input"] = session.tokens.get("input", 0) + _in
                session.tokens["output"] = session.tokens.get("output", 0) + _out
                _cr = getattr(response.usage, "cache_read_input_tokens", 0) or 0
                _cw = getattr(response.usage, "cache_creation_input_tokens", 0) or 0
                if _cr:
                    session.tokens["cache_read"] = session.tokens.get("cache_read", 0) + _cr
                # Per-turn OUTPUT tokens are the latency driver (generation is serial,
                # input is cached), so log every turn: this is how we verify the plan-
                # once/terse-execution prompt actually shrinks per-turn output live.
                logger.info(f"[browser-tokens] turn={turn} out={_out} in={_in} cache_read={_cr} cache_write={_cw} llm_ms={_llm_ms}")

            assistant_content = []
            text_parts = []
            tool_uses = []

            for block in response.content:
                if block.type == "text":
                    text_parts.append(block.text)
                    assistant_content.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    tool_uses.append(block)
                    assistant_content.append({
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    })

            # think-shorter telemetry: a turn that emits BOTH prose and an action
            # tool is the redundant narration the prompt now forbids; count it so
            # the bench can verify the prose actually went away.
            if any(t.strip() for t in text_parts) and any(
                tu.name in _ACTION_TOOLS_REQUIRING_REPORT for tu in tool_uses
            ):
                narration_turns += 1

            if text_parts:
                asst_msg = Message(
                    role="assistant",
                    content="\n".join(text_parts),
                )
                session.messages.append(asst_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": asst_msg.model_dump(mode="json"),
                })

            for tu in tool_uses:
                tool_msg = Message(
                    role="tool_call",
                    content={"id": tu.id, "tool": tu.name, "input": tu.input},
                )
                session.messages.append(tool_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": tool_msg.model_dump(mode="json"),
                })

            messages.append({"role": "assistant", "content": assistant_content})

            if response.stop_reason != "tool_use":
                break

            tool_results = []
            cancelled = False

            # Sort tool_uses so ReportProgress is always processed first within
            # a turn, even if the model emits it after action tools. This way
            # the brain state is recorded before any actions execute.
            has_report_progress = any(tu.name == "ReportProgress" for tu in tool_uses)
            has_action_tools = any(
                tu.name in _ACTION_TOOLS_REQUIRING_REPORT for tu in tool_uses
            )
            # Violation: action tools without ReportProgress in the same turn.
            # The model MUST articulate its evaluation/memory/goal before acting.
            report_progress_violation = has_action_tools and not has_report_progress
            if report_progress_violation:
                consecutive_violations += 1
                logger.warning(
                    f"[browser-agent {session_id}] ReportProgress violation "
                    f"({consecutive_violations}/{MAX_CONSECUTIVE_VIOLATIONS}): "
                    f"action tools called without brain state"
                )
                if consecutive_violations >= MAX_CONSECUTIVE_VIOLATIONS:
                    logger.error(
                        f"[browser-agent {session_id}] hit "
                        f"{MAX_CONSECUTIVE_VIOLATIONS} consecutive ReportProgress "
                        f"violations; aborting to prevent runaway loop"
                    )
                    # Surface a user-visible error message so the frontend
                    # shows something coherent instead of just stopping.
                    err_msg = Message(
                        role="assistant",
                        content=(
                            "I got stuck repeating the same action without "
                            "thinking it through. Stopping here so I don't "
                            "loop. Feel free to ask me to try again."
                        ),
                    )
                    session.messages.append(err_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": err_msg.model_dump(mode="json"),
                    })
                    break
            else:
                # Reset on a clean turn; only CONSECUTIVE violations
                # count toward the limit. A single bad turn followed by
                # a good one shouldn't kill the agent.
                consecutive_violations = 0
            # Stable sort: ReportProgress first, then everything else in order.
            tool_uses_sorted = sorted(
                tool_uses,
                key=lambda t: 0 if t.name == "ReportProgress" else 1,
            )

            # Under-batching detector: the model ignores prompt-level batching
            # invitations, so measure each turn and nudge mechanically below.
            _turn_actions = sum(1 for t in tool_uses_sorted if t.name in _BATCHABLE_ACTION_TOOLS)
            _turn_has_batch = any(t.name in ("BrowserBatch", "BrowserRepeatFlow") for t in tool_uses_sorted)
            if _turn_actions >= 2 or _turn_has_batch:
                multi_action_turns += 1
                single_action_streak = 0
                if _turn_has_batch:
                    batch_calls += 1
            elif _turn_actions == 1:
                single_action_streak += 1
            logger.info(
                f"[browser-batching {session_id}] turn={turn} actions={_turn_actions} "
                f"batch={_turn_has_batch} streak={single_action_streak}"
            )

            for tu in tool_uses_sorted:
                if cancel_event.is_set():
                    cancelled = True
                    break

                # Handle ReportProgress; no-op execution that just records the
                # model's brain state and streams it to the dashboard.
                if tu.name == "ReportProgress":
                    eval_prev = tu.input.get("evaluation_previous", "")
                    working_mem = tu.input.get("working_memory", "")
                    next_goal = tu.input.get("next_goal", "")
                    if next_goal:
                        current_next_goal = next_goal
                    if working_mem:
                        latest_working_mem = working_mem  # for the tier-2 playbook distill at the end
                    # Distill the agent's own working memory into a per-domain
                    # hint for the next visit. Only persist when the run stayed
                    # on a SINGLE apex domain: working_memory is cumulative, so
                    # on a multi-domain run it would describe one site but get
                    # filed under whichever domain happens to be current.
                    note_domain = (
                        session.browser_domains[-1]
                        if session.browser_domains
                        else start_domain
                    )
                    single_domain = len(set(session.browser_domains)) <= 1
                    if note_domain and working_mem and single_domain:
                        browser_history.set_domain_note(note_domain, working_mem)
                    brain_text = (
                        f"📋 **Plan**\n"
                        + (f"_Previous_: {eval_prev}\n" if eval_prev else "")
                        + f"_Memory_: {working_mem}\n"
                        f"_Next_: {next_goal}"
                    )
                    brain_msg = Message(role="assistant", content=brain_text)
                    session.messages.append(brain_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": brain_msg.model_dump(mode="json"),
                    })
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": "Progress recorded."}],
                    })
                    continue

                # Reject action tools when ReportProgress is missing this turn.
                # We MUST still emit a tool_result for every tool_use_id or the
                # next API request 400s.
                if (
                    report_progress_violation
                    and tu.name in _ACTION_TOOLS_REQUIRING_REPORT
                ):
                    rejection_text = (
                        "REJECTED: You called an action tool without first calling "
                        "ReportProgress in the same turn. ReportProgress is REQUIRED "
                        "before every batch of action tools; it's how you reflect "
                        "on what just happened and articulate your next goal. Try "
                        "again: emit ReportProgress and your action tool(s) in the "
                        "same response."
                    )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": rejection_text}],
                        "is_error": True,
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={
                            "text": rejection_text,
                            "tool_name": tu.name,
                            "elapsed_ms": 0,
                        },
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Skill self-awareness (backend-inline; the skill store is here,
                # not in the webview). The agent can inspect what shortcuts it has
                # for this site and prune stale ones. Kept off the LLM context by
                # default (it's a tool the agent calls only when it wants).
                if tu.name in ("BrowserListSkills", "BrowserDeprecateSkill"):
                    cur_host = browser_skills.host_of(last_seen_url) or replay_host
                    if tu.name == "BrowserListSkills":
                        skills = browser_skills.list_skills(cur_host) if cur_host else []
                        playbook = browser_playbook.get_playbook(cur_host) if cur_host else []
                        parts = []
                        if skills:
                            _tag = {"trusted": "proven", "probation": "unproven", "quarantine": "disabled"}
                            def _fmt_skill(s):
                                line = f"- \"{s['task']}\" ({s['steps']} steps, {_tag.get(s['state'], s['state'])}, reused {s['replays']}x"
                                if s.get("builds_on"):
                                    line += f", builds on {len(s['builds_on'])} other shortcut(s)"
                                return line + ")"
                            parts.append(f"Learned shortcuts for {cur_host}:\n" + "\n".join(_fmt_skill(s) for s in skills[:20]))
                        if playbook:
                            parts.append(f"Strategy I've learned about {cur_host}:\n" + "\n".join(f"- {b}" for b in playbook))
                        meta_text = "\n\n".join(parts) if parts else f"Nothing learned for {cur_host or 'this site'} yet."
                    else:
                        target = tu.input.get("task", "")
                        ok = browser_skills.deprecate_skill(cur_host, target) if cur_host else False
                        meta_text = (f"Removed the stale shortcut \"{target}\"; it'll be re-learned next time you do it."
                                     if ok else f"No matching shortcut \"{target}\" found to remove.")
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": meta_text}]})
                    result_msg = Message(role="tool_result", content={"text": meta_text, "tool_name": tu.name, "elapsed_ms": 0})
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Schema extract (backend-inline): the aux model reads the page
                # text so the main model gets just the JSON it asked for, never
                # the 15k raw chars. Read-only; falls back honest on any miss.
                if tu.name == "BrowserExtract":
                    instruction = str(tu.input.get("instruction", "")).strip()
                    st = time.time()
                    ex_ok = False
                    if not instruction:
                        ex_text = "BrowserExtract needs an instruction saying what to pull from the page."
                    else:
                        page = await _cancellable(execute_browser_tool("BrowserGetText", {}, browser_id, tab_id))
                        if page is None:
                            ex_text = "Cancelled."
                        elif page.get("error"):
                            ex_text = f"Could not read the page: {page['error']}"
                        else:
                            if page.get("url"):
                                last_seen_url = page["url"]
                            aux_client, aux_model = await _get_aux_client()
                            data = await browser_extract.extract_structured(
                                aux_client, aux_model, str(page.get("text", "")),
                                instruction, tu.input.get("schema"),
                            )
                            ex_text = data or (
                                "Extraction unavailable right now; use BrowserGetText and read the page yourself."
                            )
                            ex_ok = bool(data)
                    # every attempt is logged (the completion gate cross-examines
                    # this; a successful extract IS the productive read of a task)
                    action_log.append({
                        "tool": "BrowserExtract", "input": {"instruction": instruction[:200]},
                        "result_summary": ex_text[:200],
                        "elapsed_ms": int((time.time() - st) * 1000), "ok": ex_ok,
                    })
                    browser_metrics.record_tool(
                        session_id, browser_id, turn, "BrowserExtract",
                        int((time.time() - st) * 1000), ok=ex_ok,
                        error="" if ex_ok else ex_text[:160], is_loop=False,
                        stagnation_streak=0, result_len=len(ex_text),
                    )
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": ex_text}]})
                    result_msg = Message(role="tool_result", content={"text": ex_text, "tool_name": tu.name, "elapsed_ms": 0})
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Intra-run batch replay: run a learned mechanical flow for many
                # inputs at machine speed, verify every step, gate sends, never
                # ghost. Reads/searches loop freely; irreversible steps refuse.
                if tu.name == "BrowserRepeatFlow":
                    steps_tmpl = tu.input.get("steps") or []
                    values = [str(v) for v in (tu.input.get("values") or [])]
                    ok_struct, why = browser_batch_replay.validate_template(steps_tmpl)
                    safe, safe_why = (browser_batch_replay.template_safety(steps_tmpl) if ok_struct else (False, why))
                    if not ok_struct:
                        bf_text = f"Couldn't run the batch: {why}."
                    elif not safe:
                        bf_text = (f"Refused to auto-repeat this flow: {safe_why}. "
                                   "Do those steps one at a time so each is confirmed.")
                    elif not values:
                        bf_text = "No values to repeat; nothing to do."
                    else:
                        records = []  # {value, ok, text} per item, for the data return
                        for val in values:
                            if cancel_event.is_set():
                                break
                            item_ok = True
                            item_text = ""
                            for tool_name, params in browser_batch_replay.fill_template(steps_tmpl, val):
                                st = time.time()
                                res = await _cancellable(execute_browser_tool(tool_name, params, browser_id, tab_id))
                                if res is None:
                                    item_ok = False; item_text = "cancelled"; break
                                el = int((time.time() - st) * 1000)
                                step_ok = "error" not in res
                                # carry each step's output; the LAST read step's text is
                                # the data the agent wanted from this item.
                                if step_ok and res.get("text"):
                                    item_text = str(res["text"])
                                action_log.append({
                                    "tool": tool_name, "input": params,
                                    "result_summary": str(res.get("text", res.get("error", "")))[:200],
                                    "elapsed_ms": el, "ok": step_ok,
                                })
                                browser_metrics.record_tool(
                                    session_id, browser_id, turn, tool_name, el, ok=step_ok,
                                    error=res.get("error", ""), is_loop=False, stagnation_streak=0,
                                    result_len=len(str(res.get("text") or res.get("error") or "")),
                                )
                                if res.get("url"):
                                    last_seen_url = res["url"]
                                if not step_ok:
                                    item_ok = False
                                    item_text = str(res.get("error") or "did not match the template")
                                    break
                            records.append({"value": val, "ok": item_ok, "text": item_text})
                        bf_text = browser_batch_replay.summarize_batch(
                            records, browser_batch_replay.is_readonly_template(steps_tmpl),
                        )
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": bf_text}]})
                    result_msg = Message(role="tool_result", content={"text": bf_text, "tool_name": tu.name, "elapsed_ms": 0})
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Handle RequestHumanIntervention; pause and wait for user
                if tu.name == "RequestHumanIntervention":
                    problem = tu.input.get("problem", "")
                    instruction = tu.input.get("instruction", "")
                    decision = await _request_browser_approval(
                        session, tu.name, {"problem": problem, "instruction": instruction},
                    )
                    if decision.get("behavior") != "deny":
                        result_text = "User resolved the issue. Continue with the task."
                    else:
                        user_message = decision.get("message", "").strip()
                        if user_message and user_message != "Skipped by user":
                            result_text = f"User skipped this intervention and said: \"{user_message}\"\nAddress what the user said and adapt your approach accordingly."
                        else:
                            result_text = "User skipped this intervention. Try a different approach or move on."
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": result_text}],
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={"text": result_text, "tool_name": tu.name, "elapsed_ms": 0},
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                policy = _browser_perms.get(tu.name, "always_allow")

                if policy == "deny":
                    denied_text = f"Tool {tu.name} is denied by permission policy."
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": denied_text}],
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={"text": denied_text, "tool_name": tu.name, "elapsed_ms": 0},
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                if policy == "ask":
                    decision = await _request_browser_approval(
                        session, tu.name, tu.input,
                    )
                    if decision.get("behavior") == "deny":
                        denied_text = decision.get("message") or f"Tool {tu.name} denied by user."
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tu.id,
                            "content": [{"type": "text", "text": denied_text}],
                        })
                        result_msg = Message(
                            role="tool_result",
                            content={"text": denied_text, "tool_name": tu.name, "elapsed_ms": 0},
                        )
                        session.messages.append(result_msg)
                        await ws_manager.send_to_session(session_id, "agent:message", {
                            "session_id": session_id,
                            "message": result_msg.model_dump(mode="json"),
                        })
                        continue

                start = time.time()
                # did the PREVIOUS action already hand us fresh page state? a solo
                # re-read now is a wasted round-trip; remembered before we overwrite it
                _had_fresh_state = fresh_state_pending
                tool_input = tu.input
                if tu.name == "BrowserListInteractives" and current_next_goal:
                    tool_input = {**tu.input, "goal": current_next_goal}

                async def _wait_exec(tool, params, bid, tid):
                    return await _cancellable(execute_browser_tool(tool, params, bid, tid))

                # Hard send-guard: an irreversible step physically cannot ride in a
                # batch (the solo-send rule was prompt-only before; prompts drift).
                _guard_why = (browser_batch_replay.live_batch_guard(
                    (tool_input or {}).get("actions"), attached_state_seen,
                    composer_pending=bool(browser_batch_replay.send_payload_from_log(action_log)))
                    if tu.name == "BrowserBatch" else "")
                if _guard_why:
                    batch_guard_blocks += 1
                    logger.info(
                        f"[browser-batch-guard {session_id}] blocked batch at turn {turn}: {_guard_why}"
                    )
                    result = {"error": (
                        f"BATCH BLOCKED, nothing was executed: {_guard_why}. Irreversible "
                        "steps (Send/Submit/Pay/Post/Connect class) never ride in a batch: "
                        "do that step SOLO with BrowserClickIndex + `expect` proof, and "
                        "batch only the routine steps around it."
                    )}
                elif tu.name == "BrowserWait":
                    # Smart wait: return as soon as the page is ready (target or DOM
                    # settle), not on a blind timer (the audit's 42%-of-time hog).
                    result = await browser_wait.smart_wait(
                        _wait_exec, browser_id, tab_id, tu.input.get("milliseconds"),
                        until=(tu.input.get("until") or ""),
                    )
                else:
                    result = await _cancellable(execute_browser_tool(
                        tu.name, tool_input, browser_id, tab_id,
                    ))
                if result is None:
                    cancelled = True
                    break
                elapsed_ms = int((time.time() - start) * 1000)

                # Act-and-confirm: if the agent declared the change it expects, VERIFY
                # it actually happened, success is observed, never assumed. A hit returns
                # fast (act + confirm in one turn); a miss is a clear "may not have worked"
                # (and a wedge surfaces as a clean not-confirmed, not a blind 20s timeout),
                # so the agent never claims a success it didn't see or re-fires blindly.
                _expect = (str(tu.input.get("expect") or "").strip()
                           if isinstance(tu.input, dict) else "")
                if _expect and "error" not in result and tu.name in _CONFIRM_TOOLS:
                    _conf = await browser_wait.smart_wait(_wait_exec, browser_id, tab_id, 3500, until=_expect)
                    if isinstance(_conf, dict):
                        result["confirmed"] = bool(_conf.get("found"))
                        if _conf.get("found"):
                            result["text"] = f"{result.get('text') or ''}\nConfirmed: '{_expect}' is now present."
                        else:
                            result["text"] = (
                                f"{result.get('text') or ''}\nNOT confirmed: '{_expect}' did not appear within "
                                f"{_conf.get('waited_ms')}ms. This only means that exact text was not found on "
                                "the page; if this result already contains direct evidence (e.g. 'Verified: the "
                                "box now contains ...'), TRUST THAT and do not redo the action. Otherwise check "
                                "the page before assuming success, and never re-fire an irreversible action "
                                "(Send/Submit/Pay/Post) without first verifying the previous one did not go through."
                            )

                action_log.append({
                    "tool": tu.name,
                    "input": tu.input,
                    "result_summary": result.get("text", result.get("error", ""))[:200],
                    "elapsed_ms": elapsed_ms,
                    # carried so a successful run distills into a replayable skill
                    "ok": "error" not in result,
                    "clicked_role": result.get("clickedRole"),
                    "clicked_name": result.get("clickedName"),
                    # per-sub click identities, aligned by index, so a batched
                    # click_index can distill into a replayable ClickByName
                    "sub_results": [
                        {"index": r.get("index"), "ok": "error" not in r,
                         "clicked_role": r.get("clickedRole"), "clicked_name": r.get("clickedName")}
                        for r in (result.get("results") or [])
                    ] if tu.name == "BrowserBatch" else None,
                })
                if result.get("url"):
                    last_seen_url = result["url"]
                card_gone_streak = card_gone_streak + 1 if card_is_unavailable(result) else 0

                # Error-recovery: the action MISSED (stale index, occlusion, off
                # screen) but the page is alive. The model would otherwise spend a
                # whole turn re-listing to see what happened; attach the CURRENT
                # element list to the error so it re-acts next turn instead. Pure
                # state enrichment, the action is NEVER retried (no double-send risk).
                if "error" in result and card_gone_streak == 0 and recoverable_tool_error(result.get("error", "")):
                    try:
                        _rl = await asyncio.wait_for(
                            _wait_exec("BrowserListInteractives",
                                       {"goal": current_next_goal} if current_next_goal else {},
                                       browser_id, tab_id), timeout=5.0)
                        if isinstance(_rl, dict) and _rl.get("text") and "error" not in _rl:
                            attached_state_seen.clear()
                            attached_state_seen.update(
                                l for l in str(_rl["text"]).splitlines() if l.startswith("["))
                            result["text"] = (f"{result.get('error')}\n\n[recovery] That action did not "
                                              f"take effect, but the page is live. Current elements (re-act "
                                              f"from HERE, do not just retry the old index):\n"
                                              f"{_truncate_state(str(_rl['text']))}")
                            recovery_attaches += 1
                            logger.info(f"[browser-recovery {session_id}] attached fresh state after "
                                        f"recoverable error at turn {turn}: {str(result.get('error'))[:60]}")
                    except Exception:
                        pass

                # a direct full list resets the delta baseline to what the model just saw
                if tu.name == "BrowserListInteractives" and "error" not in result:
                    attached_state_seen.clear()
                    attached_state_seen.update(
                        l for l in str(result.get("text") or "").splitlines() if l.startswith("[")
                    )
                _auto_state = await _post_action_state(
                    tu.name, tu.input, result, browser_id, tab_id, _wait_exec, current_next_goal,
                    seen_lines=attached_state_seen,
                )
                if _auto_state:
                    result["text"] = f"{result.get('text') or ''}{_auto_state}"
                    # a mutation attached fresh state; it stays "available" through
                    # intervening reads (Wait/Extract don't invalidate it), so a
                    # later solo re-list is still caught as redundant.
                    fresh_state_pending = True

                # Auto-dismiss a blocking junk popup (cookie wall / upsell /
                # coachmark) before it costs the model a turn. Mechanical, once
                # per URL, only on the tight throwaway-dismiss vocabulary that
                # never sits on a task-needed control, so it can't close anything
                # required. After closing, re-list so the model sees the page beneath.
                if tu.name in _AUTO_STATE_TOOLS and "error" not in result:
                    _pop_url = (result.get("url") or last_seen_url or "").split("#")[0]
                    if _pop_url and _pop_url not in dismissed_popup_urls:
                        _close = interstitial_dismiss_target("\n".join(attached_state_seen))
                        if _close:
                            dismissed_popup_urls.add(_pop_url)
                            _dres = await _cancellable(execute_browser_tool(
                                "BrowserClickByName", {"name": _close}, browser_id, tab_id))
                            _dok = isinstance(_dres, dict) and "error" not in _dres
                            logger.info(f"[browser-popup {session_id}] auto-dismissed '{_close}' "
                                        f"ok={_dok} on {_pop_url[:80]}")
                            if _dok:
                                _fresh = await _post_action_state(
                                    "BrowserClickByName", {}, _dres or {}, browser_id, tab_id,
                                    _wait_exec, current_next_goal, seen_lines=attached_state_seen)
                                result["text"] = (f"{result.get('text') or ''}\n\n[auto] Closed a blocking "
                                                  f"popup ('{_close}'); the page beneath is now active.{_fresh}")

                # Auto candidate scan: landing on a results-shaped page normally
                # costs a read-then-decide turn pair; the cheap aux model reads it
                # now so the pick happens on this same turn. Capped, per-URL,
                # fail-silent (a miss just means the old two-turn dance).
                if (tu.name in _AUTO_STATE_TOOLS and "error" not in result
                        and auto_scan_count < _AUTO_SCAN_MAX_PER_RUN):
                    _scan_url = (result.get("url") or last_seen_url or "").split("#")[0]
                    if _scan_url and _scan_url not in auto_scanned_urls and _RESULTS_URL_RE.search(_scan_url):
                        auto_scanned_urls.add(_scan_url)
                        _scan_json, _sc_ms = await _scan_results(task)
                        if _scan_json:
                            auto_scan_count += 1
                            result["text"] = (
                                f"{result.get('text') or ''}\n\n[auto candidate scan] An assistant model read "
                                f"this results page against the task:\n{_scan_json}\n"
                                "Treat it as a hint; verify on the page before acting."
                            )
                            action_log.append({
                                "tool": "BrowserExtract", "input": {"instruction": "(auto candidate scan)"},
                                "result_summary": _scan_json[:200], "elapsed_ms": _sc_ms, "ok": True,
                            })
                            browser_metrics.record_tool(
                                session_id, browser_id, turn, "BrowserExtract", _sc_ms, ok=True,
                                error="", is_loop=False, stagnation_streak=0, result_len=len(_scan_json),
                            )
                            logger.info(
                                f"[browser-cold {session_id}] auto candidate scan on {_scan_url[:90]} "
                                f"in {_sc_ms}ms ({len(_scan_json)}ch)"
                            )
                        else:
                            logger.info(
                                f"[browser-cold {session_id}] auto candidate scan empty on "
                                f"{_scan_url[:90]} after {_sc_ms}ms"
                            )

                # Deferred replay re-check: the orchestrator often opens a fresh
                # card on the wrong host, so the dispatch-time replay missed. Once
                # a navigation lands us on a host that DOES have a matching skill,
                # and nothing has dirtied the page yet, switch to replay (still
                # verified per-step, still trust-gated). Fires at most once.
                if (not replay_rechecked and tu.name == "BrowserNavigate"
                        and replay_recheck_is_safe(action_log)):
                    cur_host = browser_skills.host_of(last_seen_url)
                    if cur_host and cur_host != replay_host:
                        replay_rechecked = True
                        _deferred = await _try_replay(cur_host, turn + 1, allow_prefix=True)
                        if _deferred is not None:
                            return _deferred
                        # a prefix replay just moved the page; tell the model on
                        # THIS result so it continues from the composer
                        if replay_prefix_note:
                            result["text"] = f"{result.get('text') or ''}{replay_prefix_note}"
                            replay_prefix_note = ""
                        elif not route_hint_keys:
                            _h_skill, _h_score = browser_skills.find_similar_skill(cur_host, skill_key_task)
                            if _h_skill:
                                _hint, route_hint_keys = browser_skills.render_route_hint(_h_skill, skill_key_task, _h_score)
                                if _hint:
                                    result["text"] = f"{result.get('text') or ''}{_hint}"
                                    logger.info(
                                        f"[browser-route {session_id}] hint attached at re-check turn {turn}: "
                                        f"host={cur_host} sim={_h_score:.2f} steps={len(route_hint_keys)}"
                                    )

                if tu.name == "BrowserScreenshot" and result.get("image"):
                    final_screenshot = result["image"]

                # Loop detection: did we just repeat the same (tool, input,
                # result) for the third time in a row? If so, attach a loud
                # warning to this tool_result so the model is forced to
                # acknowledge it on its next turn.
                # Loop detection only covers the non-excluded tools, so skip the
                # hash entirely for the excluded ones; otherwise a screenshot/read
                # serializes its full ~1MB result here just for _detect_loop to
                # discard it (it short-circuits excluded tools to False anyway).
                if tu.name in _LOOP_DETECTION_EXCLUDED_TOOLS:
                    is_loop = False
                else:
                    call_key = _hash_tool_call(tu.name, tu.input, result)
                    is_loop = _detect_loop(recent_tool_calls, call_key)
                    recent_tool_calls.append(call_key)
                    if len(recent_tool_calls) > _LOOP_WINDOW_SIZE * 2:
                        recent_tool_calls = recent_tool_calls[-_LOOP_WINDOW_SIZE * 2:]

                content_blocks = _format_tool_result(result, tu.name)
                try:
                    url = result.get("url") or (tu.input or {}).get("url")
                    if url:
                        domain = _extract_domain(str(url))
                        if domain and domain not in session.browser_domains:
                            session.browser_domains.append(domain)
                except Exception:
                    pass
                # The fast tier is ~0% used because the agent never thinks to ask.
                # Once per host, when safe GET routes have been captured, nudge it:
                # reading via the API beats re-scraping, especially in a batch loop.
                try:
                    _rc = int(result.get("routes_available") or 0)
                    _rhost = browser_skills.host_of(result.get("url") or last_seen_url)
                    if _rc > 0 and _rhost and _rhost not in route_hinted_hosts:
                        route_hinted_hosts.add(_rhost)
                        content_blocks = content_blocks + [{"type": "text", "text": (
                            f"\n\n💡 {_rc} of this site's own API endpoint(s) were captured. To READ "
                            "data (and especially to repeat a read for many items), BrowserReplayRoute "
                            "(or a replay_route step in BrowserRepeatFlow) is much faster and more "
                            "reliable than navigating + scraping. See BrowserListRoutes.")}]
                except Exception:
                    pass
                if is_loop:
                    loop_trigger_count += 1
                    repeat_count = sum(1 for c in recent_tool_calls if c == call_key)
                    warning = _LOOP_WARNING_TEXT.format(count=repeat_count)
                    logger.warning(
                        f"[browser-agent {session_id}] loop detected on {tu.name} "
                        f"(trigger #{loop_trigger_count}): {warning}"
                    )
                    content_blocks = content_blocks + [
                        {"type": "text", "text": f"\n\n⚠️ {warning}"}
                    ]

                # Stagnation: busy-but-stuck (no URL change + failures across a
                # run of actions), distinct from the exact-repeat loop above.
                stagnation_streak, stagnation_prev_url, stagnation_prev_text, stag_nudge = advance_stagnation(
                    stagnation_streak, stagnation_prev_url, stagnation_prev_text, tu.name, result,
                )
                # Skip the nudge when the loud loop warning already fired this
                # turn (avoid double-messaging), but the aux adjudication below
                # is NOT gated on is_loop: repeated identical failures trip BOTH
                # detectors, and that's exactly when the escape hatch is needed.
                if stag_nudge and not is_loop:
                    logger.warning(
                        f"[browser-agent {session_id}] stagnation streak "
                        f"{stagnation_streak} on {tu.name}"
                    )
                    content_blocks = content_blocks + [
                        {"type": "text", "text": f"\n\n⚠️ {stag_nudge}"}
                    ]

                # Under-batching nudge: two consecutive turns each spent a full
                # model round-trip on ONE predictable action; say so on the
                # result the model is about to read. Deterministic, code-fired.
                if (tu is tool_uses_sorted[-1] and single_action_streak >= 2
                        and "error" not in result and not is_loop and not stag_nudge):
                    single_action_streak = 0
                    batching_nudges += 1
                    logger.info(
                        f"[browser-batching {session_id}] nudge #{batching_nudges} fired at turn {turn}"
                    )
                    content_blocks = content_blocks + [{"type": "text", "text": (
                        "\n\n⚡ That was another full model round-trip spent on ONE action. If the "
                        "state above already names your next 2-3 targets, put them in ONE "
                        "BrowserBatch (or several tool calls in this same reply); they run in "
                        "order, settle between steps, and stop safely at the first failure, so a "
                        "conservative batch costs nothing. Keep irreversible steps "
                        "(Send/Submit/Pay/Post) solo."
                    )}]

                # Redundant-read nudge: the previous action already attached a fresh
                # element list, and this turn spent a whole round-trip re-reading it.
                # Reads are the biggest turn sink (measured ~16 of 25 turns).
                if (tu.name in ("BrowserListInteractives", "BrowserGetText")
                        and _had_fresh_state and "error" not in result):
                    redundant_read_nudges += 1
                    fresh_state_pending = False  # nudge once per attached-state cluster
                    logger.info(
                        f"[browser-batching {session_id}] redundant-read nudge #{redundant_read_nudges} "
                        f"({tu.name}) at turn {turn}"
                    )
                    content_blocks = content_blocks + [{"type": "text", "text": (
                        "\n\n⚡ Your PREVIOUS action already ended with a fresh '[page state after "
                        "action]' element list, so this re-read cost a round-trip for nothing. Act "
                        "straight from the attached state; only re-read after it says it was truncated "
                        "or you genuinely changed the page in a way that list wouldn't reflect."
                    )}]
                # Deterministic nudging exhausted: ONE cheap aux adjudication
                # to suggest a concrete next step before we keep failing.
                if stagnation_exhausted(stagnation_streak) and not aux_adjudicated:
                    aux_adjudicated = True
                    aux_client, aux_model = await _get_aux_client()
                    if aux_client and aux_model:
                        recent = "\n".join(
                            f"- {a['tool']} -> {str(a.get('result_summary', ''))[:120]}"
                            for a in action_log[-3:]
                        )
                        page_text = str(result.get("text") or result.get("error") or "")
                        guidance = await _cancellable(adjudicate_stuck(
                            aux_client, aux_model, current_next_goal, recent, page_text,
                        ))
                        if guidance:
                            content_blocks = content_blocks + [
                                {"type": "text", "text": f"\n\n💡 Suggested next step: {guidance}"}
                                ]

                _ok = "error" not in result
                browser_metrics.record_tool(
                    session_id, browser_id, turn, tu.name, elapsed_ms,
                    ok=_ok, error=result.get("error", ""),
                    is_loop=is_loop, stagnation_streak=stagnation_streak,
                    result_len=len(str(result.get("text") or result.get("error") or "")),
                )

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": content_blocks,
                    **({"is_error": True} if is_loop else {}),
                })

                result_text = result.get("text", result.get("error", ""))
                result_msg = Message(
                    role="tool_result",
                    content={"text": result_text, "tool_name": tu.name, "elapsed_ms": elapsed_ms},
                )
                session.messages.append(result_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": result_msg.model_dump(mode="json"),
                })

            messages.append({"role": "user", "content": tool_results})

            if cancelled:
                break

            # Hard cap on loops: if the model keeps repeating itself even
            # after we warn it, force-exit so we don't burn the entire turn
            # budget on a stuck agent.
            if loop_trigger_count >= _LOOP_HARD_CAP:
                logger.warning(
                    f"[browser-agent {session_id}] hit loop hard cap "
                    f"({_LOOP_HARD_CAP}); force-exiting"
                )
                break

            # The card is unusable, gone (closed) OR hung (commands keep timing
            # out / the page never responds). Either way the agent can't make
            # progress, so stop retrying after a short streak and report honestly,
            # instead of the 20-minute spin on a wedged tab.
            if card_gone_streak >= _CARD_GONE_LIMIT:
                logger.warning(
                    f"[browser-agent {session_id}] browser card {browser_id} is unusable "
                    f"({card_gone_streak} consecutive gone/hung results); aborting fast"
                )
                break

        if cancel_event.is_set():
            session.status = "stopped"
            browser_metrics.record_task(session_id, browser_id, task, "stopped",
                                        metrics_started_at, turn + 1, action_log, session.tokens)
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "stopped",
                "session": session.model_dump(mode="json"),
            })
            return {
                "session_id": session_id,
                "browser_id": browser_id,
                "summary": "Agent was stopped by the user. Do NOT retry or create new browser agents.",
                "error": "Agent was stopped by the user.",
                "action_log": action_log,
                "final_screenshot": final_screenshot,
            }

        summary_parts = text_parts if text_parts else ["Task completed."]
        summary = "\n".join(summary_parts)

        if not final_screenshot:
            try:
                ss_result = await execute_browser_tool(
                    "BrowserScreenshot", {}, browser_id, tab_id,
                )
                if ss_result.get("image"):
                    final_screenshot = ss_result["image"]
            except Exception:
                pass

        # Persist conversation history so the next BrowserAgent call on this
        # browser can resume rather than re-orient. Trim to the most recent
        # _MAX_HISTORY_MESSAGES turns to keep token usage bounded; but
        # never split a tool_use ↔ tool_result pair across the cut, or the
        # next API request will 400.
        browser_history._browser_history[browser_id] = _trim_history_by_turns(
            messages, _MAX_HISTORY_MESSAGES,
        )

        # Honesty gate: the model declaring done is not proof the goal happened.
        # If the run did no real work (zero actions, all actions errored, or only
        # looked around), report the truth instead of a ghost "completed". A gone
        # card gets its own precise reason instead of the generic verdict.
        if card_gone_streak >= _CARD_GONE_LIMIT:
            honest, dishonest_reason = False, "the browser became unresponsive (the tab hung or was closed); it needs a fresh browser to continue"
        else:
            honest, dishonest_reason = completion_is_honest(action_log)
        final_status = "completed" if honest else "error"
        if not honest:
            summary = f"I was not able to complete this task ({dishonest_reason})."
            logger.warning(
                f"[browser-agent {session_id}] completion gate caught a ghost: "
                f"model declared done but {dishonest_reason}; reporting as error"
            )

        session.status = final_status
        logger.info(
            f"[browser-batching {session_id}] run summary: turns={turn + 1} "
            f"multi_action_turns={multi_action_turns} batch_calls={batch_calls} "
            f"nudges={batching_nudges} redundant_reads={redundant_read_nudges} "
            f"guard_blocks={batch_guard_blocks}"
        )
        # Route-hint adoption: of the hinted steps, how many did the run actually
        # take? Pure telemetry; this is how we learn whether hints steer or get
        # ignored (the batching-nudge lesson: measure, don't assume).
        if route_hint_keys:
            _adopted = sum(1 for k in route_hint_keys if browser_skills.hint_step_adopted(k, action_log))
            logger.info(
                f"[browser-route {session_id}] adoption: {_adopted}/{len(route_hint_keys)} "
                f"hinted steps matched by executed actions"
            )
        _tools_ms_total = sum(int(a.get("elapsed_ms", 0) or 0) for a in action_log)
        _wall_ms = int((time.time() - metrics_started_at) * 1000)
        _err_tools = sum(1 for a in action_log if not a.get("ok", True))
        logger.info(
            f"[browser-time {session_id}] wall={_wall_ms}ms llm={llm_ms_total}ms "
            f"tools={_tools_ms_total}ms other={max(0, _wall_ms - llm_ms_total - _tools_ms_total)}ms "
            f"auto_scans={auto_scan_count} hint_steps={len(route_hint_keys)} "
            f"tool_errors={_err_tools} recovery_attaches={recovery_attaches}"
        )
        _nt = turn + 1
        # merge-verify telemetry: read-only tool calls AFTER the last state-changing
        # action are the redundant trailing "let me re-verify" turns the prompt now
        # folds into the OUTCOME line; this should trend to 0 on the confirmed path.
        _act_tools = {"BrowserType", "BrowserClickIndex", "BrowserClick", "BrowserClickByName",
                      "BrowserPressKey", "BrowserScroll", "BrowserBatch", "BrowserNavigate"}
        _read_tools = {"BrowserScreenshot", "BrowserGetText", "BrowserGetElements",
                       "BrowserListInteractives", "BrowserExtract"}
        _last_act = max((i for i, a in enumerate(action_log)
                         if a.get("tool") in _act_tools and a.get("ok")), default=-1)
        _trailing_reads = sum(1 for a in action_log[_last_act + 1:]
                              if a.get("tool") in _read_tools) if _last_act >= 0 else 0
        logger.info(
            f"[browser-output {session_id}] out_tokens={out_tokens_total} "
            f"mean_out_per_turn={out_tokens_total // max(1, _nt)} narration_turns={narration_turns}/{_nt} "
            f"trailing_reads={_trailing_reads}"
        )
        browser_metrics.record_task(session_id, browser_id, task, final_status,
                                    metrics_started_at, turn + 1, action_log, session.tokens,
                                    path="llm_fallback" if replay_attempted else "llm",
                                    task_sig=browser_skills._sig(skill_key_task),
                                    playbook_seeded=pb_seeded)
        # Learn this task ONLY from a genuinely successful run whose deliverable a
        # deterministic replay can actually reproduce. We skip recording when the
        # run was dishonest (ghost) OR when its answer was gathered/judged content
        # (a list/report): replay can redo the clicks but not regenerate the
        # judgment, so recording it would create a thin shortcut that later ghosts.
        informational = deliverable_is_informational(summary, skill_key_task)
        logger.info(f"[browser-skills] record gate: honest={honest} informational={informational}")
        if honest and not informational:
            try:
                rec_host = browser_skills.host_of(last_seen_url)
                _distilled = browser_skills.distill_steps(action_log)
                logger.info(
                    f"[browser-skills] record attempt: host={rec_host!r} "
                    f"last_url={last_seen_url!r} action_tools={[a.get('tool') for a in action_log]} "
                    f"distilled={[s['tool'] for s in _distilled]}"
                )
                if browser_skills.record_skill(rec_host, skill_key_task, action_log):
                    logger.info(f"[browser-skills] learned skill for {rec_host} (future runs replay fast)")
                else:
                    logger.info(f"[browser-skills] NOT recorded (host empty or no robust steps)")
            except Exception as e:
                logger.warning(f"[browser-skills] record raised: {e}")
        elif honest and informational:
            logger.info("[browser-skills] NOT recorded (deliverable was gathered/judged content; "
                        "replay can't reproduce it, so no thin-shortcut ghost)")

        # Tier-2 memory: on a substantive verified success, distill this run into
        # the DURABLE strategy playbook (one cheap aux call, mem0-style distill+
        # reconcile). Fires for BOTH mechanical and judgment tasks, it's how the
        # judgment ones (which can't be skills) still get faster/wiser next time.
        if browser_playbook.should_learn(honest, turn + 1):
            try:
                pb_host = browser_skills.host_of(last_seen_url)
                if pb_host:
                    aux_client, aux_model = await _get_aux_client()
                    changed = await browser_playbook.distill_and_store(
                        pb_host, skill_key_task, latest_working_mem, summary,
                        aux_client, aux_model,
                    )
                    # Perceived value, zero clicks: a calm closing line so the user
                    # sees the agent got a little smarter for next time. Only when
                    # it genuinely learned something, so it stays honest + rare.
                    if changed:
                        session.memory_learned = True  # drives the subtle "Learned" card chip
                        _learn_msg = Message(role="assistant",
                                             content=f"Noted what worked on {pb_host} so I'm faster here next time.")
                        session.messages.append(_learn_msg)
                        await ws_manager.send_to_session(session_id, "agent:message", {
                            "session_id": session_id, "message": _learn_msg.model_dump(mode="json"),
                        })
            except Exception as e:
                logger.debug(f"[browser-playbook] distill skipped: {e}")
        agent_manager._sync_session_close(session)
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": final_status,
            "session": session.model_dump(mode="json"),
        })

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": summary,
            # surface the honest failure to the parent so it doesn't treat a
            # did-nothing run as a success it can build on
            **({} if honest else {"error": summary}),
            "action_log": action_log,
            "final_screenshot": final_screenshot,
        }

    except Exception as e:
        logger.exception(f"Browser agent {session_id} error: {e}")
        session.status = "error"
        browser_metrics.record_task(session_id, browser_id, task, "error",
                                    metrics_started_at, locals().get("turn", -1) + 1,
                                    action_log, session.tokens)
        error_msg = Message(role="system", content=f"Error: {str(e)}")
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "error",
            "session": session.model_dump(mode="json"),
        })

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": f"Error: {str(e)}",
            "action_log": action_log,
            "final_screenshot": None,
        }


# Cards a sub-agent is actively driving in this process. Reuse must never hand
# two agents one webview (their commands would interleave into chaos).
_active_agent_cards: set[str] = set()
# find+claim+create must be one critical section or two parallel dispatches
# race to claim the same idle card (or both miss and double-create).
_card_pick_lock = asyncio.Lock()


def _find_reusable_card(dashboard_id: str, url: str, parent_session_id: str | None) -> str:
    """An existing same-host spawned card to drive instead of stacking another
    webview: concurrent same-site webviews wedge each other (shared-partition
    lock contention), so a retry must REUSE, not multiply. The parent's own
    card first, else one orphaned by a finished parent. User-created cards
    (no spawned_by) are never grabbed implicitly."""
    want = browser_skills.host_of(url)
    if not (dashboard_id and want):
        return ""
    try:
        from backend.apps.dashboards.dashboards import _load
        cards = _load(dashboard_id).layout.browser_cards
    except Exception:
        return ""
    from backend.apps.agents.agent_manager import agent_manager
    own, orphan = "", ""
    for bid, card in cards.items():
        spawned = getattr(card, "spawned_by", None)
        if not spawned or bid in _active_agent_cards:
            continue
        if browser_skills.host_of(getattr(card, "url", "") or "") != want:
            continue
        if spawned == parent_session_id:
            own = own or bid
        else:
            parent = agent_manager.get_session(spawned)
            if parent is None or getattr(parent, "status", "") != "running":
                orphan = orphan or bid
    return own or orphan


async def _create_browser_card(dashboard_id: str, url: str, parent_session_id: str | None = None) -> str:
    """Create a new browser card on the dashboard and return its browser_id."""
    from backend.apps.dashboards.dashboards import _load, _save
    from backend.apps.dashboards.models import BrowserCardPosition, BrowserTab

    dashboard = _load(dashboard_id)
    browser_id = f"browser-{uuid4().hex[:8]}"
    tab_id = f"tab-{uuid4().hex[:8]}"
    tab = BrowserTab(id=tab_id, url=url or "https://www.google.com", title="")
    card = BrowserCardPosition(
        browser_id=browser_id,
        url=url or "https://www.google.com",
        tabs=[tab],
        activeTabId=tab_id,
        x=40,
        y=100,
        width=1280,
        height=800,
        spawned_by=parent_session_id,
    )
    dashboard.layout.browser_cards[browser_id] = card
    dashboard.updated_at = datetime.now()
    _save(dashboard)

    await ws_manager.broadcast_global("dashboard:browser_card_added", {
        "dashboard_id": dashboard_id,
        "browser_card": card.model_dump(mode="json"),
        "parent_session_id": parent_session_id or "",
    })
    return browser_id


async def run_browser_agents(
    tasks: list[dict],
    model: str,
    dashboard_id: str | None = None,
    pre_selected_browser_ids: list[str] | None = None,
    parent_session_id: str | None = None,
) -> list[dict]:
    """Run multiple browser sub-agents in parallel.

    Each task dict has: { browser_id (optional), task, url (optional) }
    Returns a list of result dicts, one per task.
    """
    pass  # Browser agent launch captured via session dump

    # No dashboard renderer means every browser command is dead on arrival;
    # failing here saves the 2-5 LLM turns a sub burns narrating timeouts at a
    # corpse before card-gone detection trips.
    if not ws_manager.global_connections:
        logger.warning("[browser-agent] dispatch refused: no dashboard connected")
        return [{
            "summary": (
                "Error: no dashboard window is connected, so browser tools cannot run. "
                "Tell the user to open the OpenSwarm window and try again; do not retry until they do."
            ),
            "action_log": [], "final_screenshot": None,
        } for _ in tasks]

    pre_selected = set(pre_selected_browser_ids or [])

    async def _run_one(task_def: dict) -> dict:
        browser_id = task_def.get("browser_id", "")
        task_text = task_def.get("task", "")
        url = task_def.get("url", "")
        # advisory deep entry (from the fast-path brief): a NEW card opens on it
        # directly (no google detour); a REUSED card is never moved by it, so a
        # warm card's deeper page state always wins
        entry_url = task_def.get("entry_url", "")

        reused = False
        if not browser_id and dashboard_id:
            # the url param is often empty with the target buried in the task
            # text; a url there still names the host we must not duplicate
            host_src = url or entry_url or next(iter(re.findall(r"https?://[^\s)\"'<>]+", task_text)), "")
            async with _card_pick_lock:
                browser_id = _find_reusable_card(dashboard_id, host_src, parent_session_id)
                if browser_id:
                    reused = True
                else:
                    browser_id = await _create_browser_card(dashboard_id, url or entry_url, parent_session_id)
                    if entry_url and not url:
                        logger.info(f"[browser-cold] new card {browser_id} opens at brief entry {entry_url}")
                _active_agent_cards.add(browser_id)
            if reused:
                logger.info(f"[browser-agent] reusing same-host card {browser_id} instead of stacking another webview")
                if url:
                    # a retry starts from the task's entry URL, never the failed attempt's leftover page state
                    try:
                        await execute_browser_tool("BrowserNavigate", {"url": url}, browser_id)
                    except Exception:
                        pass
            else:
                await asyncio.sleep(2.0)
        elif browser_id:
            _active_agent_cards.add(browser_id)

        is_pre_selected = browser_id in pre_selected
        _nav_url = url or ("" if reused else entry_url)
        try:
            return await run_browser_agent(
                task=task_text,
                browser_id=browser_id,
                model=model,
                dashboard_id=dashboard_id,
                pre_selected=is_pre_selected,
                initial_url=_nav_url if _nav_url and browser_id not in pre_selected else None,
                parent_session_id=parent_session_id,
            )
        finally:
            _active_agent_cards.discard(browser_id)

    results = await asyncio.gather(*[_run_one(t) for t in tasks], return_exceptions=True)

    final = []
    for r in results:
        if isinstance(r, Exception):
            final.append({"summary": f"Error: {str(r)}", "action_log": [], "final_screenshot": None})
        else:
            final.append(r)
    return final
