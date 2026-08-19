"""Pins the RunToolScript (PTC) contract: scripts chain allowlisted tools through the broker,
only printed output returns, and every guardrail (allowlist, call cap, timeout, stdout cap,
secret-free child env) actually bites. The whole point is intermediates never reach context,
so the strongest assertion here is what the RESULT does NOT contain."""

import sys

from backend.apps.agents import ptc_mcp_server as ptc


class P_FakeCore:
    """Stands in for the combined sidecar: routes every allowlisted name to a canned handler."""

    def __init__(self):
        self.calls = []
        self.P_ROUTE = {name: self for name in ptc.SCRIPT_ALLOWED_TOOLS}

    def p_call(self, mod, name, args):
        self.calls.append((name, args))
        if name == "WebFetch":
            return {"content": [{"type": "text", "text": "PAGE-BODY " + ("x" * 2000) + " NEEDLE:" + str(args.get("url"))}]}
        if name == "WebSearch":
            return {"content": [{"type": "text", "text": "r1 http://a\nr2 http://b"}]}
        if name == "MemoryWrite":
            return {"content": [{"type": "text", "text": "saved"}]}
        return {"content": [{"type": "text", "text": f"ok:{name}"}]}


def p_run(script: str) -> dict:
    return ptc.handle_tool_call("RunToolScript", {"script": script})


def p_text(result: dict) -> str:
    return result["content"][0]["text"]


def setup_function(fn):
    ptc.set_core_for_tests(P_FakeCore())


def teardown_function(fn):
    ptc.set_core_for_tests(None)


def test_chained_calls_return_only_printed_output():
    core = P_FakeCore()
    ptc.set_core_for_tests(core)
    r = p_run(
        "urls = [u.split()[1] for u in call_tool('WebSearch', {'query': 'q'}).splitlines()]\n"
        "needles = [call_tool('WebFetch', {'url': u}).split('NEEDLE:')[1] for u in urls]\n"
        "print('needles: ' + ', '.join(needles))\n"
    )
    text = p_text(r)
    assert "needles: http://a, http://b" in text
    assert "PAGE-BODY" not in text, "intermediate tool output leaked into context"
    assert len(core.calls) == 3
    assert "[script ran 3 tool call(s)]" in text
    assert not r.get("isError")


def test_non_allowlisted_tool_is_refused_but_catchable():
    r = p_run(
        "try:\n"
        "    call_tool('MCPActivate', {'server_name': 'x'})\n"
        "    print('ESCAPED')\n"
        "except PtcToolError as e:\n"
        "    print('blocked: ' + str(e)[:40])\n"
    )
    text = p_text(r)
    assert "blocked:" in text
    assert "ESCAPED" not in text


def test_call_cap_enforced():
    r = p_run(
        "hits = 0\n"
        "for i in range(60):\n"
        "    try:\n"
        "        call_tool('MemoryWrite', {'ops': []})\n"
        "        hits += 1\n"
        "    except PtcToolError:\n"
        "        break\n"
        "print('completed ' + str(hits))\n"
    )
    assert f"completed {ptc.MAX_TOOL_CALLS}" in p_text(r)


def test_script_exception_reports_partial_output():
    r = p_run("print('got this far')\nraise ValueError('boom')\n")
    text = p_text(r)
    assert r.get("isError") is True
    assert "ValueError: boom" in text
    assert "got this far" in text


def test_empty_print_is_an_error_nudge():
    r = p_run("x = 1 + 1\n")
    assert r.get("isError") is True
    assert "printed nothing" in p_text(r)


def test_stdout_capped_with_elide():
    r = p_run("print('A' * 200_000)")
    text = p_text(r)
    assert len(text.encode()) < ptc.MAX_STDOUT_BYTES + 500
    assert "output elided" in text


def test_timeout_kills_hung_script(monkeypatch):
    monkeypatch.setattr(ptc, "SCRIPT_TIMEOUT_S", 3.0)
    r = p_run("import time\ntime.sleep(60)\nprint('never')\n")
    assert r.get("isError") is True
    assert "exceeded" in p_text(r)


def test_child_env_carries_no_secrets(monkeypatch):
    monkeypatch.setenv("OPENSWARM_AUTH_TOKEN", "sekrit-token")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-nope")
    env = ptc.p_runner_env()
    joined = " ".join(f"{k}={v}" for k, v in env.items())
    assert "sekrit-token" not in joined
    assert "sk-ant-nope" not in joined
    assert "PATH" in env


def test_negative_control_no_core_routing():
    ptc.set_core_for_tests(None)
    # No __main__ sidecar in pytest, so dispatch must fail closed, not crash.
    out = ptc.p_dispatch("WebFetch", {"url": "http://x"})
    assert out["is_error"] is True
    assert "unavailable" in out["text"]


def test_runner_importable_and_single_purpose():
    import backend.apps.agents.ptc_script_runner as runner
    assert callable(runner.call_tool)
    assert sys.modules["backend.apps.agents.ptc_script_runner"] is runner
