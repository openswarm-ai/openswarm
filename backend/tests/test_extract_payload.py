"""The fast lane should not require the user to type quotes.

`quoted_payload` refuses a task with no unambiguous quoted span, and that refusal is correct:
guessing which words to send is how you post the wrong thing. But it made the fast path unreachable
for the way people actually ask. Reported live by Eric: "send hi to charles zheng on linkedin" fell
to the slow model path, which made two navigation clicks, three reads, typed nothing, and then
reported a send it had never attempted.

So the JUDGEMENT (which words) moves to the aux model and every SAFETY gate stays put: the surface
check, the committed-fill receipt, the resend guard, and the completion gate all still run against
whatever comes back. The model picks the text; the code still refuses to claim what it cannot see.

These tests cover the REJECTION rules, because that is where the risk lives. Rejecting costs one
slow-path run, which is the old behaviour. Accepting something wrong costs a message the user never
wrote, sent to a real person.
"""

from backend.apps.agents.browser import extract_payload as ep


def test_a_clean_extraction_passes():
    assert ep.clean_payload("hi", "send hi to charles zheng on linkedin") == "hi"
    assert ep.clean_payload("I'll be late", "tell mom I'll be late") == "I'll be late"


def test_quotes_the_model_adds_are_stripped():
    """The prompt says no quotes; models add them anyway, and posting a quoted string is wrong."""
    assert ep.clean_payload('"hi there"', "send hi there") == "hi there"
    assert ep.clean_payload("'hi there'", "send hi there") == "hi there"


def test_every_shape_of_NONE_is_refused():
    """The model is told to answer NONE, but a hedge is the same answer in different words and must
    never become a posted message."""
    for reply in ("NONE", "none", "N/A", "nothing", "unclear", "unknown",
                  "I can't determine the message", "I cannot tell",
                  "Sorry, no message was specified", "There is no message here",
                  "no specific message given"):
        assert ep.clean_payload(reply, "check my messages") is None, reply


def test_an_explanation_is_not_a_message():
    """A model that starts explaining has stopped extracting, and the explanation must not ride
    along into someone's inbox."""
    assert ep.clean_payload("hi\n\nI picked this because you said hi", "send hi") is None


def test_a_reply_longer_than_the_ask_is_invented_content():
    """Extraction lifts words out of the instruction; it does not compose new ones."""
    long_reply = "x" * 400
    assert ep.clean_payload(long_reply, "send hi") is None
    # ...but a genuinely long instruction may carry a genuinely long message
    long_task = "post this update: " + "y" * 300
    assert ep.clean_payload("y" * 300, long_task) is not None


def test_empty_and_whitespace_are_refused():
    assert ep.clean_payload("", "send hi") is None
    assert ep.clean_payload("   ", "send hi") is None
    assert ep.clean_payload('""', "send hi") is None


def test_the_cheap_gate_skips_absurd_inputs():
    """No aux call for an empty task or a pasted wall of text."""
    assert not ep.looks_extractable("")
    assert not ep.looks_extractable("z" * 700)
    assert ep.looks_extractable("send hi to charles zheng on linkedin")
