"""Typed shapes for the onboarding v3 endpoints (identity, local scan, prep)."""

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from backend.apps.settings.models import PersonalizedAutomation, PersonalizedStarter


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
    # The high-signal subset of apps (IDEs, design/creative tools); the profile leans on these.
    signal_apps: List[str] = Field(default_factory=list)
    folders: List[FolderSummary] = Field(default_factory=list)
    git_repo_count: int = 0
    has_gitconfig: bool = False


class PrepRequest(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    scan: Optional[ScanResult] = None
    picked_apps: List[str] = Field(default_factory=list)
    identity: List[ProviderIdentity] = Field(default_factory=list)
    usage_summary: str = ""


class PrepResponse(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    greeting: str = ""
    starters: List[PersonalizedStarter] = Field(default_factory=list)
    app_title: str = ""
    app_prompt: str = ""
    app_reason: str = ""
    # The "looked into this for you" card: a live web-research task aimed at the ONE thing this user
    # keeps asking their AI about, so the reveal shows OpenSwarm going and finding it, not just planning.
    research_title: str = ""
    research_prompt: str = ""
    research_reason: str = ""
    automations: List[PersonalizedAutomation] = Field(default_factory=list)
