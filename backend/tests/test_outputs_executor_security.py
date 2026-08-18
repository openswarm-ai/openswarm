from __future__ import annotations

import asyncio
import os
import re
import sys

import pytest

from backend.apps.outputs.executor import exec_env, execute_backend_code


RUNTIME_ENV = {
    "PYTHONDONTWRITEBYTECODE": "1",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
}

# macOS/dyld stamps this text-encoding hint into EVERY child process regardless of the env passed to exec; it is not a host-environment leak, so tolerate exactly this one key on Darwin.
P_CF_ENCODING_KEY = "__CF_USER_TEXT_ENCODING"
# Bounded value shape (three colon-separated hex fields, e.g. 0x1F5:0x0:0x0); never a general __CF_* wildcard.
P_CF_ENCODING_PATTERN = re.compile(r"\A0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+\Z")


def p_expected_runtime_env() -> dict[str, str]:
    expected = dict(RUNTIME_ENV)
    if sys.platform == "win32":
        # The strict env passes through the handful Windows needs to start python at all (USERPROFILE included, upstream's list).
        expected.update(
            {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE") if key in os.environ}
        )
    return expected


def p_assert_executor_env_allowlisted(result_env: dict[str, str], expected: dict[str, str]) -> None:
    for key, value in expected.items():
        assert result_env.get(key) == value, f"allowlisted key {key!r} missing or altered"
    extras = {key: value for key, value in result_env.items() if key not in expected}
    if sys.platform == "darwin":
        # Only the single OS-injected encoding key is tolerated, and only with its bounded value.
        assert set(extras) <= {P_CF_ENCODING_KEY}, f"unexpected extra executor env keys: {sorted(set(extras) - {P_CF_ENCODING_KEY})}"
        if P_CF_ENCODING_KEY in extras:
            assert P_CF_ENCODING_PATTERN.match(extras[P_CF_ENCODING_KEY]), f"unexpected {P_CF_ENCODING_KEY} value: {extras[P_CF_ENCODING_KEY]!r}"
    else:
        assert extras == {}, f"unexpected extra executor env keys on {sys.platform}: {sorted(extras)}"


def test_unapproved_executor_environment_is_allowlist_only(monkeypatch):
    # Gate-passing (unapproved) code runs in a from-scratch env: language essentials only, nothing from the host.
    for key, value in {"UNRELATED_HOST_SETTING": "host-secret", "OPENAI_API_KEY": "provider-secret"}.items():
        monkeypatch.setenv(key, value)
    expected = p_expected_runtime_env()
    p_assert_executor_env_allowlisted(exec_env(approved=False), expected)


def test_user_approved_execution_inherits_the_host_env_but_never_its_secrets(monkeypatch):
    # Upstream's Run Anyway contract (adopted): approved code behaves like a normal process (HOME, PATH, unrelated settings), while every credential family, including the hosted deployment's, is scrubbed by name or prefix.
    secrets = {
        "OPENSWARM_AUTH_TOKEN": "install-secret",
        "OPENSWARM_DEMO_OPENAI_API_KEY": "demo-secret",
        "OPENSWARM_EDGE_STORAGE_PATH": "storage-secret",
        "EDGE_AUTH_TOKEN": "edge-secret",
        "OPENAI_API_KEY": "provider-secret",
        "AWS_SECRET_ACCESS_KEY": "cloud-secret",
        "DATABASE_URL": "database-secret",
        "PGPASSWORD": "pg-secret",
    }
    for key, value in secrets.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("UNRELATED_HOST_SETTING", "host-setting")

    result = asyncio.run(
        execute_backend_code(
            "import os\nresult = dict(os.environ)\n",
            {},
            approved=True,
        )
    )

    assert not secrets.keys() & result.result.keys(), sorted(secrets.keys() & result.result.keys())
    assert result.result.get("UNRELATED_HOST_SETTING") == "host-setting"
    assert result.result.get("PYTHONUTF8") == "1"
    assert result.result.get("PYTHONIOENCODING") == "utf-8"


def test_executor_environment_allowlist_check_is_non_vacuous():
    # The allowlist checker must reject leaks; a permissive checker would make the
    # test above vacuous. These feed synthetic envs to the same checker (no subprocess).
    expected = p_expected_runtime_env()
    p_assert_executor_env_allowlisted(dict(expected), expected)

    with pytest.raises(AssertionError):
        p_assert_executor_env_allowlisted({**expected, "UNRELATED_HOST_SETTING": "host-secret"}, expected)
    with pytest.raises(AssertionError):
        p_assert_executor_env_allowlisted({**expected, "OPENAI_API_KEY": "provider-secret"}, expected)
    with pytest.raises(AssertionError):
        p_assert_executor_env_allowlisted({**expected, "LANG": "tampered"}, expected)

    if sys.platform == "darwin":
        p_assert_executor_env_allowlisted({**expected, P_CF_ENCODING_KEY: "0x1F5:0x0:0x0"}, expected)
        with pytest.raises(AssertionError):
            p_assert_executor_env_allowlisted({**expected, P_CF_ENCODING_KEY: "not-a-valid-format"}, expected)
        # A different __CF_* key must NOT be waved through: the tolerance is one exact key, not a wildcard.
        with pytest.raises(AssertionError):
            p_assert_executor_env_allowlisted({**expected, "__CF_SOMETHING_ELSE": "0x1:0x0:0x0"}, expected)


def test_user_approved_execution_does_not_inherit_host_environment(monkeypatch):
    monkeypatch.setenv("OPENSWARM_DEMO_OPENAI_API_KEY", "demo-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "provider-secret")
    monkeypatch.setenv("DATABASE_URL", "database-secret")

    result = asyncio.run(
        execute_backend_code(
            "import os\n"
            "result = {\n"
            "    'demo': os.getenv('OPENSWARM_DEMO_OPENAI_API_KEY'),\n"
            "    'provider': os.getenv('OPENAI_API_KEY'),\n"
            "    'storage': os.getenv('DATABASE_URL'),\n"
            "    'utf8': os.getenv('PYTHONUTF8'),\n"
            "}\n",
            {},
            approved=True,
        )
    )

    assert result.result == {
        "demo": None,
        "provider": None,
        "storage": None,
        "utf8": "1",
    }


def test_user_approved_execution_preserves_input_and_unicode_behavior():
    result = asyncio.run(
        execute_backend_code(
            "result = {'message': input_data['message']}\n",
            {"message": "caf\u00e9"},
            approved=True,
        )
    )

    assert result.result == {"message": "caf\u00e9"}
