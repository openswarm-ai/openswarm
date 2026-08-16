"""A serve-static app's card sat on "Starting preview" forever (found live 2026-08-16 on packaged
exp.9: runtime HTTP status said ready and its URL served 200/10.8KB, while the runtime-logs WS
status frame carried frontend_url null). Mechanism: the WS frame re-gated frontend_url on
rt.running, but serve-static runtimes have NO process by design, so running is False forever, and
with no process there are no log lines to trigger a status re-push: structurally stuck. The
frontend_url property is the one honest gate (crashed/suspended vite -> None, static -> serve
URL); these pin that the WS frame trusts it.
"""
import re


def test_ws_status_frame_uses_the_property_not_a_running_gate():
    src = open("backend/main.py").read()
    frame = src[src.index("def p_build_status_frame"):src.index("Initial status frame")]
    assert '"frontend_url": rt.frontend_url,' in frame, "the property is the single source of truth"
    assert "frontend_url if rt.running" not in frame, "the duplicate running gate is the Starting-preview wedge"


def test_property_still_refuses_dead_and_frozen_vite():
    # Both directions: dropping the WS gate must not resurrect the dead-port ERR_FAILED class the
    # gate was imitating; the property's own conditions are what protect that.
    src = open("backend/apps/outputs/runtime.py").read()
    prop = src[src.index("def frontend_url"):src.index("async def start")]
    assert re.search(r"self\.frontend_port and self\.p_frontend_ready and self\.running and not self\.p_suspended", prop), \
        "vite URLs must still require a live, unfrozen process"
    assert "serve_static" in prop, "static apps get their serve URL with no process at all"
