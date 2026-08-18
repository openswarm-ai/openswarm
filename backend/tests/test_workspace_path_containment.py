"""Workspace path containment for the Output file endpoints (issues #135, #136).

#135: all four guards used `os.path.normpath`, which is pure string math and
never resolves symlinks, so a symlink planted inside a workspace pointed the
read/write/delete anywhere on disk.

#136: `serve_workspace_file` and `seed_workspace` compared with a bare
`startswith(folder)`, so a sibling folder whose name merely PREFIXES the
workspace (`abc` vs `abc-evil`) sailed through a guard meant for `abc`.

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_workspace_path_containment.py -v
"""

import asyncio
import os
from typing import Any, Dict

import pytest
from fastapi import HTTPException

from backend.apps.outputs import outputs as outputs_mod
from backend.apps.outputs.models import WorkspaceSeedRequest
from backend.apps.outputs.workspace_io import resolve_in_workspace



def p_run(coro: Any) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture
def workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> Dict[str, str]:
    """A workspace root with one real workspace, a prefix-colliding sibling, and
    an out-of-tree secret, wired into every endpoint under test."""
    root = tmp_path / "workspaces"
    (root / "abc").mkdir(parents=True)
    (root / "abc-evil").mkdir()
    (root / "abc" / "index.html").write_text("<html>hi</html>")
    (root / "abc-evil" / "loot.txt").write_text("sibling loot")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("top secret")
    monkeypatch.setattr(outputs_mod, "WORKSPACE_DIR", str(root))
    return {"root": str(root), "folder": str(root / "abc"), "outside": str(outside)}


def p_symlink(target: str, link: str) -> None:
    try:
        os.symlink(target, link, target_is_directory=os.path.isdir(target))
    except (OSError, NotImplementedError) as e:
        pytest.skip(f"symlinks unavailable on this platform: {e}")


# --- the resolver itself -----------------------------------------------------

def test_plain_relative_path_resolves(workspace: Dict[str, str]) -> None:
    got = resolve_in_workspace(workspace["folder"], "sub/dir/file.txt")
    assert got == os.path.join(os.path.realpath(workspace["folder"]), "sub", "dir", "file.txt")


def test_folder_itself_is_inside(workspace: Dict[str, str]) -> None:
    assert resolve_in_workspace(workspace["folder"], "") == os.path.realpath(workspace["folder"])


def test_dotdot_escape_is_rejected(workspace: Dict[str, str]) -> None:
    assert resolve_in_workspace(workspace["folder"], "../../outside/secret.txt") is None


def test_absolute_path_is_rejected(workspace: Dict[str, str]) -> None:
    assert resolve_in_workspace(workspace["folder"], "/etc/hosts") is None


def test_sibling_prefix_collision_is_rejected(workspace: Dict[str, str]) -> None:
    """#136: `<root>/abc-evil/loot.txt` string-prefixes `<root>/abc`."""
    assert resolve_in_workspace(workspace["folder"], "../abc-evil/loot.txt") is None


def test_symlink_inside_workspace_is_rejected(workspace: Dict[str, str]) -> None:
    """#135: normpath happily walks `esc` because it never resolves the link."""
    p_symlink(workspace["outside"], os.path.join(workspace["folder"], "esc"))
    assert resolve_in_workspace(workspace["folder"], "esc/secret.txt") is None


def test_symlinked_file_inside_workspace_is_rejected(workspace: Dict[str, str]) -> None:
    p_symlink(os.path.join(workspace["outside"], "secret.txt"),
              os.path.join(workspace["folder"], "leak.txt"))
    assert resolve_in_workspace(workspace["folder"], "leak.txt") is None


def test_symlinked_workspace_root_is_not_false_rejected(tmp_path: Any) -> None:
    """Both sides get realpath'd, so a symlinked ancestor (macOS /var ->
    /private/var, every tempfile path) must not reject a legitimate file."""
    real = tmp_path / "real_ws"
    real.mkdir()
    (real / "index.html").write_text("hi")
    link = tmp_path / "linked_ws"
    p_symlink(str(real), str(link))
    got = resolve_in_workspace(str(link), "index.html")
    assert got == os.path.join(os.path.realpath(str(real)), "index.html")


def test_symlink_pointing_back_inside_is_allowed(workspace: Dict[str, str]) -> None:
    """Containment, not a symlink ban: a link that stays in the workspace works."""
    inner = os.path.join(workspace["folder"], "assets")
    os.makedirs(inner)
    p_symlink(inner, os.path.join(workspace["folder"], "static"))
    assert resolve_in_workspace(workspace["folder"], "static/logo.svg") == os.path.join(
        os.path.realpath(inner), "logo.svg"
    )


# --- the four endpoints that guard with it -----------------------------------

def test_serve_rejects_symlink_escape(workspace: Dict[str, str]) -> None:
    p_symlink(workspace["outside"], os.path.join(workspace["folder"], "esc"))
    with pytest.raises(HTTPException) as e:
        p_run(outputs_mod.serve_workspace_file("abc", "esc/secret.txt"))
    assert e.value.status_code == 403


def test_serve_rejects_sibling_prefix(workspace: Dict[str, str]) -> None:
    with pytest.raises(HTTPException) as e:
        p_run(outputs_mod.serve_workspace_file("abc", "../abc-evil/loot.txt"))
    assert e.value.status_code == 403


def test_serve_still_serves_a_real_file(workspace: Dict[str, str]) -> None:
    resp = p_run(outputs_mod.serve_workspace_file("abc", "index.html"))
    assert b"hi" in resp.body


def test_seed_skips_symlink_escape(workspace: Dict[str, str]) -> None:
    p_symlink(workspace["outside"], os.path.join(workspace["folder"], "esc"))
    p_run(outputs_mod.seed_workspace(WorkspaceSeedRequest(
        workspace_id="abc", files={"esc/planted.txt": "x"}, template_mode="flat",
    )))
    assert not os.path.exists(os.path.join(workspace["outside"], "planted.txt"))


def test_seed_skips_sibling_prefix(workspace: Dict[str, str]) -> None:
    p_run(outputs_mod.seed_workspace(WorkspaceSeedRequest(
        workspace_id="abc", files={"../abc-evil/planted.txt": "x"}, template_mode="flat",
    )))
    assert not os.path.exists(os.path.join(workspace["root"], "abc-evil", "planted.txt"))


def test_seed_still_writes_a_real_file(workspace: Dict[str, str]) -> None:
    p_run(outputs_mod.seed_workspace(WorkspaceSeedRequest(
        workspace_id="abc", files={"app/main.py": "print(1)"}, template_mode="flat",
    )))
    assert os.path.isfile(os.path.join(workspace["folder"], "app", "main.py"))


def test_write_rejects_symlink_escape(workspace: Dict[str, str]) -> None:
    p_symlink(workspace["outside"], os.path.join(workspace["folder"], "esc"))
    with pytest.raises(HTTPException) as e:
        p_run(outputs_mod.write_workspace_file("abc", "esc/planted.txt", {"content": "x"}))
    assert e.value.status_code == 403
    assert not os.path.exists(os.path.join(workspace["outside"], "planted.txt"))


def test_write_still_writes_a_real_file(workspace: Dict[str, str]) -> None:
    p_run(outputs_mod.write_workspace_file("abc", "notes/todo.md", {"content": "hello"}))
    assert (open(os.path.join(workspace["folder"], "notes", "todo.md")).read()) == "hello"


def test_delete_rejects_symlink_escape(workspace: Dict[str, str]) -> None:
    p_symlink(workspace["outside"], os.path.join(workspace["folder"], "esc"))
    with pytest.raises(HTTPException) as e:
        p_run(outputs_mod.delete_workspace_file("abc", "esc/secret.txt"))
    assert e.value.status_code == 403
    assert os.path.exists(os.path.join(workspace["outside"], "secret.txt"))


def test_delete_still_deletes_a_real_file(workspace: Dict[str, str]) -> None:
    victim = os.path.join(workspace["folder"], "deep", "gone.txt")
    os.makedirs(os.path.dirname(victim))
    open(victim, "w").write("x")
    p_run(outputs_mod.delete_workspace_file("abc", "deep/gone.txt"))
    assert not os.path.exists(victim)
    assert not os.path.isdir(os.path.dirname(victim))


def test_delete_prunes_up_to_but_not_past_the_workspace(workspace: Dict[str, str]) -> None:
    victim = os.path.join(workspace["folder"], "only.txt")
    open(victim, "w").write("x")
    p_run(outputs_mod.delete_workspace_file("abc", "only.txt"))
    assert os.path.isdir(workspace["folder"])
