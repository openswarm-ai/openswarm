"""Unit tests for edge routing, path-safe bundle resolution, rate limiting,
installer streaming with mocked upstreams, and the vendored sandbox. Tigris and
the LLM proxy still require live services and are exercised in staging E2E.

Run with:  .venv/bin/python -m pytest tests/test_edge.py
"""
import asyncio
import io
import json
import os
import sys
import tarfile

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import main as edge_main
from app.main import slug_from_host
from app.bundles import unpack, resolve_file
from app.inject import inject_runtime
from app.ratelimit import RateLimiter
from app.code_safety import validate_code_safety, UnsafeCodeError
from app import sandbox as edge_sandbox
from app.sandbox import run_backend


def test_slug_from_host():
    assert slug_from_host("notes.openswarm.host") == "notes"
    assert slug_from_host("notes.openswarm.host:443") == "notes"
    assert slug_from_host("UPPER.openswarm.host") == "upper"
    assert slug_from_host("openswarm.host") is None        # apex
    assert slug_from_host("www.openswarm.host") is None     # www
    assert slug_from_host("a.b.openswarm.host") is None     # multi-label
    assert slug_from_host("notes.evil.com") is None        # wrong domain
    assert slug_from_host("bad_slug.openswarm.host") is None  # underscore


def _mk_tar(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_resolve_file_paths():
    b = unpack(_mk_tar({
        "index.html": b"<html>home</html>",
        "assets/app.js": b"console.log(1)",
        "backend.py": b"result={}",
    }))
    assert resolve_file(b, "/")[0] == b"<html>home</html>"
    assert resolve_file(b, "assets/app.js")[1] == "text/javascript"
    assert resolve_file(b, "deep/spa/route")[0] == b"<html>home</html>"   # SPA fallback
    assert resolve_file(b, "backend.py")[0] == b"<html>home</html>"       # never serve source
    assert resolve_file(b, "../../etc/passwd")[0] == b"<html>home</html>"  # traversal blocked


def test_backend_code_available_for_compute_not_static():
    b = unpack(_mk_tar({"index.html": b"x", "backend.py": b"import math\nresult={}"}))
    assert b.backend_code == "import math\nresult={}"
    data, _ = resolve_file(b, "backend.py")
    assert data == b"x"


def test_rate_limiter():
    rl = RateLimiter(limit=3, window_seconds=100)
    assert all(rl.allow("ip1") for _ in range(3))
    assert rl.allow("ip1") is False  # 4th over the limit
    assert rl.allow("ip2") is True   # a different key is independent


def _mock_download_clients(monkeypatch, *, reject_unknown=False):
    calls = []

    class InstallerStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"installer-bytes"

    async def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/api/install/authorize-download":
            payload = json.loads(request.content)
            assert request.headers["x-edge-auth"] == edge_main.EDGE_AUTH_TOKEN
            if reject_unknown and payload["platform"] == "plan9":
                return httpx.Response(404, json={"message": "unknown download target"})
            return httpx.Response(
                200,
                json={
                    "assetUrl": "https://github.test/OpenSwarm-arm64.dmg",
                    "filename": "OpenSwarm-arm64-affiliate_hash_123.dmg",
                },
            )
        if request.url.host == "github.test":
            return httpx.Response(
                200,
                stream=InstallerStream(),
                headers={
                    "Content-Type": "application/x-apple-diskimage",
                    "Content-Length": "15",
                },
            )
        raise AssertionError(f"unexpected upstream request: {request.url}")

    transport = httpx.MockTransport(handle)
    real_async_client = httpx.AsyncClient

    def mocked_async_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(edge_main.httpx, "AsyncClient", mocked_async_client)
    return calls


def test_download_streams_bytes_with_cloud_filename(monkeypatch):
    calls = _mock_download_clients(monkeypatch)
    client = TestClient(edge_main.app)
    response = client.get(
        "/download/mac/arm64?ref=alice",
        headers={"host": edge_main.EDGE_PUBLIC_HOST, "fly-client-ip": "198.51.100.11"},
    )

    assert response.status_code == 200
    assert response.content == b"installer-bytes"
    assert response.headers["content-type"] == "application/x-apple-diskimage"
    assert response.headers["content-length"] == "15"
    assert response.headers["content-disposition"] == (
        'attachment; filename="OpenSwarm-arm64-affiliate_hash_123.dmg"'
    )
    assert response.headers["cache-control"] == "private, no-store"
    assert json.loads(calls[0].content) == {"platform": "mac", "arch": "arm64", "ref": "alice"}
    assert calls[1].url.host == "github.test"


def test_download_rejects_app_subdomains_without_upstream_call(monkeypatch):
    calls = _mock_download_clients(monkeypatch)
    client = TestClient(edge_main.app)
    response = client.get(
        "/download/mac/arm64",
        headers={"host": "notes.openswarm.host", "fly-client-ip": "198.51.100.12"},
    )

    assert response.status_code == 404
    assert calls == []


def test_download_maps_unknown_target_to_404(monkeypatch):
    _mock_download_clients(monkeypatch, reject_unknown=True)
    client = TestClient(edge_main.app)
    response = client.get(
        "/download/plan9/x64",
        headers={"host": edge_main.EDGE_PUBLIC_HOST, "fly-client-ip": "198.51.100.13"},
    )

    assert response.status_code == 404
    assert response.json() == {"error": "unknown download target"}


def test_download_rate_limits_per_client_ip(monkeypatch):
    calls = _mock_download_clients(monkeypatch)
    monkeypatch.setattr(edge_main, "_download_limiter", RateLimiter(limit=1, window_seconds=60))
    client = TestClient(edge_main.app)
    headers = {"host": edge_main.EDGE_PUBLIC_HOST, "fly-client-ip": "198.51.100.14"}

    assert client.get("/download/mac/arm64", headers=headers).status_code == 200
    assert client.get("/download/mac/arm64", headers=headers).status_code == 429
    assert len(calls) == 2  # authorize + artifact only for the allowed request


def test_sandbox_rejects_unsafe_and_allows_safe():
    try:
        validate_code_safety("import os\nresult={}")
        assert False, "expected UnsafeCodeError"
    except UnsafeCodeError:
        pass
    validate_code_safety("import math\nresult={'x': math.pi}")  # no raise


def test_sandbox_rejects_the_module_handle_escapes():
    """Issue #134 at the public tier: the preamble's own `sys`/`io` handles, an
    attribute chain onto a withheld module, and the dunder walk."""
    for code in (
        "result = {'cwd': sys.modules['os'].getcwd()}",
        "result = {'x': str(io.open)}",
        "result = {'c': str(json.codecs)}",
        "result = {'n': len(().__class__.__bases__[0].__subclasses__())}",
        "result = {'c': str(getattr(json, 'codecs'))}",
    ):
        try:
            validate_code_safety(code)
            assert False, f"expected UnsafeCodeError for {code!r}"
        except UnsafeCodeError:
            pass


def test_sandbox_runs_safe_code():
    res = asyncio.run(run_backend("result = {'sum': sum(input_data['nums'])}", {"nums": [1, 2, 3]}))
    assert res.result == {"sum": 6}


def test_sandbox_runs_allowlisted_imports():
    """The builtins scrub used to delete exec/eval, which broke `import statistics`
    and every namedtuple; a sandbox that can't run real code isn't secure, it's off."""
    res = asyncio.run(run_backend(
        "import statistics, datetime\n"
        "result = {'mean': statistics.mean(input_data['nums']), 'd': datetime.time(9, 0).isoformat()}",
        {"nums": [1, 2, 3]},
    ))
    assert res.result == {"mean": 2, "d": "09:00:00"}


def test_sandbox_subprocess_has_no_module_handles(monkeypatch):
    """Second wall: pretend a payload beats the gate, and the subprocess still
    has no module left to grab."""
    monkeypatch.setattr(edge_sandbox, "validate_code_safety", lambda code: None)
    for handle in ("sys", "io", "builtins"):
        try:
            asyncio.run(run_backend(f"result = {{'x': str({handle})}}", {}))
            assert False, f"{handle} was still reachable"
        except RuntimeError as e:
            assert "NameError" in str(e)


def test_inject_runtime():
    out = inject_runtime(b"<html><head><title>x</title></head><body>hi</body></html>").decode()
    assert "OUTPUT_COMPUTE" in out and "OUTPUT_LLM" in out
    assert out.index("OUTPUT_COMPUTE") < out.index("</head>")  # injected inside <head>
    # no head/body: shim is prepended, original content preserved
    bare = inject_runtime(b"<div>bare</div>").decode()
    assert "OUTPUT_COMPUTE" in bare and bare.endswith("<div>bare</div>")


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} passed")


if __name__ == "__main__":
    _run_all()


def test_app_api_proxy_routes_by_machine_and_404s_frontend_only(monkeypatch):
    """ENG-293: /api/* on an app host forwards to the app's OWN machine via fly-force-instance-id;
    an app with no runtime spec answers an honest 404, and no Machines credential exists here."""
    from app import bundles as edge_bundles

    seen = {}

    async def fake_spec(slug):
        return {"machine_id": "mach-42"} if slug == "hasapi" else None

    monkeypatch.setattr(edge_main, "get_runtime_spec", fake_spec)
    monkeypatch.setattr(edge_main, "APPS_RUNNER_URL", "https://runner.test")

    class FakeStream:
        status_code = 200
        headers = {"content-type": "application/json"}

        async def aiter_raw(self):
            yield b'{"ok": true}'

        async def aclose(self):
            return None

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def build_request(self, method, url, headers=None, content=None, params=None):
            seen.update({"method": method, "url": url, "headers": headers or {}})
            return object()

        async def send(self, req, stream=False):
            return FakeStream()

        async def aclose(self):
            return None

    monkeypatch.setattr(edge_main.httpx, "AsyncClient", FakeClient)
    client = TestClient(edge_main.app)

    r = client.post("/api/todos", headers={"host": "hasapi.openswarm.host"}, json={"a": 1})
    assert r.status_code == 200
    assert seen["url"] == "https://runner.test/api/todos"
    assert seen["headers"]["fly-force-instance-id"] == "mach-42"

    r2 = client.get("/api/todos", headers={"host": "staticonly.openswarm.host"})
    assert r2.status_code == 404
