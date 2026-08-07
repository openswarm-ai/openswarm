from pydantic import BaseModel, Field
from typing import Any, Optional
from uuid import uuid4


class Skill(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    content: str
    file_path: str = ""
    command: str = ""
    # Platform-shipped skills (e.g. App Builder): UI hides delete and DELETE returns 409, but content stays editable so users can tune them.
    built_in: bool = False
    # Multi-file skills live in ~/.claude/skills/<id>/ with a SKILL.md plus supporting files (scripts, templates). dir_path is set for those; empty for a legacy flat <id>.md skill. has_supporting_files flags extra files beyond SKILL.md so the prompt layer knows to point the agent at the folder for on-demand reading.
    dir_path: str = ""
    has_supporting_files: bool = False
    # Provenance for registry-installed skills, used to detect + apply updates. source is owner/repo ('' for user-created), folder is the skill's path in that repo, version is the folder's git tree SHA at install time (changes iff something inside the folder changes upstream).
    source: str = ""
    folder: str = ""
    version: str = ""
    # The detail-page toggle: a disabled skill stays installed but leaves the agent's skill list, the Skill tool refuses to load it, and cloud runs skip it.
    enabled: bool = True
    # SKILL.md mtime (epoch seconds); feeds the settings table's Last updated column.
    updated_at: float = 0


class SkillCreate(BaseModel):
    name: str
    description: str = ""
    content: str
    command: str = ""


class SkillUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    content: Optional[str] = None
    command: Optional[str] = None
    enabled: Optional[bool] = None


class SkillLoadRequest(BaseModel):
    id: str


class SkillUpload(BaseModel):
    filename: str
    content_b64: str


class SkillWorkspaceSeedRequest(BaseModel):
    workspace_id: str
    skill_content: Optional[str] = None
    meta: Optional[dict[str, Any]] = None
