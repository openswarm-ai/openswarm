"""CRUD smoke for /api/dashboards.

Dashboards are the spatial canvas units. Each holds a `DashboardLayout`
(positions for agent/view/browser cards + sticky notes). Sessions are
tagged with `dashboard_id` so deleting a dashboard cascades into its
sessions.

Tests:
  - lifespan migration creates "Dashboard 1" on a fresh boot
  - create / get / update (name + layout) / duplicate / delete round-trip
  - delete cascades into SESSIONS_DIR (sessions tagged with the
    dashboard id are removed from disk)
  - seed-demo lays down a session JSON with two messages
"""

from __future__ import annotations

import json
import os


def test_lifespan_seeds_default_dashboard(client):
    """First boot with no existing dashboards creates 'Dashboard 1'."""
    resp = client.get("/api/dashboards/list")
    assert resp.status_code == 200
    items = resp.json()["dashboards"]
    assert len(items) >= 1
    assert any(d["name"] == "Dashboard 1" for d in items)


def test_create_get_update_delete_dashboard(client):
    create = client.post(
        "/api/dashboards/create",
        json={"name": "Project Alpha"},
    )
    assert create.status_code == 200
    dashboard_id = create.json()["id"]

    fetched = client.get(f"/api/dashboards/{dashboard_id}")
    assert fetched.status_code == 200
    assert fetched.json()["name"] == "Project Alpha"

    # Renaming flips auto_named → False (per dashboards.py:275).
    update = client.put(
        f"/api/dashboards/{dashboard_id}",
        json={"name": "Project Beta"},
    )
    assert update.status_code == 200
    body = update.json()
    assert body["name"] == "Project Beta"
    assert body["auto_named"] is False

    deleted = client.delete(f"/api/dashboards/{dashboard_id}")
    assert deleted.status_code == 200

    gone = client.get(f"/api/dashboards/{dashboard_id}")
    assert gone.status_code == 404


def test_dashboard_layout_field_round_trip(client):
    """PUT the `layout` field on a dashboard with a sticky note and
    assert it survives a re-fetch via /api/dashboards/{id}.

    Named `_field_` (not `_dashboard_layout_`) to make clear this exercises
    the `layout` attribute of the live `Dashboard` model — not the legacy
    `backend.apps.dashboard_layout` package, which was removed.
    """
    create = client.post("/api/dashboards/create", json={"name": "L"})
    dashboard_id = create.json()["id"]

    layout = {
        "cards": {},
        "view_cards": {},
        "browser_cards": {},
        "notes": {
            "n1": {
                "note_id": "n1",
                "x": 100,
                "y": 200,
                "width": 240,
                "height": 200,
                "content": "test note",
                "color": "yellow",
            }
        },
        "expanded_session_ids": [],
    }
    resp = client.put(
        f"/api/dashboards/{dashboard_id}",
        json={"layout": layout},
    )
    assert resp.status_code == 200

    refetched = client.get(f"/api/dashboards/{dashboard_id}")
    assert refetched.json()["layout"]["notes"]["n1"]["content"] == "test note"


def test_duplicate_dashboard(client):
    create = client.post("/api/dashboards/create", json={"name": "Source"})
    dashboard_id = create.json()["id"]

    dup = client.post(f"/api/dashboards/{dashboard_id}/duplicate")
    assert dup.status_code == 200
    body = dup.json()
    assert body["id"] != dashboard_id
    assert body["name"] == "Source (copy)"


def test_delete_dashboard_cascades_to_sessions(client):
    """Sessions tagged with dashboard_id must be removed on delete.

    Drops a fake session file straight onto SESSIONS_DIR (no agent
    spawn needed) and verifies the cascade in `delete_dashboard`.
    """
    from backend.config.paths import SESSIONS_DIR

    create = client.post("/api/dashboards/create", json={"name": "Cascade"})
    dashboard_id = create.json()["id"]

    os.makedirs(SESSIONS_DIR, exist_ok=True)
    session_id = "fake-session-cascade"
    session_path = os.path.join(SESSIONS_DIR, f"{session_id}.json")
    with open(session_path, "w") as f:
        json.dump(
            {
                "id": session_id,
                "name": "junk",
                "dashboard_id": dashboard_id,
                "messages": [],
                "branches": {},
                "active_branch_id": "main",
                "created_at": "2026-01-01T00:00:00",
            },
            f,
        )
    assert os.path.exists(session_path)

    deleted = client.delete(f"/api/dashboards/{dashboard_id}")
    assert deleted.status_code == 200

    assert not os.path.exists(session_path), (
        "session file tagged with deleted dashboard should be removed"
    )


def test_seed_demo_creates_session(client):
    from backend.config.paths import SESSIONS_DIR

    create = client.post("/api/dashboards/create", json={"name": "Demo"})
    dashboard_id = create.json()["id"]

    resp = client.post(f"/api/dashboards/{dashboard_id}/seed-demo")
    assert resp.status_code == 200
    session_id = resp.json()["session_id"]

    session_path = os.path.join(SESSIONS_DIR, f"{session_id}.json")
    assert os.path.exists(session_path)

    with open(session_path) as f:
        data = json.load(f)
    assert data["dashboard_id"] == dashboard_id
    assert len(data["messages"]) == 2  # canned welcome conversation
