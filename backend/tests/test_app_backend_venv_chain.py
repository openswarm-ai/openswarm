"""The fresh-app-cannot-boot-a-backend chain (Haik, 2026-08-14, stable 1.7.7).

Root cause, verified against the shipped bundle: the packaged interpreter has no `ensurepip` and
no `pip`, so `python -m venv` yields a venv holding three symlinks and nothing else. The warm-cache
builder left that hollow venv on disk on every failure path, and `backend_init.sh` reused it on a
directory-exists check, so a known-broken venv was copied into every new app while three layers
printed success. These pin each link so the chain cannot silently reform.
"""

import inspect
import os
import re

from backend.apps.outputs import view_builder_templates


TEMPLATE_DIR = os.path.join(os.path.dirname(inspect.getfile(view_builder_templates)), "webapp_template")


def p_builder_src() -> str:
    return inspect.getsource(view_builder_templates.p_ensure_warm_python_venv)


# --------------------------------------------------------------- never leave known-bad output


def test_every_failure_path_deletes_the_half_built_venv():
    src = p_builder_src()
    # Each `return None` in the body must be preceded by a cleanup; count them as pairs.
    returns = src.count("return None")
    cleanups = src.count("shutil.rmtree(venv_dir, ignore_errors=True)")
    assert returns >= 3, "the builder should still have its failure paths"
    assert cleanups >= returns, (
        f"{returns} failure paths but only {cleanups} cleanups; a hollow venv left on disk "
        "gets copied into the next app forever"
    )


def test_the_builder_refuses_a_venv_with_no_pip():
    src = p_builder_src()
    assert "os.path.exists(pip)" in src, "a venv without pip must be discarded, not populated"


def test_the_sentinel_means_usable_not_merely_attempted():
    src = p_builder_src()
    i_probe = src.find("import fastapi, typeguard, httpx, uvicorn")
    i_sentinel = src.find('open(sentinel, "w"')
    assert i_probe != -1, "the builder must prove the venv can import what the template needs"
    assert i_probe < i_sentinel, "the import probe must run BEFORE the sentinel is written"


# --------------------------------------------------------------- the consumer honors the sentinel


def test_backend_init_gates_reuse_on_the_sentinel_not_directory_existence():
    init = open(os.path.join(TEMPLATE_DIR, "backend_init.sh"), encoding="utf-8").read()
    assert "CACHE_SENTINEL" in init, "the reuse gate must consult .populated"
    reuse = re.search(r'if \[\[ -d "\$CACHE_VENV".*?\]\]; then\n\s*echo "Reusing', init, re.S)
    assert reuse and "CACHE_SENTINEL" in reuse.group(0), (
        "the branch that copies the cache must require the sentinel; -d alone copies hollow venvs"
    )


# --------------------------------------------------------------- the interpreter must be capable


def test_the_packaged_build_keeps_ensurepip():
    build = open(os.path.join(os.path.dirname(view_builder_templates.__file__), "..", "..", "..",
                              "scripts", "build-python-env.sh"), encoding="utf-8").read()
    assert 'rm -rf "$PYTHON_ENV_DIR/lib/python3.13/ensurepip"' not in build, (
        "stripping ensurepip makes every app-backend venv hollow; that is the root cause"
    )
    assert "cannot create a venv with pip" in build, (
        "the build must PROVE the bundled interpreter can make a working venv, not assume it"
    )


# --------------------------------------------------------------- host env must not leak


def test_pythonpath_is_stripped_from_workspace_subprocesses():
    from backend.apps.outputs.runtime import AppRuntime
    src = inspect.getsource(AppRuntime.p_spawn_env_base)
    assert "PYTHONPATH" in src, (
        "the host's PYTHONPATH points at the app bundle's site-packages and shadows the "
        "workspace venv, so pip reports success while installing nothing"
    )


# --------------------------------------------------------------- serve mode vs a real backend


def test_serve_mode_never_engages_for_an_app_that_declares_a_backend():
    from backend.apps.outputs.runtime import AppRuntime
    src = inspect.getsource(AppRuntime.p_start_new_mode)
    assert "p_declares_backend" in src, (
        "serve mode spawns nothing; engaging it for an app with a backend serves a bundle "
        "against an API that was never started, and returns True"
    )
    assert src.index("p_declares_backend") < src.index("self.serve_static = True")


def test_a_restart_re_decides_serve_mode():
    from backend.apps.outputs.runtime import AppRuntime
    src = inspect.getsource(AppRuntime.start)
    assert "self.serve_static = False" in src, "a stale serve_static survives the restart meant to clear it"


def test_the_restart_sentinel_watcher_can_see_serve_mode_runtimes():
    from backend.apps.outputs.runtime import AppRuntimeManager
    src = inspect.getsource(AppRuntimeManager)
    watcher = src[src.find("RESTART_SENTINEL_NAME"):]
    assert "peer.serve_static" in watcher, (
        "a serve-mode runtime has no process, so gating on `running` made restart.sh dead on "
        "exactly the runtimes that needed restarting"
    )
