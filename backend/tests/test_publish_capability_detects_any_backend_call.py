"""The publish capability gate must catch a backend call however it is spelled (ENG-293).

A published app gets static files plus two same-origin bridges (`/__compute`, one
sandboxed backend.py with no network, no disk and a 30s cap, and `/__llm`). There is
no `/api/*` route, so a frontend that calls its own FastAPI backend works in preview
and 404s the moment it has a public URL.

The gate that warns about this matched the literal string `/api`. An agent that wrote
`const API_BASE = '/backend'` and then fetched `${API_BASE}/items` sailed past it and
shipped a broken app with no warning at all, which is the load-bearing-string-match
shape this codebase treats as a bug in its own right.

These cases are the class, not one string: a base-URL constant, an env var, a proxy
prefix, and a rewritten route. The clean block underneath is the other half of the bar,
because a detector that flags a plain static app just trains people to hit Publish
Anyway.

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_publish_capability_detects_any_backend_call.py -v
"""

import uuid
from typing import Any, List, Tuple

import pytest

from backend.apps.outputs import publish_common
from backend.apps.outputs.models import Output
from backend.apps.outputs.publish_capability import check_publish_capability


# (name, frontend source) pairs that all reach a backend this deploy cannot serve.
P_REACHES_BACKEND: List[Tuple[str, str]] = [
    ("literal /api", "fetch('/api/items').then(r => r.json())"),
    ("base-url constant", "const API_BASE = '/backend';\nfetch(`${API_BASE}/items`)"),
    ("env var base", "const base = import.meta.env.VITE_API_URL;\nfetch(base + '/items')"),
    ("proxy prefix", "await fetch('/server/v1/items')"),
    ("absolute localhost", "fetch('http://localhost:8000/items')"),
    ("axios instance", "axios.create({ baseURL: '/backend' })"),
]

# Static apps that must NOT be flagged, or the warning becomes noise.
P_CLEAN: List[Tuple[str, str]] = [
    ("pure static", "document.querySelector('#app').textContent = 'hi'"),
    ("uses the supported bridge", "const out = await window.OUTPUT_COMPUTE({ x: 1 })"),
    ("uses the llm bridge", "const r = await window.OUTPUT_LLM({ prompt: 'hi' })"),
    ("external api, not ours", "fetch('https://api.github.com/repos/x/y')"),
]


@pytest.fixture
def p_ws_root(tmp_path: Any, monkeypatch: Any) -> Any:
    root = tmp_path / "ws"
    root.mkdir()
    monkeypatch.setattr(publish_common, "OUTPUTS_WORKSPACE_DIR", str(root))
    return root


def p_seeded_app(ws_root: Any, source: str) -> Output:
    """A workspace with a real backend and one frontend file, through the public entry point."""
    wsid = uuid.uuid4().hex
    (ws_root / wsid).mkdir()
    out = Output(name="Demo", description="", files={}, workspace_id=wsid)
    root = ws_root / wsid
    (root / ".env").write_text("BACKEND_PORT=8123\n")
    (root / "backend").mkdir()
    (root / "backend" / "main.py").write_text("app = 1\n")
    fe = root / "frontend" / "src"
    fe.mkdir(parents=True)
    (fe / "api.ts").write_text(source)
    return out


@pytest.mark.parametrize("name,source", P_REACHES_BACKEND, ids=[n for n, _ in P_REACHES_BACKEND])
def test_every_way_of_calling_a_backend_is_caught(p_ws_root: Any, name: str, source: str) -> None:
    out = p_seeded_app(p_ws_root, source)
    hits = check_publish_capability(out).api_callers
    assert hits, (
        f"{name}: this app calls a backend the published deploy cannot serve, and the gate "
        "said nothing. It will 404 in production having worked in preview."
    )


@pytest.mark.parametrize("name,source", P_CLEAN, ids=[n for n, _ in P_CLEAN])
def test_a_static_app_is_not_flagged(p_ws_root: Any, name: str, source: str) -> None:
    out = p_seeded_app(p_ws_root, source)
    hits = check_publish_capability(out).api_callers
    assert not hits, f"{name}: flagged an app that publishes fine, which trains users to ignore the warning"


def test_the_enumeration_did_not_shrink() -> None:
    """A case list that quietly loses entries is a check that quietly stops checking."""
    assert len(P_REACHES_BACKEND) >= 6
    assert len(P_CLEAN) >= 4
