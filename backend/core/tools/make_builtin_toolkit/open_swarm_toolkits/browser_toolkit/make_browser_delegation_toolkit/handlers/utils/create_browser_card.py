from datetime import datetime
from uuid import uuid4
from typing import Optional, Callable

from typeguard import typechecked

from backend.core.events.events import EventCallback, BrowserCardAddedEvent
from backend.core.shared_structs.browser.BrowserCardPosition import BrowserCardPosition
from backend.core.shared_structs.browser.BrowserTab import BrowserTab
from backend.core.shared_structs.dashboard.Dashboard import Dashboard


@typechecked
async def create_browser_card(
    dashboard_id: str,
    load_dashboard: Callable[[str], Dashboard],
    save_dashboard: Callable[[Dashboard], None],
    emit: Optional[EventCallback] = None,
) -> str:
    dashboard = load_dashboard(dashboard_id)
    browser_id = f"browser-{uuid4().hex[:8]}"
    tab_id = f"tab-{uuid4().hex[:8]}"
    tab = BrowserTab(id=tab_id, url="https://www.google.com", title="")
    card = BrowserCardPosition(
        browser_id=browser_id, url="https://www.google.com",
        tabs=[tab], activeTabId=tab_id, x=40, y=100, width=1280, height=800,
    )
    dashboard.layout.browser_cards[browser_id] = card
    dashboard.updated_at = datetime.now()
    save_dashboard(dashboard)
    if emit:
        await emit(BrowserCardAddedEvent(
            dashboard_id=dashboard_id,
            browser_card=card,
        ))
    return browser_id