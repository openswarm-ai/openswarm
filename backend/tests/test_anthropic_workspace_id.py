"""Anthropic's identity-linked keys (personal and service-account) can span workspaces, and such a
key must send `anthropic-workspace-id` on every request or the API answers 400 before the model is
reached. A user hit exactly that on 2026-09-03 (install 59a37510, three turns) and our card told them
to re-enter the key. The workspace id is one setting, sent from the one helper every key lane uses,
and the refusal is classified on a declared signal with its own card, first in the auth chain."""

import os
import re

from backend.apps.agents.core.error_classify import is_auth_error, is_workspace_id_error
from backend.apps.settings.credentials import anthropic_workspace_header, own_key_anthropic_client, own_key_cli_env
from backend.apps.settings.models import AppSettings

P_REAL_400 = (
    'The agent runtime reported this turn failed (stop_sequence). API Error: 400 {"type":"error","error":'
    '{"type":"invalid_request_error","message":"anthropic-workspace-id is required when authenticating with an '
    'identity-linked API key; send the id of the workspace this request acts in."},"request_id":null}'
)
P_REAL_404 = 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"Workspace `wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ` not found."}}'
P_REAL_BAD = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"anthropic-workspace-id header must be a valid workspace ID."}}'


def test_a_key_without_a_workspace_id_gets_exactly_the_env_it_always_did():
    settings = AppSettings(anthropic_api_key="sk-ant-test")
    assert own_key_cli_env(settings) == {"ANTHROPIC_API_KEY": "sk-ant-test"}
    assert anthropic_workspace_header(settings) == {}


def test_a_workspace_id_rides_the_cli_custom_headers_and_the_sdk_default_headers():
    settings = AppSettings(anthropic_api_key="sk-ant-test", anthropic_workspace_id=" wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ ")
    env = own_key_cli_env(settings)
    assert env["ANTHROPIC_API_KEY"] == "sk-ant-test"
    assert env["ANTHROPIC_CUSTOM_HEADERS"] == "anthropic-workspace-id: wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ"
    client = own_key_anthropic_client(settings)
    assert client.default_headers["anthropic-workspace-id"] == "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ"


def test_anthropics_three_workspace_refusals_are_classified_as_auth_on_a_declared_signal():
    for text in (P_REAL_400, P_REAL_404, P_REAL_BAD):
        assert is_workspace_id_error(RuntimeError(text)), text
        assert is_auth_error(RuntimeError(text)), text
    # Controls: an ordinary 400, a stray "workspace" and a schema 400 stay what they were.
    for text in ("line 400, in run", "the workspace is on the left", 'API Error: 400 {"message":"tools.0.input_schema: unsupported"}'):
        assert not is_workspace_id_error(RuntimeError(text)), text


def test_the_workspace_card_is_decided_before_every_other_auth_reading():
    src = open(os.path.join(os.path.dirname(__file__), "..", "apps", "agents", "manager", "run", "handle_run_error.py")).read()
    workspace = src.index("is_workspace_id_error(e, extra_text=p_stderr_tail)")
    assert workspace < src.index('reason = "codex_token_rotating"')
    assert workspace < src.index('reason = "anthropic_auth_invalid"')
    assert 'reason = "anthropic_workspace_id"' in src


def test_no_lane_builds_a_client_or_env_from_the_raw_key_outside_credentials():
    """The class seal: the user's own key reaches the wire through own_key_* only, so a lane added
    tomorrow cannot forget the workspace header the way three lanes had until 2026-09-03."""
    root = os.path.join(os.path.dirname(__file__), "..", "apps")
    raw_client = re.compile(r"AsyncAnthropic\(\s*api_key=(?:global_)?settings\.anthropic_api_key")
    raw_env = re.compile(r'"ANTHROPIC_API_KEY":\s*(?:global_)?settings\.anthropic_api_key')
    offenders = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(dirpath, name)
            text = open(path, encoding="utf-8", errors="replace").read()
            if path.endswith(os.path.join("settings", "credentials.py")):
                continue
            if raw_client.search(text) or raw_env.search(text):
                offenders.append(os.path.relpath(path, root))
    assert offenders == [], offenders
    proxy = open(os.path.join(root, "agents", "proxy", "anthropic_proxy.py")).read()
    assert "anthropic_workspace_header" in proxy
