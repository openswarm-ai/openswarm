"""Pins the RunToolScript fan-out (ENG-417): independent tool calls run concurrently, results come
back in call order, and one failure is that call's result rather than the batch's.

The wall-clock assertions inject ~1s of latency on purpose. A fan-out benchmark against a local
no-op tool measures thread overhead and "disproves" the win: 20 localhost fetches ran 36ms
sequential vs 75ms parallel, which is why every timing case here has a real sleep in it."""

import threading
import time

from backend.apps.agents import ptc_mcp_server as ptc

P_LATENCY_S = 1.0


class P_SlowCore:
    """Every tool sleeps, the way a real fetch does. Records peak concurrency, because "did it
    actually run in parallel" is the claim, not "did it finish sooner"."""

    def __init__(self, latency=P_LATENCY_S, fail_urls=()):
        self.P_ROUTE = {name: self for name in ptc.SCRIPT_ALLOWED_TOOLS}
        self.latency = latency
        self.fail_urls = set(fail_urls)
        self.live = 0
        self.peak = 0
        self.lock = threading.Lock()

    def p_call(self, mod, name, args):
        with self.lock:
            self.live += 1
            self.peak = max(self.peak, self.live)
        try:
            time.sleep(self.latency)
            url = str(args.get("url", ""))
            if url in self.fail_urls:
                return {"content": [{"type": "text", "text": f"404 for {url}"}], "isError": True}
            return {"content": [{"type": "text", "text": f"BODY:{url or name}"}]}
        finally:
            with self.lock:
                self.live -= 1


def p_run(script):
    return ptc.handle_tool_call("RunToolScript", {"script": script})


def p_text(result):
    return result["content"][0]["text"]


def teardown_function(fn):
    ptc.set_core_for_tests(None)


P_URLS = [f"http://x/{i}" for i in range(8)]
P_FANOUT = (
    f"urls = {P_URLS!r}\n"
    "for r in call_tools([{'name': 'WebFetch', 'args': {'url': u}} for u in urls]):\n"
    "    print(r.text if r.ok else 'FAILED ' + r.error)\n"
)
P_SEQUENTIAL = (
    f"urls = {P_URLS!r}\n"
    "for u in urls:\n"
    "    try:\n"
    "        print(call_tool('WebFetch', {'url': u}))\n"
    "    except PtcToolError as e:\n"
    "        print('FAILED', e)\n"
)


def test_a_batch_beats_the_loop_by_about_the_fanout_width():
    """The acceptance case: N independent calls at ~1s each finish in ~N/width, not N."""
    ptc.set_core_for_tests(P_SlowCore())
    t0 = time.monotonic()
    fan = p_run(P_FANOUT)
    p_fan_s = time.monotonic() - t0

    ptc.set_core_for_tests(P_SlowCore())
    t0 = time.monotonic()
    seq = p_run(P_SEQUENTIAL)
    p_seq_s = time.monotonic() - t0

    assert p_seq_s > len(P_URLS) * P_LATENCY_S * 0.9, "the sequential arm did not actually serialize"
    assert p_fan_s < p_seq_s / 3, f"fan-out {p_fan_s:.1f}s vs sequential {p_seq_s:.1f}s"
    # Identical output bytes: the win may not cost a single character of the answer.
    assert p_text(fan).split("[script ran")[0] == p_text(seq).split("[script ran")[0]


def test_it_really_runs_concurrently_not_just_faster():
    """Wall clock alone would also pass if a cache made the second arm free."""
    core = P_SlowCore()
    ptc.set_core_for_tests(core)
    p_run(P_FANOUT)
    assert core.peak > 1, "nothing overlapped"
    assert core.peak <= ptc.SCRIPT_FANOUT_WIDTH, f"fan-out width breached: {core.peak}"


def test_results_come_back_in_call_order_however_they_finish():
    """Staggered latency, so the completion order is provably not the call order."""

    class P_Staggered(P_SlowCore):
        def p_call(self, mod, name, args):
            i = int(str(args.get("url", "http://x/0")).rsplit("/", 1)[1])
            time.sleep(0.05 * (8 - i))
            return {"content": [{"type": "text", "text": f"BODY:{args.get('url')}"}]}

    ptc.set_core_for_tests(P_Staggered())
    out = p_text(p_run(P_FANOUT))
    assert [ln for ln in out.splitlines() if ln.startswith("BODY:")] == [f"BODY:{u}" for u in P_URLS]


def test_one_failure_does_not_poison_the_batch():
    ptc.set_core_for_tests(P_SlowCore(latency=0.05, fail_urls={P_URLS[3]}))
    out = p_text(p_run(P_FANOUT))
    assert out.count("BODY:") == len(P_URLS) - 1
    assert "FAILED 404 for http://x/3" in out


def test_the_budget_is_spent_per_item_so_the_calls_that_fit_still_run():
    """A batch over the cap used to be all-or-nothing thinking; the ones that fit run, the rest
    say why not, and the total is still capped."""
    ptc.set_core_for_tests(P_SlowCore(latency=0.01))
    n = ptc.MAX_TOOL_CALLS + 4
    out = p_text(p_run(
        f"urls = [f'http://x/{{i}}' for i in range({n})]\n"
        "rs = []\n"
        "for i in range(0, len(urls), 20):\n"
        "    rs += call_tools([{'name': 'WebFetch', 'args': {'url': u}} for u in urls[i:i+20]])\n"
        "print('ok', sum(1 for r in rs if r.ok), 'blocked', sum(1 for r in rs if not r.ok))\n"
    ))
    assert f"ok {ptc.MAX_TOOL_CALLS} blocked 4" in out


def test_an_empty_batch_is_free_and_a_huge_one_is_refused_before_the_wire():
    ptc.set_core_for_tests(P_SlowCore(latency=0.01))
    assert "EMPTY []" in p_text(p_run("print('EMPTY', call_tools([]))"))
    r = p_run("call_tools([{'name': 'WebFetch', 'args': {}} for _ in range(200)])")
    assert r.get("isError") and "at most" in p_text(r)


def test_a_malformed_call_is_rejected_and_names_what_is_wrong():
    ptc.set_core_for_tests(P_SlowCore(latency=0.01))
    r = p_run("call_tools(['WebFetch'])")
    assert r.get("isError") and "non-empty 'name'" in p_text(r)


def test_the_allowlist_still_holds_inside_a_batch():
    """The batch path is a second door to p_dispatch; a gate on one door only is this repo's
    recurring defect."""
    ptc.set_core_for_tests(P_SlowCore(latency=0.01))
    out = p_text(p_run(
        "r = call_tools([{'name': 'Bash', 'args': {'command': 'echo hi'}}])[0]\n"
        "print('OK' if r.ok else 'REFUSED ' + r.error)\n"
    ))
    assert "REFUSED" in out and "not callable from scripts" in out


def test_the_fan_out_does_not_extend_the_script_deadline():
    """RunToolScript is exempt from the 25s wedge watchdog, so its own 300s budget is the only
    ceiling; a batch may not become an unbounded wait."""
    src = open("backend/apps/agents/ptc_mcp_server.py").read()
    i = src.index("def p_dispatch_batch")
    body = src[i:i + 1200]
    assert "t.join(timeout=" in body and "deadline - time.monotonic()" in body
    assert "SCRIPT_TIMEOUT_S" not in body, "the batch must ride the caller's deadline, not a fresh one"
