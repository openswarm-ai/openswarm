import json
import os
import logging
from contextlib import asynccontextmanager
from fastapi import HTTPException
from backend.config.Apps import SubApp
from backend.apps.modes.models import Mode, ModeCreate, ModeUpdate, BUILTIN_MODES

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "modes")


@asynccontextmanager
async def modes_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    for builtin in BUILTIN_MODES:
        _save(builtin)
    yield


modes = SubApp("modes", modes_lifespan)


def _load_all() -> list[Mode]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(DATA_DIR, fname)) as f:
                result.append(Mode(**json.load(f)))
    return result


def _save(mode: Mode):
    with open(os.path.join(DATA_DIR, f"{mode.id}.json"), "w") as f:
        json.dump(mode.model_dump(), f, indent=2)


def _load(mode_id: str) -> Mode:
    path = os.path.join(DATA_DIR, f"{mode_id}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Mode not found")
    with open(path) as f:
        return Mode(**json.load(f))


def load_mode(mode_id: str) -> Mode | None:
    """Public helper for other modules to resolve a mode by ID."""
    path = os.path.join(DATA_DIR, f"{mode_id}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return Mode(**json.load(f))


@modes.router.get("/list")
async def list_modes():
    return {"modes": [m.model_dump() for m in _load_all()]}


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
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(mode, k, v)
    _save(mode)
    return {"ok": True, "mode": mode.model_dump()}


@modes.router.delete("/{mode_id}")
async def delete_mode(mode_id: str):
    mode = _load(mode_id)
    if mode.is_builtin:
        raise HTTPException(status_code=403, detail="Cannot delete built-in modes")
    path = os.path.join(DATA_DIR, f"{mode_id}.json")
    if os.path.exists(path):
        os.remove(path)
    return {"ok": True}
