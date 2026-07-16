"""Read-script (authed-page extraction turn-collapser): answer-or-INSUFFICIENT
contract, fail-open on thin pages / declines / errors, and the flag gate."""
import asyncio

from backend.apps.agents.browser import browser_read_script as rs


class Blk:
    def __init__(self, text): self.type = "text"; self.text = text


class Resp:
    def __init__(self, text): self.content = [Blk(text)]


class Aux:
    def __init__(self, text): self.txt = text; self.messages = self; self.calls = 0
    async def create(self, **kw): self.calls += 1; return Resp(self.txt)


def tool_returning(text):
    async def run_tool(name, params, browser_id, tab_id):
        assert name == "BrowserGetText"
        return {"text": text}
    return run_tool


PAGE = "Tyler Chen\nHe/Him · 1st\nSomething Here\nIrvine, California\nEntrepreneurs First\n" + ("filler " * 200)


def test_flag_gate(monkeypatch):
    monkeypatch.delenv("OSW_READ_SCRIPT", raising=False)
    assert rs.read_script_enabled() is False
    monkeypatch.setenv("OSW_READ_SCRIPT", "1")
    assert rs.read_script_enabled() is True
    monkeypatch.setenv("OSW_READ_SCRIPT", "0")
    assert rs.read_script_enabled() is False


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
