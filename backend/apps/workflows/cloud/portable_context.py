"""What travels with a workflow besides the workflow, and the sharp line about what does not.

Two things go up:

* **Skills.** The user's own writing. A container without them does not get a weaker Skill tool,
  it gets none at all (the backend gates the whole tool on one non-built-in skill existing), and
  the agent then answers from general knowledge in exactly the same confident voice. So the
  skills travel and the cloud run knows what the user's house ratio actually is.
* **The NAMES of connected apps.** Names only, so the agent can say "I cannot reach your Notion
  from a cloud run" instead of inventing what is in it.

One thing must never go up: the credentials behind those apps. A ToolDefinition's `credentials`
and `oauth_tokens` hold Slack session cookies, Notion and GitHub access tokens that do not expire,
and Google refresh tokens. The destination is an ephemeral machine executing the user's own agent
prose with Bash in it. Sending them would put a permanent, full-scope key to someone's email and
documents inside a box designed to be thrown away, so this module reads `tool.name` and nothing
else, and the runner's own RunSpec has no field that could hold a secret even if someone tried.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from pydantic import BaseModel, ConfigDict, Field
from typeguard import typechecked

logger = logging.getLogger(__name__)

# Matches openswarm-runner/runner/run_spec.py. The runner refuses past these anyway; refusing here
# too means an oversized push is a legible error on the user's own machine, not a dead cloud run.
MAX_SKILLS = 60
MAX_SKILL_FILE_CHARS = 200_000
MAX_TOTAL_SKILL_CHARS = 1_000_000
# A skill is prose and small scripts. Anything else in the folder is somebody's stray download.
PORTABLE_SUFFIXES = (".md", ".txt", ".py", ".sh", ".json", ".yaml", ".yml", ".csv", ".ts", ".js")


class PortableSkillFile(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    path: str
    text: str


class PortableSkill(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    id: str
    files: List[PortableSkillFile]


class PortableContext(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    skills: List[PortableSkill] = Field(default_factory=list)
    # Names of apps connected here whose sign-in details stay here.
    unavailable_mcp_servers: List[str] = Field(default_factory=list)

    @typechecked
    def as_body(self) -> Dict[str, Any]:
        return {
            "skills": [skill.model_dump(mode="json") for skill in self.skills],
            "unavailable_mcp_servers": self.unavailable_mcp_servers,
        }


@typechecked
def p_read_text(path: str) -> str:
    """The file's text, or empty when it is binary, unreadable, or too big to carry."""
    try:
        if os.path.getsize(path) > MAX_SKILL_FILE_CHARS:
            return ""
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except (OSError, UnicodeDecodeError):
        return ""


@typechecked
def p_skill_files(skill: Any) -> List[PortableSkillFile]:
    """One skill flattened to SKILL.md plus whatever else is in its folder.

    A legacy flat `<id>.md` skill goes up as a folder with a SKILL.md too, so the wire has one
    shape and the container has one layout.
    """
    files = [PortableSkillFile(path="SKILL.md", text=skill.content)]
    folder = getattr(skill, "dir_path", "") or ""
    if not folder or not os.path.isdir(folder):
        return files
    for directory, subdirs, filenames in os.walk(folder):
        subdirs[:] = sorted(name for name in subdirs if not name.startswith("."))
        for filename in sorted(filenames):
            if filename == "SKILL.md" or not filename.lower().endswith(PORTABLE_SUFFIXES):
                continue
            absolute = os.path.join(directory, filename)
            if os.path.islink(absolute):
                continue
            text = p_read_text(absolute)
            if text:
                files.append(PortableSkillFile(
                    path=os.path.relpath(absolute, folder).replace(os.sep, "/"),
                    text=text,
                ))
    return files


@typechecked
def portable_skills() -> List[PortableSkill]:
    """Every skill the user wrote or installed. Built-ins are skipped: the container seeds its own."""
    from backend.apps.skills.skills import safe_slug, sync_skills

    out: List[PortableSkill] = []
    budget = MAX_TOTAL_SKILL_CHARS
    for skill in sync_skills():
        if skill.built_in or not skill.enabled or len(out) >= MAX_SKILLS:
            continue
        # The id becomes a directory name in the container, so it has to survive being one.
        slug = safe_slug(skill.id)
        if not slug:
            continue
        files = p_skill_files(skill)
        cost = sum(len(f.text) for f in files)
        if cost > budget:
            logger.info("skill %s not sent to the cloud: the run spec's skill budget is spent", skill.id)
            continue
        budget -= cost
        out.append(PortableSkill(id=slug, files=files))
    return out


@typechecked
def unavailable_mcp_servers() -> List[str]:
    """Connected apps, by name. Reads `tool.name` and deliberately nothing else."""
    from backend.apps.tools_lib.tools_lib import load_all_tools

    names: List[str] = []
    for tool in load_all_tools():
        if tool.mcp_config and tool.enabled and tool.auth_status in ("configured", "connected"):
            names.append(tool.name)
    return sorted(set(names))


@typechecked
def portable_context() -> PortableContext:
    """Everything a cloud run should know that the workflow itself does not carry."""
    try:
        skills = portable_skills()
    except Exception:
        logger.exception("could not gather skills for the cloud; the run will have none")
        skills = []
    try:
        servers = unavailable_mcp_servers()
    except Exception:
        logger.exception("could not gather connected app names for the cloud")
        servers = []
    return PortableContext(skills=skills, unavailable_mcp_servers=servers)
