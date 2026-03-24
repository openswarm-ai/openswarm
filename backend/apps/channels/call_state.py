import logging
from datetime import datetime
from typing import Optional, Literal

logger = logging.getLogger(__name__)

CallStatus = Literal[
    "ringing", "connected", "gathering", "processing", "responding", "completed", "failed"
]

VALID_TRANSITIONS: dict[CallStatus, set[CallStatus]] = {
    "ringing": {"connected", "completed", "failed"},
    "connected": {"gathering", "completed", "failed"},
    "gathering": {"processing", "completed", "failed"},
    "processing": {"responding", "completed", "failed"},
    "responding": {"gathering", "completed", "failed"},
    "completed": set(),
    "failed": set(),
}


class CallState:
    """Tracks the lifecycle of a single voice call."""

    def __init__(
        self,
        call_sid: str,
        channel_id: str,
        from_number: str,
        to_number: str,
    ):
        self.call_sid = call_sid
        self.channel_id = channel_id
        self.from_number = from_number
        self.to_number = to_number
        self.agent_session_id: Optional[str] = None
        self.status: CallStatus = "ringing"
        self.turns: list[dict] = []
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
        self.error: Optional[str] = None

    def transition(self, new_status: CallStatus) -> bool:
        """Attempt a state transition. Returns True if valid."""
        if new_status in VALID_TRANSITIONS.get(self.status, set()):
            logger.info(
                "Call %s: %s -> %s", self.call_sid, self.status, new_status
            )
            self.status = new_status
            self.last_activity = datetime.now()
            return True
        logger.warning(
            "Call %s: invalid transition %s -> %s",
            self.call_sid, self.status, new_status,
        )
        return False

    def add_turn(self, role: str, content: str):
        self.turns.append({
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
        })
        self.last_activity = datetime.now()

    @property
    def is_active(self) -> bool:
        return self.status not in ("completed", "failed")

    @property
    def duration_seconds(self) -> float:
        return (datetime.now() - self.created_at).total_seconds()

    def to_dict(self) -> dict:
        return {
            "call_sid": self.call_sid,
            "channel_id": self.channel_id,
            "from_number": self.from_number,
            "to_number": self.to_number,
            "agent_session_id": self.agent_session_id,
            "status": self.status,
            "turns": self.turns,
            "created_at": self.created_at.isoformat(),
            "last_activity": self.last_activity.isoformat(),
            "duration_seconds": self.duration_seconds,
            "error": self.error,
        }


class CallManager:
    """Manages all active voice calls."""

    def __init__(self):
        self.calls: dict[str, CallState] = {}

    def create_call(
        self,
        call_sid: str,
        channel_id: str,
        from_number: str,
        to_number: str,
    ) -> CallState:
        call = CallState(call_sid, channel_id, from_number, to_number)
        self.calls[call_sid] = call
        return call

    def get_call(self, call_sid: str) -> Optional[CallState]:
        return self.calls.get(call_sid)

    def end_call(self, call_sid: str, status: CallStatus = "completed"):
        call = self.calls.get(call_sid)
        if call:
            call.transition(status)

    def cleanup_stale(self, max_duration_seconds: int = 3600):
        """Remove calls that have exceeded max duration."""
        stale = [
            sid
            for sid, call in self.calls.items()
            if not call.is_active or call.duration_seconds > max_duration_seconds
        ]
        for sid in stale:
            if self.calls[sid].is_active:
                self.calls[sid].transition("failed")
                self.calls[sid].error = "Exceeded max call duration"
            del self.calls[sid]

    def get_active_calls(self) -> list[dict]:
        return [c.to_dict() for c in self.calls.values() if c.is_active]
