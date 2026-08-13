"""The boot fingerprint must be a function of CONFIG, never of object identity (ENG-179).

`boot_fingerprint` serialises with `json.dumps(..., default=str)`. Anything not JSON-serialisable
therefore stringifies to its repr, and a default repr carries a memory address:

    <backend.foo.Thing object at 0x10b155310>

Two equivalent instances then hash differently, so a session whose config never changed still fails
the pool check and pays a full CLI respawn (measured elsewhere at 0.58s). Today every such value is
excluded by `NON_BOOT_KEYS`, so the bug is latent, not live. It becomes live the moment someone
adds a callable, a client, or a dataclass-without-repr to the options and does not think about that
frozenset, which is exactly the kind of thing nobody thinks about.

This is the seal: the hashed blob may not contain an object address, and equivalent configs must
hash equal. Both are checked against the REAL options shape rather than a toy.

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_boot_fingerprint_is_deterministic.py -v
"""

import json
import re
from typing import Any, Dict

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.run.client_pool import NON_BOOT_KEYS, boot_fingerprint

# The address pattern a default repr leaves behind.
P_ADDRESS = re.compile(r" at 0x[0-9a-f]+", re.I)


class P_Opaque:
    """No __repr__, so str() yields an address. Stands in for a callback, client or hook."""

    def __init__(self, value: int) -> None:
        self.value = value


def p_session() -> AgentSession:
    return AgentSession(name="probe", model="opus", cwd="/tmp")


def p_realistic_options() -> Dict[str, Any]:
    """The shape RunOptions actually builds, opaque values included."""
    return {
        "model": "cc/claude-opus-4-5",
        "max_buffer_size": 64 * 1024 * 1024,
        "permission_mode": "default",
        "allowed_tools": ["Read", "Bash", "Edit"],
        "disallowed_tools": ["Cron"],
        "include_partial_messages": True,
        "env": {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"},
        "mcp_servers": {"openswarm-core": {"env": {"OSW_MCP_MODULES": "ui,memory"}}},
        "tools": ["Read", "Write"],
        # The excluded ones, present exactly as the real dict has them.
        "can_use_tool": P_Opaque(1),
        "stderr": P_Opaque(2),
        "hooks": {"PreToolUse": [P_Opaque(3)]},
        "resume": "abc",
        "fork_session": False,
    }


def test_equivalent_configs_hash_equal_with_fresh_opaque_instances() -> None:
    """The bug, stated directly: same config, new callback objects, must be the same fingerprint."""
    s = p_session()
    a, b = p_realistic_options(), p_realistic_options()
    assert a["can_use_tool"] is not b["can_use_tool"], "the fixture must use DISTINCT instances"
    assert boot_fingerprint(a, s) == boot_fingerprint(b, s), (
        "identical config hashed differently because an opaque value reached the blob; every turn "
        "would pay a CLI respawn"
    )


def test_the_hashed_blob_contains_no_object_address() -> None:
    """Directly assert the property, so a future non-serialisable option is caught at the source."""
    s = p_session()
    opts = p_realistic_options()
    frozen = {k: v for k, v in opts.items() if k not in NON_BOOT_KEYS}
    frozen["p_branch"] = s.active_branch_id
    blob = json.dumps(frozen, sort_keys=True, default=str)
    found = P_ADDRESS.findall(blob)
    assert not found, (
        f"the fingerprint blob carries {len(found)} object address(es) {found[:3]}; that value is "
        "identity-dependent, so equivalent configs will hash differently and respawn the CLI"
    )


def test_a_real_config_change_still_changes_the_fingerprint() -> None:
    """The other direction: a fingerprint that never changes would silently reuse a stale CLI."""
    s = p_session()
    base = p_realistic_options()
    for key, changed in (
        ("model", "cc/claude-haiku-4-5"),
        ("allowed_tools", ["Read"]),
        ("mcp_servers", {"openswarm-core": {"env": {"OSW_MCP_MODULES": "ui"}}}),
        ("env", {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"}),
    ):
        other = p_realistic_options()
        other[key] = changed
        assert boot_fingerprint(base, s) != boot_fingerprint(other, s), (
            f"changing {key} did not change the fingerprint, so a stale CLI would be reused"
        )


def test_the_excluded_set_is_what_keeps_it_clean() -> None:
    """Names the actual mechanism, so deleting an entry from NON_BOOT_KEYS fails here loudly."""
    for key in ("can_use_tool", "stderr", "hooks"):
        assert key in NON_BOOT_KEYS, (
            f"{key} holds a non-serialisable value; excluding it is the only reason the blob has no "
            "object addresses"
        )
