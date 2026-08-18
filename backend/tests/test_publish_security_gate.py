import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.apps.outputs import outputs, publish_scan
from backend.apps.outputs.models import Output, PublishRequest, PublishReview


@pytest.fixture(autouse=True)
def p_clear_publish_scan_memo():
    publish_scan.memo.clear()
    yield
    publish_scan.memo.clear()


@pytest.mark.parametrize("failure_stage", ["resolve", "request"])
def test_auxiliary_scan_failure_blocks_and_is_not_memoized(monkeypatch, failure_stage):
    calls = {"resolve": 0}

    async def p_resolve(*args, **kwargs):
        calls["resolve"] += 1
        if failure_stage == "resolve":
            raise RuntimeError("no auxiliary model")
        return "aux-model", None

    client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(side_effect=RuntimeError("provider down"))))
    monkeypatch.setattr("backend.apps.agents.providers.registry.resolve_aux_model", p_resolve)
    monkeypatch.setattr(
        "backend.apps.settings.credentials.get_anthropic_client_for_model",
        lambda *args: client,
    )
    app = Output(name="public", files={"index.html": "<html>safe</html>"})

    first = asyncio.run(publish_scan.scan_for_publish(app, object()))
    second = asyncio.run(publish_scan.scan_for_publish(app, object()))

    assert first.verdict == second.verdict == "block"
    assert "blocked" in first.findings[0]
    assert calls["resolve"] == 2, "indeterminate scans must be retried, not memoized"


def test_non_json_auxiliary_response_blocks(monkeypatch):
    async def p_resolve(*args, **kwargs):
        return "aux-model", None

    response = SimpleNamespace(content=[SimpleNamespace(text="not-json")])
    client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=response)))
    monkeypatch.setattr("backend.apps.agents.providers.registry.resolve_aux_model", p_resolve)
    monkeypatch.setattr(
        "backend.apps.settings.credentials.get_anthropic_client_for_model",
        lambda *args: client,
    )

    review = asyncio.run(
        publish_scan.scan_for_publish(
            Output(name="public", files={"index.html": "<html>safe</html>"}),
            object(),
        )
    )

    assert review.verdict == "block"
    assert "invalid JSON" in review.findings[0]


def test_unreadable_auxiliary_response_blocks(monkeypatch):
    async def p_resolve(*args, **kwargs):
        return "aux-model", None

    client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=object())))
    monkeypatch.setattr("backend.apps.agents.providers.registry.resolve_aux_model", p_resolve)
    monkeypatch.setattr(
        "backend.apps.settings.credentials.get_anthropic_client_for_model",
        lambda *args: client,
    )
    monkeypatch.setattr(
        "backend.apps.agents.core.aux_llm.safe_resp_text",
        lambda response: (_ for _ in ()).throw(TypeError("malformed response")),
    )

    review = asyncio.run(
        publish_scan.scan_for_publish(
            Output(name="public", files={"index.html": "<html>safe</html>"}),
            object(),
        )
    )

    assert review.verdict == "block"
    assert "invalid result" in review.findings[0]


@pytest.mark.parametrize("force", [False, True])
def test_public_publish_never_bypasses_security_block(monkeypatch, force):
    app = Output(name="public", files={"backend.py": "import socket\nresult = {}\n"})
    build = AsyncMock()
    upload = AsyncMock()

    async def p_clean_aux(*args, **kwargs):
        return [], "clean", True

    monkeypatch.setattr(outputs, "load", lambda output_id: app)
    monkeypatch.setattr(outputs, "load_settings", lambda: object())
    monkeypatch.setattr(publish_scan, "llm_findings", p_clean_aux)
    monkeypatch.setattr(outputs, "build_static", build)
    monkeypatch.setattr(outputs, "upload_to_cloud", upload)

    result = asyncio.run(outputs.publish_output(PublishRequest(output_id=app.id, force=force)))

    assert result["ok"] is False
    assert result["blocked"] is True
    assert result["review"]["verdict"] == "block"
    build.assert_not_awaited()
    upload.assert_not_awaited()


def test_clean_public_publish_never_sets_cloud_override(monkeypatch):
    app = Output(name="public", files={"index.html": "<html>safe</html>"})
    upload = AsyncMock(return_value={"slug": "public", "url": "https://public.example"})

    async def p_scan(*args, **kwargs):
        return PublishReview(verdict="clean", scanned_files=["index.html"])

    monkeypatch.setattr(outputs, "load", lambda output_id: app)
    monkeypatch.setattr(outputs, "load_settings", lambda: object())
    monkeypatch.setattr(outputs, "scan_for_publish", p_scan)
    monkeypatch.setattr(outputs, "build_static", AsyncMock(return_value=None))
    monkeypatch.setattr(outputs, "collect_bundle", lambda output, dist: b"bundle")
    monkeypatch.setattr(outputs, "upload_to_cloud", upload)
    monkeypatch.setattr(outputs, "save", lambda output: None)

    result = asyncio.run(outputs.publish_output(PublishRequest(output_id=app.id, force=True)))

    assert result["ok"] is True
    assert upload.await_args.kwargs["override"] is False
