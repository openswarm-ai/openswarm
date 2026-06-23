"""Append a message to a session, or replace it in place when its id already exists. Makes a
duplicate-id row unrepresentable when a stream commit races a stop's early partial commit
(both carry the same stream message id)."""

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message


@typechecked
def upsert_message(session: AgentSession, msg: Message) -> None:
    for i, existing in enumerate(session.messages):
        if getattr(existing, "id", None) == msg.id:
            session.messages[i] = msg
            return
    session.messages.append(msg)
