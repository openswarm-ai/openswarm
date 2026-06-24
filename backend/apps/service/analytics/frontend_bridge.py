"""Bridge frontend `report()` {s, a, p} events into typed product events.

The frontend is browser-side and can't reach the analytics service directly, so
onboarding/dashboard/app events arrive here as envelopes. Best-effort.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.service.analytics.client import (
    persist_client_env,
    track_app_opened,
    track_dashboard_event,
    track_onboarding_step,
)

# report() action -> SDK onboarding status; the timeout/error variants both count as abandoned.
P_ONBOARDING_STATUS = {
    "step_started": "started",
    "step_completed": "completed",
    "step_aborted": "abandoned",
    "step_selector_timeout": "abandoned",
    "step_error": "abandoned",
}


class FrontendEventProps(BaseModel):
    model_config = ConfigDict(validate_assignment=True, extra="ignore")
    dashboard_id: Optional[str] = None
    step_id: Optional[str] = None
    timezone: Optional[str] = None
    locale: Optional[str] = None


class FrontendEvent(BaseModel):
    # A report() envelope {s, a, p}; extra fields ignored at the HTTP boundary.
    model_config = ConfigDict(validate_assignment=True, extra="ignore")
    s: Optional[str] = None
    a: Optional[str] = None
    p: FrontendEventProps = FrontendEventProps()


@typechecked
def bridge_frontend_event(event: FrontendEvent) -> None:
    # Dashboard create/delete are NOT bridged here; those fire authoritatively from the dashboards routes, so bridging them too would double-count.
    if event.s == "onboarding_v2":
        status = P_ONBOARDING_STATUS.get(event.a or "")
        if status and event.p.step_id:
            track_onboarding_step(step_id=str(event.p.step_id), status=status)
    elif event.s == "dashboard" and event.a in ("open", "close"):
        if event.p.dashboard_id:
            track_dashboard_event(dashboard_id=str(event.p.dashboard_id), action=str(event.a))
    elif event.s == "app" and event.a == "opened":
        persist_client_env(timezone=event.p.timezone, locale=event.p.locale)
        track_app_opened(timezone=event.p.timezone, locale=event.p.locale)
