import json
import os
from contextlib import asynccontextmanager
from datetime import datetime
from uuid import uuid4
from pydantic import BaseModel

from backend.config.Apps import SubApp
from backend.core.db.PydanticStore import PydanticStore
from backend.core.shared_structs.dashboard.Dashboard import Dashboard
from backend.core.shared_structs.dashboard.DashboardLayout import DashboardLayout
from backend.apps.agents.agents import get_all_sessions, delete_session
from backend.apps.settings.settings import load_settings
from backend.apps.dashboards.generate_dashboard_name import generate_dashboard_name
from backend.ports import NINE_ROUTER_PORT
from swarm_debug import debug
from typing import Optional
from backend.config.paths import DB_ROOT


DASHBOARD_STORE: PydanticStore[Dashboard] = PydanticStore[Dashboard](
    model_cls=Dashboard,
    data_dir=os.path.join(DB_ROOT, "dashboards"),
    id_field="id",
    dump_mode="json",
    not_found_detail="Dashboard not found",
)

@asynccontextmanager
async def dashboards_lifespan():
    yield


dashboards = SubApp("dashboards", dashboards_lifespan)


@dashboards.router.get("/list")
async def list_dashboards():
    all_dashboards = DASHBOARD_STORE.load_all()
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


class DashboardCreate(BaseModel):
    name: str = "Untitled Dashboard"

@dashboards.router.post("/create")
async def create_dashboard(body: DashboardCreate):
    dashboard = Dashboard(name=body.name)
    DASHBOARD_STORE.save(dashboard)
    return dashboard.model_dump(mode="json")


# TODO: Maybe parse the output of get_all_sessions into actual Agent objects?
@dashboards.router.post("/{dashboard_id}/generate-name")
async def generate_name(dashboard_id: str):
    dashboard = DASHBOARD_STORE.load(dashboard_id)

    if not dashboard.auto_named and dashboard.name != "Untitled Dashboard":
        return {"name": dashboard.name, "auto_named": dashboard.auto_named}

    sessions_resp = await get_all_sessions(dashboard_id=dashboard_id)
    sessions = sessions_resp.get("SESSIONS", [])

    prompts = []
    for session in sessions:
        for msg in session.get("messages", {}).get("messages", []):
            if msg.get("role") == "user" and isinstance(msg.get("content"), str) and msg["content"].strip():
                prompts.append(msg["content"].strip()[:200])
                break

    if not prompts:
        return {"name": dashboard.name, "auto_named": dashboard.auto_named}

    settings = load_settings()
    fallback = prompts[0][:40]
    try:
        generated = await generate_dashboard_name(
            prompts=prompts,
            api_key=settings.anthropic_api_key,
            nine_router_port=NINE_ROUTER_PORT,
        )
        if generated:
            fallback = generated
    except Exception as e:
        debug(f"[dashboards.generate_name] ERROR: Dashboard name generation failed, using fallback: {e}")

    dashboard.name = fallback
    dashboard.auto_named = True
    dashboard.updated_at = datetime.now()
    DASHBOARD_STORE.save(dashboard)
    return {"name": dashboard.name, "auto_named": True}


@dashboards.router.get("/{dashboard_id}")
async def get_dashboard(dashboard_id: str):
    dashboard = DASHBOARD_STORE.load(dashboard_id)
    return dashboard.model_dump(mode="json")




class DashboardUpdate(BaseModel):
    name: Optional[str] = None
    layout: Optional[DashboardLayout] = None
    thumbnail: Optional[str] = None

@dashboards.router.put("/{dashboard_id}")
async def update_dashboard(dashboard_id: str, body: DashboardUpdate):
    dashboard = DASHBOARD_STORE.load(dashboard_id)
    if body.name is not None:
        dashboard.name = body.name
        dashboard.auto_named = False
    if body.layout is not None:
        dashboard.layout = body.layout
    if body.thumbnail is not None:
        dashboard.thumbnail = body.thumbnail
    dashboard.updated_at = datetime.now()
    DASHBOARD_STORE.save(dashboard)
    return dashboard.model_dump(mode="json")


@dashboards.router.delete("/{dashboard_id}")
async def delete_dashboard(dashboard_id: str):
    DASHBOARD_STORE.load(dashboard_id)  # confirm it exists (raises 404 if not)

    sessions_resp = await get_all_sessions(dashboard_id=dashboard_id)
    for session in sessions_resp.get("SESSIONS", []):
        try:
            await delete_session(session["session_id"])
        except Exception:
            debug(f"[dashboards.delete_dashboard] ERROR: Failed to delete session {session.get('session_id')} during dashboard deletion")

    DASHBOARD_STORE.delete(dashboard_id)
    return {"ok": True}


@dashboards.router.post("/{dashboard_id}/duplicate")
async def duplicate_dashboard(dashboard_id: str):
    source = DASHBOARD_STORE.load(dashboard_id)
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
    with open(os.path.join(DB_ROOT, "dashboards", f"{new_id}.json"), "w") as f:
        json.dump(new_dashboard, f, indent=2)

    return new_dashboard
