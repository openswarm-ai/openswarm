"""Default template files seeded into new App Builder workspaces."""

import hashlib
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import threading

logger = logging.getLogger(__name__)


def p_resolve_npm() -> list[str] | None:
    """Resolve an invokable npm command. Windows ships npm as npm.cmd (a
    batch shim), which Python's subprocess won't find via a bare "npm";
    and the packaged Electron build bundles only node.exe (no npm) but
    exports OPENSWARM_NODE_PATH, so we also probe node's own bundled
    npm-cli.js. Returns an argv prefix, or None when npm is genuinely
    absent (caller treats warm-cache as a skippable optimization)."""
    node_path = os.environ.get("OPENSWARM_NODE_PATH")
    if node_path and os.path.exists(node_path):
        node_dir = os.path.dirname(node_path)
        # Prefer invoking npm-cli.js through our bundled node so this doesn't depend on a system node for the shim's shebang. Second entry is the canonical Mac-dist layout (lib/node_modules/npm); first is the Windows layout (node_modules/npm beside node.exe).
        for cli in (
            os.path.join(node_dir, "node_modules", "npm", "bin", "npm-cli.js"),
            os.path.join(os.path.dirname(node_dir), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        ):
            if os.path.exists(cli):
                return [node_path, cli]
        for shim in ("npm.cmd", "npm"):
            cand = os.path.join(node_dir, shim)
            if os.path.exists(cand):
                return [cand]
    for name in ("npm.cmd", "npm") if sys.platform == "win32" else ("npm",):
        found = shutil.which(name)
        if found:
            return [found]
    return None


def p_resolve_python() -> str:
    """The interpreter to build warm/workspace venvs with. sys.executable
    is the running backend's python (bundled standalone in the packaged
    build, system python in dev) and is always valid, sidestepping the
    Windows `python3` Microsoft-Store alias shim that shutil.which finds
    first and which exits non-zero with 'Python was not found'."""
    return sys.executable

# Absolute path to the bundled skill source. Surfaced as a constant so the skills subsystem can register it as a built-in skill (copy into ~/.claude/skills/ on first boot) without re-deriving the path.
APP_BUILDER_SKILL_SOURCE_PATH = os.path.join(os.path.dirname(__file__), "app_builder_skill.md")

# Second built-in skill: documentation for `swarm-debug`, the colored frame-aware logger pre-installed in every webapp-template workspace's backend. Registered the same way as the App Builder skill.
SWARM_DEBUG_SKILL_SOURCE_PATH = os.path.join(os.path.dirname(__file__), "swarm_debug_skill.md")

# Root of the vendored openswarm-ai/webapp-template snapshot. seed_workspace copytrees this into new-mode workspaces (excluding backend/, which gets brought in on-demand by the workspace's own backend_init.sh). See scripts/fetch-webapp-template.sh for the snapshot fetch + patches.
WEBAPP_TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "webapp_template")

# Bundled default; used as the read-once fallback if the user-editable copy at ~/.claude/skills/app_builder_skill.md has been removed despite the built-in flag (defensive; shouldn't happen in normal use).
with open(APP_BUILDER_SKILL_SOURCE_PATH, encoding="utf-8") as p_f:
    APP_BUILDER_SKILL_DEFAULT = p_f.read()


def load_app_builder_skill() -> str:
    """Return the live App Builder skill content. Prefers the
    user-editable copy at ~/.claude/skills/app_builder_skill.md (so a
    user's edit on the Skills page takes effect on the very next App
    Builder agent turn; no restart, no copy-on-edit dance). Falls back
    to the bundled default if the user file is somehow gone."""
    user_path = os.path.expanduser("~/.claude/skills/app_builder_skill.md")
    if os.path.exists(user_path):
        try:
            with open(user_path, encoding="utf-8") as f:
                return f.read()
        except Exception:
            pass
    return APP_BUILDER_SKILL_DEFAULT


# Backward-compat alias. Older callers import VIEW_BUILDER_SKILL directly, point them at the same content as the user-editable version so a "frozen at import" stale copy can't drift from what the skills page shows.
VIEW_BUILDER_SKILL = APP_BUILDER_SKILL_DEFAULT

VIEW_TEMPLATE_INDEX = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      background: #1a1d27;
      border: 1px solid #2e3248;
      border-radius: 12px;
      padding: 32px;
      max-width: 600px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 8px; }
    p { color: #8892a4; font-size: 0.95rem; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <h1 id="title">Ready</h1>
    <p id="desc">Describe what you want to build and the agent will update this app.</p>
  </div>
  <script>
    const input = window.OUTPUT_INPUT || {};
    const result = window.OUTPUT_BACKEND_RESULT || null;
  </script>
</body>
</html>
"""

VIEW_TEMPLATE_SCHEMA = """\
{
  "type": "object",
  "properties": {},
  "required": []
}
"""

VIEW_TEMPLATE_META = """\
{
  "name": "",
  "description": ""
}
"""

VIEW_TEMPLATE_FILES = {
    "index.html": VIEW_TEMPLATE_INDEX,
    "schema.json": VIEW_TEMPLATE_SCHEMA,
    "meta.json": VIEW_TEMPLATE_META,
}


# --------------------------------------------------------------------------- webapp_template (new-mode) seed helpers ---------------------------------------------------------------------------

def p_ignore_backend(src: str, names: list[str]) -> list[str]:
    """copytree filter; when copying the template root, drop only the
    top-level `backend/` directory. Subdirectories named `backend` deeper
    in the tree (none today, but defensively scoped) are unaffected."""
    if os.path.abspath(src) == os.path.abspath(WEBAPP_TEMPLATE_DIR):
        return [n for n in names if n == "backend"]
    return []


DEBUGGER_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "debugger")
)
TEMPLATE_BACKEND_PATH = os.path.abspath(os.path.join(WEBAPP_TEMPLATE_DIR, "backend"))


# --------------------------------------------------------------------------- Shared node_modules cache; every new webapp-template workspace symlinks its frontend/node_modules to a single warm directory. First-app create pays the ~22s npm-install cost once; every subsequent app is instant (just a symlink + vite startup, ~1s). Cache directory is keyed by a sha of the template's package.json, so a template dep bump invalidates the cache automatically; old caches sit until the user clears ~/.openswarm/cache. ---------------------------------------------------------------------------

p_warm_cache_lock = threading.Lock()
p_warm_cache_thread: threading.Thread | None = None


# Pre-built node_modules archive bundled with packaged releases. Generated by `scripts/build-template-archive.sh` and shipped at this path inside the app's resources. When present (and tagged with the current package.json sha), extract instead of running npm; decompression is ~3 s vs ~22 s for the live install. Stale archives (package.json bumped but archive not rebuilt) are silently ignored, so the live-install fallback always wins on correctness.
P_BUNDLED_ARCHIVE_DIR = os.path.join(
    os.path.dirname(__file__), "webapp_template_cache"
)


def p_bundled_archive_path_for(digest: str) -> str:
    """Sha-tagged archive path so a stale archive from a prior template
    version is automatically skipped instead of overwriting the cache with
    out-of-date modules."""
    return os.path.join(P_BUNDLED_ARCHIVE_DIR, f"node_modules.{digest}.tar.gz")


def bundled_extracted_modules() -> str | None:
    """A node_modules tree shipped ALREADY EXTRACTED in resources (digest-tagged),
    so a workspace can junction straight at it with ZERO extract. This skips the
    ~14s first-app tar-extract on Windows (the extract is dominated by Defender
    scanning ~tens of thousands of small files as they're written; shipping it
    extracted moves that scan to install time, once). Returns the read-only path
    or None when no extracted tree is shipped (e.g. the Mac build, which ships
    the .tar.gz and uses the extract path instead). vite only reads node_modules
    (its optimize cache lives elsewhere), so a read-only shared tree is safe."""
    cand = os.path.join(P_BUNDLED_ARCHIVE_DIR, warm_cache_digest(), "node_modules")
    return cand if os.path.isdir(cand) else None


def p_try_extract_bundled_archive(cache_dir: str, digest: str) -> bool:
    """Unpack the sha-tagged bundled archive into `cache_dir` if one
    exists for the current template digest. Returns True on success,
    False to signal the caller should fall back to a live `npm install`.
    The archive is built from the same package.json + package-lock.json
    sha so the extracted tree is byte-equivalent to `npm ci`."""
    archive_path = p_bundled_archive_path_for(digest)
    if not os.path.exists(archive_path):
        return False
    try:
        logger.info(
            "webapp-template: unpacking bundled warm-cache archive %s",
            archive_path,
        )
        os.makedirs(cache_dir, exist_ok=True)
        # Archive root is `node_modules/`; extracting into cache_dir places it at the expected path. tarfile uses zlib internally for .gz, no extra dep needed.
        with tarfile.open(archive_path, "r:gz") as tar:
            tar.extractall(cache_dir)
        cache_modules = os.path.join(cache_dir, "node_modules")
        if os.path.isdir(cache_modules):
            return True
        logger.warning(
            "webapp-template: bundled archive extracted but no node_modules/ "
            "directory at %s; falling back to npm install",
            cache_modules,
        )
        return False
    except Exception as exc:
        logger.warning(
            "webapp-template: bundled-archive extract failed (%s); "
            "falling back to npm install",
            exc,
        )
        return False


def warm_cache_digest() -> str:
    """Sha of the template's frontend/package.json; used as the cache
    key + the bundled-archive filename suffix so a package.json bump
    invalidates both at once."""
    pkg_path = os.path.join(WEBAPP_TEMPLATE_DIR, "frontend", "package.json")
    try:
        with open(pkg_path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:12]
    except OSError:
        return "fallback"


def p_warm_cache_dir() -> str:
    """Path the warm node_modules lives under. Hashed by package.json so
    upgrades automatically force a re-populate."""
    base = os.environ.get("OPENSWARM_WEBAPP_CACHE_DIR") or os.path.expanduser(
        "~/.openswarm/cache/webapp_template_node_modules"
    )
    return os.path.join(base, warm_cache_digest())


def warm_cache_is_complete(cache_modules: str) -> bool:
    """A populated node_modules/ dir is not proof of a *finished* install.
    npm links package bins (node_modules/.bin/*) in the final phase, so an
    install killed partway (e.g. Electron quit mid-warm) leaves the package
    trees on disk but no .bin/. The old `os.path.isdir(node_modules)` check
    then trusted that half-tree forever, every app symlinked to it, and
    `npm run dev` died with `vite: command not found`. Require the one bin
    every webapp-template app actually launches with so a partial cache is
    treated as not-ready and repopulated instead of cached as good."""
    return os.path.exists(os.path.join(cache_modules, ".bin", "vite"))


def ensure_warm_cache() -> str | None:
    """Populate the warm-cache node_modules if missing or incomplete.
    Returns the absolute path to the populated `node_modules` directory, or
    None on failure. Thread-safe; concurrent callers block on a single
    install instead of racing. Idempotent and fast after the first call."""
    cache_dir = p_warm_cache_dir()
    cache_modules = os.path.join(cache_dir, "node_modules")

    if warm_cache_is_complete(cache_modules):
        return cache_modules

    # Prefer a pre-extracted bundled tree: junction the workspace straight at it, no tar-extract and no npm. This is the #9 first-app speed win on Windows.
    bundled = bundled_extracted_modules()
    if bundled:
        logger.info("webapp-template: using bundled pre-extracted node_modules (zero extract)")
        return bundled

    with p_warm_cache_lock:
        if warm_cache_is_complete(cache_modules):
            return cache_modules
        # A node_modules that exists but flunks the completeness check is a half-finished install; wipe it so the rebuild below starts on clean ground instead of layering onto a broken tree.
        if os.path.isdir(cache_modules):
            shutil.rmtree(cache_modules, ignore_errors=True)
        # Fast path: pre-built archive shipped inside the release. The build script generates this so users hitting OpenSwarm for the first time skip the ~22 s live `npm install`. Falls through on any failure so dev installs (no archive) keep working.
        if p_try_extract_bundled_archive(cache_dir, warm_cache_digest()):
            if warm_cache_is_complete(cache_modules):
                logger.info("webapp-template: warm cache ready from bundled archive")
                return cache_modules
            # Archive unpacked a tree without the launch bin; don't trust it.
            shutil.rmtree(cache_modules, ignore_errors=True)
        try:
            os.makedirs(cache_dir, exist_ok=True)
            # Copy package.json + lockfile (if it exists) into the cache dir so npm has something to install from. We don't write back to the template; the lockfile generated here stays local to the cache.
            tmpl_pkg = os.path.join(WEBAPP_TEMPLATE_DIR, "frontend", "package.json")
            tmpl_lock = os.path.join(WEBAPP_TEMPLATE_DIR, "frontend", "package-lock.json")
            shutil.copyfile(tmpl_pkg, os.path.join(cache_dir, "package.json"))
            base_flags = ["--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error", "--ignore-scripts"]
            npm = p_resolve_npm()
            if npm is None:
                logger.info("webapp-template: no npm available; skipping warm cache (workspace will install on first run)")
                return None
            if os.path.exists(tmpl_lock):
                shutil.copyfile(tmpl_lock, os.path.join(cache_dir, "package-lock.json"))
                cmd = [*npm, "ci", *base_flags]
            else:
                # No lockfile yet; `npm install` resolves the tree and writes one into the cache dir for future use.
                cmd = [*npm, "install", *base_flags]
            logger.info("webapp-template: warming node_modules cache at %s", cache_dir)
            result = subprocess.run(
                cmd, cwd=cache_dir, capture_output=True, text=True, timeout=600
            )
            # --prefer-offline reuses npm's metadata cache, which can be stale: if a pinned transitive (e.g. a @babel/* helper) was published after the cache snapshot, resolution fails ETARGET even though the registry has it. Retry once online (drops --prefer-offline) so a partially-stale cache self-heals instead of dead-ending the whole App Builder frontend.
            if result.returncode != 0 and "ETARGET" in (result.stderr or ""):
                online_cmd = [c for c in cmd if c != "--prefer-offline"]
                logger.info("webapp-template: warm-cache offline pass hit ETARGET; retrying online")
                result = subprocess.run(
                    online_cmd, cwd=cache_dir, capture_output=True, text=True, timeout=600
                )
            if result.returncode != 0:
                logger.warning(
                    "webapp-template warm-cache install failed (rc=%s): %s",
                    result.returncode,
                    (result.stderr or "")[-1500:],
                )
                return None
            # Never hand back a tree the workspace can't actually launch from.
            if not warm_cache_is_complete(cache_modules):
                logger.warning("webapp-template: warm-cache install left no .bin/vite; not caching")
                return None
            return cache_modules
        except Exception as exc:
            logger.warning("webapp-template warm-cache failed: %s", exc)
            return None


def p_try_link_dir(src: str, target: str) -> bool:
    """Point `target` at `src` as cheaply as possible. Prefer a symlink (instant,
    shared, zero disk). On Windows os.symlink needs admin / Developer Mode, which
    a normal user account lacks, so fall back to a directory junction (mklink /J,
    no privilege required), then to a full copy as a last resort so even a
    locked-down Windows box ends up with a usable node_modules. Returns True if
    `target` now resolves to the dependency tree."""
    try:
        os.symlink(src, target)
        return True
    except OSError:
        pass
    if os.name == "nt":
        try:
            r = subprocess.run(
                ["cmd", "/c", "mklink", "/J", target, src],
                capture_output=True, text=True, timeout=15,
            )
            if r.returncode == 0 and os.path.isdir(target):
                return True
        except Exception:
            pass
    try:
        # Slow + uses disk, but guarantees the workspace can boot vite even when neither symlink nor junction is available.
        shutil.copytree(src, target, dirs_exist_ok=True)
        return True
    except OSError as exc:
        logger.warning("webapp-template link/copy failed (%s) for %s", exc, target)
        return False


def link_node_modules(workspace_dir: str) -> None:
    """After copytree, point the workspace's frontend/node_modules at
    the warm-cache directory. Safe fallback; if the cache isn't ready,
    the workspace's run.sh will fall through to its own install path."""
    cache_modules = ensure_warm_cache()
    if not cache_modules:
        return
    # The warm cache holds the TEMPLATE's deps; only link it when this workspace's package.json matches, else run.sh sees vite present, skips install, and the app's custom deps are missing. On mismatch (a customized import) leave node_modules absent so run.sh installs the app's real deps.
    pkg_path = os.path.join(workspace_dir, "frontend", "package.json")
    try:
        with open(pkg_path, "rb") as fh:
            if hashlib.sha256(fh.read()).hexdigest()[:12] != warm_cache_digest():
                return
    except OSError:
        return
    target = os.path.join(workspace_dir, "frontend", "node_modules")
    if os.path.islink(target):
        try:
            if os.readlink(target) == cache_modules:
                return
        except OSError:
            pass
        try:
            os.unlink(target)
        except OSError:
            return
    elif os.path.isdir(target):
        # If the dir is EMPTY (left over from copytree of the template's placeholder node_modules; `.gitkeep`-style scenarios) nuke it so we can symlink to the warm cache. A non-empty directory is treated as a real npm install; respect it and bail.
        try:
            has_content = any(True for _ in os.scandir(target))
        except OSError:
            return
        if has_content:
            return
        try:
            os.rmdir(target)
        except OSError:
            return
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
    except OSError as exc:
        logger.warning("webapp-template mkdir failed (%s) for %s", exc, workspace_dir)
        return
    if p_try_link_dir(cache_modules, target):
        logger.info("webapp-template: linked %s -> %s", target, cache_modules)


# --------------------------------------------------------------------------- Shared Python venv cache; same pattern as the node_modules cache, but for the workspace backend's FastAPI + transitive deps. Eliminates the ~25s `python -m venv` + `pip install -e .` that backend_init.sh otherwise pays per workspace. ---------------------------------------------------------------------------

p_warm_venv_lock = threading.Lock()


def warm_venv_dir() -> str:
    """Cache root for the shared backend venv, keyed by a sha of the
    template backend's pyproject.toml so a dep bump auto-invalidates."""
    pyproject = os.path.join(WEBAPP_TEMPLATE_DIR, "backend", "pyproject.toml")
    try:
        with open(pyproject, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()[:12]
    except OSError:
        digest = "fallback"
    base = os.environ.get("OPENSWARM_BACKEND_VENV_CACHE_DIR") or os.path.expanduser(
        "~/.openswarm/cache/webapp_template_backend_venv"
    )
    return os.path.join(base, digest)


def p_ensure_warm_python_venv() -> str | None:
    """Populate the warm-cache backend venv if missing. Returns the
    absolute path to the populated `.venv` directory, or None on
    failure. Thread-safe and idempotent; fast return after first call."""
    cache_dir = warm_venv_dir()
    venv_dir = os.path.join(cache_dir, ".venv")
    sentinel = os.path.join(cache_dir, ".populated")

    if os.path.isfile(sentinel) and os.path.isdir(venv_dir):
        return venv_dir

    with p_warm_venv_lock:
        if os.path.isfile(sentinel) and os.path.isdir(venv_dir):
            return venv_dir
        try:
            os.makedirs(cache_dir, exist_ok=True)
            # Pick the same python the workspace's run.sh would have picked, so the venv's binary is compatible. Includes bare `python` as the last fallback for Windows, where there's no `python3` symlink; the installer ships just `python.exe`. On macOS/Linux the versioned candidates match first so we don't accidentally pick a system Python 2.x via the bare name.
            py = p_resolve_python()

            # Wipe any half-populated venv from a previous crashed run.
            if os.path.isdir(venv_dir):
                shutil.rmtree(venv_dir, ignore_errors=True)

            logger.info("webapp-template: creating warm backend venv at %s", venv_dir)
            r = subprocess.run(
                [py, "-m", "venv", venv_dir],
                capture_output=True, text=True, timeout=120,
            )
            if r.returncode != 0:
                logger.warning("warm-venv create failed: %s", r.stderr[-1500:])
                return None

            # Install the template's dependencies (fastapi[standard], typeguard, swarm-debug, transitives); keep this list in sync with webapp_template/backend/pyproject.toml. NOT the workspace's own backend, which gets editable-installed per-workspace by run.sh after the cache copy. The venv layout differs by platform: POSIX puts executables in `bin/`, Windows in `Scripts/`, and the executable name itself gets `.exe`.
            if os.name == "nt":
                pip = os.path.join(venv_dir, "Scripts", "pip.exe")
            else:
                pip = os.path.join(venv_dir, "bin", "pip")
            deps = ["fastapi[standard]", "typeguard==4.4.2", "swarm-debug"]
            r = subprocess.run(
                [pip, "install", "--disable-pip-version-check", *deps],
                capture_output=True, text=True, timeout=600,
            )
            if r.returncode != 0:
                logger.warning("warm-venv pip install failed: %s", r.stderr[-1500:])
                return None

            with open(sentinel, "w", encoding="utf-8") as fh:
                fh.write("ok\n")
            logger.info("webapp-template: warm backend venv ready at %s", venv_dir)
            return venv_dir
        except Exception as exc:
            logger.warning("warm python venv failed: %s", exc)
            return None


def warm_cache_in_background() -> None:
    """Kick off a one-shot daemon thread that pre-populates BOTH the
    node_modules cache and the backend-venv cache so the user's FIRST
    webapp-template seed doesn't pay the install costs. No-op (fast
    return) if both caches are already there or a thread is in flight."""
    global p_warm_cache_thread
    if p_warm_cache_thread is not None and p_warm_cache_thread.is_alive():
        return
    node_done = warm_cache_is_complete(os.path.join(p_warm_cache_dir(), "node_modules"))
    venv_done = os.path.isfile(os.path.join(warm_venv_dir(), ".populated"))
    if node_done and venv_done:
        return

    def p_runner() -> None:
        try:
            ensure_warm_cache()
        except Exception:
            logger.exception("background warm node_modules crashed")
        try:
            p_ensure_warm_python_venv()
        except Exception:
            logger.exception("background warm python venv crashed")

    p_warm_cache_thread = threading.Thread(
        target=p_runner, daemon=True, name="webapp-template-warm-cache"
    )
    p_warm_cache_thread.start()


# Trigger pre-warm on module import; backend startup hits this and the installs run in parallel with the rest of the boot. By the time the user creates their first app, node_modules + the backend venv are usually ready.
warm_cache_in_background()


def patch_env_port(env_path: str, key: str, value: str) -> None:
    """Idempotent in-place rewrite: `KEY=...` → `KEY=value`. Appends if
    the key isn't present. Preserves surrounding lines untouched."""
    if not os.path.exists(env_path):
        return
    with open(env_path, encoding="utf-8") as f:
        text = f.read()
    pat = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    new_line = f"{key}={value}"
    if pat.search(text):
        text = pat.sub(new_line, text)
    else:
        if text and not text.endswith("\n"):
            text += "\n"
        text += new_line + "\n"
    with open(env_path, "w", encoding="utf-8") as f:
        f.write(text)


def seed_webapp_template_workspace(workspace_dir: str, frontend_port: int) -> None:
    """Copy the vendored webapp-template snapshot into `workspace_dir`,
    excluding the master template's `backend/` (brought in on-demand by
    the workspace's own `backend_init.sh`). Then:

      1. Copy `.env.example` → `.env` verbatim (preserves the upstream
         defaults `FRONTEND_PORT=4949` and `BACKEND_PORT=NONE`).
      2. Sed both `.env` and `.env.example` to set `FRONTEND_PORT=<port>`.
         BACKEND_PORT stays NONE in both (per spec; the agent flips it
         via backend_init.sh when it needs a backend).
      3. Append an install-specific path to `.env` ONLY (NOT
         `.env.example`; it is an absolute path on the current
         machine, not a template default):
            OPENSWARM_TEMPLATE_BACKEND_PATH=<abs path to master template's backend/>
         It is read by `backend_init.sh`. The debugger is no longer
         seeded from a local path; the template's `pip install -e .`
         resolves `swarm-debug` from PyPI.

    Idempotent within reason; re-running over an existing workspace
    overwrites template files and re-asserts the env values.
    """
    os.makedirs(workspace_dir, exist_ok=True)
    shutil.copytree(
        WEBAPP_TEMPLATE_DIR,
        workspace_dir,
        ignore=p_ignore_backend,
        dirs_exist_ok=True,
    )
    # Symlink the workspace's frontend/node_modules at the warm cache so `npm install` can be skipped entirely by the workspace run.sh.
    link_node_modules(workspace_dir)
    env_path = os.path.join(workspace_dir, ".env")
    env_example_path = os.path.join(workspace_dir, ".env.example")
    src_example = os.path.join(WEBAPP_TEMPLATE_DIR, ".env.example")
    if os.path.exists(src_example):
        shutil.copyfile(src_example, env_path)
    else:
        # .env.example can be absent from a packaged build whose copy step stripped dotfiles (the Windows build's recursive '.env.*' exclude did exactly this). Write the default directly so the workspace always has a .env with BACKEND_PORT=NONE; without it run.sh sees no BACKEND_PORT, takes the backend branch, and dies on a backend that isn't there, leaving the app stuck on the splash. Mac was unaffected because its build anchors the exclude and ships .env.example.
        with open(env_path, "w", encoding="utf-8") as f:
            f.write("BACKEND_PORT=NONE\nFRONTEND_PORT=4949\n")

    patch_env_port(env_path, "FRONTEND_PORT", str(frontend_port))
    patch_env_port(env_example_path, "FRONTEND_PORT", str(frontend_port))

    # Install-specific paths; .env only.
    patch_env_port(env_path, "OPENSWARM_TEMPLATE_BACKEND_PATH", TEMPLATE_BACKEND_PATH)
    # Backend-venv warm-cache path; backend_init.sh checks this for a pre-populated `.venv/` to cp -aR into the workspace instead of paying the ~25s venv-create + pip-install cost. Written even if the cache isn't ready yet; backend_init.sh re-checks at run time.
    patch_env_port(env_path, "OPENSWARM_BACKEND_VENV_CACHE", warm_venv_dir())

    # Make the shipped scripts executable. tarball/git extracts may strip the +x bit depending on how the snapshot was vendored.
    for script in ("run.sh", "backend_init.sh", "restart.sh", "frontend/run.sh"):
        p = os.path.join(workspace_dir, script)
        if os.path.exists(p):
            os.chmod(p, 0o755)
