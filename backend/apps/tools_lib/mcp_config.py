"""MCP server config derivation and path resolution helpers."""

from __future__ import annotations

import json
import logging
import os
import shutil
from typing import Optional

from backend.apps.tools_lib.oauth_providers import OAUTH_PROVIDERS

logger = logging.getLogger(__name__)

_TOOLS_LIB_DIR = os.path.dirname(os.path.abspath(__file__))
_UV_BIN_DIR = os.path.join(_TOOLS_LIB_DIR, "uv-bin")


def _extra_bin_dirs() -> list[str]:
    """Well-known user-local bin directories that may not be on PATH in packaged apps."""
    home = os.path.expanduser("~")
    dirs = [
        _UV_BIN_DIR,
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".cargo", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".volta", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    nvm_node = os.path.join(home, ".nvm", "versions", "node")
    try:
        if os.path.isdir(nvm_node):
            versions = sorted(os.listdir(nvm_node), reverse=True)
            if versions:
                dirs.insert(0, os.path.join(nvm_node, versions[0], "bin"))
    except OSError:
        pass
    fnm_bin = os.path.join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin")
    if os.path.isdir(fnm_bin):
        dirs.insert(0, fnm_bin)
    return dirs


def _resolve_command(command: str) -> str | None:
    found = shutil.which(command)
    if found:
        return found
    for d in _extra_bin_dirs():
        candidate = os.path.join(d, command)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    candidate = os.path.join(_UV_BIN_DIR, command)
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return None


def _augmented_path() -> str:
    extra = [d for d in _extra_bin_dirs() if os.path.isdir(d)]
    current = os.environ.get("PATH", "")
    seen: set[str] = set()
    parts: list[str] = []
    for p in extra + current.split(os.pathsep):
        if p and p not in seen:
            seen.add(p)
            parts.append(p)
    return os.pathsep.join(parts)


def derive_mcp_config(tool) -> Optional[dict]:
    """Build the claude_agent_sdk mcp_servers config entry for a tool."""
    if not tool.mcp_config:
        return None

    config: dict = dict(tool.mcp_config)

    if tool.credentials:
        if config.get("type") in ("http", "sse"):
            headers = config.setdefault("headers", {})
            for key, val in tool.credentials.items():
                if key.lower() in ("authorization", "api_key", "api-key"):
                    headers.setdefault("Authorization", f"Bearer {val}")
        else:
            env = config.setdefault("env", {})
            env.update(tool.credentials)

    if tool.auth_type == "oauth2" and tool.oauth_tokens.get("access_token"):
        if config.get("type") in ("http", "sse"):
            headers = config.setdefault("headers", {})
            headers["Authorization"] = f"Bearer {tool.oauth_tokens['access_token']}"
        else:
            env = config.setdefault("env", {})
            provider_key = tool.oauth_provider or "google"
            provider = OAUTH_PROVIDERS.get(provider_key)
            if provider:
                for token_field, env_var in provider.token_env_mapping.items():
                    if token_field.startswith("_client_id"):
                        val = os.environ.get(provider.client_id_env, "")
                    elif token_field.startswith("_client_secret"):
                        val = os.environ.get(provider.client_secret_env, "")
                    else:
                        val = tool.oauth_tokens.get(token_field, "")
                    if val:
                        if provider.env_value_transform == "notion_headers" and token_field == "access_token":
                            val = json.dumps({
                                "Authorization": f"Bearer {val}",
                                "Notion-Version": "2022-06-28",
                            })
                        env[env_var] = val
                for _, env_var in provider.extra_token_fields.items():
                    val = tool.oauth_tokens.get(env_var, "")
                    if val:
                        env[env_var] = val
                if provider_key == "figma" and tool.oauth_tokens.get("access_token"):
                    args = config.get("args", [])
                    if "--figma-api-key" not in args:
                        config["args"] = args + ["--figma-api-key", tool.oauth_tokens["access_token"]]
            else:
                env["OAUTH_ACCESS_TOKEN"] = tool.oauth_tokens["access_token"]

    if config.get("type") == "stdio":
        if config.get("command"):
            resolved = _resolve_command(config["command"])
            if resolved:
                config["command"] = resolved
            else:
                logger.warning(f"Command '{config['command']}' not found on PATH or bundled directories")
        env = config.setdefault("env", {})
        env.setdefault("PATH", _augmented_path())
        env.setdefault("PYTHONPATH", "")
        _is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"
        if _is_packaged:
            _resources = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
            _bundled_python = os.path.join(_resources, "python-env", "bin", "python3")
            if os.path.exists(_bundled_python):
                env.setdefault("UV_PYTHON", _bundled_python)
        else:
            _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            _venv_python = os.path.join(_backend, ".venv", "bin", "python3")
            if os.path.exists(_venv_python):
                env.setdefault("UV_PYTHON", _venv_python)

    return config
