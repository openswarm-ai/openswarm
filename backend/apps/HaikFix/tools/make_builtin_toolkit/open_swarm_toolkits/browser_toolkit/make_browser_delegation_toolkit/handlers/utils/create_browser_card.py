from datetime import datetime
from uuid import uuid4

from typeguard import typechecked
from typing import Optional

from backend.apps.dashboards.dashboards import _load, _save
from backend.apps.dashboards.models import BrowserCardPosition, BrowserTab
from backend.apps.HaikFix.Agent.shared_structs.events import EventCallback, BrowserCardAddedEvent

@typechecked
async def create_browser_card(
    dashboard_id: str,
    emit: Optional[EventCallback] = None,
) -> str:
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
    if emit:
        await emit(BrowserCardAddedEvent(
            dashboard_id=dashboard_id,
            browser_card=card,
        ))
    return browser_id
