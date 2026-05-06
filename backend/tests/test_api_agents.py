"""REST-surface smoke tests for /api/agents.

Tests:
  - Auth: a request without the bearer token returns 401 (positive
    control on the middleware).
  - GET /sessions returns an empty list on a clean root.
  - POST /launch creates a session; subsequent GET /sessions/{id}
    succeeds; DELETE removes it.
  - POST /sessions/{id}/edit_message validates input.
  - PATCH /sessions/{id} updates allowed fields (name, system_prompt).
  - GET /history returns paginated results.
"""

from __future__ import annotations


def test_protected_route_requires_auth(app, tmp_data_dirs):
    """Positive control: hitting an agents route without auth → 401."""

    from fastapi.testclient import TestClient

    with TestClient(app) as tc:
        # No Authorization header.
        resp = tc.get("/api/agents/sessions")
    assert resp.status_code == 401


def test_list_sessions_empty(client):
    resp = client.get("/api/agents/sessions")
    assert resp.status_code == 200
    assert resp.json() == {"sessions": []}


def test_get_unknown_session_returns_404(client):
    resp = client.get("/api/agents/sessions/does-not-exist")
    assert resp.status_code == 404


def test_launch_get_delete_session(client, stub_agent_loop):
    """End-to-end REST round-trip for a session.

    Uses stub_agent_loop defensively even though `launch` itself
    doesn't kick the loop — keeps the test stable if the launch path
    is ever refactored to start streaming immediately.
    """
    launch = client.post(
        "/api/agents/launch",
        json={
            "name": "Smoke Agent",
            "model": "sonnet",
            "mode": "agent",
            "provider": "anthropic",
        },
    )
    assert launch.status_code == 200, launch.text
    session_id = launch.json()["session_id"]

    fetched = client.get(f"/api/agents/sessions/{session_id}")
    assert fetched.status_code == 200
    body = fetched.json()
    assert body["id"] == session_id
    assert body["name"] == "Smoke Agent"

    listed = client.get("/api/agents/sessions").json()["sessions"]
    assert any(s["id"] == session_id for s in listed)

    deleted = client.delete(f"/api/agents/sessions/{session_id}")
    assert deleted.status_code == 200

    gone = client.get(f"/api/agents/sessions/{session_id}")
    assert gone.status_code == 404


def test_send_message_requires_prompt(client, stub_agent_loop):
    launch = client.post(
        "/api/agents/launch",
        json={"name": "X", "model": "sonnet", "mode": "agent"},
    )
    session_id = launch.json()["session_id"]

    resp = client.post(
        f"/api/agents/sessions/{session_id}/message",
        json={"prompt": ""},
    )
    assert resp.status_code == 400


def test_edit_message_requires_id_and_content(client, stub_agent_loop):
    launch = client.post(
        "/api/agents/launch",
        json={"name": "X", "model": "sonnet", "mode": "agent"},
    )
    session_id = launch.json()["session_id"]

    missing_id = client.post(
        f"/api/agents/sessions/{session_id}/edit_message",
        json={"content": "hi"},
    )
    assert missing_id.status_code == 400

    missing_content = client.post(
        f"/api/agents/sessions/{session_id}/edit_message",
        json={"message_id": "abc"},
    )
    assert missing_content.status_code == 400


def test_patch_session_updates_name(client, stub_agent_loop):
    """PATCH /sessions/{id} only mutates the allowlist {name,
    system_prompt, thinking_level}. Anything else is silently ignored
    in `update_session` — tested implicitly by the round-trip below."""
    launch = client.post(
        "/api/agents/launch",
        json={"name": "Original", "model": "sonnet", "mode": "agent"},
    )
    session_id = launch.json()["session_id"]

    resp = client.patch(
        f"/api/agents/sessions/{session_id}",
        json={"name": "Renamed", "model": "ignored-because-not-allowed"},
    )
    assert resp.status_code == 200

    fetched = client.get(f"/api/agents/sessions/{session_id}").json()
    assert fetched["name"] == "Renamed"
    assert fetched["model"] == "sonnet"  # not changed by the PATCH


def test_history_endpoint_returns_paginated_shape(client):
    """`/history` is the search-and-resume endpoint. Even with no
    saved sessions it should return the paginated wrapper without
    error."""
    resp = client.get("/api/agents/history", params={"q": "", "limit": 5, "offset": 0})
    assert resp.status_code == 200
    body = resp.json()
    # We don't pin the exact key set here (it grows over time); just
    # that the response is a JSON object with a list-of-things in it.
    assert isinstance(body, dict)
    # The paginated wrapper does have stable keys though — assert them so
    # we catch accidental reshapes that would break the frontend's
    # history drawer.
    assert "sessions" in body and isinstance(body["sessions"], list)
    assert "total" in body
    assert "has_more" in body


# ---------------------------------------------------------------------------
# Lifecycle: stop / close / resume / duplicate / switch_branch
# ---------------------------------------------------------------------------


def _launch(client, **overrides) -> str:
    """Helper: launch a session and return its id."""
    payload = {"name": "T", "model": "sonnet", "mode": "agent"}
    payload.update(overrides)
    resp = client.post("/api/agents/launch", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["session_id"]


def test_stop_agent_marks_session_stopped(client, stub_agent_loop):
    """POST /sessions/{id}/stop transitions status to 'stopped'.

    The route is idempotent on a freshly-launched session that has no
    running task — `stop_agent` no-ops on the task side and still flips
    the status field.
    """
    session_id = _launch(client)

    resp = client.post(f"/api/agents/sessions/{session_id}/stop")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    fetched = client.get(f"/api/agents/sessions/{session_id}").json()
    assert fetched["status"] == "stopped"


def test_close_session_removes_from_active_and_lands_in_history(client, stub_agent_loop):
    """`/close` is the soft-delete path: persists the session JSON to
    disk, drops it from in-memory, and the `/history` endpoint should
    serve it back. Distinct from DELETE which is a hard purge."""
    session_id = _launch(client, name="To-Close")

    resp = client.post(f"/api/agents/sessions/{session_id}/close")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    listed = client.get("/api/agents/sessions").json()["sessions"]
    assert all(s["id"] != session_id for s in listed)

    history = client.get("/api/agents/history").json()
    assert any(item["id"] == session_id for item in history["sessions"])


def test_close_unknown_session_returns_404(client):
    resp = client.post("/api/agents/sessions/does-not-exist/close")
    assert resp.status_code == 404


def test_resume_session_restores_to_active(client, stub_agent_loop):
    """Round-trip: launch → close → resume → session is active again
    (in-memory) and gone from history."""
    session_id = _launch(client, name="To-Resume")

    close = client.post(f"/api/agents/sessions/{session_id}/close")
    assert close.status_code == 200

    resume = client.post(f"/api/agents/sessions/{session_id}/resume")
    assert resume.status_code == 200
    body = resume.json()
    assert body["session"]["id"] == session_id

    fetched = client.get(f"/api/agents/sessions/{session_id}")
    assert fetched.status_code == 200

    # `resume_session` deletes the on-disk file, so the entry should no
    # longer appear in history.
    history = client.get("/api/agents/history").json()
    assert all(item["id"] != session_id for item in history["sessions"])


def test_resume_unknown_session_returns_404(client):
    resp = client.post("/api/agents/sessions/does-not-exist/resume")
    assert resp.status_code == 404


def test_duplicate_session_returns_new_session(client, stub_agent_loop):
    """Duplicate forks the chat history into a new session id. The
    original must still be reachable; the copy gets ` (copy)` appended
    to the name."""
    original_id = _launch(client, name="Original")

    resp = client.post(f"/api/agents/sessions/{original_id}/duplicate", json={})
    assert resp.status_code == 200
    new_session = resp.json()["session"]
    assert new_session["id"] != original_id
    assert new_session["name"].endswith("(copy)")

    listed_ids = {s["id"] for s in client.get("/api/agents/sessions").json()["sessions"]}
    assert original_id in listed_ids
    assert new_session["id"] in listed_ids


def test_switch_branch_validation(client, stub_agent_loop):
    """Empty `branch_id` → 400; switching to the default `main` branch
    that always exists → 200."""
    session_id = _launch(client)

    missing = client.post(
        f"/api/agents/sessions/{session_id}/switch_branch",
        json={},
    )
    assert missing.status_code == 400

    ok = client.post(
        f"/api/agents/sessions/{session_id}/switch_branch",
        json={"branch_id": "main"},
    )
    assert ok.status_code == 200


# ---------------------------------------------------------------------------
# Routes defined directly on `app` in main.py: /compact and /clear
# ---------------------------------------------------------------------------


def test_session_compact_returns_status(client, stub_agent_loop):
    """`/compact` is a programmatic summarisation pass — no LLM call.
    On a session with < 4 messages it short-circuits with `compacted=False`
    but still returns 200."""
    session_id = _launch(client)

    resp = client.post(f"/api/agents/sessions/{session_id}/compact")
    assert resp.status_code == 200
    body = resp.json()
    assert "compacted" in body
    assert body["compacted"] is False  # short prompt, nothing to compact


def test_session_compact_unknown_returns_404(client):
    resp = client.post("/api/agents/sessions/does-not-exist/compact")
    assert resp.status_code == 404


def test_session_clear_resets_sdk_state(client, stub_agent_loop):
    """`/clear` keeps `messages` but mints a new sdk_session_id and
    resets MCPs/outputs/tokens/cost. We assert the response shape and
    that the session-level fields snap back to defaults."""
    session_id = _launch(client)

    resp = client.post(f"/api/agents/sessions/{session_id}/clear")
    assert resp.status_code == 200
    assert resp.json() == {"cleared": True}

    fetched = client.get(f"/api/agents/sessions/{session_id}").json()
    assert fetched["sdk_session_id"] is None
    assert fetched["active_mcps"] == []
    assert fetched["active_outputs"] == []
    assert fetched["tokens"] == {"input": 0, "output": 0}
    assert fetched["cost_usd"] == 0.0


def test_session_clear_unknown_returns_404(client):
    resp = client.post("/api/agents/sessions/does-not-exist/clear")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Read-only metadata endpoints
# ---------------------------------------------------------------------------


def test_browser_agent_children_empty_for_fresh_session(client, stub_agent_loop):
    session_id = _launch(client)
    resp = client.get(f"/api/agents/sessions/{session_id}/browser-agents")
    assert resp.status_code == 200
    assert resp.json() == {"sessions": []}


def test_list_models_returns_envelope(client):
    """`GET /models` returns `{"models": <dict>, "notes": <list>}`. With
    no API keys configured and 9Router down (the test environment), the
    `models` dict can legitimately be empty — the contract is the
    envelope, not the contents."""
    resp = client.get("/api/agents/models")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body.get("models"), dict)
    assert isinstance(body.get("notes"), list)


# ---------------------------------------------------------------------------
# Validation-only: generate-title, generate-group-meta, approval
#
# These routes' happy paths fan out to Anthropic / WebSocket-resolved
# events; we deliberately stop at "the route rejects bad input" so the
# tests stay hermetic. End-to-end coverage lives elsewhere.
# ---------------------------------------------------------------------------


def test_generate_title_requires_prompt(client, stub_agent_loop):
    session_id = _launch(client)
    resp = client.post(
        f"/api/agents/sessions/{session_id}/generate-title",
        json={"prompt": ""},
    )
    assert resp.status_code == 400


def test_generate_group_meta_requires_group_id_and_tool_calls(client, stub_agent_loop):
    session_id = _launch(client)

    missing_group = client.post(
        f"/api/agents/sessions/{session_id}/generate-group-meta",
        json={"tool_calls": [{"tool": "Bash"}]},
    )
    assert missing_group.status_code == 400

    missing_calls = client.post(
        f"/api/agents/sessions/{session_id}/generate-group-meta",
        json={"group_id": "g1", "tool_calls": []},
    )
    assert missing_calls.status_code == 400


def test_approval_pydantic_validation(client):
    """`/approval` is the only agents route gated by a Pydantic model —
    Pydantic returns 422 (not 400) on validation errors. We test all
    three failure modes plus a well-formed body that just no-ops because
    the request_id has no live waiter (handle_approval is best-effort)."""
    empty = client.post("/api/agents/approval", json={})
    assert empty.status_code == 422

    missing_behavior = client.post(
        "/api/agents/approval",
        json={"request_id": "abc"},
    )
    assert missing_behavior.status_code == 422

    bad_behavior = client.post(
        "/api/agents/approval",
        json={"request_id": "abc", "behavior": "maybe"},
    )
    assert bad_behavior.status_code == 422

    well_formed = client.post(
        "/api/agents/approval",
        json={"request_id": "abc", "behavior": "deny"},
    )
    assert well_formed.status_code == 200
    assert well_formed.json() == {"ok": True}


# ---------------------------------------------------------------------------
# Query parameters / launch field round-trip
# ---------------------------------------------------------------------------


def test_launch_round_trips_optional_fields(client, stub_agent_loop, tmp_path):
    """Launch with the full optional surface and assert each field
    that's actually preserved comes back out via GET.

    Note: `allowed_tools` is intentionally NOT round-tripped — the
    launch path ignores `config.allowed_tools` and resolves the tool
    set from the mode definition (`_resolve_mode`). The caller-supplied
    list is dropped on the floor; what ends up on the session is the
    mode's tool roster. See agent_manager.launch_agent for the source.
    """
    target = str(tmp_path / "workdir")
    import os as _os
    _os.makedirs(target, exist_ok=True)

    launch = client.post(
        "/api/agents/launch",
        json={
            "name": "Full",
            "model": "sonnet",
            "mode": "agent",
            "system_prompt": "be concise",
            "target_directory": target,
            "dashboard_id": "dash-test",
        },
    )
    assert launch.status_code == 200, launch.text
    session_id = launch.json()["session_id"]

    body = client.get(f"/api/agents/sessions/{session_id}").json()
    assert body["system_prompt"] == "be concise"
    assert body["dashboard_id"] == "dash-test"
    assert body["cwd"] == target
    # Mode-resolved tools are non-empty for the default "agent" mode.
    assert isinstance(body["allowed_tools"], list)
    assert len(body["allowed_tools"]) > 0


def test_list_sessions_dashboard_filter(client, stub_agent_loop):
    """`?dashboard_id=` scopes the list to one dashboard. Sessions
    without a dashboard never leak into a filtered list."""
    no_dash_id = _launch(client, name="Loose")
    in_dash_id = _launch(client, name="Pinned", dashboard_id="dash-A")

    all_sessions = client.get("/api/agents/sessions").json()["sessions"]
    assert {s["id"] for s in all_sessions} >= {no_dash_id, in_dash_id}

    filtered = client.get(
        "/api/agents/sessions",
        params={"dashboard_id": "dash-A"},
    ).json()["sessions"]
    filtered_ids = {s["id"] for s in filtered}
    assert in_dash_id in filtered_ids
    assert no_dash_id not in filtered_ids


def test_history_pagination_and_search(client, stub_agent_loop):
    """Close three sessions and exercise q / limit / offset.

    The search index is built from `name + message content`; with no
    messages, only `name` is indexable.
    """
    ids = [
        _launch(client, name=f"alpha-{i}") for i in range(3)
    ]
    for sid in ids:
        client.post(f"/api/agents/sessions/{sid}/close").raise_for_status()

    # No filter, limit=2 → first page returns 2, has_more=True.
    page1 = client.get(
        "/api/agents/history",
        params={"limit": 2, "offset": 0},
    ).json()
    assert page1["total"] == 3
    assert len(page1["sessions"]) == 2
    assert page1["has_more"] is True

    # Offset to the tail.
    page2 = client.get(
        "/api/agents/history",
        params={"limit": 2, "offset": 2},
    ).json()
    assert len(page2["sessions"]) == 1
    assert page2["has_more"] is False

    # Search restricts. "alpha" matches all three by name.
    matched = client.get(
        "/api/agents/history",
        params={"q": "alpha"},
    ).json()
    assert matched["total"] == 3

    # An obviously-absent token returns nothing.
    none = client.get(
        "/api/agents/history",
        params={"q": "zzzz-no-match-zzzz"},
    ).json()
    assert none["total"] == 0
    assert none["sessions"] == []


# ---------------------------------------------------------------------------
# Expanded PATCH coverage
# ---------------------------------------------------------------------------


def test_patch_session_updates_system_prompt(client, stub_agent_loop):
    session_id = _launch(client)
    resp = client.patch(
        f"/api/agents/sessions/{session_id}",
        json={"system_prompt": "you are a helpful otter"},
    )
    assert resp.status_code == 200
    body = client.get(f"/api/agents/sessions/{session_id}").json()
    assert body["system_prompt"] == "you are a helpful otter"


def test_patch_session_updates_thinking_level(client, stub_agent_loop):
    """`thinking_level` accepts an enum {off, low, medium, high, auto}.
    Garbage values are silently ignored by `update_session` — assert
    that round-trip behaviour."""
    session_id = _launch(client)

    accepted = client.patch(
        f"/api/agents/sessions/{session_id}",
        json={"thinking_level": "high"},
    )
    assert accepted.status_code == 200
    assert client.get(f"/api/agents/sessions/{session_id}").json()["thinking_level"] == "high"

    # Bogus enum value: the route still returns 200 (silently ignored)
    # and the previous value is preserved.
    rejected = client.patch(
        f"/api/agents/sessions/{session_id}",
        json={"thinking_level": "extreme"},
    )
    assert rejected.status_code == 200
    assert client.get(f"/api/agents/sessions/{session_id}").json()["thinking_level"] == "high"
