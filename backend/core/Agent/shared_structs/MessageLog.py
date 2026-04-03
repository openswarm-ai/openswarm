from typeguard import typechecked
from pydantic import BaseModel, Field
from typing import List

from backend.core.Agent.shared_structs.Message.Message import AnyMessage


class MessageLog(BaseModel):
    """Ordered log of conversation messages for an Agent.

    Backed by a plain list — optimized for sequential append (the hot path)
    while still supporting ID-based lookup and slicing for branching.
    """

    messages: List[AnyMessage] = Field(default_factory=list)

    @typechecked
    def append(self, msg: AnyMessage) -> None:
        """Append a message to the end of the log. O(1) amortized."""
        self.messages.append(msg)

    @typechecked
    def get(self, message_id: str) -> AnyMessage | None:
        """Look up a single message by ID.

        Returns None if no message with the given ID exists.
        O(n) scan — fine for infrequent lookups on conversation-sized data.
        """
        return next((m for m in self.messages if m.id == message_id), None)

    @typechecked
    def slice_to(self, message_id: str) -> List[AnyMessage]:
        """Return all messages from the start up to and including the given ID.

        Used by Agent.branch() to snapshot the conversation history at a
        specific fork point. Raises ValueError if the ID isn't found.
        """
        for i, m in enumerate[AnyMessage](self.messages):
            if m.id == message_id:
                return self.messages[:i + 1]
        raise ValueError(f"Message {message_id} not found")

    @typechecked
    def all(self) -> List[AnyMessage]:
        """Return a shallow copy of the full message list."""
        return list[AnyMessage](self.messages)

    @typechecked
    def __len__(self) -> int:
        """Return the number of messages in the log."""
        return len(self.messages)