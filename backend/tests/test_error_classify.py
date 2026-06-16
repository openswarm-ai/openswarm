"""redact_for_telemetry is the wall between a model_error diagnostic and a key
leak: in own_key mode the subprocess stderr we now attach can echo the user's
provider key, so these tests pin that no secret shape survives while the actual
error text (the whole point of capturing stderr) does.

The secret-shaped inputs are built by concatenation on purpose: no contiguous
key-shaped literal lands in this source file (so it never trips gitleaks or
alarms a reader), yet the runtime values are still key-shaped enough to exercise
the scrub. None of these are real keys; they unlock nothing."""
from backend.apps.agents.core.error_classify import redact_for_telemetry


def test_redacts_provider_key_shapes_keeps_context():
    anthropic = "sk-" + "ant-" + "A" * 28
    openai = "sk-" + "B" * 24
    google = "AIza" + "C" * 30
    github = "ghp" + "_" + "D" * 24
    s = f"9router: invalid x-api-key {anthropic} {openai} {google} {github}"
    out = redact_for_telemetry(s)
    for secret in (anthropic, openai, google, github):
        assert secret not in out
    assert "[redacted]" in out
    # The diagnostic signal survives, that's the reason we capture stderr at all.
    assert "9router: invalid x-api-key" in out


def test_redacts_bearer_and_key_value():
    bearer_token = "E" * 24
    kv_value = "F" * 16
    s = "Authorization: " + "Bearer " + bearer_token + "\n" + "api_key=" + kv_value
    out = redact_for_telemetry(s)
    assert bearer_token not in out
    assert kv_value not in out


def test_keeps_tail_and_bounds_length():
    # The real error lands at the end of the stderr stream, so we keep the tail.
    s = "old noise\n" * 500 + "Command failed: ENOENT spawn 9router"
    out = redact_for_telemetry(s, limit=120)
    assert len(out) <= 120
    assert "Command failed: ENOENT spawn 9router" in out


def test_empty_is_safe():
    assert redact_for_telemetry("") == ""
