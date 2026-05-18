from pydantic import BaseModel, Field, model_validator
from typing import Literal, Optional, Any
from uuid import uuid4
from datetime import datetime


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
    permission: str = "ask"
    thumbnail: Optional[str] = None
    # Linkage so reopening the App Builder reattaches to the in-progress session
    # and reuses the same on-disk workspace folder instead of seeding a fresh one
    # (which would orphan the running agent + lose chat history on every navigate).
    session_id: Optional[str] = None
    workspace_id: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())

    @model_validator(mode="before")
    @classmethod
    def _migrate_flat_fields(cls, data: Any) -> Any:
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

    @property
    def frontend_code(self) -> str:
        return self.files.get("index.html", "")

    @property
    def backend_code(self) -> str | None:
        return self.files.get("backend.py")


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
    def _migrate_flat_fields(cls, data: Any) -> Any:
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
    permission: Optional[str] = None
    thumbnail: Optional[str] = None
    session_id: Optional[str] = None
    workspace_id: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_flat_fields(cls, data: Any) -> Any:
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
    # When False (default), `/execute` returns AST warnings instead of
    # running if the backend code touches anything outside the safe
    # data-shaping allowlist. The UI shows those warnings to the user and
    # re-submits with force=True after they click "Run Anyway." This is
    # a UX gate, not a security one; anyone holding the auth token can
    # set force=True; the value is providing the user explicit visibility
    # of what's about to execute.
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
    # Populated when the AST validator flagged risky constructs and the
    # caller didn't set force=True. When present, `backend_result` is null
    # because execution was deferred pending user consent.
    warnings: Optional[list[str]] = None
    code_preview: Optional[str] = None


class WorkspaceSeedRequest(BaseModel):
    workspace_id: str
    files: Optional[dict[str, str]] = None
    meta: Optional[dict[str, Any]] = None
    # "webapp_template" (default) → seed the vendored
    # openswarm-ai/webapp-template snapshot (React + Vite + TS frontend
    # with optional FastAPI backend), allocate a free FRONTEND_PORT,
    # leave BACKEND_PORT=NONE. Runtime spawns `bash run.sh`; preview
    # pane points at `http://localhost:{FRONTEND_PORT}/`.
    # "flat" → legacy single-`index.html` workspace, kept for explicit
    # opt-in (migration helper, regression tests). Workspaces predating
    # this flip continue to work in old-mode automatically since the
    # runtime detects mode via the presence of `run.sh`.
    template_mode: Literal["flat", "webapp_template"] = "webapp_template"

    @model_validator(mode="before")
    @classmethod
    def _migrate_flat_fields(cls, data: Any) -> Any:
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
