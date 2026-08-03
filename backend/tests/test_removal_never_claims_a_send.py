"""A delete task must never exit through the send machinery.

Measured live 2026-08-02. Asked to delete three reddit posts, the run replied "Done, that's sent."
and removed nothing: an independent re-read found all three still on the profile. Three separate
paths let it happen, and all three share one root cause.

`task_is_send` is TRUE for a removal task. That is deliberate and documented (`is_removal_task`
exists precisely because the send classifier keys on the verb), but every consumer of `task_is_send`
then has to remember to exclude removals, and three of them did not:

  1. the two-sided receipt, which cannot tell composing from SEARCHING. To find a post you want to
     delete, the model types its title into the site's search box. That sets
     composer_committed_payload. Navigating to the result leaves the box empty. "Fill committed AND
     box now empty" is the receipt, so a delete that deleted nothing scored a verified send.
  2. the autosend path, the sharper edge: it CLICKS Send on that same typed text, so a delete task
     could search for a post and then post the search.
  3. the post-send stall backstop, which phrased the ending as a send confirmation.

These tests are about the WIRING, not the regexes: they assert that a removal task is excluded from
each of the three, so a future consumer of `task_is_send` that forgets the exclusion fails here.
"""

import inspect
import re

from backend.apps.agents.browser import browser_agent as BA
from backend.apps.agents.browser.browser_loop import is_removal_task


P_SRC = inspect.getsource(BA)


def p_guard_near(needle: str, window: int = 6) -> str:
    """The few lines above a landmark, where its guard lives."""
    i = P_SRC.find(needle)
    assert i != -1, f"landmark moved: {needle!r}"
    return "\n".join(P_SRC[:i].splitlines()[-window:]) + "\n" + needle


def test_a_delete_task_is_still_classified_as_a_send():
    """The premise the other tests rest on. If this ever flips, the exclusions below become dead
    code and their protection quietly disappears, so it is asserted rather than assumed."""
    task = 'Go to reddit.com and delete my post titled "canary9428eec8"'
    assert is_removal_task(task), "a delete task must read as a removal"
    assert re.search(r"\b(post|submit|publish|send)\b", task, re.I), (
        "and it also carries a publish verb, which is why task_is_send is true for it")


def test_the_two_sided_receipt_excludes_removals():
    """The path that scored the false success: typing a title into search, then navigating away."""
    guard = p_guard_near('if (task_is_send and not p_task_is_removal and not send_confirmed\n'
                         '                        and "error" not in result')
    assert "not p_task_is_removal" in guard


def test_the_autosend_click_path_excludes_removals():
    """The dangerous one: this path clicks Send on whatever the model just typed."""
    guard = p_guard_near("and browser_send_script.autosend_enabled()):")
    assert "not p_task_is_removal" in guard


def test_the_post_send_backstop_refuses_to_claim_a_send_on_a_removal():
    """Defence in depth. Even if a removal reaches the post-send ending, it must not borrow the
    send wording, and it must not report success."""
    i = P_SRC.find("if p_task_is_removal:")
    assert i != -1, "the removal branch in the post-send backstop is gone"
    branch = P_SRC[i:i + 900]
    assert "done_success = False" in branch, "a removal that cannot be confirmed is not a success"
    assert "could not confirm anything was deleted" in branch
    # The send wording must be ASSIGNED only under the non-removal branch. Checked on the assignment
    # rather than the raw text, because the comment above it quotes the bad reply on purpose.
    removal_code = [ln for ln in branch.split("elif")[0].splitlines()
                    if "done_message" in ln and not ln.strip().startswith("#")]
    assert removal_code and all("sent" not in ln for ln in removal_code), removal_code


def test_the_completion_gate_describes_the_task_the_user_actually_gave():
    """The fourth site of the same root cause, found while cleaning up after the third.

    `is_publish_task` matches the NOUN in "delete my post", so a delete run reaches the publish
    branch of the completion gate. Flagging it is right (the run proved nothing either way), but
    the sentence was "the send was never confirmed, so it may not have gone out", which points the
    user at the wrong page to check: they deleted something, and nothing was ever meant to go out.
    """
    from backend.apps.agents.browser.browser_loop import completion_is_honest

    honest, why = completion_is_honest([], publish_task=True, send_confirmed=False,
                                       removal_task=True)
    assert not honest
    assert "deletion" in why and "may still be there" in why
    assert "gone out" not in why, "a delete must not be described as a send"

    honest, why = completion_is_honest([], publish_task=True, send_confirmed=False)
    assert not honest and "gone out" in why, "a real send keeps its own wording"
