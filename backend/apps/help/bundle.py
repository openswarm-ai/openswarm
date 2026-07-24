"""Diagnostic bundle for bug reports: one folder a user can drag into a GitHub issue.

Everything is assembled LOCALLY and only revealed in the file manager; nothing uploads
anywhere by itself. Contents are deliberately allowlisted (identity, versions, feature
booleans, provider KINDS, counts, log tail) so no secret or API key can ever ride along.
"""

import base64
import json
import os
import platform
import re
import sys
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, List, Optional

from pydantic import BaseModel, ConfigDict, Field
from typeguard import typechecked

from backend.config.Apps import SubApp
from backend.config.paths import DATA_ROOT, SESSIONS_DIR


@asynccontextmanager
async def help_lifespan() -> AsyncIterator[None]:
    yield


help_app = SubApp("help", help_lifespan)

DIAG_DIR = os.path.join(DATA_ROOT, "diagnostics")
LOG_TAIL_LINES = 200
MAX_ATTACHMENTS = 6
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
# Key-shaped strings never belong in a shareable report, even from free-text log lines.
P_SECRET_RE = re.compile(r"(sk-[A-Za-z0-9\-]{8,}|Bearer\s+\S+|api[_-]?key[\"']?\s*[:=]\s*\S+)", re.IGNORECASE)


class BundleAttachment(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    name: str
    data_b64: str


class BundleRequest(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    kind: str = "bug"
    description: str = ""
    attachments: List[BundleAttachment] = Field(default_factory=list)


@typechecked
def p_safe_name(name: str) -> str:
    base = os.path.basename(name or "attachment")
    return re.sub(r"[^A-Za-z0-9._-]", "_", base)[:80] or "attachment"


@typechecked
def p_scrub(text: str) -> str:
    return P_SECRET_RE.sub("[redacted]", text)


@typechecked
def p_log_tail() -> str:
    """Last lines of the backend log when packaged (Electron writes backend.log next to the data
    root); dev runs log to the terminal, so a missing file just yields an honest note."""
    candidates = [
        os.path.join(os.path.dirname(DATA_ROOT), "backend.log"),
        os.path.join(DATA_ROOT, "backend.log"),
    ]
    for p in candidates:
        try:
            if os.path.isfile(p):
                with open(p, "r", errors="replace") as fh:
                    lines = fh.readlines()[-LOG_TAIL_LINES:]
                return p_scrub("".join(lines))
        except Exception:
            continue
    return "(no backend.log found; dev runs log to the terminal)"


@typechecked
def p_count_dir(path: str) -> int:
    try:
        return len(os.listdir(path))
    except Exception:
        return 0


@typechecked
def p_build_report(req: BundleRequest) -> str:
    from backend.apps.settings.store import load_settings

    s = load_settings()
    provider_kinds: List[str] = []
    if getattr(s, "anthropic_api_key", None):
        provider_kinds.append("anthropic-key")
    if getattr(s, "openai_api_key", None):
        provider_kinds.append("openai-key")
    if getattr(s, "free_trial_token", None):
        provider_kinds.append("free-trial")
    facts = {
        "kind": req.kind,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "app_version": os.environ.get("OPENSWARM_APP_VERSION", "dev"),
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "python": sys.version.split()[0],
        "packaged": os.environ.get("OPENSWARM_PACKAGED") == "1",
        "installation_id": getattr(s, "installation_id", None),
        "user_email": getattr(s, "user_email", None),
        "signin_method": getattr(s, "signin_method", None),
        "default_model": getattr(s, "default_model", None),
        "connection_mode": getattr(s, "connection_mode", None),
        "provider_kinds": provider_kinds,
        "session_count": p_count_dir(SESSIONS_DIR),
        "theme": getattr(s, "theme", None),
    }
    lines = [
        f"# OpenSwarm {('bug report' if req.kind == 'bug' else 'feature request')}",
        "",
        "## What the user reported",
        req.description.strip() or "(no description)",
        "",
        "## Environment",
        "```json",
        json.dumps(facts, indent=2, default=str),
        "```",
        "",
        "## Recent backend log",
        "```",
        p_log_tail(),
        "```",
        "",
    ]
    return "\n".join(lines)


@help_app.router.post("/bundle")
@typechecked
async def build_bundle(body: BundleRequest) -> dict:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    folder = os.path.join(DIAG_DIR, f"report-{stamp}")
    os.makedirs(folder, exist_ok=True)
    report_path = os.path.join(folder, "diagnostic-report.md")
    with open(report_path, "w") as fh:
        fh.write(p_build_report(body))
    saved: List[str] = []
    for att in body.attachments[:MAX_ATTACHMENTS]:
        try:
            raw = base64.b64decode(att.data_b64)
            if len(raw) > MAX_ATTACHMENT_BYTES:
                continue
            dest = os.path.join(folder, p_safe_name(att.name))
            with open(dest, "wb") as fh:
                fh.write(raw)
            saved.append(os.path.basename(dest))
        except Exception:
            continue
    return {"folder": folder, "report": report_path, "attachments": saved}
