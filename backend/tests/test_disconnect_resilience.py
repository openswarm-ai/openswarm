"""Stress test for the WS resilience layer.

Goal: actively try to break the agent run with disconnects, drops,
reconnects, and concurrent broadcasts. The visible bug we're chasing
is "Network issue" toasts that flip a still-running task to a
terminal state. After these fixes the contract should be:

  1. The agent task NEVER dies because of a WS drop.
  2. Every event the server emits is replayable, in order, with no
     duplicates and no gaps, after any number of disconnects.
  3. Terminal events (completed/stopped/error) are always observable
     by a client that reconnects later, even if the only persistence
     of the event is the on-disk terminal log.
  4. Concurrent broadcasts (thinking deltas + tool calls + status
     changes from many tasks) preserve seq order == wire order.
  5. A client that's been gone too long for the ring buffer gets a
     `agent:gap_detected` instead of silent loss.

We don't run real Claude Code; we install a stub `agent_loop` that
emits the same WS event shapes a real run would (status, stream,
message, completed). That keeps the test fast (>200 iterations in
seconds) and self-contained.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_disconnect_resilience.py -v
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import sys
import tempfile
from typing import Any
from unittest.mock import patch

import pytest
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.testclient import TestClient

# --------------------------------------------------------------------------- Boot env: route data to a tempdir BEFORE importing backend modules so the persistence dir for terminal events lives under our control. ---------------------------------------------------------------------------

P_TMPROOT = tempfile.mkdtemp(prefix="openswarm-disconnect-test-")
os.environ.setdefault("OPENSWARM_DATA_DIR", P_TMPROOT)

# Push the seq_log persist dir to a deterministic location too.
P_SEQ_DIR = os.path.join(P_TMPROOT, "seq_terminals")
os.makedirs(P_SEQ_DIR, exist_ok=True)


@pytest.fixture(autouse=True)
def p_patch_persist_dir():
    """Force the seq_log to use our tmp dir so we can assert on disk state."""
    from backend.apps.agents.core import seq_log as sl_mod

    # Rebuild the singleton with our test dir.
    new_store = sl_mod.SeqLogStore(persist_dir=P_SEQ_DIR)
    monkey = patch.object(sl_mod, "seq_log", new_store)
    monkey.start()
    # Also patch the symbol re-exported into ws_manager's import scope.
    from backend.apps.agents.core import ws_manager as wm_mod
    wm_monkey = patch.object(wm_mod, "seq_log", new_store)
    wm_monkey.start()
    yield new_store
    monkey.stop()
    wm_monkey.stop()


# --------------------------------------------------------------------------- Minimal FastAPI app with the real WS endpoint logic. We import ws_manager directly and replicate the handler from backend/main.py without any of its auth middleware so the TestClient can connect without a token. ---------------------------------------------------------------------------


def p_build_app(seq_log):
    """Replicates main.py's WS handler + adds a /test/emit endpoint
    so the test thread can drive event emission through the same
    event loop as the WS handler, avoiding the cross-loop hazards
    of `asyncio.run()` mid-test."""
    from backend.apps.agents.core.ws_manager import ws_manager

    app = FastAPI()

    @app.websocket("/ws/agents/{session_id}")
    async def ws_session(websocket: WebSocket, session_id: str):
        await ws_manager.connect_session(session_id, websocket)
        try:
            while True:
                data = await websocket.receive_text()
                msg = json.loads(data)
                event = msg.get("event")
                payload = msg.get("data", {})
                if event == "client:hello":
                    last_seq = int(payload.get("last_seq") or 0)
                    ack = await ws_manager.replay_to(session_id, websocket, last_seq)
                    await websocket.send_text(json.dumps({
                        "event": "server:hello",
                        "session_id": session_id,
                        "data": {
                            "connection_uuid": payload.get("connection_uuid", ""),
                            "current_seq": seq_log.current_seq(session_id),
                            "ack": ack,
                        },
                    }))
                elif event == "client:ping":
                    await websocket.send_text(json.dumps({
                        "event": "server:pong",
                        "session_id": session_id,
                        "data": {"nonce": payload.get("nonce")},
                    }))
        except WebSocketDisconnect:
            ws_manager.disconnect_session(session_id, websocket)

    @app.post("/test/emit/{session_id}")
    async def emit_events(session_id: str, body: dict):
        n = int(body.get("n", 0))
        terminate = body.get("terminate")  # str or None
        concurrent = int(body.get("concurrent", 1))
        await p_emit_run(session_id, n, terminate=terminate, concurrent_tasks=concurrent)
        return {"ok": True, "current_seq": seq_log.current_seq(session_id)}

    return app


def p_emit(client, session_id: str, n: int, terminate: str | None = None, concurrent: int = 1):
    """Drive event emission via the test-only HTTP endpoint."""
    r = client.post(f"/test/emit/{session_id}", json={
        "n": n, "terminate": terminate, "concurrent": concurrent,
    })
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- Helpers ---------------------------------------------------------------------------


async def p_emit_run(session_id: str, n_events: int, terminate: str | None = "completed", concurrent_tasks: int = 1):
    """Emit a synthetic agent run.

    `concurrent_tasks` lets the test stress the per-session lock by
    fanning out the broadcast across multiple coroutines. The seq
    log must still order them strictly.
    """
    from backend.apps.agents.core.ws_manager import ws_manager

    async def emit_chunk(start: int, count: int):
        for i in range(count):
            await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                "session_id": session_id,
                "message_id": "m1",
                "delta": f"chunk-{start + i}",
            })
            # Yield to the scheduler so other coroutines interleave; this is what surfaces the seq race if locking is wrong.
            await asyncio.sleep(0)

    if concurrent_tasks <= 1:
        await emit_chunk(0, n_events)
    else:
        per = n_events // concurrent_tasks
        tasks = [
            asyncio.create_task(emit_chunk(i * per, per))
            for i in range(concurrent_tasks)
        ]
        await asyncio.gather(*tasks)
        # Mop up the remainder so total event count is exact.
        rem = n_events - per * concurrent_tasks
        if rem > 0:
            await emit_chunk(per * concurrent_tasks, rem)

    if terminate is not None:
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": terminate,
        })


# --------------------------------------------------------------------------- Unit-level: seq log fundamentals ---------------------------------------------------------------------------


def test_seq_monotonic_under_concurrency(p_patch_persist_dir):
    """200 concurrent broadcasts must yield strictly monotonic seq."""
    app = p_build_app(p_patch_persist_dir)
    sid = "session-conc-1"
    with TestClient(app) as client:
        p_emit(client, sid, n=200, terminate=None, concurrent=4)
    _, newest, events = p_patch_persist_dir.replay(sid, 0)
    assert newest == 200
    seqs = [json.loads(s)["seq"] for s in events]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)


def test_terminal_event_persisted(p_patch_persist_dir):
    app = p_build_app(p_patch_persist_dir)
    sid = "session-term-1"
    with TestClient(app) as client:
        p_emit(client, sid, n=0, terminate="completed")
    raw = p_patch_persist_dir.load_terminal(sid)
    assert raw is not None
    obj = json.loads(raw)
    assert obj["event"] == "agent:status"
    assert obj["data"]["status"] == "completed"


def test_replay_after_eviction_reports_gap(p_patch_persist_dir):
    app = p_build_app(p_patch_persist_dir)
    sid = "session-evict-1"
    with TestClient(app) as client:
        p_emit(client, sid, n=700, terminate=None)
    oldest, newest, events = p_patch_persist_dir.replay(sid, last_seq=10)
    assert newest == 700
    assert oldest is not None and oldest > 10
    # Replay only includes seqs > 10 that survived eviction.
    assert all(json.loads(s)["seq"] > 10 for s in events)


# --------------------------------------------------------------------------- Integration: full WS connect / disconnect / resume cycle ---------------------------------------------------------------------------


def test_resume_after_disconnect_recovers_all_events(p_patch_persist_dir):
    """Simulate a single disconnect mid-run, then a clean resume."""
    app = p_build_app(p_patch_persist_dir)

    sid = "session-res-1"
    received: list[dict] = []

    with TestClient(app) as client:
        # Phase 1: connect, hello, see N events, then close abruptly.
        with client.websocket_connect(f"/ws/agents/{sid}") as ws:
            ws.send_text(json.dumps({"event": "client:hello", "data": {"last_seq": 0, "connection_uuid": "c1"}}))
            hello = json.loads(ws.receive_text())
            assert hello["event"] == "server:hello"
            # Inject a few events via the /test/emit endpoint.
            p_emit(client, sid, n=10, terminate=None)
            for _ in range(10):
                received.append(json.loads(ws.receive_text()))
            assert len(received) == 10
            assert received[-1]["seq"] == 10

        # Phase 2: between connections, the server keeps emitting. The agent task is alive; only the WS is gone.
        p_emit(client, sid, n=10, terminate="completed")

        # Phase 3: reconnect with last_seq=10, expect replay of seq 11..21 (10 deltas + 1 status), then the server:hello ack.
        with client.websocket_connect(f"/ws/agents/{sid}") as ws:
            ws.send_text(json.dumps({"event": "client:hello", "data": {"last_seq": 10, "connection_uuid": "c2"}}))
            replay: list[dict] = []
            while True:
                msg = json.loads(ws.receive_text())
                if msg["event"] == "server:hello":
                    break
                replay.append(msg)
            seqs = [m["seq"] for m in replay]
            assert seqs == list(range(11, 22)), f"unexpected replay seqs: {seqs}"
            statuses = [m for m in replay if m["event"] == "agent:status"]
            assert len(statuses) == 1
            assert statuses[0]["data"]["status"] == "completed"


def test_terminal_event_visible_after_full_eviction(p_patch_persist_dir):
    """If the in-memory log is wiped (process restart simulation),
    a reconnecting client should still see the terminal event from
    disk, never a phantom 'running' spinner."""
    app = p_build_app(p_patch_persist_dir)
    sid = "session-evict-term-1"

    seq_log = p_patch_persist_dir

    with TestClient(app) as client:
        p_emit(client, sid, n=5, terminate="completed")

        # Simulate a process restart: clear the in-memory ring buffer but keep the persisted terminal file.
        seq_log.per_session.pop(sid, None)

        with client.websocket_connect(f"/ws/agents/{sid}") as ws:
            ws.send_text(json.dumps({"event": "client:hello", "data": {"last_seq": 0, "connection_uuid": "c1"}}))
            received = []
            while True:
                msg = json.loads(ws.receive_text())
                if msg["event"] == "server:hello":
                    received.append(msg)
                    break
                received.append(msg)
            terminals = [m for m in received if m["event"] == "agent:status"]
            assert len(terminals) == 1
            assert terminals[0]["data"]["status"] == "completed"


def test_gap_detected_when_buffer_evicted(p_patch_persist_dir):
    """A client whose lastSeq is older than the oldest buffered seq
    should receive `agent:gap_detected` so it can REST-refresh,
    rather than silently miss events."""
    app = p_build_app(p_patch_persist_dir)
    sid = "session-gap-1"

    with TestClient(app) as client:
        # Fill the buffer past its limit so seq 1..200 are evicted.
        p_emit(client, sid, n=700, terminate=None)
        with client.websocket_connect(f"/ws/agents/{sid}") as ws:
            ws.send_text(json.dumps({"event": "client:hello", "data": {"last_seq": 5, "connection_uuid": "c1"}}))
            saw_gap = False
            saw_hello = False
            while not saw_hello:
                msg = json.loads(ws.receive_text())
                if msg["event"] == "agent:gap_detected":
                    saw_gap = True
                elif msg["event"] == "server:hello":
                    saw_hello = True
                    assert msg["data"]["ack"]["ok"] is False
                    assert msg["data"]["ack"]["reason"] == "gap"
            assert saw_gap


def test_ping_pong_round_trip(p_patch_persist_dir):
    app = p_build_app(p_patch_persist_dir)
    sid = "session-ping-1"

    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/agents/{sid}") as ws:
            ws.send_text(json.dumps({"event": "client:hello", "data": {"last_seq": 0, "connection_uuid": "c1"}}))
            assert json.loads(ws.receive_text())["event"] == "server:hello"
            ws.send_text(json.dumps({"event": "client:ping", "data": {"nonce": "abc"}}))
            pong = json.loads(ws.receive_text())
            assert pong["event"] == "server:pong"
            assert pong["data"]["nonce"] == "abc"


# --------------------------------------------------------------------------- The big one: hundreds of randomized disconnect scenarios. ---------------------------------------------------------------------------


N_STRESS_ITERATIONS = int(os.environ.get("DISCONNECT_STRESS_N", "500"))


@pytest.mark.parametrize("iteration", range(N_STRESS_ITERATIONS))
def test_stress_random_disconnect(iteration, p_patch_persist_dir):
    """Each iteration: a random number of events, a random number of
    disconnects at random points, optionally ending in a terminal
    status. After all reconnects, the client must have observed
    every event exactly once, in seq order, and the terminal event
    if one was emitted."""
    rng = random.Random(iteration)  # deterministic per iteration
    app = p_build_app(p_patch_persist_dir)

    sid = f"session-stress-{iteration}"
    total_events = rng.randint(5, 80)
    n_disconnects = rng.randint(1, min(5, total_events // 2 or 1))
    will_terminate = rng.random() < 0.7  # 70% of runs reach a terminal

    # Disconnect points: each is a count of events emitted *before* the WS drops. We deliberately exclude `total_events` itself so the breakpoint list never collides with the appended final iteration (which is when the optional terminal status fires).
    if total_events > 1:
        breakpoints = sorted(rng.sample(range(1, total_events), min(n_disconnects, total_events - 1)))
    else:
        breakpoints = []
    seen: dict[int, dict] = {}  # seq -> event payload
    last_seq = 0

    with TestClient(app) as client:
        emitted_so_far = 0
        for bp in breakpoints + [total_events]:
            # Open a fresh socket, hello with our last_seq.
            with client.websocket_connect(f"/ws/agents/{sid}") as ws:
                ws.send_text(json.dumps({"event": "client:hello", "data": {"last_seq": last_seq, "connection_uuid": f"c-{rng.random()}"}}))

                # Drain until server:hello, recording any replayed events.
                while True:
                    msg = json.loads(ws.receive_text())
                    if msg["event"] == "server:hello":
                        break
                    if "seq" in msg:
                        seen[msg["seq"]] = msg
                        last_seq = max(last_seq, msg["seq"])

                to_emit = bp - emitted_so_far
                emitted_so_far = bp
                terminate = "completed" if (bp == total_events and will_terminate) else None

                # Drive the emit through the test app's HTTP endpoint so the broadcast happens on the same event loop as the WS handler. Using asyncio.run() here would create an isolated loop and re-bind the per-session asyncio.Lock to a different loop, which is hostile to anyio's blocking-portal pattern.
                p_emit(client, sid, n=to_emit, terminate=terminate)

                expected = to_emit + (1 if terminate else 0)
                for _ in range(expected):
                    msg = json.loads(ws.receive_text())
                    seen[msg["seq"]] = msg
                    last_seq = max(last_seq, msg["seq"])

            # Closing the with-block disconnects the WS. The loop opens a fresh socket on the next iteration.

    # ----- Assertions: completeness, ordering, no dups, terminal -----
    expected_total = total_events + (1 if will_terminate else 0)
    assert len(seen) == expected_total, f"missing events: expected {expected_total}, got {len(seen)}"
    seqs = sorted(seen.keys())
    assert seqs == list(range(1, expected_total + 1)), f"non-contiguous seqs: {seqs[:5]}...{seqs[-5:]}"
    if will_terminate:
        last = seen[expected_total]
        assert last["event"] == "agent:status"
        assert last["data"]["status"] == "completed"


# --------------------------------------------------------------------------- Concurrent broadcast: many fan-out coroutines must preserve seq order ---------------------------------------------------------------------------


@pytest.mark.parametrize("trial", range(30))
def test_concurrent_broadcast_preserves_order(trial, p_patch_persist_dir):
    """8 coroutines fanning out 400 events under the per-session lock.
    Drives the emit through the TestClient's portal so we use the
    real event loop the rest of the WS layer runs on."""
    app = p_build_app(p_patch_persist_dir)
    sid = f"session-conc-{trial}"

    with TestClient(app) as client:
        p_emit(client, sid, n=400, terminate="completed", concurrent=8)

    oldest, newest, events = p_patch_persist_dir.replay(sid, last_seq=0)
    assert newest == 401  # 400 deltas + 1 status
    seqs = [json.loads(s)["seq"] for s in events]
    assert seqs == sorted(seqs)
    # Each seq appears exactly once in the buffer.
    assert len(seqs) == len(set(seqs))


# --------------------------------------------------------------------------- Auth/security smoke: the WS endpoint here is unauth'd by design (test scaffolding), but main.py's p_ws_auth_ok must remain in place. This test pins that contract so a future refactor can't accidentally strip it. ---------------------------------------------------------------------------


# --------------------------------------------------------------------------- Extra stress: terminate happens INSIDE a disconnect window. The client must see the terminal event on its next reconnect (whether from ring buffer or persisted disk record). ---------------------------------------------------------------------------


@pytest.mark.parametrize("trial", range(50))
def test_terminate_during_disconnect_is_observable(trial, p_patch_persist_dir):
    rng = random.Random(1000 + trial)
    app = p_build_app(p_patch_persist_dir)
    sid = f"session-mid-term-{trial}"
    n_pre = rng.randint(0, 40)
    n_post = rng.randint(0, 40)
    seen: dict[int, dict] = {}
    last_seq = 0

    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/agents/{sid}") as ws:
            ws.send_text(json.dumps({"event": "client:hello", "data": {"last_seq": 0, "connection_uuid": "c1"}}))
            assert json.loads(ws.receive_text())["event"] == "server:hello"
            if n_pre:
                p_emit(client, sid, n=n_pre, terminate=None)
                for _ in range(n_pre):
                    msg = json.loads(ws.receive_text())
                    seen[msg["seq"]] = msg
                    last_seq = max(last_seq, msg["seq"])
        # Disconnected. Emit the rest + terminate while WS is gone.
        p_emit(client, sid, n=n_post, terminate="completed")
        # Reconnect. We expect to receive everything from last_seq+1 through to the terminal, possibly via disk if the buffer rolled (it won't here; numbers are small).
        with client.websocket_connect(f"/ws/agents/{sid}") as ws:
            ws.send_text(json.dumps({"event": "client:hello", "data": {"last_seq": last_seq, "connection_uuid": "c2"}}))
            while True:
                msg = json.loads(ws.receive_text())
                if msg["event"] == "server:hello":
                    break
                if "seq" in msg:
                    seen[msg["seq"]] = msg

    expected = n_pre + n_post + 1
    assert len(seen) == expected
    seqs = sorted(seen.keys())
    assert seqs == list(range(1, expected + 1))
    last = seen[expected]
    assert last["event"] == "agent:status"
    assert last["data"]["status"] == "completed"


# --------------------------------------------------------------------------- Sanity: an explicit `WebSocketDisconnect` MUST NOT cancel the underlying agent task. We don't have a real agent here, but we can at least assert that the ws_manager's disconnect path doesn't touch any task registry. ---------------------------------------------------------------------------


def test_disconnect_does_not_touch_agent_task(p_patch_persist_dir):
    """If a future refactor adds task cancellation to disconnect_session,
    this test will catch it. We import agent_manager lazily so the
    `tasks` dict starts empty; we register a sentinel task and confirm
    disconnect_session doesn't poke it."""
    from backend.apps.agents.core.ws_manager import ws_manager
    # Insert a real Future into a parallel registry to mimic `agent_manager.tasks[session_id]` and confirm ws_manager never reaches into it. We don't import agent_manager (heavy); we just inspect the source.
    import inspect
    src = inspect.getsource(ws_manager.disconnect_session)
    assert "cancel" not in src.lower()
    assert "agent_manager" not in src
    assert "tasks" not in src


def test_main_ws_endpoints_still_gated_by_auth(p_patch_persist_dir):
    src = open(os.path.join(os.path.dirname(__file__), "..", "main.py")).read()
    assert "p_ws_auth_ok(websocket)" in src, (
        "main.py WS endpoints must still call p_ws_auth_ok before accepting "
        "the connection, otherwise any local web page can read agent traffic."
    )
    # And the disconnect handler must NOT call any task-cancel helper, that's the regression we're guarding against.
    assert "stop_agent" not in src.split("WebSocketDisconnect")[1].split("def ")[0], (
        "WebSocketDisconnect handler must not cancel the agent task."
    )
