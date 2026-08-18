import asyncio
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager


# Cap concurrent ROOT agent turns so firing 30 agents at once does not spawn 30 CLIs at once.
# The overflow queues. Env-tunable; 0/blank disables the gate.
MAX_CONCURRENT_TURNS = int(os.environ.get("OSW_MAX_CONCURRENT_TURNS", "8") or "0")


class TurnAdmission:
    @typechecked
    def get_turn_admission(self) -> asyncio.Semaphore:
        """Return the admission semaphore for the current running loop."""
        loop = asyncio.get_running_loop()
        if self.p_turn_admission_sema is None or self.p_turn_admission_loop is not loop:
            self.p_turn_admission_sema = asyncio.Semaphore(MAX_CONCURRENT_TURNS)
            self.p_turn_admission_loop = loop
        return self.p_turn_admission_sema

    @asynccontextmanager
    async def turn_admission_slot(self, session: AgentSession, session_id: str) -> AsyncIterator[None]:
        """Hold one concurrency slot for a root turn; child turns bypass to avoid deadlock."""
        if MAX_CONCURRENT_TURNS <= 0 or session.parent_session_id is not None:
            yield
            return
        sema = self.get_turn_admission()
        was_queued = sema.locked()
        if was_queued:
            try:
                await ws_manager.send_to_session(session_id, "agent:queued", {"session_id": session_id})
            except Exception:
                pass
        async with sema:
            if was_queued:
                try:
                    await ws_manager.send_to_session(session_id, "agent:admitted", {"session_id": session_id})
                except Exception:
                    pass
            yield
