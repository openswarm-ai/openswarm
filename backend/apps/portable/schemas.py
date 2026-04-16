"""Pydantic models for the .swarm bundle manifest.

See SWARM_FILE_FORMAT.md in the repo root for the format spec.
"""

from pydantic import BaseModel, Field
from typing import Optional


FORMAT_VERSION = "1.0"
OPENSWARM_MIN_VERSION = "0.4.0"


class BundleAuthor(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None


class BundleInfo(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    author: Optional[BundleAuthor] = None
    created_at: str
    checksum: Optional[str] = None


class ContentEntry(BaseModel):
    id: str
    name: str
    # type-specific extras, free-form
    extra: dict = Field(default_factory=dict)


class Contents(BaseModel):
    dashboard: Optional[dict] = None  # {id, name}
    skills: list[dict] = Field(default_factory=list)
    tools: list[dict] = Field(default_factory=list)
    apps: list[dict] = Field(default_factory=list)
    modes: list[dict] = Field(default_factory=list)


class RequiredEnv(BaseModel):
    key: str
    component_type: str  # "tool" | "app"
    component_id: str
    component_name: str
    description: str = ""
    required: bool = True


class Warnings(BaseModel):
    executes_code: bool = False
    executes_code_reasons: list[str] = Field(default_factory=list)


class Manifest(BaseModel):
    format: str = "swarm"
    format_version: str = FORMAT_VERSION
    openswarm_min_version: str = OPENSWARM_MIN_VERSION

    bundle: BundleInfo
    contents: Contents
    required_env: list[RequiredEnv] = Field(default_factory=list)
    warnings: Warnings = Field(default_factory=Warnings)
