"""A launch that carries a prompt must RUN it.

The trap this seals (ENG-131): AgentConfig had no `prompt` field, so pydantic silently dropped it
from `POST /api/agents/launch`. The session was created, broadcast as "running", and then nothing
was ever scheduled: a permanent silent spinner with 0 messages, indistinguishable from a real hang.
Five sessions were forensically chased through pool, router, and scheduler before the launch body
turned out to be the whole story.
"""

import asyncio

from pytest import MonkeyPatch

from backend.apps.agents import agents as agents_module
from backend.apps.agents.core.models import AgentConfig, AgentSession


def p_launch(monkeypatch: MonkeyPatch, config: AgentConfig) -> list:
    sent: list = []
    session = AgentSession(name="probe")

    async def fake_launch(cfg: AgentConfig) -> AgentSession:
        return session

    async def fake_send(session_id: str, prompt: str, **kwargs) -> None:
        sent.append((session_id, prompt))

    monkeypatch.setattr(agents_module.agent_manager, "launch_agent", fake_launch)
    monkeypatch.setattr(agents_module.agent_manager, "send_message", fake_send)

    async def run() -> None:
        await agents_module.launch_agent(config)
        # The first turn is fire-and-forget; drain it before asserting.
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    asyncio.run(run())
    return sent


def test_launch_with_prompt_schedules_the_first_turn(monkeypatch: MonkeyPatch) -> None:
    sent = p_launch(monkeypatch, AgentConfig(name="probe", prompt="say ready"))
    assert len(sent) == 1
    assert sent[0][1] == "say ready"


def test_launch_without_prompt_schedules_nothing(monkeypatch: MonkeyPatch) -> None:
    assert p_launch(monkeypatch, AgentConfig(name="probe")) == []


def test_prompt_survives_the_launch_body_parse() -> None:
    # The original failure: this field VANISHED in validation, so the route could never see it.
    assert AgentConfig(**{"prompt": "hello", "name": "x"}).prompt == "hello"
