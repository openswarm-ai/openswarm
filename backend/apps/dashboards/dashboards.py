import json
import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from uuid import uuid4

from backend.config.Apps import SubApp
from backend.apps.dashboards.models import (
    Dashboard,
    DashboardCreate,
    DashboardUpdate,
    DashboardLayout,
    CardPosition,
    ViewCardPosition,
)
from fastapi import HTTPException

logger = logging.getLogger(__name__)

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(BACKEND_DIR, "data", "dashboards")
SESSIONS_DIR = os.path.join(BACKEND_DIR, "data", "sessions")

OLD_LAYOUT_DIR = os.path.join(BACKEND_DIR, "data", "dashboard_layout")
OLD_LAYOUT_FILE = os.path.join(OLD_LAYOUT_DIR, "layout.json")


def _load_all() -> list[Dashboard]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(DATA_DIR, fname)) as f:
                result.append(Dashboard(**json.load(f)))
    return result


def _save(dashboard: Dashboard):
    with open(os.path.join(DATA_DIR, f"{dashboard.id}.json"), "w") as f:
        json.dump(dashboard.model_dump(mode="json"), f, indent=2)


def _load(dashboard_id: str) -> Dashboard:
    path = os.path.join(DATA_DIR, f"{dashboard_id}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Dashboard not found")
    with open(path) as f:
        return Dashboard(**json.load(f))


def _delete(dashboard_id: str):
    path = os.path.join(DATA_DIR, f"{dashboard_id}.json")
    if os.path.exists(path):
        os.remove(path)


def _migrate_if_needed():
    """One-time migration: if no dashboards exist, create 'Dashboard 1' from old layout."""
    existing = _load_all()
    if existing:
        return

    logger.info("No dashboards found — running one-time migration")

    layout = DashboardLayout()
    if os.path.exists(OLD_LAYOUT_FILE):
        try:
            with open(OLD_LAYOUT_FILE) as f:
                data = json.load(f)
            if "cards" in data:
                layout = DashboardLayout(**data)
                logger.info("Migrated layout from old layout.json")
        except Exception:
            logger.exception("Failed to read old layout.json, using empty layout")

    dashboard = Dashboard(name="Dashboard 1", layout=layout)
    _save(dashboard)
    logger.info(f"Created default dashboard: {dashboard.id}")

    if os.path.exists(SESSIONS_DIR):
        count = 0
        for fname in os.listdir(SESSIONS_DIR):
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(SESSIONS_DIR, fname)
            with open(fpath) as f:
                session_data = json.load(f)
            session_data["dashboard_id"] = dashboard.id
            with open(fpath, "w") as f:
                json.dump(session_data, f, indent=2)
            count += 1
        if count:
            logger.info(f"Tagged {count} existing chat sessions with dashboard_id={dashboard.id}")


@asynccontextmanager
async def dashboards_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    _migrate_if_needed()
    yield


dashboards = SubApp("dashboards", dashboards_lifespan)


@dashboards.router.get("/list")
async def list_dashboards():
    all_dashboards = _load_all()
    all_dashboards.sort(key=lambda d: d.updated_at or d.created_at, reverse=True)
    items = []
    for d in all_dashboards:
        dumped = d.model_dump(mode="json")
        items.append({
            "id": dumped["id"],
            "name": dumped.get("name", "Untitled"),
            "created_at": dumped.get("created_at"),
            "updated_at": dumped.get("updated_at"),
        })
    return {"dashboards": items}


@dashboards.router.post("/create")
async def create_dashboard(body: DashboardCreate):
    dashboard = Dashboard(name=body.name)
    _save(dashboard)
    return dashboard.model_dump(mode="json")


@dashboards.router.get("/{dashboard_id}")
async def get_dashboard(dashboard_id: str):
    dashboard = _load(dashboard_id)
    return dashboard.model_dump(mode="json")


@dashboards.router.put("/{dashboard_id}")
async def update_dashboard(dashboard_id: str, body: DashboardUpdate):
    dashboard = _load(dashboard_id)
    if body.name is not None:
        dashboard.name = body.name
    if body.layout is not None:
        dashboard.layout = body.layout
    dashboard.updated_at = datetime.now()
    _save(dashboard)
    return dashboard.model_dump(mode="json")


@dashboards.router.delete("/{dashboard_id}")
async def delete_dashboard(dashboard_id: str):
    _load(dashboard_id)

    if os.path.exists(SESSIONS_DIR):
        for fname in os.listdir(SESSIONS_DIR):
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(SESSIONS_DIR, fname)
            try:
                with open(fpath) as f:
                    data = json.load(f)
                if data.get("dashboard_id") == dashboard_id:
                    os.remove(fpath)
            except Exception:
                logger.warning(f"Failed to read/delete session file {fname}")

    from backend.apps.agents.agent_manager import agent_manager
    to_remove = [
        sid for sid, sess in agent_manager.sessions.items()
        if getattr(sess, "dashboard_id", None) == dashboard_id
    ]
    for sid in to_remove:
        try:
            await agent_manager.delete_session(sid)
        except Exception:
            logger.warning(f"Failed to delete active session {sid} during dashboard deletion")

    _delete(dashboard_id)
    return {"ok": True}


@dashboards.router.post("/{dashboard_id}/duplicate")
async def duplicate_dashboard(dashboard_id: str):
    source = _load(dashboard_id)
    source_data = source.model_dump(mode="json")
    new_id = uuid4().hex
    now = datetime.now().isoformat()

    new_dashboard = {
        **source_data,
        "id": new_id,
        "name": f"{source_data.get('name', 'Untitled')} (copy)",
        "created_at": now,
        "updated_at": now,
        "layout": {"cards": {}, "view_cards": source_data.get("layout", {}).get("view_cards", {})},
    }
    with open(os.path.join(DATA_DIR, f"{new_id}.json"), "w") as f:
        json.dump(new_dashboard, f, indent=2)

    return new_dashboard
