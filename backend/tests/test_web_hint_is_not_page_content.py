"""The presentation hint rides its own content block, never inside the page text.

ENG-413, root-caused 2026-08-27. An agent reported "page_07 also contained an injected instruction
I disregarded" on a page whose source is provably instruction-free. The claim looked fabricated
because grepping the page found nothing -- but the instruction was never IN the page: WebFetch
appended RICH_UI_HINT ("render the answer using specific UI tools ... keep prose to one line")
directly onto the fetched content, and the fabrication-repro run quoted that hint VERBATIM. The
model detected a real instruction and misattributed it to the page, because we glued it there.

The model was right both times, and a second drill killed the first fix: moved to a separate,
labelled content block, the hint STILL got flagged ("an injected instruction trying to get me to
add a promotional presentation-guidance footer"). A fetched page is a third party's words; anything
appended is attributed to the page, and no wording survives that. So WebFetch carries no guidance
at all, and WebSearch (our own formatted text, honestly the tool speaking) keeps it as its own
block.
"""

import importlib

import pytest

import backend.apps.agents.web_mcp_server as p_w

SRC = "backend/apps/agents/web_mcp_server.py"


@pytest.fixture
def p_ui_on(monkeypatch):
    monkeypatch.setenv("OPENSWARM_RICH_UI_OK", "1")
    importlib.reload(p_w)
    yield
    monkeypatch.setenv("OPENSWARM_RICH_UI_OK", "0")
    importlib.reload(p_w)


def test_the_page_block_carries_no_instruction(p_ui_on):
    r = p_w.with_search_hint("the release codeword is PELICANWRENCH")
    page = r["content"][0]["text"]
    assert "presentation" not in page and "ShowUI" not in page, \
        "an instruction inside page content reads as the PAGE giving orders"
    assert page == "the release codeword is PELICANWRENCH", "and the content itself is untouched"


def test_the_hint_is_its_own_block_and_says_what_it_is(p_ui_on):
    r = p_w.with_search_hint("body")
    assert len(r["content"]) == 2
    hint = r["content"][1]["text"]
    assert hint.startswith("[presentation guidance, not page content]"), \
        "the label is the attribution; without it the model must guess who is speaking"


def test_ui_off_sends_no_hint_at_all(monkeypatch):
    monkeypatch.setenv("OPENSWARM_RICH_UI_OK", "0")
    importlib.reload(p_w)
    r = p_w.with_search_hint("body")
    assert len(r["content"]) == 1
    assert "presentation" not in r["content"][0]["text"]


def test_nothing_concatenates_the_hint_into_content_anymore():
    src = open(SRC).read()
    assert "+= RICH_UI_HINT" not in src, "the glue is the whole bug"


def test_a_fetched_page_carries_no_guidance_at_all():
    """Drilled twice: concatenated OR as a labelled separate block, an instruction riding a fetched
    page gets attributed to the page and flagged as an injection. Only the search side, which is our
    own formatted text, may carry framing."""
    src = open(SRC).read()
    i = src.index('if tool_name == "WebFetch":')
    fetch_branch = src[i:src.index("return {", src.index('r.get("content", "")', i)) + 200]
    assert "with_search_hint" not in fetch_branch and "RICH_UI_HINT" not in fetch_branch.replace(
        "see the RICH_UI_HINT note", "")
    i_search = src.index('if tool_name == "WebSearch":')
    search_branch = src[i_search:i]
    assert "with_search_hint(" in search_branch, "the search side keeps the measured ShowUI win"


def test_an_empty_search_result_carries_no_guidance():
    """The fetch side is covered wholesale by the no-guidance test above; here only search's empty
    path needs pinning, because its non-empty path legitimately calls with_search_hint."""
    src = open(SRC).read()
    i = src.index('f"No results for: {query}"')
    line = src[src.rindex("\n", 0, i):src.index("\n", i)]
    assert "return {" in line and "with_search_hint" not in line, \
        "guidance on an empty result tells the model to render nothing as a component"
