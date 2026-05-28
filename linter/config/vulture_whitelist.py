# Vulture whitelist — suppress false positives for symbols used by
# frameworks, entry points, and external consumers.
#
# Pass this file as an argument to vulture alongside source directories.
# Each bare name tells vulture "this symbol is intentionally used."

# backend/main.py — entry points referenced by string, not direct call
main
app

# FastAPI route handlers — registered via decorators, called by framework
pull_structure
push_structure
reset_color
reset_emoji
check

# FastAPI lifespan context managers — passed to SubApp constructor
debugger_lifespan
health_lifespan

# debug.py — module replaces itself with the debug() function via
# sys.modules[__name__] = debug, consumed by external packages
debug

# ---- OpenSwarm additions (eric/linter-integration) ----
# These are intentional false positives: symbols vulture can't see being
# used because the use is dynamic, a monkey-patch, or a kept-for-compat alias.

# google_workspace_mcp_shim/run.py: runtime monkey-patch of a third-party
# module attribute (gauth.get_credentials = _patched_get_credentials).
get_credentials

# outputs/view_builder_templates.py: deliberate backward-compat alias,
# kept so older importers don't snap a stale copy. The comment there explains why.
VIEW_BUILDER_SKILL

# browser_agent.py: `for turn in range(MAX_TURNS)` loop counter we don't read.
turn

# service.py: tuple-unpack byproducts of _compute_delta(); only cost_delta is
# consumed, the token/request deltas are computed but not summed yet.
prompt_delta
completion_delta
requests_delta

# ---- Suspected genuinely-dead, whitelisted to keep the linter additive-only ----
# This task is tooling-only and must not edit backend source, so these stay
# whitelisted rather than deleted. They have zero call sites today; a future
# non-additive cleanup pass should remove the definitions and these lines.
thinking_params_for
_resolve_model
load_output
submit_state
get_provider_credentials

# outputs.py + dashboards.py: model field assigned in Python but read only via
# model_dump() serialization to the frontend (drives preview sort order), so vulture
# can't see the read.
preview_updated_at
