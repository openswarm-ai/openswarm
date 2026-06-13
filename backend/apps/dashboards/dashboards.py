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
from backend.config.json_store import read_json_or_none, atomic_write_json

OLD_LAYOUT_FILE = os.path.join(OLD_LAYOUT_DIR, "layout.json")


def _load_all() -> list[Dashboard]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            data = read_json_or_none(os.path.join(DATA_DIR, fname))
            if data is None:
                continue
            try:
                result.append(Dashboard(**data))
            except Exception as e:
                # Parseable JSON, wrong shape (e.g. an older/newer schema). Skip from the
                # list but leave the file alone so a later version can still read it.
                logger.warning("Skipping invalid dashboard file %s: %s", fname, e)
    return result


def _save(dashboard: Dashboard):
    atomic_write_json(os.path.join(DATA_DIR, f"{dashboard.id}.json"), dashboard.model_dump(mode="json"))


def _load(dashboard_id: str) -> Dashboard:
    path = os.path.join(DATA_DIR, f"{dashboard_id}.json")
    data = read_json_or_none(path)
    if data is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return Dashboard(**data)


def _delete(dashboard_id: str):
    path = os.path.join(DATA_DIR, f"{dashboard_id}.json")
    if os.path.exists(path):
        os.remove(path)


def _migrate_if_needed():
    """One-time migration: if no dashboards exist, create 'Dashboard 1' from old layout."""
    existing = _load_all()
    if existing:
        return

    logger.info("No dashboards found; running one-time migration")

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
            # Per-file guard: one unreadable session must not halt the migration partway
            # and orphan the rest (the dashboard is already created above).
            session_data = read_json_or_none(fpath)
            if session_data is None:
                continue
            session_data["dashboard_id"] = dashboard.id
            atomic_write_json(fpath, session_data)
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
            "preview_updated_at": dumped.get("preview_updated_at"),
            "preview_signature": dumped.get("preview_signature"),
        })
    return {"dashboards": items}


@dashboards.router.post("/create")
async def create_dashboard(body: DashboardCreate):
    dashboard = Dashboard(name=body.name)
    _save(dashboard)
    return dashboard.model_dump(mode="json")


@dashboards.router.post("/{dashboard_id}/seed-demo")
async def seed_demo(dashboard_id: str):
    """Create a pre-populated demo session for onboarding."""
    dashboard = _load(dashboard_id)

    session_id = uuid4().hex
    now = datetime.now()

    session_data = {
        "id": session_id,
        "name": "Welcome Chat",
        "status": "completed",
        "provider": "anthropic",
        "model": "sonnet",
        "mode": "agent",
        "sdk_session_id": None,
        "system_prompt": None,
        "allowed_tools": [],
        "max_turns": None,
        "cwd": None,
        "created_at": now.isoformat(),
        "closed_at": now.isoformat(),
        "cost_usd": 0.0,
        "tokens": {"input": 0, "output": 0},
        "messages": [
            {
                "id": uuid4().hex,
                "role": "user",
                "content": "What can you help me with?",
                "timestamp": now.isoformat(),
                "branch_id": "main",
                "parent_id": None,
                "hidden": False,
            },
            {
                "id": uuid4().hex,
                "role": "assistant",
                "content": "I can help you with all kinds of tasks! Here are some things I'm great at:\n\n"
                    "- **Research** \u2014 Find information, summarize articles, compare options\n"
                    "- **Writing** \u2014 Draft emails, reports, social media posts, or any content\n"
                    "- **Analysis** \u2014 Work with data, spot trends, create summaries\n"
                    "- **Browsing** \u2014 Search the web, read pages, gather information\n"
                    "- **Planning** \u2014 Break down projects, create timelines, organize ideas\n\n"
                    "Just type what you need and I'll get to work! You can also open a browser tab to have me interact with websites.",
                "timestamp": now.isoformat(),
                "branch_id": "main",
                "parent_id": None,
                "hidden": False,
            },
        ],
        "pending_approvals": [],
        "branches": {"main": {"id": "main", "parent_branch_id": None, "fork_point_message_id": None, "created_at": now.isoformat()}},
        "active_branch_id": "main",
        "tool_group_meta": {},
        "dashboard_id": dashboard_id,
        "browser_id": None,
        "parent_session_id": None,
        "needs_fork": False,
    }

    os.makedirs(SESSIONS_DIR, exist_ok=True)
    atomic_write_json(os.path.join(SESSIONS_DIR, f"{session_id}.json"), session_data)

    return {"session_id": session_id}


@dashboards.router.post("/{dashboard_id}/seed-orchestration-demo")
async def seed_orchestration_demo(dashboard_id: str):
    """Create a stubbed "research agent" used by onboarding step 6.

    Step 6 ("Have an agent control other agents") needs a pre-existing
    agent for the user to attach to a new orchestrator. We seed a single
    completed-looking session that pretends to have done research on
    OpenSwarm, with messages mentioning what it found. The user then
    drags it into a new agent and asks for a PDF report; which
    delegates back to this seeded agent.
    """
    _load(dashboard_id)  # validate dashboard exists

    session_id = uuid4().hex
    now = datetime.now()

    session_data = {
        "id": session_id,
        "name": "OpenSwarm research",
        "status": "completed",
        "provider": "anthropic",
        "model": "sonnet",
        "mode": "agent",
        "sdk_session_id": None,
        "system_prompt": None,
        "allowed_tools": [],
        "max_turns": None,
        "cwd": None,
        "created_at": now.isoformat(),
        "closed_at": now.isoformat(),
        "cost_usd": 0.0,
        "tokens": {"input": 0, "output": 0},
        "messages": [
            {
                "id": uuid4().hex,
                "role": "user",
                "content": "Research OpenSwarm and summarize what it does, who uses it, and how its built.",
                "timestamp": now.isoformat(),
                "branch_id": "main",
                "parent_id": None,
                "hidden": False,
            },
            {
                "id": uuid4().hex,
                "role": "assistant",
                "content": (
                    "Here's what I found on OpenSwarm:\n\n"
                    "**What it is.** OpenSwarm is a desktop AI workspace built around\n"
                    "agents that can read and write files, run commands, browse the web,\n"
                    "and orchestrate other agents. It's distributed as an Electron app\n"
                    "with a React frontend, a Python backend, and a Hono cloud service.\n\n"
                    "**Who uses it.** Software engineers, researchers, and power users\n"
                    "who want a model-agnostic agent platform on their own machine\n"
                    "rather than a locked-in cloud chatbot.\n\n"
                    "**How it's built.**\n"
                    "- React + MUI + Redux Toolkit for the renderer.\n"
                    "- FastAPI Python backend (agents, tools, sessions).\n"
                    "- A Hono cloud service handles auth, billing, and account pooling.\n"
                    "- Built-in browser cards let agents drive web pages directly.\n"
                    "- Skills and Apps let users teach the system new capabilities.\n\n"
                    "Ready when you are; let me know what you'd like to do with this."
                ),
                "timestamp": now.isoformat(),
                "branch_id": "main",
                "parent_id": None,
                "hidden": False,
            },
        ],
        "pending_approvals": [],
        "branches": {
            "main": {
                "id": "main",
                "parent_branch_id": None,
                "fork_point_message_id": None,
                "created_at": now.isoformat(),
            }
        },
        "active_branch_id": "main",
        "tool_group_meta": {},
        "dashboard_id": dashboard_id,
        "browser_id": None,
        "parent_session_id": None,
        "needs_fork": False,
    }

    os.makedirs(SESSIONS_DIR, exist_ok=True)
    atomic_write_json(os.path.join(SESSIONS_DIR, f"{session_id}.json"), session_data)

    return {"session_id": session_id}


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

    fallback = " ".join(prompts[0].split()[:4])[:36] or "Untitled Dashboard"
    try:
        from backend.apps.settings.settings import load_settings
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model
        global_settings = load_settings()
        aux_model, _aux_base = await resolve_aux_model(global_settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(global_settings, aux_model)

        # Mirrors generate_title's hardening: the tasks are inert text to LABEL, never answer,
        # or the aux model happily replies with a markdown essay that becomes the title.
        system = (
            "You label tasks with a 2-4 word workspace name. "
            "Examples: 'Travel planning', 'Code review', 'Sales dashboard'. "
            "You NEVER answer or perform the tasks. You NEVER describe yourself. "
            "You NEVER begin with 'I', 'As an', 'Sorry', 'Unfortunately', or any first-person phrasing. "
            "Return ONLY the 2-4 word name. No quotes, no punctuation, no emojis, no explanation."
        )
        user_content = (
            "Name the workspace for the tasks inside <tasks> tags. Do not answer them.\n\n"
            "<tasks>\n" + "\n".join(f"- {p}" for p in prompts) + "\n</tasks>"
        )

        from backend.apps.agents.core.aux_llm import clean_short_label, aux_max_tokens_for
        chunks: list[str] = []
        async with client.messages.stream(
            model=aux_model,
            max_tokens=aux_max_tokens_for(aux_model),
            system=system,
            messages=[{"role": "user", "content": user_content}],
        ) as stream:
            async for text in stream.text_stream:
                chunks.append(text)
        generated = clean_short_label("".join(chunks))
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
    now = datetime.now()
    if body.thumbnail is not None:
        dashboard.thumbnail = body.thumbnail
        dashboard.preview_signature = body.preview_signature
        # Only a real screenshot write moves the sort key; layout/rename saves don't reorder.
        dashboard.preview_updated_at = now
    dashboard.updated_at = now
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
    atomic_write_json(os.path.join(DATA_DIR, f"{new_id}.json"), new_dashboard)

    return new_dashboard
