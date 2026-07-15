import os

from pydantic import BaseModel, Field, computed_field, model_validator
from typing import Literal, Optional, Any
from uuid import uuid4
from datetime import datetime

from backend.config.paths import OUTPUTS_WORKSPACE_DIR


class Output(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    icon: str = "view_quilt"
    input_schema: dict[str, Any] = Field(default_factory=lambda: {
        "type": "object",
        "properties": {},
        "required": [],
    })
    files: dict[str, str] = Field(default_factory=dict)
    thumbnail: Optional[str] = None
    # Bumped only when a fresh thumbnail is saved; drives sidebar/grid order so merely opening an app doesn't reshuffle the list.
    preview_updated_at: Optional[str] = None
    # Linkage so reopening the App Builder reattaches to the in-progress session and reuses the same on-disk workspace folder instead of seeding a fresh one (which would orphan the running agent + lose chat history on every navigate).
    session_id: Optional[str] = None
    workspace_id: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    # App publishing to {slug}.openswarm.host. Server-managed: set by the publish endpoint, never accepted from OutputUpdate (so a client can't spoof a live URL).
    published_slug: Optional[str] = None
    published_url: Optional[str] = None
    publish_status: Optional[Literal["publishing", "published", "error"]] = None
    publish_error: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def p_migrate_flat_fields(cls, data: Any) -> Any:
        """Migrate legacy frontend_code/backend_code fields into the files dict."""
        if not isinstance(data, dict):
            return data
        if "files" not in data or not data["files"]:
            files: dict[str, str] = {}
            fc = data.pop("frontend_code", None)
            bc = data.pop("backend_code", None)
            if fc:
                files["index.html"] = fc
            if bc:
                files["backend.py"] = bc
            data["files"] = files
        else:
            data.pop("frontend_code", None)
            data.pop("backend_code", None)
        return data

    @computed_field
    @property
    def workspace_path(self) -> str:
        """Absolute on-disk folder for this app, resolved from workspace_id. API-only (excluded from the saved JSON since it's machine-specific and re-derivable); lets the frontend show the real edit path when an App card is selected."""
        if not self.workspace_id:
            return ""
        return os.path.abspath(os.path.join(OUTPUTS_WORKSPACE_DIR, self.workspace_id))

    @property
    def frontend_code(self) -> str:
        return self.files.get("index.html", "")

    @property
    def backend_code(self) -> str | None:
        return self.files.get("backend.py")


class OutputVersion(BaseModel):
    """A saved point in an app's history. The list endpoint returns these; the
    heavy bits (the serialized app metadata + the workspace byte tree) live in
    the version's manifest plus content-addressed blobs on disk, not here."""
    id: str = Field(default_factory=lambda: uuid4().hex)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    label: str = ""
    # auto: saved after a builder edit run. manual: user clicked Save this version. pre_restore: the automatic backup taken right before a restore (so restore undoes).
    source: Literal["auto", "manual", "pre_restore"] = "auto"
    parent_id: Optional[str] = None
    thumbnail: Optional[str] = None


class OutputCreate(BaseModel):
    name: str
    description: str = ""
    icon: str = "view_quilt"
    input_schema: dict[str, Any] = Field(default_factory=lambda: {
        "type": "object",
        "properties": {},
        "required": [],
    })
    files: dict[str, str] = Field(default_factory=dict)
    thumbnail: Optional[str] = None
    session_id: Optional[str] = None
    workspace_id: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def p_migrate_flat_fields(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if "files" not in data or not data["files"]:
            files: dict[str, str] = {}
            fc = data.pop("frontend_code", None)
            bc = data.pop("backend_code", None)
            if fc:
                files["index.html"] = fc
            if bc:
                files["backend.py"] = bc
            data["files"] = files
        else:
            data.pop("frontend_code", None)
            data.pop("backend_code", None)
        return data


class OutputUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    input_schema: Optional[dict[str, Any]] = None
    files: Optional[dict[str, str]] = None
    thumbnail: Optional[str] = None
    session_id: Optional[str] = None
    workspace_id: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def p_migrate_flat_fields(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if "files" not in data:
            files: dict[str, str] = {}
            fc = data.pop("frontend_code", None)
            bc = data.pop("backend_code", None)
            if fc:
                files["index.html"] = fc
            if bc:
                files["backend.py"] = bc
            if files:
                data["files"] = files
        else:
            data.pop("frontend_code", None)
            data.pop("backend_code", None)
        return data


class OutputExecute(BaseModel):
    output_id: str
    input_data: dict[str, Any] = Field(default_factory=dict)
    # When False (default), `/execute` returns AST warnings instead of running if the backend code touches anything outside the safe data-shaping allowlist. The UI shows those warnings to the user and re-submits with force=True after they click "Run Anyway." This is a UX gate, not a security one; anyone holding the auth token can set force=True; the value is providing the user explicit visibility of what's about to execute.
    force: bool = False


class OutputExecuteResult(BaseModel):
    output_id: str
    output_name: str
    frontend_code: str
    input_data: dict[str, Any]
    backend_result: Optional[dict[str, Any]] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    error: Optional[str] = None
    # Populated when the AST validator flagged risky constructs and the caller didn't set force=True. When present, `backend_result` is null because execution was deferred pending user consent.
    warnings: Optional[list[str]] = None
    code_preview: Optional[str] = None


class AgentCreateAppRequest(BaseModel):
    name: str
    description: str = ""
    # The calling agent session (injected by the apps MCP server); persisted on the Output so the dashboard drops the card next to that agent and the Building overlay tracks its turns.
    parent_session_id: str = ""


class WorkspaceSeedRequest(BaseModel):
    workspace_id: str
    files: Optional[dict[str, str]] = None
    meta: Optional[dict[str, Any]] = None
    # "webapp_template" (default) → seed the vendored openswarm-ai/webapp-template snapshot (React + Vite + TS frontend with optional FastAPI backend), allocate a free FRONTEND_PORT, leave BACKEND_PORT=NONE. Runtime spawns `bash run.sh`; preview pane points at `http://localhost:{FRONTEND_PORT}/`. "flat" → legacy single-`index.html` workspace, kept for explicit opt-in (migration helper, regression tests). Workspaces predating this flip continue to work in old-mode automatically since the runtime detects mode via the presence of `run.sh`.
    template_mode: Literal["flat", "webapp_template"] = "webapp_template"

    @model_validator(mode="before")
    @classmethod
    def p_migrate_flat_fields(cls, data: Any) -> Any:
        """Accept legacy frontend_code/backend_code/schema_json fields."""
        if not isinstance(data, dict):
            return data
        if "files" not in data:
            files: dict[str, str] = {}
            fc = data.pop("frontend_code", None)
            bc = data.pop("backend_code", None)
            sj = data.pop("schema_json", None)
            if fc:
                files["index.html"] = fc
            if bc:
                files["backend.py"] = bc
            if sj:
                files["schema.json"] = sj
            if files:
                data["files"] = files
        else:
            data.pop("frontend_code", None)
            data.pop("backend_code", None)
            data.pop("schema_json", None)
        return data


class VibeCodeRequest(BaseModel):
    prompt: str
    current_frontend_code: str = ""
    current_backend_code: str = ""
    current_schema: str = ""
    name: str = ""
    description: str = ""


class PublishReview(BaseModel):
    # Same JSON shape the frontend shareTypes.ReviewSummary expects.
    verdict: Literal["clean", "warn", "block"] = "clean"
    findings: list[str] = Field(default_factory=list)
    scanned_files: list[str] = Field(default_factory=list)


class PublishPreflightRequest(BaseModel):
    output_id: str


class PublishRequest(BaseModel):
    output_id: str
    slug: Optional[str] = None
    force: bool = False


class PublishPreflightResponse(BaseModel):
    review: PublishReview


class PublishResult(BaseModel):
    ok: bool = True
    published_slug: Optional[str] = None
    published_url: Optional[str] = None
    # When the AST safety net blocks a non-force publish, carry the findings so the UI shows the review modal instead of a generic error toast.
    blocked: bool = False
    review: Optional[PublishReview] = None
    error: Optional[str] = None
