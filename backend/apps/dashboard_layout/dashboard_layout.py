import json
import os
import logging
from contextlib import asynccontextmanager
from backend.config.Apps import SubApp
from backend.apps.dashboard_layout.models import DashboardLayout, DashboardLayoutUpdate

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "dashboard_layout")
LAYOUT_FILE = os.path.join(DATA_DIR, "layout.json")


@asynccontextmanager
async def dashboard_layout_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    yield


dashboard_layout = SubApp("dashboard_layout", dashboard_layout_lifespan)


def _default_layout() -> DashboardLayout:
    return DashboardLayout(cards={})


def _load() -> DashboardLayout:
    if not os.path.exists(LAYOUT_FILE):
        return _default_layout()
    try:
        with open(LAYOUT_FILE) as f:
            data = json.load(f)
        if "columns" in data and "cards" not in data:
            logger.info("Detected old column-based layout format, resetting to empty canvas")
            return _default_layout()
        return DashboardLayout(**data)
    except Exception:
        logger.exception("Failed to load dashboard layout, returning default")
        return _default_layout()


def _save(layout: DashboardLayout):
    with open(LAYOUT_FILE, "w") as f:
        json.dump(layout.model_dump(), f, indent=2)


@dashboard_layout.router.get("")
async def get_layout():
    layout = _load()
    return layout.model_dump()


@dashboard_layout.router.put("")
async def update_layout(body: DashboardLayoutUpdate):
    layout = DashboardLayout(cards=body.cards, view_cards=body.view_cards)
    _save(layout)
    return layout.model_dump()
