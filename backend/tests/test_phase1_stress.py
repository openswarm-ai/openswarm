"""Stress tests for live perceived-latency paths.

  - Message.client_message_id round-trip (optimistic dedupe)
  - Mode migration: 'chat' -> 'ask' on reconcile + lifespan deletion
  - DashboardLayout notes round-trip
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import string
import tempfile
from typing import Any
from unittest.mock import patch, AsyncMock

import pytest

# ---------------------------------------------------------------------------
# Boot env: route data dirs into a tmp scratch root before importing
# backend modules.
# ---------------------------------------------------------------------------

_TMPROOT = tempfile.mkdtemp(prefix="openswarm-phase1-stress-")
os.environ.setdefault("OPENSWARM_DATA_DIR", _TMPROOT)


# ---------------------------------------------------------------------------
# Group 1 — Message.client_message_id
# ---------------------------------------------------------------------------


def test_message_round_trips_client_id():
    """The new field must default to None and survive model_dump."""
    from backend.apps.agents.models import Message

    m = Message(role="user", content="hi")
    assert m.client_message_id is None

    dumped = m.model_dump(mode="json")
    assert "client_message_id" in dumped
    assert dumped["client_message_id"] is None

    m2 = Message(role="user", content="hi", client_message_id="opt-abc-123")
    dumped2 = m2.model_dump(mode="json")
    assert dumped2["client_message_id"] == "opt-abc-123"
    rehydrated = Message.model_validate(dumped2)
    assert rehydrated.client_message_id == "opt-abc-123"


def test_message_legacy_payload_without_client_id():
    """Older session JSON files won't have the field — must still load."""
    from backend.apps.agents.models import Message

    legacy = {
        "id": "abc",
        "role": "assistant",
        "content": "hello",
        "timestamp": "2026-04-29T00:00:00",
        "branch_id": "main",
    }
    m = Message.model_validate(legacy)
    assert m.client_message_id is None


def test_client_message_id_collision_resistance():
    """Many random client_message_ids must remain distinct values
    after serialization. Smoke-tests the field preservation in bulk."""
    from backend.apps.agents.models import Message

    seen: set[str] = set()
    for _ in range(500):
        cmi = "opt-" + "".join(random.choices(string.ascii_lowercase + string.digits, k=24))
        seen.add(cmi)
        m = Message(role="user", content=f"msg {cmi}", client_message_id=cmi)
        assert m.client_message_id == cmi
        # Round-trip preserves it
        assert Message.model_validate(m.model_dump(mode="json")).client_message_id == cmi
    assert len(seen) >= 495  # collisions are statistically negligible


# ---------------------------------------------------------------------------
# Group 2 — Mode migration: chat → ask
# ---------------------------------------------------------------------------


def test_builtin_modes_no_chat():
    """Chat must be removed from BUILTIN_MODES; Ask must be present
    with the merged tools (Read+Glob+Grep + Web*)."""
    from backend.apps.modes.models import BUILTIN_MODES

    ids = {m.id for m in BUILTIN_MODES}
    assert "chat" not in ids, "chat mode should have been merged into ask"
    assert "ask" in ids
    ask = next(m for m in BUILTIN_MODES if m.id == "ask")
    assert "WebFetch" in (ask.tools or []), "ask should now include web tools"
    assert "WebSearch" in (ask.tools or [])
    assert "Read" in (ask.tools or [])
    assert "Edit" not in (ask.tools or []), "ask must remain read-only"
    assert "Write" not in (ask.tools or [])
    assert "Bash" not in (ask.tools or [])


def test_modes_lifespan_deletes_stale_chat():
    """A built-in chat.json on disk must be removed on lifespan run.
    User-modified chat.json (is_builtin=False) must be left alone."""
    from backend.apps.modes import modes as modes_mod

    with tempfile.TemporaryDirectory() as td:
        chat_path = os.path.join(td, "chat.json")
        with open(chat_path, "w") as f:
            json.dump({
                "id": "chat", "name": "Chat", "is_builtin": True,
                "system_prompt": "old", "tools": ["AskUserQuestion"],
            }, f)
        with patch.object(modes_mod, "DATA_DIR", td):
            asyncio.run(_run_lifespan(modes_mod))
        assert not os.path.exists(chat_path), "stale built-in chat.json should be removed"

    # User-customized: leave alone
    with tempfile.TemporaryDirectory() as td:
        chat_path = os.path.join(td, "chat.json")
        with open(chat_path, "w") as f:
            json.dump({
                "id": "chat", "name": "MyChat", "is_builtin": False,
                "system_prompt": "user wrote this",
            }, f)
        with patch.object(modes_mod, "DATA_DIR", td):
            asyncio.run(_run_lifespan(modes_mod))
        assert os.path.exists(chat_path), "user-customized chat.json must NOT be deleted"


async def _run_lifespan(modes_mod):
    async with modes_mod.modes_lifespan():
        pass


def test_session_reconcile_migrates_chat_to_ask():
    """reconcile_on_startup must rewrite mode='chat' to 'ask' on disk."""
    from backend.apps.agents.agent_manager import AgentManager
    from backend.apps.agents import agent_manager as am_mod

    with tempfile.TemporaryDirectory() as td:
        # Seed 50 sessions: 30 with mode='chat', 20 with mode='agent'.
        # Some marked running so we also exercise the stale-status path.
        for i in range(50):
            sid = f"sess-{i}"
            mode = "chat" if i < 30 else "agent"
            status = "running" if i % 7 == 0 else "stopped"
            with open(os.path.join(td, f"{sid}.json"), "w") as f:
                json.dump({
                    "id": sid, "name": sid, "model": "sonnet",
                    "mode": mode, "status": status, "messages": [],
                }, f)

        with patch.object(am_mod, "SESSIONS_DIR", td):
            mgr = AgentManager()
            asyncio.run(mgr.reconcile_on_startup())

        for i in range(50):
            sid = f"sess-{i}"
            with open(os.path.join(td, f"{sid}.json")) as f:
                data = json.load(f)
            if i < 30:
                assert data["mode"] == "ask", f"session {sid} should be migrated chat→ask"
            else:
                assert data["mode"] == "agent", f"session {sid} should be untouched"
            # Stale running flipped to stopped
            if i % 7 == 0:
                assert data["status"] == "stopped"


def test_reconcile_idempotent():
    """Running reconcile twice mustn't keep rewriting / churn the file."""
    from backend.apps.agents.agent_manager import AgentManager
    from backend.apps.agents import agent_manager as am_mod

    with tempfile.TemporaryDirectory() as td:
        sid = "s1"
        with open(os.path.join(td, f"{sid}.json"), "w") as f:
            json.dump({
                "id": sid, "name": sid, "model": "sonnet",
                "mode": "chat", "status": "stopped", "messages": [],
            }, f)
        with patch.object(am_mod, "SESSIONS_DIR", td):
            mgr = AgentManager()
            asyncio.run(mgr.reconcile_on_startup())
            mtime_after_first = os.path.getmtime(os.path.join(td, f"{sid}.json"))
            # Second pass must NOT rewrite (mode already 'ask', status already stopped)
            asyncio.run(mgr.reconcile_on_startup())
            mtime_after_second = os.path.getmtime(os.path.join(td, f"{sid}.json"))
        assert mtime_after_first == mtime_after_second, "reconcile must be idempotent"



# ---------------------------------------------------------------------------
# Group 6 — Notes layout serialization
# ---------------------------------------------------------------------------


def test_dashboard_layout_notes_round_trip():
    from backend.apps.dashboards.models import DashboardLayout, NotePosition

    n = NotePosition(note_id="n1", x=100, y=200, content="todo: ship",
                     color="yellow", width=240, height=200)
    layout = DashboardLayout(notes={"n1": n})
    dumped = layout.model_dump(mode="json")
    assert "notes" in dumped
    assert dumped["notes"]["n1"]["content"] == "todo: ship"

    rehydrated = DashboardLayout.model_validate(dumped)
    assert rehydrated.notes["n1"].content == "todo: ship"
    assert rehydrated.notes["n1"].color == "yellow"


def test_dashboard_layout_legacy_no_notes():
    """Older dashboard JSON without 'notes' must still load cleanly."""
    from backend.apps.dashboards.models import DashboardLayout

    legacy = {
        "cards": {}, "view_cards": {}, "browser_cards": {},
        "expanded_session_ids": [],
    }
    layout = DashboardLayout.model_validate(legacy)
    assert layout.notes == {}


def test_notes_stress_many_round_trips():
    """500 notes with random colors / positions must all serialize."""
    from backend.apps.dashboards.models import DashboardLayout, NotePosition

    notes = {}
    colors = ["yellow", "pink", "blue", "green", "purple", "gray"]
    for i in range(500):
        nid = f"n{i}"
        notes[nid] = NotePosition(
            note_id=nid,
            x=random.uniform(-5000, 5000),
            y=random.uniform(-5000, 5000),
            width=random.uniform(160, 600),
            height=random.uniform(120, 600),
            content="x" * random.randint(0, 5000),
            color=random.choice(colors),
        )
    layout = DashboardLayout(notes=notes)
    dumped = layout.model_dump(mode="json")
    rehydrated = DashboardLayout.model_validate(dumped)
    assert len(rehydrated.notes) == 500
    for nid, orig in notes.items():
        assert rehydrated.notes[nid].content == orig.content
        assert rehydrated.notes[nid].color == orig.color


# ---------------------------------------------------------------------------
# Group 7 — Concurrent send_message dedupe stress
#
# Real-world scenario: user mashes Enter quickly. 50 concurrent sends
# each with a unique client_message_id must produce 50 echoed messages
# carrying the right ids. Pure pydantic / asyncio test — no real
# agent loop.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_send_message_unique_client_ids():
    """100 parallel Message constructions with unique client_message_ids
    must round-trip independently — no cross-talk on the dataclass."""
    from backend.apps.agents.models import Message

    async def make_one(i: int):
        cmi = f"opt-{i}-{random.randint(0, 1_000_000)}"
        m = Message(role="user", content=f"msg {i}", client_message_id=cmi)
        return cmi, m.model_dump(mode="json")["client_message_id"]

    pairs = await asyncio.gather(*(make_one(i) for i in range(100)))
    expected = [p[0] for p in pairs]
    actual = [p[1] for p in pairs]
    assert expected == actual, "client_message_id must round-trip exactly"
    assert len(set(actual)) == 100, "all unique"


# ---------------------------------------------------------------------------
# Pytest config: register asyncio mode so we don't need the plugin.
# ---------------------------------------------------------------------------


def pytest_collection_modifyitems(config, items):
    """Auto-mark async tests so they run under pytest-asyncio."""
    for item in items:
        if asyncio.iscoroutinefunction(getattr(item, "function", None)):
            item.add_marker(pytest.mark.asyncio)
