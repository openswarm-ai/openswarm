"""ENG-293: a published webapp with its own FastAPI backend must carry backend/ + runspec.json in
the bundle (source only, no caches/venv/secrets), and a frontend-only app must carry neither, so
the cloud can trust has_backend without unpacking the tar."""

import io
import json
import os
import tarfile

import pytest

from backend.apps.outputs.models import Output
from backend.apps.outputs import publish_build


def p_make_workspace(tmp_path, with_backend: bool):
    ws = tmp_path / "ws"
    (ws / "frontend").mkdir(parents=True)
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>app</html>")
    if with_backend:
        b = ws / "backend"
        (b / "apps").mkdir(parents=True)
        (b / "main.py").write_text("app = None")
        (b / "apps" / "api.py").write_text("x = 1")
        (b / "requirements.txt").write_text("fastapi==0.115.0")
        (b / ".env").write_text("SECRET=1")
        (b / "__pycache__").mkdir()
        (b / "__pycache__" / "main.cpython-312.pyc").write_bytes(b"\x00")
        (b / ".venv").mkdir()
        (b / ".venv" / "big.py").write_text("nope")
    return str(ws), str(dist)


def p_bundle_names(output, dist):
    data = publish_build.collect_bundle(output, dist)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        return {m.name: tar.extractfile(m).read() if m.isfile() else b"" for m in tar.getmembers()}


def test_backend_workspace_bundles_source_and_runspec(tmp_path, monkeypatch):
    ws, dist = p_make_workspace(tmp_path, with_backend=True)
    out = Output(id="o1", name="T", output_type="webapp")
    monkeypatch.setattr(publish_build, "workspace_dir", lambda o: ws)
    monkeypatch.setattr(publish_build, "is_webapp", lambda o: True)
    names = p_bundle_names(out, dist)
    assert "index.html" in names
    assert "backend/main.py" in names
    assert "backend/apps/api.py" in names
    assert "backend/requirements.txt" in names
    spec = json.loads(names["runspec.json"])
    assert spec["has_backend"] is True and "uvicorn" in spec["start"]
    # The world-readable bundle must never carry secrets or dead weight.
    assert not any(".env" in n for n in names), "dotenv files are secrets"
    assert not any("__pycache__" in n or ".venv" in n or n.endswith(".pyc") for n in names)


def test_frontend_only_workspace_carries_no_backend_or_runspec(tmp_path, monkeypatch):
    ws, dist = p_make_workspace(tmp_path, with_backend=False)
    out = Output(id="o2", name="T", output_type="webapp")
    monkeypatch.setattr(publish_build, "workspace_dir", lambda o: ws)
    monkeypatch.setattr(publish_build, "is_webapp", lambda o: True)
    names = p_bundle_names(out, dist)
    assert "index.html" in names
    assert not any(n.startswith("backend/") for n in names)
    assert "runspec.json" not in names
