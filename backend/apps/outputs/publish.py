"""App publishing: build the static bundle, scan it, ship it to the cloud host.

A finished app is static: webapp-mode builds to `frontend/dist` via the bundled
node (same node the runtime spawns vite with); flat-mode is already `index.html`.
The optional `backend.py` is the sandboxed data-shaping kind, so the cloud edge
can run it on a shared sandbox. Scanning runs here on the user's OWN creds, so it
costs us nothing and the code never leaves the machine until they choose to ship.

Layering note: this lives under `outputs/` (below `swarm/`), so it reuses the
local `get_code_warnings` and defines its own review model rather than importing
`swarm.review` upward. The JSON shape matches the frontend `ReviewSummary`."""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import shutil
import tarfile
from typing import Literal, Optional

import httpx

from backend.apps.outputs.executor import get_code_warnings
from backend.apps.outputs.models import Output, PublishReview
from backend.apps.outputs.workspace_io import _WALK_SKIP_DIRS
from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL
from backend.config.paths import OUTPUTS_WORKSPACE_DIR

logger = logging.getLogger(__name__)

_BUILD_TIMEOUT = 180  # vite build on a cold-ish node_modules can be slow
_SCAN_CODE_BUDGET = 60_000  # chars of source we hand the aux model
_MAX_BUNDLE_FILE = 25 * 1024 * 1024
_SCAN_EXTS = (".py", ".html", ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".css")

_SCAN_SYSTEM_PROMPT = (
    "You are a security reviewer for a no-code app host. The app below will be "
    "served publicly at a *.openswarm.dev subdomain. Read the source and report "
    "only concrete, real risks a reviewer would act on: hardcoded secrets or API "
    "keys, phishing or credential-harvesting forms, sending user data to a "
    "third-party endpoint, obvious XSS or injection, or anything malicious. Do "
    "NOT nitpick style or speculate. Reply ONLY with JSON: "
    '{"severity": "clean|warn|block", "findings": ["short dev-readable line", ...]}. '
    "Use block only for clearly malicious or credential-harvesting code. Empty "
    "findings means clean."
)


class PublishError(Exception):
    """User-facing publish failure; message is safe to show in a toast."""


def slugify(name: str) -> str:
    """A url-safe slug hint from the app name; the cloud guarantees uniqueness."""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "app").lower()).strip("-")
    s = s[:32].strip("-")
    return s or "app"


def is_webapp(output: Output) -> bool:
    return bool(output.workspace_id)


def _workspace_dir(output: Output) -> str:
    return os.path.join(OUTPUTS_WORKSPACE_DIR, output.workspace_id or "")


def _node_bin() -> Optional[str]:
    return os.environ.get("OPENSWARM_NODE_PATH") or shutil.which("node")


# --- source collection (for scanning) ---------------------------------------

def _collect_source(output: Output) -> dict[str, str]:
    """Gather human-readable source text for the scan. Flat apps come from the
    files dict; webapp apps walk the workspace skipping node_modules/.venv/dist."""
    src: dict[str, str] = {}
    for name, content in (output.files or {}).items():
        if name.lower().endswith(_SCAN_EXTS):
            src[name] = content
    if is_webapp(output):
        root = _workspace_dir(output)
        for base, _dirs, fnames in os.walk(root):
            _dirs[:] = [d for d in _dirs if d not in _WALK_SKIP_DIRS]
            for fn in fnames:
                if not fn.lower().endswith(_SCAN_EXTS):
                    continue
                full = os.path.join(base, fn)
                if os.path.islink(full):
                    continue
                try:
                    if os.path.getsize(full) > 512 * 1024:
                        continue
                    with open(full, "r", encoding="utf-8", errors="replace") as f:
                        rel = os.path.relpath(full, root).replace(os.sep, "/")
                        src[rel] = f.read()
                except OSError:
                    continue
    return src


def _scan_blob(src: dict[str, str]) -> str:
    parts: list[str] = []
    total = 0
    for path, code in src.items():
        chunk = f"=== {path} ===\n{code}\n"
        if total + len(chunk) > _SCAN_CODE_BUDGET:
            chunk = chunk[: max(0, _SCAN_CODE_BUDGET - total)]
        parts.append(chunk)
        total += len(chunk)
        if total >= _SCAN_CODE_BUDGET:
            break
    return "".join(parts)


def _ast_findings(src: dict[str, str]) -> tuple[list[str], list[str]]:
    findings: list[str] = []
    scanned: list[str] = []
    for path, code in src.items():
        if path.lower().endswith(".py"):
            scanned.append(path)
            for w in get_code_warnings(code):
                findings.append(f"{path}: {w}")
    return findings, scanned


async def _llm_findings(src: dict[str, str], settings) -> tuple[list[str], str]:
    """Aux-tier semantic pass. Best-effort: if no aux model is configured or the
    call fails, return clean so the AST pass still gates. Runs on the user's creds."""
    blob = _scan_blob(src)
    if not blob.strip():
        return [], "clean"
    from backend.apps.agents.providers.registry import resolve_aux_model
    from backend.apps.settings.credentials import get_anthropic_client_for_model
    from backend.apps.agents.core.aux_llm import _safe_resp_text
    try:
        model, _base = await resolve_aux_model(settings, preferred_tier="haiku")
    except Exception:
        return [], "clean"
    client = get_anthropic_client_for_model(settings, model)
    try:
        resp = await client.messages.create(
            model=model,
            max_tokens=1200,
            system=_SCAN_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": blob}],
        )
    except Exception:
        logger.exception("publish LLM scan call failed; AST-only result stands")
        return [], "clean"
    text = _safe_resp_text(resp).strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return [], "clean"
    findings = [str(f) for f in parsed.get("findings", []) if str(f).strip()][:20]
    severity = parsed.get("severity", "clean")
    if severity not in ("clean", "warn", "block"):
        severity = "warn" if findings else "clean"
    return findings, severity


async def scan_for_publish(output: Output, settings) -> PublishReview:
    src = _collect_source(output)
    ast_findings, scanned = _ast_findings(src)
    llm_findings, llm_sev = await _llm_findings(src, settings)
    findings = ast_findings + llm_findings
    verdict: Literal["clean", "warn", "block"] = "clean"
    if findings:
        verdict = "warn"
    if llm_sev == "block":
        verdict = "block"
    return PublishReview(
        verdict=verdict,
        findings=findings,
        scanned_files=scanned or sorted(src.keys()),
    )


def quick_ast_gate(output: Output) -> list[str]:
    """Cheap, free safety net used by /publish when force is not set: flags the
    AST-visible 'runs code outside the sandbox' findings without an LLM call."""
    findings, _ = _ast_findings(_collect_source(output))
    return findings


# --- build + bundle ----------------------------------------------------------

async def build_static(output: Output) -> Optional[str]:
    """Webapp apps -> build `frontend/dist`, return its path. Flat apps need no
    build (the files dict is the artifact), return None. Raises PublishError with
    a user-safe message on any failure."""
    if not is_webapp(output):
        return None
    fe = os.path.join(_workspace_dir(output), "frontend")
    vite = os.path.join(fe, "node_modules", "vite", "bin", "vite.js")
    node = _node_bin()
    if not node or not os.path.exists(vite):
        raise PublishError(
            "This app isn't set up to build yet. Open it once in the editor, then try publishing again."
        )
    proc = await asyncio.create_subprocess_exec(
        node, "node_modules/vite/bin/vite.js", "build",
        cwd=fe,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "NODE_ENV": "production"},
    )
    try:
        _out, err = await asyncio.wait_for(proc.communicate(), timeout=_BUILD_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise PublishError("Building your app took too long and was stopped.")
    if proc.returncode != 0:
        logger.error("vite build failed (%s): %s", output.id, err.decode(errors="replace")[-2000:])
        raise PublishError("We couldn't build your app. Make sure it runs in the editor, then try again.")
    dist = os.path.join(fe, "dist")
    if not os.path.isdir(dist):
        raise PublishError("The build finished but produced no files.")
    return dist


def collect_bundle(output: Output, dist_dir: Optional[str]) -> bytes:
    """tar.gz of what the cloud should host. Webapp -> the built dist tree.
    Flat -> the files dict, including backend.py (the edge runs it on the shared
    sandbox; the edge refuses to serve .py as a static file)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        if dist_dir:
            for root, _dirs, files in os.walk(dist_dir):
                for fn in files:
                    full = os.path.join(root, fn)
                    if os.path.islink(full):
                        continue
                    try:
                        if os.path.getsize(full) > _MAX_BUNDLE_FILE:
                            continue
                    except OSError:
                        continue
                    rel = os.path.relpath(full, dist_dir).replace(os.sep, "/")
                    tar.add(full, arcname=rel)
        else:
            for name, content in (output.files or {}).items():
                data = content.encode("utf-8")
                if len(data) > _MAX_BUNDLE_FILE:
                    continue
                info = tarfile.TarInfo(name=name.replace(os.sep, "/"))
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# --- cloud client ------------------------------------------------------------

def _cloud_auth(settings) -> tuple[Optional[str], str]:
    """Publish works for ANY signed-in account, so read the bearer directly
    rather than proxy_auth (which only yields a token in pro/free-trial modes).
    Matches the cloud's requireAuthedUser gate."""
    base = (getattr(settings, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL).rstrip("/")
    token = getattr(settings, "openswarm_bearer_token", None)
    return token, base


def _safe_detail(resp: httpx.Response, fallback: str) -> str:
    try:
        body = resp.json()
        msg = body.get("message") or body.get("error")
        if isinstance(msg, str) and msg:
            return msg
    except Exception:
        pass
    return fallback


async def upload_to_cloud(
    settings, *, output_id: str, name: str, slug_hint: str, bundle: bytes, override: bool
) -> dict:
    token, base = _cloud_auth(settings)
    if not token:
        raise PublishError("Sign in to your OpenSwarm account to publish apps.")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{base}/api/apps/publish",
                headers={"Authorization": f"Bearer {token}"},
                # output_id lets the cloud reuse this app's slug on republish instead
                # of minting a duplicate; override marks a publish past a non-clean scan.
                data={"name": name, "slug": slug_hint, "output_id": output_id, "override": "1" if override else "0"},
                files={"bundle": ("app.tar.gz", bundle, "application/gzip")},
            )
    except httpx.HTTPError:
        raise PublishError("Couldn't reach the publishing service. Check your connection and try again.")
    if r.status_code >= 400:
        raise PublishError(_safe_detail(r, "Publishing failed. Please try again."))
    return r.json()


async def unpublish_from_cloud(settings, slug: str) -> None:
    token, base = _cloud_auth(settings)
    if not token:
        raise PublishError("Sign in to your OpenSwarm account to manage published apps.")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{base}/api/apps/{slug}/delete",
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError:
        raise PublishError("Couldn't reach the publishing service. Check your connection and try again.")
    if r.status_code >= 400 and r.status_code != 404:
        raise PublishError(_safe_detail(r, "Couldn't unpublish. Please try again."))
