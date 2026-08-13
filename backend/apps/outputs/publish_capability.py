"""Catch the publish cliff before it ships: an app whose frontend calls its own
FastAPI backend works in preview and breaks on its public URL.

Publishing uploads a STATIC bundle. The edge serves that bundle plus exactly two
runtime bridges (`/__compute`, which runs a single sandboxed `backend.py`, and
`/__llm`); there is no `/api/*` route, so every `/api/...` fetch falls through to
the static catch-all and 404s. Nothing else in the publish path notices, because
`publish_scan` is a SECURITY scan. This module is the capability scan."""
from __future__ import annotations

import os
import re
from typing import List

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.outputs.models import Output, PublishReview
from backend.apps.outputs.publish_common import is_webapp, workspace_dir
from backend.apps.outputs.workspace_io import WALK_SKIP_DIRS

P_FRONTEND_EXTS = (".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".html")
P_MAX_FILE_BYTES = 512 * 1024
P_MAX_LISTED = 8
# Matches /api/foo, "/api", '/api' and `/api` but not /apiary or /rapid.
# A published app is served static files plus exactly two same-origin bridges, so ANY other
# same-origin call is the cliff. Matching the literal "/api" caught 1 of 6 real shapes: a base-URL
# constant, an env var, a proxy prefix, an absolute localhost URL and an axios baseURL all shipped
# silently broken. Spelling is the agent's choice, so the detector cannot depend on it.
P_BRIDGES = ("/__compute", "/__llm")
P_STATIC_EXT = re.compile(r"\.[a-z0-9]{2,5}([\"'`?#]|$)", re.I)
P_BACKEND_SIGNALS = (
    re.compile(r"/api(?:/|[\"'`]|$)"),
    # const API_BASE = '/backend'  /  baseURL: "/server"
    re.compile(r"(?:api[_-]?base|base[_-]?url|apiurl|api[_-]?url)\s*[:=]\s*[\"'`](/[^\"'`]*)", re.I),
    # import.meta.env.VITE_API_URL, process.env.REACT_APP_API_BASE
    re.compile(r"env\.[A-Z0-9_]*API[A-Z0-9_]*", re.I),
    # a backend the published host cannot reach at all
    re.compile(r"https?://(?:localhost|127\.0\.0\.1)(?::\d+)?"),
)
# fetch('/server/v1/items') with no file extension is an endpoint, not an asset.
P_ROOTED_FETCH = re.compile(r"fetch\(\s*[\"'`](/[^\"'`]*)")


def p_reaches_unserved_backend(text: str) -> bool:
    """True when the source calls something the published deploy does not serve."""
    for pattern in P_BACKEND_SIGNALS:
        if pattern.search(text):
            return True
    for path in P_ROOTED_FETCH.findall(text):
        if path.startswith(P_BRIDGES):
            continue
        if P_STATIC_EXT.search(path):
            continue
        return True
    return False


class PublishCapabilityReport(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    backend_enabled: bool = False
    backend_port: str = ""
    api_callers: List[str] = []
    findings: List[str] = []


@typechecked
def p_backend_port(root: str) -> str:
    """The workspace's BACKEND_PORT, or "" when the backend was never enabled."""
    env_path = os.path.join(root, ".env")
    try:
        with open(env_path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                key, _, value = line.partition("=")
                if key.strip() != "BACKEND_PORT":
                    continue
                port = value.split("#", 1)[0].strip()
                return "" if port.upper() in ("", "NONE") else port
    except OSError:
        return ""
    return ""


@typechecked
def p_api_callers(root: str) -> List[str]:
    """Frontend files that reach for /api/..., relative to the workspace root."""
    hits: List[str] = []
    for base, dirs, fnames in os.walk(root):
        dirs[:] = [d for d in dirs if d not in WALK_SKIP_DIRS and d != "backend"]
        for fn in fnames:
            if not fn.lower().endswith(P_FRONTEND_EXTS):
                continue
            full = os.path.join(base, fn)
            if os.path.islink(full):
                continue
            try:
                if os.path.getsize(full) > P_MAX_FILE_BYTES:
                    continue
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    if p_reaches_unserved_backend(fh.read()):
                        hits.append(os.path.relpath(full, root))
            except OSError:
                continue
    return sorted(hits)


@typechecked
def check_publish_capability(output: Output) -> PublishCapabilityReport:
    """Does this app depend on something publishing cannot carry?"""
    if not is_webapp(output):
        return PublishCapabilityReport()
    root = workspace_dir(output)
    port = p_backend_port(root)
    has_backend = bool(port) or os.path.isfile(os.path.join(root, "backend", "main.py"))
    if not has_backend:
        return PublishCapabilityReport()
    callers = p_api_callers(root)
    if not callers:
        return PublishCapabilityReport(backend_enabled=True, backend_port=port)
    shown = ", ".join(callers[:P_MAX_LISTED])
    if len(callers) > P_MAX_LISTED:
        shown += f", and {len(callers) - P_MAX_LISTED} more"
    return PublishCapabilityReport(
        backend_enabled=True,
        backend_port=port,
        api_callers=callers,
        findings=[
            "This app has a FastAPI backend, and publishing does not upload it. "
            f"{len(callers)} frontend file(s) call /api/... ({shown}); those requests "
            "will 404 on the published URL even though they work in preview.",
            "A published app gets static files plus two same-origin bridges: "
            "window.OUTPUT_COMPUTE(input), which runs a single sandboxed backend.py "
            "(pure compute, no network, no disk, 30s limit), and window.OUTPUT_LLM(body). "
            "Move the server-side logic into backend.py to use OUTPUT_COMPUTE, or keep "
            "this app local instead of publishing it.",
        ],
    )


@typechecked
def merge_capability(output: Output, review: PublishReview) -> PublishReview:
    """Capability findings ride OUTSIDE the security memo, which is keyed on a
    source hash that never sees .env, so a backend_init.sh run would otherwise
    return a cached all-clear."""
    report = check_publish_capability(output)
    if not report.findings:
        return review
    return PublishReview(
        verdict="block",
        findings=report.findings + review.findings,
        scanned_files=review.scanned_files,
    )
