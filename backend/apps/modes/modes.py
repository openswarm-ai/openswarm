import os
from contextlib import asynccontextmanager
from fastapi import HTTPException
from pydantic import BaseModel
from typing import Optional
from backend.config.Apps import SubApp
from backend.core.db.PydanticStore import PydanticStore
from backend.apps.modes.Mode import Mode
from backend.apps.modes.BUILTIN_MODES import BUILTIN_MODES
from backend.config.paths import DB_ROOT


MODE_STORE: PydanticStore[Mode] = PydanticStore[Mode](
    model_cls=Mode,
    data_dir=os.path.join(DB_ROOT, "modes"),
    id_field="id",
    dump_mode="json",
    not_found_detail="Mode not found",
)

@asynccontextmanager
async def modes_lifespan():
    for builtin in BUILTIN_MODES:
        MODE_STORE.save(builtin)
    yield


modes = SubApp("modes", modes_lifespan)


@modes.router.get("/list")
async def list_modes():
    builtin_defaults = {m.id: m.model_dump() for m in BUILTIN_MODES}
    return {"modes": [m.model_dump() for m in MODE_STORE.load_all()], "builtin_defaults": builtin_defaults}


@modes.router.get("/{mode_id}")
async def get_mode(mode_id: str):
    return MODE_STORE.load(mode_id).model_dump()


class ModeCreate(BaseModel):
    name: str
    description: str = ""
    system_prompt: Optional[str] = None
    tools: Optional[list[str]] = None
    default_next_mode: Optional[str] = None
    icon: str = "smart_toy"
    color: str = "#818cf8"
    default_folder: Optional[str] = None

@modes.router.post("/create")
async def create_mode(body: ModeCreate):
    mode = Mode(
        name=body.name,
        description=body.description,
        system_prompt=body.system_prompt,
        tools=body.tools,
        default_next_mode=body.default_next_mode,
        icon=body.icon,
        color=body.color,
        default_folder=body.default_folder,
        is_builtin=False,
    )
    MODE_STORE.save(mode)
    return {"ok": True, "mode": mode.model_dump()}


class ModeUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    tools: Optional[list[str]] = None
    default_next_mode: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    default_folder: Optional[str] = None

@modes.router.put("/{mode_id}")
async def update_mode(mode_id: str, body: ModeUpdate):
    mode = MODE_STORE.load(mode_id)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(mode, k, v)
    MODE_STORE.save(mode)
    return {"ok": True, "mode": mode.model_dump()}


@modes.router.post("/{mode_id}/reset")
async def reset_mode(mode_id: str):
    """Reset a built-in mode to its hardcoded defaults."""
    builtin = next((m for m in BUILTIN_MODES if m.id == mode_id), None)
    if not builtin:
        raise HTTPException(status_code=400, detail="Only built-in modes can be reset")
    MODE_STORE.save(builtin)
    return {"ok": True, "mode": builtin.model_dump()}


@modes.router.delete("/{mode_id}")
async def delete_mode(mode_id: str):
    mode = MODE_STORE.load(mode_id)
    if mode.is_builtin:
        raise HTTPException(status_code=403, detail="Cannot delete built-in modes")
    MODE_STORE.delete(mode_id)
    return {"ok": True}
