"""The generic, site-agnostic verification core of the verified-action executor:
does an action produce the SPECIFIC expected effect, checked against a before/after
snapshot with zero per-site code. Pinned here, and pinned to match the send-script's
proven receipt so wiring it in was behavior-preserving."""
from backend.apps.agents.browser import browser_verified_action as va
from backend.apps.agents.browser.browser_agent import payload_in_textbox

EMPTY = '[2]<textbox "Write a message">\n[9]<button "Attach">'
FILLED = '[2]<textbox "Write a message" value="[test] hello world r9-os">\n[14]<button "Send">'
SENT = '[2]<textbox "Write a message">\n[9]<button "Attach">'
PAYLOAD = "[test] hello world r9-os"


def test_url_changed_and_changed():
    assert va.expectation_met("url_changed", "s", "s", "u1", "u2")
    assert not va.expectation_met("url_changed", "s", "s", "u1", "u1")
    assert va.expectation_met("changed", "a", "b")
    assert not va.expectation_met("changed", "a", "a")


def test_appeared_and_gone():
    assert va.expectation_met("appeared:Send", EMPTY, FILLED)      # Send button showed up
    assert not va.expectation_met("appeared:Send", FILLED, FILLED)
    assert va.expectation_met("gone:Send", FILLED, SENT)           # Send button vanished after send
    assert not va.expectation_met("gone:Send", EMPTY, EMPTY)


def test_filled_and_cleared_match_the_send_receipt():
    # filled == the fill committed; cleared == the composer emptied (the send receipt)
    assert va.expectation_met("filled:" + PAYLOAD, EMPTY, FILLED)
    assert va.expectation_met("cleared:" + PAYLOAD, FILLED, SENT)
    assert not va.expectation_met("cleared:" + PAYLOAD, EMPTY, FILLED)  # still in the box


def test_generic_verifier_agrees_with_the_proven_inline_check():
    # The send-script's receipt was `not payload_in_textbox(state, payload)`; the
    # generic `cleared:` predicate must give the identical verdict on every state.
    for state in (EMPTY, FILLED, SENT):
        old = not payload_in_textbox(state, PAYLOAD)
        new = va.expectation_met("cleared:" + PAYLOAD, FILLED, state)
        assert old == new, f"mismatch on state={state!r}"


def test_unknown_expectation_fails_safe():
    assert not va.expectation_met("teleported:X", EMPTY, FILLED)  # typo/unknown = not met
