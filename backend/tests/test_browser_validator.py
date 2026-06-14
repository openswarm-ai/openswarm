"""Aux-LLM stuck-adjudication for the browser sub-agent."""

import asyncio

from backend.apps.agents.browser.browser_validator import adjudicate_stuck, p_extract_text  # p-private-ignore: p_extract_text


class Block:
    def __init__(self, type_, text=""):
        self.type = type_
        self.text = text


class Resp:
    def __init__(self, blocks):
        self.content = blocks


class FakeClient:
    """Minimal Anthropic-shaped client: client.messages.create(...)."""

    def __init__(self, resp=None, raise_exc=None):
        self.resp = resp
        self.raise_exc = raise_exc
        self.calls = []
        self.messages = self

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.raise_exc:
            raise self.raise_exc
        return self.resp


def test_returns_extracted_guidance_and_assembles_prompt():
    fc = FakeClient(resp=Resp([Block("text", "Press Tab then Enter to focus the field.")]))
    out = asyncio.run(adjudicate_stuck(fc, "cheap-model", "share the doc", "- click -> not found", "the page"))
    assert out == "Press Tab then Enter to focus the field."
    call = fc.calls[0]
    assert call["model"] == "cheap-model"
    assert call["max_tokens"] == 300
    prompt = call["messages"][0]["content"]
    assert "share the doc" in prompt
    assert "not found" in prompt


def test_swallows_provider_error_and_returns_empty():
    fc = FakeClient(raise_exc=RuntimeError("429 rate limited"))
    out = asyncio.run(adjudicate_stuck(fc, "m", "g", "r", "p"))
    assert out == ""


def testp_extract_text_joins_text_blocks_and_ignores_others():
    resp = Resp([Block("text", "First."), Block("tool_use"), Block("text", "Second.")])
    assert p_extract_text(resp) == "First. Second."


def test_handles_empty_inputs_without_crashing():
    fc = FakeClient(resp=Resp([Block("text", "ok")]))
    out = asyncio.run(adjudicate_stuck(fc, "m", "", "", ""))
    assert out == "ok"
    # placeholders keep the prompt well-formed
    prompt = fc.calls[0]["messages"][0]["content"]
    assert "(unknown)" in prompt and "(none)" in prompt and "(empty)" in prompt
