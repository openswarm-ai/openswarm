from datetime import datetime
from uuid import uuid4

from typeguard import typechecked

# NOTE: Legacy dependancy. TODO: fix this shit cuh
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.dashboards.dashboards import _load, _save
from backend.apps.dashboards.models import BrowserCardPosition, BrowserTab

@typechecked
async def create_browser_card(dashboard_id: str) -> str:
    dashboard = _load(dashboard_id)
    browser_id = f"browser-{uuid4().hex[:8]}"
    tab_id = f"tab-{uuid4().hex[:8]}"
    tab = BrowserTab(id=tab_id, url="https://www.google.com", title="")
    card = BrowserCardPosition(
        browser_id=browser_id, url="https://www.google.com",
        tabs=[tab], activeTabId=tab_id, x=40, y=100, width=1280, height=800,
    )
    dashboard.layout.browser_cards[browser_id] = card
    dashboard.updated_at = datetime.now()
    _save(dashboard)
    await ws_manager.broadcast_global("dashboard:browser_card_added", {
        "dashboard_id": dashboard_id,
        "browser_card": card.model_dump(mode="json"),
    })
    return browser_id
