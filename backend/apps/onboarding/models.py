"""Typed shapes for the onboarding v3 endpoints (identity, local scan, prep)."""

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from backend.apps.settings.models import PersonalizedStarter


class ProviderIdentity(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    provider: str
    label: str
    email: Optional[str] = None
    plan: Optional[str] = None


class IdentityResponse(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    providers: List[ProviderIdentity] = Field(default_factory=list)


class FolderSummary(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    name: str
    entry_count: int = 0
    screenshot_count: int = 0
    top_extensions: List[str] = Field(default_factory=list)


class ScanResult(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    apps: List[str] = Field(default_factory=list)
    folders: List[FolderSummary] = Field(default_factory=list)
    git_repo_count: int = 0
    has_gitconfig: bool = False


class PrepRequest(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    scan: Optional[ScanResult] = None
    picked_apps: List[str] = Field(default_factory=list)


class PrepResponse(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    greeting: str = ""
    starters: List[PersonalizedStarter] = Field(default_factory=list)
