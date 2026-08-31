"""ENG-355 through the CHILD, not the orchestrator.

The browser read script stages ONE page and answers it with a single aux call, so the big-model
loop never starts. That is the right trade for "open X and read the heading" and the wrong one for
"start at X, then click through to Y, then to Z": page 1 cannot answer a route.

Measured live on the packaged 1.7.10-exp.1 candidate, 2026-08-30: a 4-hop Wikipedia task ran its
browser child with turns=1 and llm=0ms, and the run came back reporting INSUFFICIENT for page 2.
3 of 16 browser agents that session made zero model calls.

The guard fails toward the LOOP, which is only slower. Accepting instead yields a partial answer
that reads as a complete one, which is further down the ladder.
"""

from backend.apps.agents.browser.browser_read_script import is_answer, needs_multi_page


def test_a_route_across_pages_declines_the_single_page_read():
    assert needs_multi_page(
        "Start at https://en.wikipedia.org/wiki/Hypertext_Transfer_Protocol . From that page, "
        "CLICK through to the article about HTTP/2, then from there to QUIC."
    )
    assert needs_multi_page("Visit these six pages one at a time and report the heading of each")
    assert needs_multi_page("Go to the dashboard then click the billing tab")
    assert needs_multi_page("read each of these pages and summarise them")


def test_two_or_more_distinct_urls_is_a_route():
    assert needs_multi_page("compare https://a.example.com and https://b.example.com")
    # The same URL repeated is still one page, so it must not read as a route.
    assert not needs_multi_page("open https://a.example.com and quote the title of https://a.example.com")


def test_an_ordinary_single_page_read_still_takes_the_fast_path():
    """The innocent cases. A bare navigation verb is exactly what this path exists for, so if any
    of these start declining, the read script has been throttled into uselessness."""
    for task in (
        "go to https://example.com and tell me the main heading",
        "open the pricing page and read the top tier price",
        "what does this page say about refunds?",
        "visit the careers site and count the open roles",
        "navigate to the docs and quote the install command",
    ):
        assert not needs_multi_page(task), task


def test_the_decline_contract_is_unchanged():
    """The guard is additive: INSUFFICIENT and prose declines must still fail closed."""
    assert is_answer("INSUFFICIENT") is None
    assert is_answer("I cannot access the individual product page") is None
    assert is_answer("The heading is 'Example Domain'") == "The heading is 'Example Domain'"
    # A page legitimately lacking a field is still a real answer, not a decline.
    assert is_answer("The page does not show a price for that item.") is not None


# The pure-function tests above pass even if nothing CALLS needs_multi_page, which is how the first
# version of this file scored green against a deleted call site. These drive run_read_script itself
# and assert it never touched the page, so the wiring is what is under test.
import asyncio


class _RecordingTools:
    def __init__(self):
        self.calls = []

    async def __call__(self, name, args, browser_id, tab_id):
        self.calls.append(name)
        return {"text": "x" * 5000}


def _run(task):
    from backend.apps.agents.browser.browser_read_script import run_read_script
    tools = _RecordingTools()
    out = asyncio.run(run_read_script(
        aux_client=object(), aux_model="cheap-model", task=task,
        browser_id="b1", tab_id="t1", execute_tool=tools, current_url="https://example.com",
    ))
    return out, tools.calls


def test_run_read_script_declines_a_route_without_reading_the_page():
    out, calls = _run(
        "Start at https://en.wikipedia.org/wiki/HTTP . From that page CLICK through to HTTP/2, "
        "then from there to QUIC, and give me the first sentence of each."
    )
    assert out is None, "a route task must fall through to the browser loop"
    assert calls == [], f"it must bail BEFORE touching the page, but ran {calls}"
