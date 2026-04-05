from typing import Optional, Tuple, List

from backend.apps.modes.modes import get_mode_by_id
from backend.apps.modes.Mode import Mode
from backend.apps.settings.settings import load_settings
from backend.apps.agents.ResolvedModeConfig.compose_system_prompt import compose_system_prompt
from backend.core.tools.shared_structs.Toolkit import Toolkit
from typeguard import typechecked
from pydantic import BaseModel, Field

class ResolvedModeConfig(BaseModel):
    system_prompt: Optional[str] = None
    allowed_tools: List[str] = Field(default_factory=list)
    disallowed_tools: List[str] = Field(default_factory=list)
    cwd: Optional[str] = None

    @typechecked
    @classmethod
    async def create(
        cls,
        mode_id: str,
        session_prompt: Optional[str],
        toolkit: Toolkit,
    ) -> "ResolvedModeConfig":

        settings = load_settings()
        mode_def: Optional[Mode] = await get_mode_by_id(mode_id)

        system_prompt: Optional[str] = compose_system_prompt(
            global_default=settings.default_system_prompt,
            mode_prompt=mode_def.system_prompt if mode_def else None,
            session_prompt=session_prompt,
        )

        allowed_tools, disallowed_tools = toolkit.collect_tool_permissions()
        if mode_def and mode_def.tools is not None:
            mode_tool_set: set[str] = set[str](mode_def.tools)
            disallowed_tools += [t for t in allowed_tools if t not in mode_tool_set]
            allowed_tools = [t for t in allowed_tools if t in mode_tool_set]

        cwd: Optional[str] = mode_def.default_folder if mode_def and mode_def.default_folder else None

        return cls(
            system_prompt=system_prompt,
            allowed_tools=allowed_tools,
            disallowed_tools=disallowed_tools,
            cwd=cwd,
        )