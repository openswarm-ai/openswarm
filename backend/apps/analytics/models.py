from pydantic import BaseModel
from typing import Optional


class AnalyticsEvent(BaseModel):
    id: Optional[int] = None
    timestamp: str
    event_type: str
    properties: dict
    session_id: Optional[str] = None
    dashboard_id: Optional[str] = None


class UsageSummary(BaseModel):
    total_sessions: int = 0
    total_cost_usd: float = 0.0
    total_messages: int = 0
    total_tool_calls: int = 0
    avg_session_duration_seconds: float = 0.0
    session_completion_rate: float = 0.0
    approval_rate: float = 0.0
    models_used: dict[str, int] = {}
    modes_used: dict[str, int] = {}
    top_tools: list[list] = []


class TimeSeriesPoint(BaseModel):
    date: str
    value: float


class ExportPayload(BaseModel):
    export_version: str = "1.0"
    exported_at: str = ""
    app_version: str = "unknown"
    period: dict = {}
    summary: dict = {}
