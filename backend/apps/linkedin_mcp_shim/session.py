from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from datetime import UTC, datetime
from typing import Any, Callable
from uuid import uuid4

from fastapi import HTTPException

from backend.apps.tools_lib.mcp_config import derive_mcp_config, linkedin_profile_dir, _resolve_command
from backend.apps.tools_lib.models import ToolDefinition

_connect_processes: dict[str, dict[str, Any]] = {}
_warmup_processes: dict[str, dict[str, Any]] = {}


def _is_linkedin_host(value: str | None) -> bool:
    host = (value or "").lower().strip(".")
    return host == "linkedin.com" or host.endswith(".linkedin.com")


def linkedin_auth_state_ready() -> bool:
    profile_dir = linkedin_profile_dir()
    auth_root = os.path.dirname(profile_dir)
    cookies_path = os.path.join(auth_root, "cookies.json")
    if not (
        os.path.isdir(profile_dir)
        and os.path.isfile(cookies_path)
        and os.path.isfile(os.path.join(auth_root, "source-state.json"))
    ):
        return False
    try:
        with open(cookies_path, "r") as f:
            cookies = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(cookies, list) and any(
        c.get("name") == "li_at" and c.get("value")
        for c in cookies
        if isinstance(c, dict)
    )


def clear_linkedin_auth_state() -> None:
    profile_dir = linkedin_profile_dir()
    auth_root = os.path.dirname(profile_dir)
    for path in (profile_dir, os.path.join(auth_root, "runtime-profiles")):
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
    for path in (
        os.path.join(auth_root, "cookies.json"),
        os.path.join(auth_root, "source-state.json"),
    ):
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass


def _atomic_write_json(path: str, payload: Any) -> None:
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def write_linkedin_cookie_bridge(cookies: list[dict[str, Any]]) -> None:
    profile_dir = linkedin_profile_dir()
    auth_root = os.path.dirname(profile_dir)
    os.makedirs(profile_dir, mode=0o700, exist_ok=True)
    marker = os.path.join(profile_dir, ".openswarm-bridge")
    with open(marker, "w") as f:
        f.write(datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"))
    os.chmod(marker, 0o600)

    normalized = []
    for cookie in cookies:
        name = cookie.get("name")
        value = cookie.get("value")
        domain = cookie.get("domain") or ".linkedin.com"
        if not name or value is None or not _is_linkedin_host(str(domain)):
            continue
        normalized.append({
            "name": name,
            "value": value,
            "domain": domain if str(domain).startswith(".") else f".{domain}",
            "path": cookie.get("path") or "/",
            "expires": cookie.get("expires", -1),
            "httpOnly": bool(cookie.get("httpOnly", False)),
            "secure": cookie.get("secure", True) is not False,
            "sameSite": cookie.get("sameSite") or "None",
        })

    if not any(c.get("name") == "li_at" for c in normalized):
        raise HTTPException(status_code=400, detail="LinkedIn login cookie li_at was not found")

    cookies_path = os.path.join(auth_root, "cookies.json")
    _atomic_write_json(cookies_path, normalized)
    _atomic_write_json(os.path.join(auth_root, "source-state.json"), {
        "version": 1,
        "source_runtime_id": "openswarm-electron-cookie-bridge",
        "login_generation": str(uuid4()),
        "created_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "profile_path": os.path.abspath(os.path.expanduser(profile_dir)),
        "cookies_path": os.path.abspath(os.path.expanduser(cookies_path)),
    })


def _script_path(script_name: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), script_name)


def _command(tool: ToolDefinition, script_name: str, label: str) -> tuple[list[str], dict[str, str]]:
    config = derive_mcp_config(tool)
    if not config or config.get("type") != "stdio":
        raise HTTPException(status_code=400, detail="LinkedIn MCP must use stdio transport")
    command = _resolve_command("uv")
    if not command:
        raise HTTPException(status_code=500, detail=f"Cannot resolve uv for LinkedIn {label}")
    return [
        command,
        "run",
        "--with",
        "linkedin-scraper-mcp",
        "python",
        _script_path(script_name),
        "--user-data-dir",
        linkedin_profile_dir(),
    ], {**os.environ, **(config.get("env") or {})}


def _kill_state(state: dict[str, Any] | None) -> None:
    proc = state.get("proc") if state else None
    if proc:
        try:
            proc.kill()
        except Exception:
            pass


def kill_linkedin_processes(tool_id: str) -> None:
    _kill_state(_connect_processes.pop(tool_id, None))
    _kill_state(_warmup_processes.pop(tool_id, None))


def _start_process(
    tool_id: str,
    cmd: list[str],
    env: dict[str, str],
    processes: dict[str, dict[str, Any]],
    success_status: str,
    on_success: Callable[[], None] | None = None,
) -> None:
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, text=True)
    state: dict[str, Any] = {"proc": proc, "status": "running", "output": "", "started_at": time.time()}

    def _read_output() -> None:
        try:
            if proc.stdout:
                for line in proc.stdout:
                    state["output"] += line
            proc.wait()
            if proc.returncode == 0:
                state["status"] = success_status
                if on_success:
                    on_success()
            else:
                state["status"] = "error"
        except Exception as e:
            state["status"] = "error"
            state["output"] += f"\n{type(e).__name__}: {e}"

    threading.Thread(target=_read_output, daemon=True).start()
    processes[tool_id] = state


def start_linkedin_warmup(tool_id: str, tool: ToolDefinition) -> dict[str, str]:
    existing = _warmup_processes.get(tool_id)
    proc = existing.get("proc") if existing else None
    if proc and proc.poll() is None:
        return {"status": "already_running"}
    _warmup_processes.pop(tool_id, None)
    cmd, env = _command(tool, "warmup.py", "warmup")
    _start_process(tool_id, cmd, env, _warmup_processes, "ready")
    return {"status": "started"}


def start_linkedin_connect(
    tool_id: str,
    tool: ToolDefinition,
    on_connected: Callable[[], None],
) -> dict[str, str]:
    _kill_state(_connect_processes.pop(tool_id, None))
    cmd, env = _command(tool, "run.py", "setup")
    _start_process(tool_id, cmd, env, _connect_processes, "connected", on_connected)
    return {"status": "running"}


def linkedin_connect_process_status(tool_id: str) -> dict[str, str] | None:
    state = _connect_processes.get(tool_id)
    if not state:
        return None
    status = state.get("status", "running")
    result = {"status": status, "output": (state.get("output") or "")[-4000:]}
    if status in ("connected", "error"):
        _connect_processes.pop(tool_id, None)
    return result
