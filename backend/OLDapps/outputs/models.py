from pydantic import BaseModel, Field, model_validator
from typing import Optional, Any
from uuid import uuid4
from datetime import datetime


def _migrate_legacy_files(
    data: dict,
    *,
    allow_schema_json: bool = False,
    always_set_files: bool = False,
) -> dict:
    """Convert legacy frontend_code/backend_code fields into the files dict.

    Parameters
    ----------
    allow_schema_json:
        Also migrate a ``schema_json`` field to ``files["schema.json"]``.
    always_set_files:
        When ``True``, set ``data["files"]`` even to an empty dict if no
        legacy fields are found (used by Output / OutputCreate).  When
        ``False``, only set ``data["files"]`` if there are actual files to
        migrate (used by OutputUpdate / WorkspaceSeedRequest).
    """
    if not isinstance(data, dict):
        return data

    files_present = "files" in data
    files_truthy = files_present and data["files"]

    if not files_present or (always_set_files and not files_truthy):
        files: dict[str, str] = {}
        fc = data.pop("frontend_code", None)
        bc = data.pop("backend_code", None)
        if fc:
            files["index.html"] = fc
        if bc:
            files["backend.py"] = bc
        if allow_schema_json:
            sj = data.pop("schema_json", None)
            if sj:
                files["schema.json"] = sj
        if files or always_set_files:
            data["files"] = files
    else:
        data.pop("frontend_code", None)
        data.pop("backend_code", None)
        if allow_schema_json:
            data.pop("schema_json", None)

    return data


class AutoRunConfig(BaseModel):
    enabled: bool = False
    prompt: str = ""
    context_paths: list[dict[str, str]] = Field(default_factory=list)
    forced_tools: list[dict[str, Any]] = Field(default_factory=list)
    mode: str = "agent"
    model: str = "sonnet"


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
    auto_run_config: Optional[AutoRunConfig] = None
    thumbnail: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())

    @model_validator(mode="before")
    @classmethod
    def _migrate_flat_fields(cls, data: Any) -> Any:
        return _migrate_legacy_files(data, always_set_files=True)

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
    auto_run_config: Optional[dict[str, Any]] = None
    thumbnail: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_flat_fields(cls, data: Any) -> Any:
        return _migrate_legacy_files(data, always_set_files=True)


class OutputUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    input_schema: Optional[dict[str, Any]] = None
    files: Optional[dict[str, str]] = None
    permission: Optional[str] = None
    auto_run_config: Optional[dict[str, Any]] = None
    thumbnail: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_flat_fields(cls, data: Any) -> Any:
        return _migrate_legacy_files(data)


class OutputExecute(BaseModel):
    output_id: str
    input_data: dict[str, Any] = Field(default_factory=dict)


class OutputExecuteResult(BaseModel):
    output_id: str
    output_name: str
    frontend_code: str
    input_data: dict[str, Any]
    backend_result: Optional[dict[str, Any]] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    error: Optional[str] = None


class AutoRunRequest(BaseModel):
    prompt: str
    input_schema: dict[str, Any] = Field(default_factory=dict)
    backend_code: Optional[str] = None
    context_paths: list[dict[str, str]] = Field(default_factory=list)
    forced_tools: list[str] = Field(default_factory=list)
    model: str = "sonnet"


class AutoRunAgentRequest(BaseModel):
    prompt: str
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_id: str
    model: str = "sonnet"
    forced_tools: list[str] = Field(default_factory=list)
    context_paths: list[dict[str, str]] = Field(default_factory=list)


class WorkspaceSeedRequest(BaseModel):
    workspace_id: str
    files: Optional[dict[str, str]] = None
    meta: Optional[dict[str, Any]] = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_flat_fields(cls, data: Any) -> Any:
        return _migrate_legacy_files(data, allow_schema_json=True)