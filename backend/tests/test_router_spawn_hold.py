"""A test process never starts a router: the boot hook's sync npm install hung the whole suite on a router-less runner."""
import logging

import pytest

from backend.apps.nine_router import process


@pytest.mark.asyncio
async def test_a_held_spawn_never_reaches_the_installer_and_says_so_once(monkeypatch):
    monkeypatch.setenv("OSW_NEVER_SPAWN_ROUTER", "1")
    process.p_spawn_hold_said = False

    async def boom():
        raise AssertionError("the installer ran under a held spawn")

    monkeypatch.setattr(process, "p_ensure_running_impl", boom)
    seen = []
    handler = logging.Handler()
    handler.emit = lambda rec: seen.append(rec.getMessage())
    process.logger.addHandler(handler)
    try:
        await process.ensure_running()
        await process.ensure_running()
    finally:
        process.logger.removeHandler(handler)
    said = [m for m in seen if "NOT starting the router" in m]
    assert len(said) == 1, said


def test_the_suite_and_ci_declare_the_hold():
    import os
    import pathlib
    assert os.environ.get("OSW_NEVER_SPAWN_ROUTER") == "1", "conftest must set it"
    ci = pathlib.Path(".github/workflows/suites-matrix.yml").read_text(encoding="utf-8")
    assert "OSW_NEVER_SPAWN_ROUTER: '1'" in ci
