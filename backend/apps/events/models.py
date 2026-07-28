"""Models for the event-trigger system: normalized event envelope, per-source
trigger configs (discriminated union so a wrong shape can't be expressed), and
the per-workflow activity log entries that answer "why didn't it fire?"."""

from datetime import datetime
from typing import Annotated, Literal, Optional, Union
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Event(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    id: str = Field(default_factory=lambda: uuid4().hex)
    # Adapter kind that produced this ("file", "web", ...).
    source: str
    # Adapter-specific type, e.g. "file_created", "page_changed".
    event_type: str
    # One human-readable line; this is what gets logged and injected into runs.
    summary: str = ""
    dedup_key: str = ""
    ts: datetime = Field(default_factory=datetime.now)
    # Adapter-shaped extras (external protocol shape; keys vary per source).
    payload: dict = Field(default_factory=dict)


class FileWatchSource(BaseModel):
    kind: Literal["file"] = "file"
    # A file or directory to watch (~ expands). Directories diff their direct entries.
    path: str = ""
    poll_seconds: int = 15

    @field_validator("poll_seconds")
    @classmethod
    def p_clamp_poll(cls, v: int) -> int:
        # Clamp, don't reject: a stray value from an agent tool or old record shouldn't crash the poll loop.
        return max(5, min(v, 3600))


class WebWatchSource(BaseModel):
    kind: Literal["web"] = "web"
    url: str = ""
    # What change actually matters, in the user's words ("a reservation slot opens").
    watch_for: str = ""
    poll_seconds: int = 300

    @field_validator("poll_seconds")
    @classmethod
    def p_clamp_poll(cls, v: int) -> int:
        # 60s floor: polling someone's site faster than that is rude and burns nothing useful.
        return max(60, min(v, 86400))


class AgentCheckSource(BaseModel):
    """The universal poll source: a real agent verifies any natural-language
    condition on an interval, so anything an agent can observe (with tools,
    MCPs, the web, the filesystem) becomes a trigger."""
    kind: Literal["agent"] = "agent"
    # What event to look for, in the user's words ("a new episode of X dropped").
    check: str = ""
    # Empty = the app's default model; each poll is a real (short) agent turn.
    model: str = ""
    # MCPs the USER pre-authorized for this check at trigger creation (consent moved from the in-session MCPActivate click to the trigger config; the dispatch gate itself is unchanged).
    mcps: list[str] = Field(default_factory=list)
    poll_seconds: int = 900

    @field_validator("mcps")
    @classmethod
    def p_cap_mcps(cls, v: list[str]) -> list[str]:
        return [str(m).strip() for m in v if str(m).strip()][:8]

    @field_validator("poll_seconds")
    @classmethod
    def p_clamp_poll(cls, v: int) -> int:
        # Each poll costs a real agent turn; 60s floor keeps a typo from burning money.
        return max(60, min(v, 86400))


class CustomEventSource(BaseModel):
    """The universal push source: never polled; events arrive only via
    POST /api/events/ingest, so any script, webhook forwarder, Shortcut, or
    MCP can feed this trigger."""
    kind: Literal["custom"] = "custom"


class StreamSource(BaseModel):
    """Held-open subscription to a Server-Sent Events feed: the source's own
    event log, read live, so nothing is transient. Not polled; a long-lived
    task owns the connection and reconnects with backoff."""
    kind: Literal["stream"] = "stream"
    url: str = ""
    # Cheap server-side-of-us noise gate: only messages containing this substring become events. Empty = everything.
    contains: str = ""


EventSourceConfig = Annotated[
    Union[FileWatchSource, WebWatchSource, AgentCheckSource, CustomEventSource, StreamSource],
    Field(discriminator="kind"),
]


class EventTriggerConfig(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    id: str = Field(default_factory=lambda: uuid4().hex)
    enabled: bool = True
    source: EventSourceConfig
    # Natural-language filter, aux-LLM judged per batch. Empty = every batch fires.
    predicate: str = ""
    # Burst window: events arriving within it become ONE run, not N runs.
    coalesce_seconds: int = 30
    max_fires_per_hour: int = 6

    @field_validator("coalesce_seconds")
    @classmethod
    def p_clamp_coalesce(cls, v: int) -> int:
        return max(0, min(v, 3600))

    @field_validator("max_fires_per_hour")
    @classmethod
    def p_clamp_rate(cls, v: int) -> int:
        return max(1, min(v, 60))


class EventLogEntry(BaseModel):
    ts: datetime = Field(default_factory=datetime.now)
    trigger_id: str
    kind: Literal["emitted", "fired", "skipped", "error"]
    summary: str
    run_id: Optional[str] = None
