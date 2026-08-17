"""The reachability prober needs one route that answers 200 WITHOUT auth: probing `/` returned 401
and Chromium logged every probe tick as a console error (field report 2026-08-16). Both directions
pinned: /api/health is open, and the auth wall still stands one path over."""

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def test_health_answers_200_without_any_token():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_health_is_the_exception_not_the_rule():
    # Negative control: a real API path without a token must still 401, or the exemption leaked.
    r = client.get("/api/agents/sessions")
    assert r.status_code == 401
