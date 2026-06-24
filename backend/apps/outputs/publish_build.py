"""Build + bundle the static artifact the cloud will host. Webapp-mode runs the
bundled node on `vite build`; flat-mode is already the artifact. Secret-shaped
files (.env, private keys) are dropped because a published bundle is world-readable."""
from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import shutil
import tarfile
from typing import Optional

from backend.apps.outputs.models import Output
from backend.apps.outputs.publish_common import PublishError, is_webapp, workspace_dir

logger = logging.getLogger(__name__)

P_BUILD_TIMEOUT = 180  # vite build on a cold-ish node_modules can be slow
P_MAX_BUNDLE_FILE = 25 * 1024 * 1024
P_SECRET_KEY_EXTS = (".pem", ".key", ".p12", ".pfx", ".keystore")


def p_node_bin() -> Optional[str]:
    return os.environ.get("OPENSWARM_NODE_PATH") or shutil.which("node")


def p_safe_build_config(fe: str) -> tuple[list[str], Optional[str]]:
    """vite-plugin-terminal injects a dev-only `virtual:terminal` module that
    breaks `vite build` in older workspaces (the template later gated it to dev,
    but apps seeded before that still carry the ungated plugin). Build against a
    temp config that makes that plugin a no-op (Vite drops null plugins) so ANY
    workspace builds clean. The user's own vite.config is never touched.

    Returns (extra build args, temp-config path to delete) or ([], None)."""
    cfg_name = next(
        (n for n in ("vite.config.ts", "vite.config.js", "vite.config.mjs")
         if os.path.exists(os.path.join(fe, n))),
        None,
    )
    if not cfg_name:
        return [], None
    with open(os.path.join(fe, cfg_name), "r", encoding="utf-8") as f:
        content = f.read()
    if "vite-plugin-terminal" not in content:
        return [], None
    patched = re.sub(
        r"import\s+terminal\s+from\s+['\"]vite-plugin-terminal['\"];?",
        "const terminal = () => null;",
        content,
    )
    ext = os.path.splitext(cfg_name)[1]
    temp_name = f"vite.config.openswarm-publish{ext}"
    with open(os.path.join(fe, temp_name), "w", encoding="utf-8") as f:
        f.write(patched)
    return ["--config", temp_name], os.path.join(fe, temp_name)


async def build_static(output: Output) -> Optional[str]:
    """Webapp apps -> build `frontend/dist`, return its path. Flat apps need no
    build (the files dict is the artifact), return None. Raises PublishError with
    a user-safe message on any failure."""
    if not is_webapp(output):
        return None
    fe = os.path.join(workspace_dir(output), "frontend")
    vite = os.path.join(fe, "node_modules", "vite", "bin", "vite.js")
    node = p_node_bin()
    if not node or not os.path.exists(vite):
        raise PublishError(
            "This app isn't set up to build yet. Open it once in the editor, then try publishing again."
        )
    config_args, temp_cfg = p_safe_build_config(fe)
    proc = await asyncio.create_subprocess_exec(
        node, "node_modules/vite/bin/vite.js", "build", *config_args,
        cwd=fe,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "NODE_ENV": "production"},
    )
    try:
        _out, err = await asyncio.wait_for(proc.communicate(), timeout=P_BUILD_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise PublishError("Building your app took too long and was stopped.")
    finally:
        if temp_cfg:
            try:
                os.remove(temp_cfg)
            except OSError:
                pass
    if proc.returncode != 0:
        logger.error("vite build failed (%s): %s", output.id, err.decode(errors="replace")[-2000:])
        raise PublishError("We couldn't build your app. Make sure it runs in the editor, then try again.")
    dist = os.path.join(fe, "dist")
    if not os.path.isdir(dist):
        raise PublishError("The build finished but produced no files.")
    return dist


def p_is_secret_file(rel_path: str) -> bool:
    """This bundle is served publicly, so anything secret-shaped must never make it
    in. dotenv files and private-key material are the realistic leaks; the webapp
    path already ships only the built dist, this also covers a hand-built flat app."""
    base = rel_path.rsplit("/", 1)[-1].lower()
    return (
        base == ".env"
        or base.startswith(".env.")
        or base.endswith(P_SECRET_KEY_EXTS)
        or base in (".npmrc", ".git-credentials", ".htpasswd")
    )


def collect_bundle(output: Output, dist_dir: Optional[str]) -> bytes:
    """tar.gz of what the cloud should host. Webapp -> the built dist tree.
    Flat -> the files dict, including backend.py (the edge runs it on the shared
    sandbox; the edge refuses to serve .py as a static file). Secret-shaped files
    (.env, private keys) are dropped: a published bundle is world-readable."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        if dist_dir:
            for root, _dirs, files in os.walk(dist_dir):
                for fn in files:
                    full = os.path.join(root, fn)
                    if os.path.islink(full):
                        continue
                    rel = os.path.relpath(full, dist_dir).replace(os.sep, "/")
                    if p_is_secret_file(rel):
                        continue
                    try:
                        if os.path.getsize(full) > P_MAX_BUNDLE_FILE:
                            continue
                    except OSError:
                        continue
                    tar.add(full, arcname=rel)
        else:
            for name, content in (output.files or {}).items():
                rel = name.replace(os.sep, "/")
                if p_is_secret_file(rel):
                    continue
                data = content.encode("utf-8")
                if len(data) > P_MAX_BUNDLE_FILE:
                    continue
                info = tarfile.TarInfo(name=rel)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()
