import json
import os
import logging
from contextlib import asynccontextmanager
from fastapi import HTTPException
from backend.config.Apps import SubApp
from backend.apps.common.json_store import JsonStore
from backend.apps.modes.models import Mode, ModeCreate, ModeUpdate
from backend.apps.modes.builtin import BUILTIN_MODES

logger = logging.getLogger(__name__)

from backend.config.paths import MODES_DIR as DATA_DIR


@asynccontextmanager
async def modes_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    for builtin in BUILTIN_MODES:
        path = os.path.join(DATA_DIR, f"{builtin.id}.json")
        if not os.path.exists(path):
            _save(builtin)
    yield


modes = SubApp("modes", modes_lifespan)


_store = JsonStore(Mode, DATA_DIR, not_found_detail="Mode not found")

_load_all = _store.load_all
_save = _store.save
_load = _store.load
load_mode = _store.load_or_none


@modes.router.get("/list")
async def list_modes():
    builtin_defaults = {m.id: m.model_dump() for m in BUILTIN_MODES}
    return {"modes": [m.model_dump() for m in _load_all()], "builtin_defaults": builtin_defaults}


@modes.router.get("/{mode_id}")
async def get_mode(mode_id: str):
    return _load(mode_id).model_dump()


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
    _save(mode)
    return {"ok": True, "mode": mode.model_dump()}


@modes.router.put("/{mode_id}")
async def update_mode(mode_id: str, body: ModeUpdate):
    mode = _load(mode_id)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(mode, k, v)
    _save(mode)
    return {"ok": True, "mode": mode.model_dump()}


@modes.router.post("/{mode_id}/reset")
async def reset_mode(mode_id: str):
    """Reset a built-in mode to its hardcoded defaults."""
    builtin = next((m for m in BUILTIN_MODES if m.id == mode_id), None)
    if not builtin:
        raise HTTPException(status_code=400, detail="Only built-in modes can be reset")
    _save(builtin)
    return {"ok": True, "mode": builtin.model_dump()}


@modes.router.delete("/{mode_id}")
async def delete_mode(mode_id: str):
    mode = _load(mode_id)
    if mode.is_builtin:
        raise HTTPException(status_code=403, detail="Cannot delete built-in modes")
    _store.delete(mode_id)
    return {"ok": True}
