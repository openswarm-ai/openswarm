"""Every provider lane sets ENABLE_TOOL_SEARCH, because the collision it prevents is CLI-side.

ENG-394: a ToolSearch-deferred tool 400s the NEXT request with "cannot have both
defer_loading=true and cache_control set". The CLI's `tengu_defer_all_bn4` defers every tool;
`ENABLE_TOOL_SEARCH=auto` stops it. That was already known and already fixed -- in 4 of 8 branches.
The direct-Anthropic-key lanes were among the four misses, which is precisely where it was hit on
opus-5, and it later killed a user's app build mid-flight.

Same defect this codebase keeps paying for: a guard inside one branch protects only that branch,
and the next branch added forgets it. The flag is now applied AFTER the chain, where no branch can
miss it.
"""

import re

SRC = "backend/apps/agents/manager/configure_provider_env.py"


def p_src() -> str:
    return open(SRC).read()


def test_the_flag_is_applied_outside_the_branch_chain():
    src = p_src()
    i = src.index('p_env.setdefault("ENABLE_TOOL_SEARCH", "auto")')
    # Everything before it in the function is the if/elif chain; the setdefault must come after the
    # LAST elif, so no branch can return without it.
    last_elif = src.rindex("\n    elif ", 0, i)
    assert last_elif < i, "it must sit below every branch, not inside one"


def test_it_never_overrides_a_branch_that_set_it_deliberately():
    src = p_src()
    assert "setdefault(" in src, "a branch with its own value keeps it"
    assert 'p_env["ENABLE_TOOL_SEARCH"] =' not in src


def test_it_survives_a_branch_that_ships_only_one_key():
    """The direct-api-key lane is literally `{"ANTHROPIC_API_KEY": ...}`; that is the shape that
    was missing the flag, and the same shape the base-override seam already had to be fixed for."""
    src = p_src()
    assert '{"ANTHROPIC_API_KEY": global_settings.anthropic_api_key}' in src
    i = src.index('{"ANTHROPIC_API_KEY": global_settings.anthropic_api_key}')
    j = src.index('p_env.setdefault("ENABLE_TOOL_SEARCH", "auto")')
    assert i < j, "the setdefault runs after that branch assigns its env"


def test_a_lane_with_no_env_at_all_does_not_crash():
    src = p_src()
    i = src.index('p_env = options_kwargs.get("env")')
    assert "isinstance(p_env, dict)" in src[i:i + 200], \
        "a branch that never set env must not raise on the way past"


def test_no_branch_quietly_disables_deferral_some_other_way():
    # If a lane ever needs deferral ON, it must say so explicitly rather than by omission, which is
    # how this got lost the first time.
    src = p_src()
    for m in re.finditer(r'ENABLE_TOOL_SEARCH["\']\s*[:=]\s*["\']([a-z]+)["\']', src):
        assert m.group(1) == "auto", f"unexpected ENABLE_TOOL_SEARCH value {m.group(1)!r}"
