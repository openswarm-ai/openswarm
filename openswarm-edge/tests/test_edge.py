"""Unit tests for the edge's pure logic: Host->slug parsing, path-safe file
resolution, the rate limiter, and the vendored sandbox. The Tigris fetch + cloud
proxy need live services and are exercised in the staging E2E, not here.

Run with:  .venv/bin/python -m pytest tests/test_edge.py
"""
import asyncio
import io
import os
import sys
import tarfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.main import slug_from_host
from app.bundles import unpack, resolve_file
from app.inject import inject_runtime
from app.ratelimit import RateLimiter
from app.sandbox import validate_code_safety, run_backend, UnsafeCodeError


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


def test_sandbox_rejects_unsafe_and_allows_safe():
    try:
        validate_code_safety("import os\nresult={}")
        assert False, "expected UnsafeCodeError"
    except UnsafeCodeError:
        pass
    validate_code_safety("import math\nresult={'x': math.pi}")  # no raise


def test_sandbox_runs_safe_code():
    res = asyncio.run(run_backend("result = {'sum': sum(input_data['nums'])}", {"nums": [1, 2, 3]}))
    assert res.result == {"sum": 6}


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
