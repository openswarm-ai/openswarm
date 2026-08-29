"""Every guard added since 1.7.9, checked against the LEGITIMATE case that resembles the bad one.

A fix that fires beyond its intent is a trade, not a win. One of these caught a real regression the
day it was written: the frozen-sidecar liveness door resurrected sessions the user had stopped,
because a stopped browser agent looks exactly like a dead sidecar. These pin the innocent case for
each guard, so the next over-broad edit fails a test instead of shipping.
"""

import asyncio

from backend.apps.agents.core.models import AgentSession


# --------------------------------------------------------------- the machine-turn ceiling (ENG-398)

def test_a_session_stopped_during_a_gate_hold_never_gets_the_continuation(monkeypatch):
    """The gate can hold a continuation for up to a minute. If the user stops the chat in that
    window, the held send must not land. The gate itself does not check this; it relies on the
    Messaging chokepoint, so the reliance is what gets pinned."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.manager import machine_turn_gate as gate

    session = AgentSession(name="stopped-mid-hold", model="sonnet", dashboard_id="d")
    session.ended_by_user = True
    agent_manager.sessions[session.id] = session
    landed = []

    async def p_capture(sid, prompt, hidden=False, by_user=False, **kw):
        # Mirrors Messaging.py's guard: hidden + not by_user + ended_by_user -> refused.
        p_s = agent_manager.sessions.get(sid)
        if hidden and not by_user and getattr(p_s, "ended_by_user", False):
            return
        landed.append(prompt)

    monkeypatch.setattr(agent_manager, "send_message", p_capture, raising=True)
    gate.reset_for_test()
    try:
        asyncio.run(agent_manager.dispatch_hidden_continuation(session.id, "carry on", 0))
    finally:
        agent_manager.sessions.pop(session.id, None)
        gate.reset_for_test()
    assert landed == [], "a chat the user stopped must not be continued after a gate hold"


def test_the_gate_never_holds_a_human_send():
    # The capability this must not cost: a person pressing send is never delayed, at any rate.
    src = open("backend/apps/agents/agent_manager.py").read()
    head = src[:src.index("async def dispatch_hidden_continuation")]
    assert "wait_for_machine_turn_slot" not in head


def test_a_delayed_continuation_still_reaches_the_gate_in_the_right_order(monkeypatch):
    """Codex rotation waits 75s so the retry lands AFTER the token rotates. The ceiling must come
    after that wait, not replace it, or the retry burns its one shot inside the rotation window."""
    src = open("backend/apps/agents/agent_manager.py").read()
    body = src[src.index("async def dispatch_hidden_continuation"):]
    i_delay = body.index("if delay_s > 0:")
    i_gate = body.index("await wait_for_machine_turn_slot(session_id")
    assert i_delay < i_gate, "the rotation wait has to run before the ceiling, never instead of it"


# ------------------------------------------------------------------ tool-output shaping (ENG-385)

def test_shaping_never_removes_without_a_way_back():
    """The guarantee is not the line-matching heuristic, it is recoverability. Any body that gets
    cut must name where the full text lives, or a wrong guess costs the answer instead of a re-read."""
    from backend.apps.agents.manager.streaming.tool_output_shaper import shape_text
    out = shape_text("q" * 9_000, "/blobs/x-model.txt")
    assert "characters omitted" in out, "a cut is always visible as a cut"
    # Recoverability is carried by the TOOL CALL surviving in the transcript, not by a path in the
    # body: drilled live 2026-08-27, a model with working injection defences refuses an instruction
    # embedded in tool output and flags it as an attack. The blob still exists for the UI, and
    # shape_for_model still refuses to cut anything it could not park.
    assert "OpenSwarm" not in out and "/blobs/" not in out


def test_shaping_leaves_a_normal_result_completely_alone():
    from backend.apps.agents.manager.streaming.tool_output_shaper import shape_tool_response
    for benign in ("ok", {"stdout": "3 passed", "stderr": ""}, [{"type": "text", "text": "done"}]):
        assert shape_tool_response(benign, "/b.txt")[0] is None


# --------------------------------------------------------- permanent-vs-transient classify (ENG-395)

def test_a_real_throttle_is_still_retried():
    """The fix stops a malformed request being retried forever. It must not stop a genuine 429,
    an expiring token, or a traceback line number from behaving as before."""
    from backend.apps.agents.core.error_classify import is_transient_capacity_error as t
    assert t(RuntimeError('API Error: 429 {"message":"rate_limit_error (reset after 21s)"}')) is True
    assert t(RuntimeError("API Error: 401 unauthorized (reset after 1m 57s)")) is True
    assert t(RuntimeError("File runner.py, line 400, in execute (reset after 3s)")) is True
    assert t(RuntimeError("overloaded_error")) is True


# ------------------------------------------------------------------- no transcript replay (ENG-396)

def test_the_users_own_words_and_the_result_both_survive():
    """Stripping model prose once went too far and made InvokeWorkflow return a trail with no
    answer in it. The user's ask is not model output, and one final result is not a replay."""
    from backend.apps.agents.manager.session.history_compaction import render_agent_trail

    class M:
        def __init__(s, role, content):
            s.role, s.content, s.id, s.hidden = role, content, "m", False

    out = render_agent_trail([
        M("user", "find the bug"),
        M("tool_call", {"tool": "Bash", "input": {"command": "pytest -q"}}),
        M("tool_result", {"tool_name": "Bash", "text": "3 failed"}),
        M("assistant", "the parser is at fault"),
    ])
    assert "find the bug" in out
    assert "pytest -q" in out and "3 failed" in out
    assert "the parser is at fault" in out, "the outcome is why the caller invoked the run"


def test_the_real_messaging_guard_is_what_the_gate_relies_on():
    """Wire check, not a mirror. The gate test above simulates the refusal; this asserts the actual
    chokepoint carries it at BOTH doors (the in-memory path and the disk-reload path), because a
    late watchdog retry reopening a closed card is exactly how ENG-369/384 happened."""
    src = open("backend/apps/agents/manager/Messaging.py").read()
    guard = "if hidden and not by_user and session.ended_by_user:"
    assert src.count(guard) == 2, \
        "both the reload path and the live path must refuse a machine send to a stopped session"
    # And a human's own click must still get through, or the Resume chip reappears forever.
    assert "if session.ended_by_user and (not hidden or by_user):" in src


def test_a_stopped_session_is_not_left_spinning_after_a_refused_continuation():
    """The other half: a refused send returns normally rather than raising, so the settle path is
    never reached. That is only safe because a human Stop already wrote a terminal status."""
    src = open("backend/apps/agents/agent_manager.py").read()
    i = src.index("async def p_settle_unstarted_continuation")
    assert 'status != "running"' in src[i:i + 600], \
        "settling must no-op on an already-terminal session rather than rewriting it"


def test_a_continuation_armed_for_a_stopped_chat_releases_its_running_promise(monkeypatch):
    """The race between ENG-390 and ENG-384: arming a continuation promises `running`, Messaging
    refuses the send SILENTLY for a stopped chat, and a silent refusal never reaches the settle
    path. Left alone the card spins forever on a chat the user ended."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.manager import machine_turn_gate as gate

    session = AgentSession(name="raced", model="sonnet", dashboard_id="d")
    session.ended_by_user = True
    session.status = "running"
    agent_manager.sessions[session.id] = session
    sent = []
    monkeypatch.setattr(agent_manager, "send_message",
                        lambda *a, **k: sent.append(a), raising=True)
    gate.reset_for_test()
    try:
        asyncio.run(agent_manager.dispatch_hidden_continuation(session.id, "go", 0))
        status = agent_manager.sessions[session.id].status
    finally:
        agent_manager.sessions.pop(session.id, None)
        gate.reset_for_test()

    assert sent == [], "no machine send into a chat a human ended"
    assert status != "running", "and the running promise must be released, or the card spins forever"


# --------------------------------------------------------------- the model catalog gate (ENG-386)

def test_a_genuinely_retired_model_is_still_healed():
    """The gate refuses to retire a model when the catalog could not be enumerated, which is right:
    a router bounce must not move a chat to another vendor. The capability it must NOT cost is the
    real one -- a model that truly no longer exists (the stranded-haiku migration) still gets moved.
    """
    src = open("frontend/src/app/Main.tsx").read()
    i_gate = src.index("catalogComplete")
    window = src[i_gate - 400:i_gate + 1200]
    assert "knownValues" in window, "the heal decides on the durable catalog, not today's payload"
    # And the refusal is not silent: a guard that stops guarding has to say so.
    assert "will NOT be auto-switched" in src


def test_the_catalog_is_independent_of_credentials():
    """The whole point: availability and existence are different questions. If known_values were
    filtered by creds it would collapse back into the payload it replaced."""
    src = open("backend/apps/agents/agents.py").read()
    i = src.index("known_values")
    assert "catalog_complete" in src[i - 2000:i + 2000]


# ------------------------------------------------------------ the suite auto-resume gate (ENG-388)

def test_auto_resume_still_works_outside_a_test_run():
    """The gate stops the suite spending real money. It must not stop a real user's crashed turn
    from resuming, which is the entire feature."""
    src = open("backend/apps/agents/manager/session/SessionPersistence.py").read()
    i = src.index("def auto_resume_held_because")
    body = src[i:i + 1400]
    assert "OSW_DISABLE_AUTO_RESUME" in body, "the declared signal comes first"
    assert 'os.environ.get("OSW_DISABLE_AUTO_RESUME") == "1"' in body, \
        "only an explicit 1 disarms it, so a stray empty value cannot silently kill crash-resume"
    assert '"pytest" in sys.modules' in body, "the incidental signal stays a fallback, never the primary"


# ------------------------------------------------------ the status promise and its release (ENG-390)

def test_settling_never_stomps_a_live_turn():
    """Releasing the running promise must not fire while a turn is genuinely in flight, or it
    reports 'completed' over work that is still going -- the exact lie ENG-390 was written to end."""
    src = open("backend/apps/agents/agent_manager.py").read()
    i = src.index("async def p_settle_unstarted_continuation")
    body = src[i:i + 800]
    assert "not p_task.done()" in body, "a live task must veto the settle"
    assert 'status != "running"' in body, "and an already-terminal session is left alone"


# -------------------------------------------- the CLI-prose policy refusal (ENG-411, 2026-08-26)

def test_a_terms_summary_is_not_mistaken_for_the_filter_refusing():
    """The guard reads bare prose with no envelope, so the innocent case is an agent that was ASKED
    about a usage policy. Eating that reply is silent work loss, a worse row than the bug."""
    from backend.apps.agents.core.error_classify import neutralize_provider_refusal
    from backend.apps.agents.manager.streaming.provider_error_speech import classify_provider_error
    for innocent in (
        "Their Usage Policy bans reverse engineering and duplicating model outputs, per section 3.",
        "I'm unable to respond to this request because the file you named does not exist.",
        "Summary: the Acceptable Use Policy has four prohibited-use categories, listed below.",
    ):
        assert neutralize_provider_refusal(innocent) == innocent
        assert classify_provider_error(innocent) is None


# ------------------------------------------------- the mid-turn valve's growth rule (ENG-418)

def test_a_turn_that_starts_high_and_sits_still_is_still_left_alone(monkeypatch):
    """Growth made more turns breakable, and every break costs a transcript REBUILD -- the frequency
    ENG-382 exists to reduce. The innocent case is a rebuild that failed to shrink: it starts high
    and does not grow, and it must RUN rather than rebuild forever."""
    from backend.apps.agents.manager.context_budget import maybe_break_midturn
    from backend.apps.agents.manager.streaming.state import TurnState
    s = AgentSession(name="t", model="opus-5"); s.context_window = 1_000_000
    t = TurnState()
    assert maybe_break_midturn(s, t, {"input_tokens": 500_000}) is False
    assert maybe_break_midturn(s, t, {"input_tokens": 505_000}) is False, "5K is not material growth"
    assert s.midturn_breaks == 0


def test_a_grown_turn_breaks_at_most_once_so_rebuilds_cannot_multiply(monkeypatch):
    from backend.apps.agents.manager.context_budget import maybe_break_midturn
    from backend.apps.agents.manager.streaming.state import TurnState
    s = AgentSession(name="t", model="opus-5"); s.context_window = 1_000_000
    t = TurnState()
    maybe_break_midturn(s, t, {"input_tokens": 100_000})
    assert maybe_break_midturn(s, t, {"input_tokens": 400_000}) is True
    for n in (500_000, 600_000, 900_000):
        assert maybe_break_midturn(s, t, {"input_tokens": n}) is False
    assert s.midturn_breaks == 1


# --------------------------------------------------- Close vs Stop on a workflow card (ENG-421)

def test_a_workflow_run_that_ended_on_its_own_still_despawns():
    """The card is kept for a HUMAN stop. The innocent case is the nightly workflow that ends by
    itself: keeping its card would leave litter on the canvas every single night, which is the leak
    the original rule was written to prevent."""
    a = "frontend/src/shared/state/isUserLaunchedSession.ts"
    src = open(a, encoding="utf-8").read()
    assert "if (LIVE_STATUSES.has" in src and "ended_by_user" in src
    assert "!session.dismissed_by_user" in src, "Close must still be able to dismiss"
    assert "!session.closed_at" not in src, \
        "closed_at is stamped by the executor on every run; using it made the fix dead code"


def test_the_dismissal_flag_is_at_the_close_door_not_in_the_shared_helper():
    """agent_manager.close_session is called by the workflow executor for bookkeeping. A flag there
    would mark every finished run as user-dismissed and delete the stopped-run cards again."""
    helper = open("backend/apps/agents/manager/SessionControl.py", encoding="utf-8").read()
    assert "dismissed_by_user" not in helper


# ------------------------------------------------------ the PTC fan-out width cap (ENG-417)

def test_one_scripts_fan_out_cannot_starve_the_rest_of_the_chat():
    """The cap is module-global on purpose: two scripts in one sidecar SHARE the width rather than
    each taking a full one. The innocent case is the chat's other builtin tools, which ride the same
    process and must still get scheduled while a 25-call batch runs."""
    from backend.apps.agents import ptc_mcp_server as ptc
    src = open("backend/apps/agents/ptc_mcp_server.py", encoding="utf-8").read()
    assert "P_FANOUT_SLOTS = threading.Semaphore(SCRIPT_FANOUT_WIDTH)" in src
    i = src.index("def p_dispatch_batch")
    body = src[i:src.index("def p_elide", i)]
    assert "P_FANOUT_SLOTS.acquire(timeout=" in body, "an unbounded acquire can lose a slot forever"
    assert "finally:" in body and "P_FANOUT_SLOTS.release()" in body
    assert ptc.SCRIPT_FANOUT_WIDTH <= 8


# ------------------------------------------------- the canvas wheel owner (ENG-420)

def test_a_gesture_that_starts_on_a_panel_still_belongs_to_the_panel():
    """Canvas ownership was added so a pan is not swallowed mid-drift. The innocent case is the
    original rule it must not break: a scroll that starts inside Settings has to stay there past the
    panel's end, or reaching the bottom of a list drags the whole world."""
    src = open("frontend/src/app/pages/Dashboard/hooks/interaction/wheelGestureOwner.ts",
               encoding="utf-8").read()
    assert "owner === CANVAS_OWNER" in src
    assert "owner.contains(target" in src, "an element owner must still hold its own gesture"
    assert "isZoom" in src, "zoom must stay reachable on every surface"
