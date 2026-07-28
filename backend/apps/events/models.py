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


EventSourceConfig = Annotated[
    Union[FileWatchSource, WebWatchSource],
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
