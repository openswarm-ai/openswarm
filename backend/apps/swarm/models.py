"""Schema for the .swarm bundle: a hardened zip whose manifest.json is a
dependency graph of entities with one designated root. The manifest never
carries secrets or payloads (payloads live as files in the zip). The *View
models are the lighter, frontend-facing shapes the share/import modals read."""
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

FORMAT_VERSION = 1


class EntityType(str, Enum):
    skill = "skill"
    app = "app"
    workflow = "workflow"
    dashboard = "dashboard"
    mode = "mode"
    session = "session"


class RequirementKind(str, Enum):
    mcp_action = "mcp_action"        # an MCP/Action that must be reconnected (never auto)
    setting = "setting"             # a safe settings fragment the user confirms
    builtin_mode = "builtin_mode"   # a builtin mode that must already exist locally
    api_key = "api_key"             # a provider key the bundle needs but can't carry
    custom_provider = "custom_provider"  # OpenAI-compatible endpoint (URL ssrf-checked)


class EntityRef(BaseModel):
    type: EntityType
    bundle_id: str                  # uuid4 hex, stable only within this bundle
    name: str
    path: str                       # dir inside the zip holding this entity


class DependencyEdge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: str = Field(alias="from")
    to: str
    relation: str = ""


class Requirement(BaseModel):
    kind: RequirementKind
    key: str
    label: str
    detail: str = ""
    referenced_by: list[str] = Field(default_factory=list)
    proposal: dict[str, Any] = Field(default_factory=dict)  # safe, non-secret hint only


class BundlePreview(BaseModel):
    root_type: EntityType
    root_name: str
    counts: dict[str, int] = Field(default_factory=dict)
    requirement_summary: list[str] = Field(default_factory=list)


class Manifest(BaseModel):
    format_version: int = FORMAT_VERSION
    created_with: str = "OpenSwarm"
    created_at: str = ""
    bundle_id: str
    # sha256 over every entity payload + file (not the manifest itself); set at pack time, re-checked on import to reject a corrupted or edited archive.
    checksum: Optional[str] = None
    root: EntityRef
    entities: list[EntityRef] = Field(default_factory=list)
    edges: list[DependencyEdge] = Field(default_factory=list)
    requirements: list[Requirement] = Field(default_factory=list)
    preview: BundlePreview


# ---- frontend-facing summary (export + import preflight) ----

class IncludeItem(BaseModel):
    type: EntityType
    name: str
    detail: str = ""


class RequirementView(BaseModel):
    kind: RequirementKind
    key: str
    label: str
    detail: str = ""


class BundleSummary(BaseModel):
    root: IncludeItem
    includes: list[IncludeItem] = Field(default_factory=list)
    requirements: list[RequirementView] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=dict)


class ReviewSummary(BaseModel):
    verdict: Literal["clean", "warn", "block"] = "clean"
    findings: list[str] = Field(default_factory=list)
    scanned_files: list[str] = Field(default_factory=list)


# ---- endpoint request/response ----

class ExportRequest(BaseModel):
    type: EntityType
    id: str
    # User-confirmed "export anyway": skips the file-content secret heuristic on direct download only; denied payload fields stay blocked.
    allow_secrets: bool = False


class ExportPreflightResponse(BaseModel):
    ok: bool = True
    summary: BundleSummary
    filename: str
    link_supported: bool = False


class ImportPreflightResponse(BaseModel):
    ok: bool = True
    summary: BundleSummary
    staging_token: str
    conflicts: list[IncludeItem] = Field(default_factory=list)
    review: Optional[ReviewSummary] = None
    warnings: list[str] = Field(default_factory=list)


class ImportCommitRequest(BaseModel):
    staging_token: str
    accept_requirements: list[str] = Field(default_factory=list)


class ImportCommitResponse(BaseModel):
    ok: bool = True
    root_type: EntityType
    root_id: str
    created: dict[str, list[str]] = Field(default_factory=dict)
    unresolved_requirements: list[RequirementView] = Field(default_factory=list)
