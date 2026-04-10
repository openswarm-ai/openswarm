import json
import os
import tempfile
import logging
from contextlib import asynccontextmanager
from fastapi import HTTPException, Query, UploadFile, File
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

from backend.config.Apps import SubApp
from backend.apps.settings.models import AppSettings, DEFAULT_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

from backend.config.paths import SETTINGS_DIR as DATA_DIR

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")


@asynccontextmanager
async def settings_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    yield


settings = SubApp("settings", settings_lifespan)


def load_settings() -> AppSettings:
    """Load settings from JSON file, returning defaults if not found."""
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE) as f:
            settings = AppSettings(**json.load(f))
        if settings.default_system_prompt is None:
            settings.default_system_prompt = DEFAULT_SYSTEM_PROMPT
        return settings
    return AppSettings()


@settings.router.get("")
async def get_settings():
    return load_settings().model_dump()


@settings.router.put("")
async def update_settings(body: AppSettings):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(body.model_dump(), f, indent=2)
    return {"ok": True, "settings": body.model_dump()}


@settings.router.get("/default-system-prompt")
async def get_default_system_prompt():
    return {"default_system_prompt": DEFAULT_SYSTEM_PROMPT}


@settings.router.post("/reset-system-prompt")
async def reset_system_prompt():
    current = load_settings()
    current.default_system_prompt = DEFAULT_SYSTEM_PROMPT
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(current.model_dump(), f, indent=2)
    return {"ok": True, "settings": current.model_dump()}


class BrowseResponse(BaseModel):
    current: str
    parent: Optional[str]
    directories: list[str]
    files: list[str]


UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "self-swarm-uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


@settings.router.post("/upload-files")
async def upload_files(files: list[UploadFile] = File(...)):
    """Accept dropped files, save them, and return their server-side paths."""
    results = []
    for f in files:
        safe_name = os.path.basename(f.filename or "untitled")
        dest = os.path.join(UPLOAD_DIR, safe_name)

        counter = 1
        base, ext = os.path.splitext(safe_name)
        while os.path.exists(dest):
            dest = os.path.join(UPLOAD_DIR, f"{base}_{counter}{ext}")
            counter += 1

        contents = await f.read()
        with open(dest, "wb") as fh:
            fh.write(contents)

        results.append({"path": dest, "name": safe_name, "size": len(contents)})

    return JSONResponse({"files": results})


@settings.router.get("/browse-directories")
async def browse_directories(path: str = Query(default="")) -> BrowseResponse:
    target = path.strip() if path.strip() else os.path.expanduser("~")
    target = os.path.expanduser(target)
    target = os.path.abspath(target)

    if not os.path.exists(target):
        raise HTTPException(status_code=404, detail=f"Path not found: {target}")
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")

    try:
        entries = sorted(os.listdir(target))
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")

    visible = [e for e in entries if not e.startswith(".")]
    directories = [e for e in visible if os.path.isdir(os.path.join(target, e))]
    files = [e for e in visible if os.path.isfile(os.path.join(target, e))]

    parent = os.path.dirname(target) if target != "/" else None

    return BrowseResponse(current=target, parent=parent, directories=directories, files=files)


@settings.router.get("/git-info")
async def git_info(path: str = Query(default="")):
    import subprocess

    target = path.strip() if path.strip() else os.path.expanduser("~")
    target = os.path.abspath(os.path.expanduser(target))

    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail="Not a directory")

    def _run(args: list[str]) -> Optional[str]:
        try:
            r = subprocess.run(args, cwd=target, capture_output=True, text=True, timeout=5)
            return r.stdout.strip() if r.returncode == 0 else None
        except Exception:
            return None

    top = _run(["git", "rev-parse", "--show-toplevel"])
    if not top:
        return JSONResponse({"is_git": False})

    branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"]) or "HEAD"
    raw_branches = _run(["git", "branch", "--list", "--format=%(refname:short)"]) or ""
    branches = [b for b in raw_branches.splitlines() if b]
    remote = _run(["git", "remote", "get-url", "origin"])
    repo_name = os.path.basename(top)

    return JSONResponse({
        "is_git": True,
        "branch": branch,
        "branches": branches,
        "remote_url": remote,
        "repo_name": repo_name,
    })


class GitCheckoutRequest(BaseModel):
    path: str
    branch: str


@settings.router.post("/git-checkout")
async def git_checkout(req: GitCheckoutRequest):
    import subprocess

    target = os.path.abspath(os.path.expanduser(req.path.strip()))
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail="Not a directory")

    try:
        r = subprocess.run(
            ["git", "checkout", req.branch],
            cwd=target, capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            return JSONResponse({"success": False, "error": r.stderr.strip()})
        return JSONResponse({"success": True})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)})
