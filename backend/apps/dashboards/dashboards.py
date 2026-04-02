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
    BrowserCardPosition,
)
from fastapi import HTTPException

logger = logging.getLogger(__name__)

from backend.config.paths import DASHBOARDS_DIR as DATA_DIR, SESSIONS_DIR, DASHBOARD_LAYOUT_DIR as OLD_LAYOUT_DIR

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
            "auto_named": dumped.get("auto_named", False),
            "created_at": dumped.get("created_at"),
            "updated_at": dumped.get("updated_at"),
            "thumbnail": dumped.get("thumbnail"),
        })
    return {"dashboards": items}


@dashboards.router.post("/create")
async def create_dashboard(body: DashboardCreate):
    from backend.apps.analytics.collector import record as _analytics
    dashboard = Dashboard(name=body.name)
    _save(dashboard)
    _analytics("dashboard.created", {"name": dashboard.name}, dashboard_id=dashboard.id)
    return dashboard.model_dump(mode="json")


@dashboards.router.post("/{dashboard_id}/generate-name")
async def generate_name(dashboard_id: str):
    dashboard = _load(dashboard_id)

    if not dashboard.auto_named and dashboard.name != "Untitled Dashboard":
        return {"name": dashboard.name, "auto_named": dashboard.auto_named}

    from backend.apps.agents.agent_manager import agent_manager

    prompts = []
    for session in agent_manager.sessions.values():
        if getattr(session, "dashboard_id", None) != dashboard_id:
            continue
        for msg in session.messages:
            if msg.role == "user" and isinstance(msg.content, str) and msg.content.strip():
                prompts.append(msg.content.strip()[:200])
                break

    if not prompts:
        return {"name": dashboard.name, "auto_named": dashboard.auto_named}

    fallback = prompts[0][:40]
    try:
        from backend.apps.settings.settings import load_settings
        from backend.apps.settings.credentials import get_anthropic_client
        global_settings = load_settings()
        client = get_anthropic_client(global_settings)

        if len(prompts) == 1:
            system = (
                "Generate a short, clear 2-4 word workspace name based on this task. "
                "Use plain language like 'Travel Planning', 'Code Review', 'Sales Dashboard'. "
                "No quotes, no punctuation, no emojis. Return only the name."
            )
            user_content = prompts[0]
        else:
            system = (
                "Generate a short, clear 2-4 word workspace name that captures the theme of these tasks. "
                "Use plain language like 'Research & Analysis', 'Content Creation', 'Project Setup'. "
                "No quotes, no punctuation, no emojis. Return only the name."
            )
            user_content = "\n".join(f"- {p}" for p in prompts)

        resp = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=30,
            system=system,
            messages=[{"role": "user", "content": user_content}],
        )
        generated = resp.content[0].text.strip().strip('"\'')
        if generated:
            fallback = generated
    except Exception as e:
        logger.warning(f"Dashboard name generation failed, using fallback: {e}")

    dashboard.name = fallback
    dashboard.auto_named = True
    dashboard.updated_at = datetime.now()
    _save(dashboard)
    return {"name": dashboard.name, "auto_named": True}


@dashboards.router.get("/{dashboard_id}")
async def get_dashboard(dashboard_id: str):
    dashboard = _load(dashboard_id)
    return dashboard.model_dump(mode="json")


@dashboards.router.put("/{dashboard_id}")
async def update_dashboard(dashboard_id: str, body: DashboardUpdate):
    dashboard = _load(dashboard_id)
    if body.name is not None:
        dashboard.name = body.name
        dashboard.auto_named = False
    if body.layout is not None:
        dashboard.layout = body.layout
    if body.thumbnail is not None:
        dashboard.thumbnail = body.thumbnail
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
        "layout": {
            "cards": {},
            "view_cards": source_data.get("layout", {}).get("view_cards", {}),
            "browser_cards": source_data.get("layout", {}).get("browser_cards", {}),
        },
    }
    with open(os.path.join(DATA_DIR, f"{new_id}.json"), "w") as f:
        json.dump(new_dashboard, f, indent=2)

    return new_dashboard
