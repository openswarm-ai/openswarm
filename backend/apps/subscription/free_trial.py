"""Zero-config free trial: arm/refresh/clear the server-funded free runs.

A brand-new user with no key and no subscription gets a small number of agent
runs funded through the cloud's shared pool, so they see the product work before
being asked to connect anything. Identity is a hashed hardware fingerprint
computed here in the backend (no Electron IPC), so deleting/reinstalling the app
does not reset the count. The cloud is authoritative for the run count and the
forced cheap model; this module only mirrors state into settings and 9Router.
"""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import re
import subprocess

import httpx

from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL
from backend.apps.settings.settings import save_settings_async

logger = logging.getLogger(__name__)

# Namespaces the hash so a raw hardware UUID never leaves the device. Public on
# purpose (open-source): it only prevents transmitting the raw id, not a secret.
_FP_SALT = "openswarm-free-trial-v1"


def _enabled() -> bool:
    # Default ON as of 1.2.80: the cloud free-trial proxy is live on prod
    # (api.openswarm.com) and arming + metered Haiku were verified end to end.
    # Set OPENSWARM_FREE_TRIAL_ENABLED=0 to force it off. The pool-shed gate +
    # daily global budget on the cloud cap total spend; arming only happens for a
    # truly-unconnected user (no key, no sub), so paid users are never touched.
    return os.environ.get("OPENSWARM_FREE_TRIAL_ENABLED", "1") == "1"


def _raw_hardware_id() -> str | None:
    """A stable per-machine id that survives app reinstall / data wipe."""
    system = platform.system()
    try:
        if system == "Darwin":
            out = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True, text=True, timeout=3,
            ).stdout
            m = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', out)
            return m.group(1) if m else None
        if system == "Windows":
            import winreg  # type: ignore
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography"
            ) as key:
                val, _ = winreg.QueryValueEx(key, "MachineGuid")
                return val or None
        for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            if os.path.exists(path):
                with open(path, "r") as f:
                    v = f.read().strip()
                    if v:
                        return v
    except Exception:
        return None
    return None


def _fingerprint(settings_obj) -> str | None:
    raw = _raw_hardware_id()
    if not raw:
        # Fail-soft: installation_id is less durable (regenerates on wipe) but
        # better than nothing on a machine where the hardware id can't be read.
        raw = getattr(settings_obj, "installation_id", None)
    if not raw:
        return None
    return hashlib.sha256((_FP_SALT + raw).encode("utf-8")).hexdigest()


def _has_own_model(s) -> bool:
    """True if the user already has any real model path in settings; never shadow it."""
    if any(getattr(s, k, None) for k in (
        "anthropic_api_key", "openai_api_key", "google_api_key", "openrouter_api_key",
        "claude_subscription_token", "openai_subscription_token", "gemini_subscription_token",
    )):
        return True
    if getattr(s, "connection_mode", "own_key") == "openswarm-pro" and getattr(s, "openswarm_bearer_token", None):
        return True
    for cp in (getattr(s, "custom_providers", None) or []):
        name = cp.get("name") if isinstance(cp, dict) else getattr(cp, "name", None)
        base = cp.get("base_url") if isinstance(cp, dict) else getattr(cp, "base_url", None)
        if (name or "").strip() and (base or "").strip():
            return True
    return False


async def _has_connected_subscription() -> bool:
    """True if 9Router holds a live Claude/ChatGPT/Gemini subscription. Those
    connections live in 9Router, not settings, so the sync check above misses
    them; this catches a sub connected while the trial was armed."""
    try:
        from backend.apps.nine_router import (
            is_running as _9r_running,
            get_providers as _9r_providers,
            NINE_ROUTER_CLAUDE_PRO_NAME,
        )
        if not _9r_running():
            return False
        conns = await _9r_providers()
        # Exclude our OWN managed node: the free trial registers itself as a `claude`
        # connection here, and counting it would make the trial think a real model is
        # connected and clear itself on the next boot (works once, dead on relaunch).
        return any(
            c.get("isActive")
            and c.get("provider") in ("claude", "codex", "gemini-cli")
            and c.get("name") != NINE_ROUTER_CLAUDE_PRO_NAME
            for c in conns
        )
    except Exception:
        return False


def _proxy_base(settings_obj) -> str:
    return (getattr(settings_obj, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL).rstrip("/")


async def _sync_routing(settings_obj) -> None:
    try:
        from backend.apps.nine_router import sync_pro_routing
        await sync_pro_routing(settings_obj)
    except Exception as e:
        logger.debug("free-trial routing sync skipped: %s", e)


async def clear_free_trial(settings_obj) -> None:
    """Drop the trial token and revert to own_key. Keeps free_trial_remaining
    (so the UI knows it's spent) and never touches a real paid mode."""
    if getattr(settings_obj, "connection_mode", "own_key") == "free-trial":
        settings_obj.connection_mode = "own_key"
    settings_obj.free_trial_token = None
    await save_settings_async(settings_obj)
    await _sync_routing(settings_obj)


async def arm_free_trial(settings_obj) -> dict:
    """Mint (or re-fetch) the machine's grant and, if runs remain, flip into
    free-trial mode. Guarded: never arms over a real key/subscription."""
    if not _enabled():
        return {"armed": False, "reason": "disabled"}
    mode = getattr(settings_obj, "connection_mode", "own_key")
    if mode not in ("own_key", "free-trial"):
        return {"armed": False, "reason": "other_mode"}
    if _has_own_model(settings_obj) or await _has_connected_subscription():
        # A real model exists now (key, custom provider, or a 9Router sub). If we
        # were on the free lane, hand the wheel back instead of re-arming.
        if mode == "free-trial":
            await clear_free_trial(settings_obj)
        return {"armed": False, "reason": "has_model"}

    fp = _fingerprint(settings_obj)
    if not fp:
        return {"armed": False, "reason": "no_fingerprint"}

    base = _proxy_base(settings_obj)
    payload: dict = {"fingerprint_hash": fp}
    if getattr(settings_obj, "installation_id", None):
        payload["install_id"] = settings_obj.installation_id
    if getattr(settings_obj, "user_id", None):
        payload["user_id"] = settings_obj.user_id

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(f"{base}/api/free-trial/mint", json=payload)
    except httpx.HTTPError as e:
        logger.debug("free-trial mint network error: %s", e)
        return {"armed": False, "reason": "network"}
    if r.status_code != 200:
        return {"armed": False, "reason": "upstream", "code": r.status_code}

    data = r.json()
    remaining = int(data.get("runs_remaining") or 0)
    settings_obj.free_trial_remaining = remaining
    settings_obj.free_trial_runs_limit = int(data.get("runs_limit") or 0) or None

    if remaining > 0:
        settings_obj.connection_mode = "free-trial"
        settings_obj.free_trial_token = data.get("trial_token")
        settings_obj.openswarm_proxy_url = base
        # Pin the trial to Haiku, the exact tier the cloud serves a free run as. Critical:
        # a sonnet/opus pick makes the Claude Code CLI attach an `effort`/thinking param
        # (reasoning models), which Haiku 400s on ("does not support the effort parameter").
        # Using Haiku end to end means the CLI never adds it, so the run just works.
        settings_obj.default_model = "haiku"
        await save_settings_async(settings_obj)
        await _sync_routing(settings_obj)
        return {"armed": True, "runs_remaining": remaining, "runs_limit": settings_obj.free_trial_runs_limit}

    # Already spent on this machine: record it but don't arm.
    await clear_free_trial(settings_obj)
    return {"armed": False, "reason": "exhausted", "runs_remaining": 0}


async def refresh_free_trial(settings_obj) -> dict:
    """Re-read remaining runs from the cloud. Called after a session ends so the
    onboarding 'runs low' nudge stays honest. Clears the trial when spent."""
    token = getattr(settings_obj, "free_trial_token", None)
    if getattr(settings_obj, "connection_mode", "own_key") != "free-trial" or not token:
        return {"connected": False, "runs_remaining": getattr(settings_obj, "free_trial_remaining", None)}

    base = _proxy_base(settings_obj)
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                f"{base}/api/free-trial/status",
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError:
        return {"connected": True, "runs_remaining": getattr(settings_obj, "free_trial_remaining", None)}

    if r.status_code == 401:
        await clear_free_trial(settings_obj)
        return {"connected": False, "runs_remaining": getattr(settings_obj, "free_trial_remaining", None)}
    if r.status_code != 200:
        return {"connected": True, "runs_remaining": getattr(settings_obj, "free_trial_remaining", None)}

    data = r.json()
    remaining = int(data.get("runs_remaining") or 0)
    settings_obj.free_trial_remaining = remaining
    if remaining <= 0:
        await clear_free_trial(settings_obj)
        return {"connected": False, "runs_remaining": 0}
    await save_settings_async(settings_obj)
    return {"connected": True, "runs_remaining": remaining, "runs_limit": getattr(settings_obj, "free_trial_runs_limit", None)}
