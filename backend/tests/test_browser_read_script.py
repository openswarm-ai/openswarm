"""Read-script (authed-page extraction turn-collapser): answer-or-INSUFFICIENT
contract, fail-open on thin pages / declines / errors, and the flag gate."""
import asyncio

from backend.apps.agents.browser import browser_read_script as rs


class Blk:
    def __init__(self, text): self.type = "text"; self.text = text


class Resp:
    def __init__(self, text): self.content = [Blk(text)]


class Aux:
    def __init__(self, text):
        self.txt = text; self.messages = self; self.calls = 0; self.last_page = ""

    async def create(self, **kw):
        self.calls += 1
        # Keep what the aux was actually shown: which page reached it IS the hydration contract.
        self.last_page = str(kw.get("messages", [{}])[0].get("content", ""))
        return Resp(self.txt)


def tool_returning(text):
    async def run_tool(name, params, browser_id, tab_id):
        assert name == "BrowserGetText"
        return {"text": text}
    return run_tool


PAGE = "Tyler Chen\nHe/Him · 1st\nSomething Here\nIrvine, California\nEntrepreneurs First\n" + ("filler " * 200)


def tool_returning_sequence(pages):
    """A page that changes between reads, like an SPA finishing its render."""
    seen = []

    async def run_tool(name, params, browser_id, tab_id):
        assert name == "BrowserGetText"
        seen.append(len(seen))
        return {"text": pages[min(len(seen) - 1, len(pages) - 1)]}
    run_tool.seen = seen
    return run_tool


# Chrome that clears the 500-char floor while the actual content is still missing. This is the
# shape that made the bug invisible: it is long enough to look like a real page.
CHROME_ONLY = ("Home Feed My Network Jobs Messaging Notifications Me Work "
               "Skip to main content Keyboard shortcuts Close jump menu " * 12)
HYDRATED = CHROME_ONLY + "\nTyler Chen\nSomething Here\nEntrepreneurs First\n" + ("filler " * 200)


def test_waits_for_the_page_to_stop_growing(monkeypatch):
    """The false-clean: a hydrating SPA crosses the char floor on nav and footer chrome long before
    the content lands. Answering from that first passing read produces a CONFIDENT WRONG answer,
    because the aux reports what it can see and nothing declines, so the INSUFFICIENT retry never
    fires. Two reads have to agree the page stopped growing before the aux sees anything."""
    monkeypatch.setattr(rs, "P_THIN_SETTLE_S", 0)
    monkeypatch.setattr(rs, "P_STABLE_SETTLE_S", 0)
    aux = Aux("His title is \"Something Here\".")
    tool = tool_returning_sequence([CHROME_ONLY, HYDRATED, HYDRATED])
    out = asyncio.run(rs.run_read_script(aux, "m", "find tyler chen's title", "b1", "t1", tool))

    assert out == "His title is \"Something Here\"."
    assert len(tool.seen) >= 3, "must re-read until two reads agree, not answer off the first"
    sent = aux.last_page
    assert "Tyler Chen" in sent, "the aux must be handed the HYDRATED page, not the chrome-only one"


def test_a_settled_page_still_answers_without_extra_waiting(monkeypatch):
    """The guard must not turn every read into a slow read: a page that is already done answers as
    soon as two reads agree, which is immediately."""
    monkeypatch.setattr(rs, "P_THIN_SETTLE_S", 0)
    monkeypatch.setattr(rs, "P_STABLE_SETTLE_S", 0)
    aux = Aux("answer")
    tool = tool_returning_sequence([HYDRATED, HYDRATED])
    assert asyncio.run(rs.run_read_script(aux, "m", "q", "b1", "t1", tool)) == "answer"
    assert len(tool.seen) == 2, "a settled page costs exactly one confirming re-read"


def test_a_page_that_never_settles_still_answers_from_the_last_read(monkeypatch):
    """Something that keeps streaming forever (a live feed) must not fail closed to the loop just
    for being busy; after the read budget we use the fullest page we got."""
    monkeypatch.setattr(rs, "P_THIN_SETTLE_S", 0)
    monkeypatch.setattr(rs, "P_STABLE_SETTLE_S", 0)
    grows = [HYDRATED + ("more " * 200 * i) for i in range(1, 8)]
    aux = Aux("answer")
    tool = tool_returning_sequence(grows)
    assert asyncio.run(rs.run_read_script(aux, "m", "q", "b1", "t1", tool)) == "answer"
    assert len(tool.seen) == rs.MAX_READS


def test_flag_gate(monkeypatch):
    monkeypatch.delenv("OSW_READ_SCRIPT", raising=False)
    assert rs.read_script_enabled() is True
    monkeypatch.setenv("OSW_READ_SCRIPT", "0")
    assert rs.read_script_enabled() is False
    monkeypatch.setenv("OSW_READ_SCRIPT", "1")
    assert rs.read_script_enabled() is True


def test_answers_from_the_staged_page():
    aux = Aux('His title is "Something Here" at Entrepreneurs First.')
    out = asyncio.run(rs.run_read_script(
        aux, "m", "find tyler chen's title", "b1", "t1", tool_returning(PAGE)))
    assert out == 'His title is "Something Here" at Entrepreneurs First.'
    assert aux.calls == 1


def test_insufficient_falls_open_to_the_loop():
    out = asyncio.run(rs.run_read_script(
        Aux("INSUFFICIENT"), "m", "find his email", "b1", "t1", tool_returning(PAGE)))
    assert out is None


def test_thin_page_skips_the_aux_call_entirely():
    aux = Aux("should never be consulted")
    out = asyncio.run(rs.run_read_script(
        aux, "m", "find tyler", "b1", "t1", tool_returning("Loading...")))
    assert out is None
    assert aux.calls == 0


def test_no_aux_client_and_tool_error_both_fail_open():
    assert asyncio.run(rs.run_read_script(
        None, "", "t", "b1", "t1", tool_returning(PAGE))) is None

    async def broken_tool(name, params, browser_id, tab_id):
        return {"error": "card is gone"}
    assert asyncio.run(rs.run_read_script(
        Aux("answer"), "m", "t", "b1", "t1", broken_tool)) is None
