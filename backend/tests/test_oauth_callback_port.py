"""The OAuth redirect URI must name the port this backend is actually reachable on.

Measured live 2026-07-28. Google bounced a real connect attempt to
http://localhost:8324/api/subscriptions/callback -> ERR_CONNECTION_REFUSED, while the backend was
serving 8326. Claude failed at the same moment for its own reason and Codex kept working, so the
symptom presented as "two providers are broken" rather than "the port is wrong", which is the
expensive kind of wrong.

Root cause: main.py exports OPENSWARM_PORT inside `if __name__ == "__main__"`. That block does not
run under `python -m uvicorn backend.main:app --port N`, so the env var was absent and the helper
fell back to the 8324 literal while uvicorn served something else. Packaged builds were never
affected (electron/main.js passes OPENSWARM_PORT explicitly), which is exactly why it survived:
it is invisible on the default port and invisible in prod.

The fix keeps the env var authoritative and uses the live request's port only as the fallback, so
prod behaviour is unchanged and the dev path stops guessing.
"""
import pytest

from backend.apps.nine_router import oauth


@pytest.fixture(autouse=True)
def no_ambient_port(monkeypatch):
    """The suite must not inherit a real OPENSWARM_PORT from the developer's shell."""
    monkeypatch.delenv("OPENSWARM_PORT", raising=False)


# --- the port helper -------------------------------------------------------------------------

def test_the_env_var_wins_when_set(monkeypatch):
    """Packaged builds always set it; that path must not change."""
    monkeypatch.setenv("OPENSWARM_PORT", "8324")
    assert oauth.resolve_backend_port(observed=9999) == 8324


def test_the_observed_port_is_used_when_the_env_var_is_missing():
    """The regression: uvicorn on 8326 with no env var used to answer 8324."""
    assert oauth.resolve_backend_port(observed=8326) == 8326


def test_it_still_falls_back_when_nothing_is_known():
    assert oauth.resolve_backend_port() == 8324


def test_a_garbage_env_var_does_not_crash_the_connect_flow(monkeypatch):
    """A malformed value must degrade to what we can observe, not raise mid-OAuth."""
    monkeypatch.setenv("OPENSWARM_PORT", "not-a-port")
    assert oauth.resolve_backend_port(observed=8326) == 8326


def test_an_empty_env_var_is_treated_as_unset(monkeypatch):
    monkeypatch.setenv("OPENSWARM_PORT", "")
    assert oauth.resolve_backend_port(observed=8326) == 8326


# --- the redirect URI itself -----------------------------------------------------------------

def test_google_gets_the_live_port_not_the_default():
    """The exact failure: gemini-cli's callback runs through our own backend endpoint."""
    uri = oauth.callback_uri_for_provider("gemini-cli", 8326)
    assert uri == "http://localhost:8326/api/subscriptions/callback"


def test_google_on_the_default_port_is_unchanged(monkeypatch):
    monkeypatch.setenv("OPENSWARM_PORT", "8324")
    assert oauth.callback_uri_for_provider("gemini-cli", 8326) == (
        "http://localhost:8324/api/subscriptions/callback")


def test_codex_keeps_its_pinned_listener_port():
    """OpenAI's client is bound to a fixed URI, which is why Codex kept connecting while the other
    two failed. It must never pick up the backend port."""
    uri = oauth.callback_uri_for_provider("codex", 8326)
    assert uri == "http://localhost:1455/auth/callback", (
        "OpenAI's OAuth client is registered against this exact URI; changing it breaks every "
        "ChatGPT connect")
    assert "8326" not in uri


def test_claude_still_routes_through_the_router_callback():
    """Anthropic only whitelists the router's callback; the backend port is not ours to substitute."""
    uri = oauth.callback_uri_for_provider("claude", 8326)
    assert str(oauth.NINE_ROUTER_PORT) in uri
    assert "8326" not in uri


def test_no_provider_silently_hardcodes_the_default_port():
    """Sweep every provider the flow knows about: on a non-default port, nothing may still say 8324
    unless it is deliberately router- or listener-pinned."""
    pinned = {"claude", "codex"}
    for provider in ("gemini-cli", "antigravity", "github", "qwen", "kiro"):
        if provider in pinned:
            continue
        uri = oauth.callback_uri_for_provider(provider, 8326)
        assert "8324" not in uri, f"{provider} stamped the default port into {uri}"
