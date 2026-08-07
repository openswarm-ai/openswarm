"""CRUD for the user's memory facts; the Settings > Memory page is the only intended client."""

from contextlib import asynccontextmanager
from typing import AsyncIterator, Dict, List

from fastapi import HTTPException
from pydantic import BaseModel
from typeguard import typechecked

from backend.config.Apps import SubApp
from backend.apps.memory.store import MemoryFact, add_fact, delete_fact, list_facts, update_fact


@asynccontextmanager
async def memory_lifespan() -> AsyncIterator[None]:
    yield


memory = SubApp("memory", memory_lifespan)


class FactBody(BaseModel):
    text: str


@memory.router.get("")
@typechecked
async def get_facts() -> Dict[str, List[MemoryFact]]:
    return {"facts": list_facts()}


@memory.router.post("")
@typechecked
async def create_fact(body: FactBody) -> MemoryFact:
    fact = add_fact(body.text, source="user")
    if fact is None:
        raise HTTPException(status_code=400, detail="Empty fact, or the memory list is full (60 max); delete something first.")
    return fact


@memory.router.patch("/{fact_id}")
@typechecked
async def edit_fact(fact_id: str, body: FactBody) -> MemoryFact:
    fact = update_fact(fact_id, body.text)
    if fact is None:
        raise HTTPException(status_code=404, detail="No such fact (or the new text is empty).")
    return fact


@memory.router.post("/distill/{session_id}")
@typechecked
async def distill(session_id: str) -> Dict[str, List[str]]:
    from backend.apps.agents.agents import agent_manager
    from backend.apps.memory.distill import distill_session_memory
    session = agent_manager.sessions.get(session_id)
    if not session:
        try:
            session = await agent_manager.resume_session(session_id)
        except ValueError:
            return {"added": []}
    return {"added": await distill_session_memory(session)}


@memory.router.delete("/{fact_id}")
@typechecked
async def remove_fact(fact_id: str) -> Dict[str, bool]:
    if not delete_fact(fact_id):
        raise HTTPException(status_code=404, detail="No such fact.")
    return {"ok": True}
