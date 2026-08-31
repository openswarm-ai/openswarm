"""A message typed at a RUNNING agent is queued, not sent, and that has to be said out loud.

Measured live on the packaged 1.7.10-exp.1 candidate, 2026-08-30: a course-correction ("actually
stop doing that, forget the inventory") was accepted with HTTP 200 at 55 tool calls, the agent ran
on to 174 over 11 minutes, and the message appeared in NO transcript and NO API field the whole
time. The only reading available to the user was "it ignored me". Stop flushed the queue in 15s and
the redirect was answered correctly, so the machinery is right; the silence was the bug.

Queueing beat the older behaviour (a silent drop), but silent-queued and silent-dropped look
identical from the outside, which is the thing this pins.
"""

import asyncio
import inspect

from backend.apps.agents.manager import Messaging


def test_a_queued_send_emits_an_event_the_ui_can_show():
    src = inspect.getsource(Messaging.Messaging.send_message)
    assert "agent:message_queued" in src, "a queued send must announce itself over the socket"
    # It has to fire on the QUEUE path, not somewhere later that a normal send also reaches.
    queue_at = src.index("pending_messages.setdefault")
    event_at = src.index("agent:message_queued")
    ret_at = src.index("return", event_at)
    assert queue_at < event_at < ret_at, "the event belongs between queueing and the early return"


def test_the_queue_depth_is_reported_not_just_the_fact():
    src = inspect.getsource(Messaging.Messaging.send_message)
    seg = src[src.index("agent:message_queued"):src.index("agent:message_queued") + 400]
    assert '"queued"' in seg, "how many are waiting is what tells a user this is piling up"
    assert "client_message_id" in seg, "the UI needs it to mark the right optimistic bubble"


def test_hidden_machine_sends_stay_silent():
    """Nudges, auth heals and watchdog retries queue too. Announcing those would put harness traffic
    in front of the user, which is the opposite of the point."""
    src = inspect.getsource(Messaging.Messaging.send_message)
    seg = src[src.index("pending_messages.setdefault"):src.index("agent:message_queued")]
    assert "if not hidden:" in seg, "only a human's own send may raise the notice"
