"""ENG-47: the upload tool is the first browser tool that can move bytes off the machine, and the
browser sub-agent takes its instructions from the page it is driving. These pin the containment
guard, including the case that matters most: a symlink planted INSIDE an allowed root."""

import os
import pytest

from backend.apps.agents.browser.resolve_upload_path import (
    resolve_upload_path,
    allowed_upload_roots,
    UploadPathRefused,
    MAX_UPLOAD_BYTES,
)


@pytest.fixture
def uploads_dir():
    root = allowed_upload_roots()[0]
    os.makedirs(root, exist_ok=True)
    return root


def test_a_file_the_user_attached_is_uploadable(uploads_dir):
    f = os.path.join(uploads_dir, "resume.pdf")
    with open(f, "w", encoding="utf-8") as fh:
        fh.write("cv")
    assert resolve_upload_path(f) == os.path.realpath(f)


@pytest.mark.parametrize("hostile", ["~/.ssh/id_rsa", "/etc/passwd", "/etc/hosts", ""])
def test_paths_outside_every_allowed_root_are_refused(hostile):
    with pytest.raises(UploadPathRefused):
        resolve_upload_path(hostile)


def test_a_symlink_inside_an_allowed_root_cannot_smuggle_a_file_out(uploads_dir):
    # String math on the path would pass this: it really does live under the uploads root.
    link = os.path.join(uploads_dir, "innocent.txt")
    if os.path.lexists(link):
        os.remove(link)
    os.symlink("/etc/hosts", link)
    try:
        with pytest.raises(UploadPathRefused):
            resolve_upload_path(link)
    finally:
        os.remove(link)


def test_a_sibling_root_with_a_shared_prefix_is_not_inside_it(uploads_dir):
    # Without the trailing separator, root `self-swarm-uploads` would own `self-swarm-uploads-evil`.
    evil = uploads_dir + "-evil"
    os.makedirs(evil, exist_ok=True)
    f = os.path.join(evil, "x.txt")
    with open(f, "w", encoding="utf-8") as fh:
        fh.write("x")
    with pytest.raises(UploadPathRefused):
        resolve_upload_path(f)


def test_a_directory_is_not_a_file(uploads_dir):
    with pytest.raises(UploadPathRefused):
        resolve_upload_path(uploads_dir)


def test_an_oversized_file_is_refused(uploads_dir, monkeypatch):
    f = os.path.join(uploads_dir, "huge.bin")
    with open(f, "w", encoding="utf-8") as fh:
        fh.write("x")
    monkeypatch.setattr(os.path, "getsize", lambda p: MAX_UPLOAD_BYTES + 1)
    with pytest.raises(UploadPathRefused):
        resolve_upload_path(f)


def test_the_dispatcher_refuses_before_the_command_leaves_the_backend(monkeypatch):
    """The guard has to sit in front of the WS hop, not inside the renderer."""
    import asyncio
    import backend.apps.agents.core.ws_manager as ws_mod
    from backend.apps.agents.browser import browser_agent

    sent = []

    async def spy(*args, **kwargs):
        sent.append(args)
        return {"text": "should never happen"}

    monkeypatch.setattr(ws_mod.ws_manager, "send_browser_command", spy, raising=True)
    out = asyncio.run(browser_agent.execute_browser_tool(
        "BrowserUploadFile", {"path": "/etc/passwd"}, "browser-1"))
    assert "Refused" in str(out.get("error", ""))
    assert sent == [], "a refused path must never reach the renderer"
