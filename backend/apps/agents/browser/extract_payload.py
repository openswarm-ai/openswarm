"""What to send, when the user did not put it in quotes.

`quoted_payload` refuses a task with no unambiguous quoted span, which is right: guessing which
words to send is how you post the wrong thing. But it made the fast lane unreachable for the way
people actually ask. Reported live: "send hi to charles zheng on linkedin" fell to the slow model
path, took two navigation clicks and three reads, typed nothing, and reported a send that had never
been attempted.

So the JUDGEMENT (which words) moves to the aux model, and every SAFETY gate stays exactly where it
is: the surface check, the committed-fill receipt, the resend guard, and the honest completion gate
all still run against whatever comes back. The model picks the text; the code still refuses to claim
anything it cannot see happen.

Kept apart from browser_send_parse because that module is pure and side-effect free by design, and
this one calls a model.
"""

import re
from typing import Optional

from typeguard import typechecked

P_SYSTEM = (
    "Extract the exact message text the user wants sent, from their instruction.\n"
    "Reply with ONLY the message, no quotes, no preamble, no explanation.\n"
    "If the instruction names no specific message to send, reply exactly: NONE\n\n"
    "send hi to charles on linkedin -> hi\n"
    "tell mom I'll be late -> I'll be late\n"
    "post that I just shipped the new build -> I just shipped the new build\n"
    "reply thanks so much to her last message -> thanks so much\n"
    "check my linkedin messages -> NONE\n"
    "find the top post on r/python -> NONE"
)

# A reply that is really a refusal, an apology, or a question. The aux model is told to answer NONE,
# but a hedge is the same answer wearing different words and must never become a posted message.
P_NOT_A_PAYLOAD_RE = re.compile(
    r"^\s*(none|n/?a|null|nothing|unclear|unknown|i (can'?t|cannot|am not|do not|don'?t)|"
    r"sorry|there is no|no (specific|message|text))\b",
    re.I,
)


@typechecked
def looks_extractable(task: str) -> bool:
    """Is this even a task with a message in it? Cheap gate before spending an aux call."""
    return bool(task) and len(task) < 600


@typechecked
def clean_payload(reply: str, task: str) -> Optional[str]:
    """The usable message from an aux reply, or None if there isn't one.

    Every rejection here costs one slow-path run, which is the old behaviour. Accepting something
    wrong costs a message the user never wrote, sent to a real person. The asymmetry is why this
    is strict.
    """
    text = (reply or "").strip().strip('"').strip("'").strip()
    if not text or P_NOT_A_PAYLOAD_RE.match(text):
        return None
    # One line. A model that starts explaining has stopped extracting, and the explanation must
    # never ride along into someone's inbox.
    if "\n" in text:
        return None
    # Longer than the instruction it came from means it invented content rather than lifting it.
    if len(text) > max(200, len(task)):
        return None
    return text
