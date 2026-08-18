"""The publish cliff: an app with a FastAPI backend works in preview and 404s on
its public URL, because publishing uploads a static bundle and the edge has no
/api/* route. Before this gate, nothing in the publish path noticed."""
import uuid

import pytest

from backend.apps.outputs import publish_common
from backend.apps.outputs.models import Output, PublishReview
from backend.apps.outputs.publish_capability import (
    check_publish_capability,
    merge_capability,
)


@pytest.fixture
def p_ws_root(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    root.mkdir()
    monkeypatch.setattr(publish_common, "OUTPUTS_WORKSPACE_DIR", str(root))
    return root


def p_app(ws_root, *, workspace: bool = True) -> Output:
    wsid = uuid.uuid4().hex if workspace else None
    if wsid:
        (ws_root / wsid).mkdir()
    return Output(
        name="Demo", description="", icon="view_quilt",
        input_schema={"type": "object", "properties": {}, "required": []},
        files={}, workspace_id=wsid, session_id=None,
    )


def p_seed(ws_root, output, *, env: str, frontend: str = "", backend_main: bool = False):
    root = ws_root / (output.workspace_id or "")
    (root / ".env").write_text(env)
    if frontend:
        fe = root / "frontend" / "src"
        fe.mkdir(parents=True)
        (fe / "api.ts").write_text(frontend)
    if backend_main:
        be = root / "backend"
        be.mkdir()
        (be / "main.py").write_text("app = 1\n")
    return root


def test_flat_app_has_no_capability_problem(p_ws_root):
    out = p_app(p_ws_root, workspace=False)
    assert check_publish_capability(out).findings == []


def test_frontend_only_workspace_is_clean(p_ws_root):
    out = p_app(p_ws_root)
    p_seed(p_ws_root, out, env="BACKEND_PORT=NONE\n", frontend="fetch('/data.json')\n")
    report = check_publish_capability(out)
    assert report.backend_enabled is False
    assert report.findings == []


def test_backend_plus_api_calls_is_blocked(p_ws_root):
    out = p_app(p_ws_root)
    p_seed(
        p_ws_root, out,
        env="BACKEND_PORT=8123 # chosen by backend_init.sh\nFRONTEND_PORT=4949\n",
        frontend="export const JOBS = '/api/jobs';\nfetch(JOBS);\n",
        backend_main=True,
    )
    report = check_publish_capability(out)
    assert report.backend_enabled is True
    assert report.backend_port == "8123"
    assert report.api_callers == ["frontend/src/api.ts"]
    assert len(report.findings) == 2
    joined = " ".join(report.findings)
    assert "frontend/src/api.ts" in joined
    assert "OUTPUT_COMPUTE" in joined


def test_backend_with_no_callers_loses_nothing(p_ws_root):
    """A backend nothing calls is dead weight, not broken functionality."""
    out = p_app(p_ws_root)
    p_seed(
        p_ws_root, out, env="BACKEND_PORT=8123\n",
        frontend="const x = 1;\n", backend_main=True,
    )
    report = check_publish_capability(out)
    assert report.backend_enabled is True
    assert report.findings == []


def test_backend_dir_without_port_still_counts(p_ws_root):
    """backend_init.sh calls this state inconsistent; publishing must not shrug."""
    out = p_app(p_ws_root)
    p_seed(
        p_ws_root, out, env="BACKEND_PORT=NONE\n",
        frontend="fetch('/api/things')\n", backend_main=True,
    )
    assert check_publish_capability(out).findings != []


def test_apiary_is_not_an_api_call(p_ws_root):
    """Prefix matching would flag /apiary and /rapid; the boundary is load-bearing."""
    out = p_app(p_ws_root)
    p_seed(
        p_ws_root, out, env="BACKEND_PORT=8123\n",
        frontend="fetch('/apiary/bees'); fetch('/rapid');\n", backend_main=True,
    )
    assert check_publish_capability(out).findings == []


def test_backend_dir_is_not_scanned_for_callers(p_ws_root):
    """The backend's own source mentioning /api must not count as a frontend caller."""
    out = p_app(p_ws_root)
    root = p_seed(p_ws_root, out, env="BACKEND_PORT=8123\n", backend_main=True)
    (root / "backend" / "routes.js").write_text("// mounts /api/jobs\n")
    assert check_publish_capability(out).findings == []


def test_merge_escalates_a_clean_security_review_to_block(p_ws_root):
    out = p_app(p_ws_root)
    p_seed(
        p_ws_root, out, env="BACKEND_PORT=8123\n",
        frontend="fetch('/api/x')\n", backend_main=True,
    )
    merged = merge_capability(out, PublishReview(verdict="clean", findings=[]))
    assert merged.verdict == "block"
    assert len(merged.findings) == 2


def test_merge_preserves_security_findings_and_order(p_ws_root):
    out = p_app(p_ws_root)
    p_seed(
        p_ws_root, out, env="BACKEND_PORT=8123\n",
        frontend="fetch('/api/x')\n", backend_main=True,
    )
    merged = merge_capability(
        out, PublishReview(verdict="warn", findings=["reads os.environ"], scanned_files=["a.py"]),
    )
    assert merged.findings[-1] == "reads os.environ"
    assert merged.scanned_files == ["a.py"]


def test_merge_is_a_passthrough_when_nothing_is_lost(p_ws_root):
    out = p_app(p_ws_root)
    p_seed(p_ws_root, out, env="BACKEND_PORT=NONE\n")
    review = PublishReview(verdict="warn", findings=["something else"])
    assert merge_capability(out, review) is review


def test_missing_env_file_does_not_explode(p_ws_root):
    """A half-seeded workspace must read as 'no backend', not raise."""
    out = p_app(p_ws_root)
    report = check_publish_capability(out)
    assert report.backend_enabled is False
    assert report.findings == []


@pytest.mark.asyncio
async def test_publish_route_refuses_to_ship_a_broken_app(p_ws_root, monkeypatch):
    """The route is where the loss was silent: it built and uploaded regardless."""
    from backend.apps.outputs import outputs as outputs_mod
    from backend.apps.outputs.models import PublishRequest

    out = p_app(p_ws_root)
    p_seed(
        p_ws_root, out, env="BACKEND_PORT=8123\n",
        frontend="fetch('/api/jobs')\n", backend_main=True,
    )
    built = []
    monkeypatch.setattr(outputs_mod, "load", lambda _: out)
    monkeypatch.setattr(outputs_mod, "load_settings", lambda: None)
    monkeypatch.setattr(outputs_mod, "build_static", lambda o: built.append(o))

    res = await outputs_mod.publish_output(PublishRequest(output_id=out.id))

    assert res["ok"] is False
    assert res["blocked"] is True
    assert res["review"]["verdict"] == "block"
    assert built == [], "publish must not build once the gate has fired"


@pytest.mark.asyncio
async def test_force_is_still_the_escape_hatch(p_ws_root, monkeypatch):
    """A user who read the finding can still ship; the gate informs, it does not trap."""
    from backend.apps.outputs import outputs as outputs_mod
    from backend.apps.outputs.models import PublishRequest

    out = p_app(p_ws_root)
    p_seed(
        p_ws_root, out, env="BACKEND_PORT=8123\n",
        frontend="fetch('/api/jobs')\n", backend_main=True,
    )
    reached = []

    async def p_boom(_):
        reached.append(True)
        raise publish_common.PublishError("stopped past the gate")

    monkeypatch.setattr(outputs_mod, "load", lambda _: out)
    monkeypatch.setattr(outputs_mod, "save", lambda _: None)
    monkeypatch.setattr(outputs_mod, "load_settings", lambda: None)
    monkeypatch.setattr(outputs_mod, "build_static", p_boom)
    # Force skips CAPABILITY findings only; the security review itself is mandatory (an unavailable review is a block, force or not), so give it a clean pass here.
    from backend.apps.outputs import publish_scan

    async def p_clean_review(*args, **kwargs):
        return [], "clean", True

    monkeypatch.setattr(publish_scan, "llm_findings", p_clean_review)

    res = await outputs_mod.publish_output(PublishRequest(output_id=out.id, force=True))

    assert reached == [True], "force must skip the gate and reach the build"
    assert res["ok"] is False
