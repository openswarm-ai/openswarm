"""Unit tests for app-publishing build/scan/bundle logic (the locally-testable
core of Workstream A). The build step (vite) and the cloud upload need node /
network and are exercised in the staging E2E, not here.

What this proves:
1. slugify makes url-safe, length-capped slugs and never empties.
2. quick_ast_gate flags backend code that reaches outside the sandbox allowlist
   and stays silent for allowlist-only code.
3. _collect_source picks up flat files and skips binary/non-source.
4. collect_bundle (flat) tars exactly the files dict; (webapp) tars a dist tree
   and skips symlinks.
5. scan_for_publish merges AST findings into the review when the LLM pass is a
   no-op, and reports a clean verdict for a benign app.

Run with:  backend/.venv/bin/python backend/tests/test_publish.py
"""
import asyncio
import io
import os
import sys
import tarfile
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.apps.outputs.models import Output
from backend.apps.outputs import publish


def test_slugify():
    assert publish.slugify("My Cool App!!") == "my-cool-app"
    assert publish.slugify("   ") == "app"
    assert publish.slugify("") == "app"
    assert publish.slugify("a" * 100) == "a" * 32
    assert publish.slugify("Café ☕ Menu") == "caf-menu"


def test_ast_gate_flags_unsafe_and_clean():
    unsafe = Output(name="x", files={"backend.py": "import os\nresult={'c': os.getcwd()}\n"})
    findings = publish.quick_ast_gate(unsafe)
    assert findings and any("os" in f for f in findings)

    clean = Output(name="x", files={"backend.py": "import math\nresult={'p': math.pi}\n"})
    assert publish.quick_ast_gate(clean) == []

    no_backend = Output(name="x", files={"index.html": "<html>hi</html>"})
    assert publish.quick_ast_gate(no_backend) == []


def test_collect_source_filters():
    o = Output(name="x", files={
        "index.html": "<html></html>",
        "backend.py": "result={}",
        "data.bin": "not source",
        "notes.txt": "ignore me",
    })
    src = publish._collect_source(o)
    assert set(src.keys()) == {"index.html", "backend.py"}


def test_collect_bundle_flat():
    o = Output(name="x", files={
        "index.html": "<html>hi</html>",
        "backend.py": "result={}",
    })
    blob = publish.collect_bundle(o, None)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
        assert sorted(t.getnames()) == ["backend.py", "index.html"]
        idx = t.extractfile("index.html").read().decode()
        assert idx == "<html>hi</html>"


def test_collect_bundle_webapp_dist_skips_symlink():
    o = Output(name="x", workspace_id="ws123")
    with tempfile.TemporaryDirectory() as dist:
        os.makedirs(os.path.join(dist, "assets"))
        with open(os.path.join(dist, "index.html"), "w") as f:
            f.write("<html>built</html>")
        with open(os.path.join(dist, "assets", "app.js"), "w") as f:
            f.write("console.log(1)")
        try:
            os.symlink(os.path.join(dist, "index.html"), os.path.join(dist, "link.html"))
        except OSError:
            pass
        blob = publish.collect_bundle(o, dist)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
        names = sorted(t.getnames())
    assert "index.html" in names
    assert "assets/app.js" in names
    assert "link.html" not in names  # symlinks are skipped


def test_scan_for_publish_merges_ast():
    # Force the LLM pass to a deterministic no-op so the test is hermetic.
    async def _no_llm(src, settings):
        return [], "clean"
    orig = publish._llm_findings
    publish._llm_findings = _no_llm
    try:
        unsafe = Output(name="x", files={"backend.py": "import socket\nresult={}\n"})
        review = asyncio.run(publish.scan_for_publish(unsafe, settings=object()))
        assert review.verdict == "warn"
        assert any("socket" in f for f in review.findings)

        clean = Output(name="x", files={"index.html": "<html>hi</html>"})
        review2 = asyncio.run(publish.scan_for_publish(clean, settings=object()))
        assert review2.verdict == "clean"
        assert review2.findings == []
    finally:
        publish._llm_findings = orig


def test_runtime_injection():
    from backend.apps.outputs.html_inject import _build_data_injection, _inject_data_into_html

    base = _build_data_injection("{}", "null")
    assert "OUTPUT_COMPUTE" not in base and "OUTPUT_LLM" not in base  # off by default

    rt = _build_data_injection("{}", "null", "null", with_runtime=True)
    assert "OUTPUT_COMPUTE" in rt and "OUTPUT_LLM" in rt  # preview stubs are defined
    # Preview must NEVER embed the install token into app JS (SECURITY.md item A).
    assert "Bearer" not in rt and "Authorization" not in rt
    assert "once this app is published" in rt

    html = _inject_data_into_html("<html><head></head><body>x</body></html>", "{}", "null", "null", with_runtime=True)
    assert "OUTPUT_LLM" in html and "</head>" in html


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} passed")


if __name__ == "__main__":
    _run_all()
