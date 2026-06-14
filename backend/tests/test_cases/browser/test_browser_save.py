"""Sandbox tests for BrowserSaveData's file sink. This is the security surface
(page-derived content, page-derived filename), so the path-confinement, size cap,
and extension allowlist are tested hard, including hostile filenames."""
import json
import os

from backend.apps.agents.browser.browser_save import save_page_data, P_ALLOWED_EXT, P_MAX_BYTES, P_SUBDIR  # p-private-ignore: P_ALLOWED_EXT, P_MAX_BYTES, P_SUBDIR


def test_happy_path_writes_into_browser_data_subdir(tmp_path):
    payload = json.dumps([{"n": "a"}, {"n": "b"}, {"n": "c"}])
    msg = save_page_data(str(tmp_path), "sid", "rows.json", payload)
    assert msg.startswith("Saved")
    assert "3 items" in msg
    out = tmp_path / P_SUBDIR / "rows.json"
    assert out.is_file()
    assert json.loads(out.read_text()) == json.loads(payload)


def test_dict_payload_reports_key_count(tmp_path):
    msg = save_page_data(str(tmp_path), "sid", "obj.json", json.dumps({"a": 1, "b": 2}))
    assert "2 keys" in msg


def test_traversal_filename_is_confined_not_escaped(tmp_path):
    # a '../../evil.json' must NOT land outside the sandbox; basename flattens it
    msg = save_page_data(str(tmp_path), "sid", "../../evil.json", "[]")
    assert msg.startswith("Saved")
    assert (tmp_path / P_SUBDIR / "evil.json").is_file()
    # nothing was written two levels up
    assert not (tmp_path.parent.parent / "evil.json").exists()


def test_absolute_path_filename_is_confined(tmp_path):
    msg = save_page_data(str(tmp_path), "sid", "/etc/evil.json", "[]")
    assert msg.startswith("Saved")
    assert (tmp_path / P_SUBDIR / "evil.json").is_file()
    assert not os.path.exists("/etc/evil.json")


def test_disallowed_extension_is_rejected(tmp_path):
    for bad in ("hack.sh", "x.js", "y.py", "noext"):
        msg = save_page_data(str(tmp_path), "sid", bad, "data")
        assert msg.startswith("Save failed"), bad
    # the allowed ones all pass
    for good in sorted(P_ALLOWED_EXT):
        msg = save_page_data(str(tmp_path), "sid", f"file{good}", "x")
        assert msg.startswith("Saved"), good


def test_empty_filename_is_rejected(tmp_path):
    assert save_page_data(str(tmp_path), "sid", "", "data").startswith("Save failed")
    assert save_page_data(str(tmp_path), "sid", "   ", "data").startswith("Save failed")


def test_oversize_payload_is_rejected(tmp_path):
    big = "x" * (P_MAX_BYTES + 1)
    msg = save_page_data(str(tmp_path), "sid", "big.txt", big)
    assert msg.startswith("Save failed")
    assert not (tmp_path / P_SUBDIR / "big.txt").exists()


def test_falls_back_to_home_workspace_when_no_cwd(tmp_path, monkeypatch):
    monkeypatch.setattr(os.path, "expanduser", lambda p: str(tmp_path))
    msg = save_page_data(None, "sess-xyz", "f.json", "[]")
    assert msg.startswith("Saved")
    assert (tmp_path / ".openswarm" / "workspaces" / "sess-xyz" / P_SUBDIR / "f.json").is_file()


def test_non_json_content_still_saves_without_count(tmp_path):
    msg = save_page_data(str(tmp_path), "sid", "notes.txt", "just some text")
    assert msg.startswith("Saved")
    assert "items" not in msg and "keys" not in msg
    assert (tmp_path / P_SUBDIR / "notes.txt").read_text() == "just some text"
