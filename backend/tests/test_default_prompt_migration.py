"""Shipping a new default system prompt has to carry the old one with it.

The default persists into settings.json, so bumping the constant alone leaves every existing install
on the old text forever: they never see the change, and "Reset to default" compares against something
that no longer exists. Each legacy revision is derived from the current default with a `replace`, and
a `replace` whose anchor has drifted silently returns the string unchanged, which turns the whole
migration into a no-op that nothing would notice. These pin both halves.
"""

from backend.apps.settings.models import DEFAULT_SYSTEM_PROMPT
from backend.apps.settings.store import (
    P_LEGACY_DEFAULT_SYSTEM_PROMPT,
    P_LEGACY_DEFAULT_SYSTEM_PROMPTS,
    P_LEGACY_LADDER_V1,
)


def test_every_legacy_revision_actually_differs_from_the_current_default():
    """A derived revision equal to the default means its anchor text drifted and the replace did
    nothing, so users on that revision would never be migrated off it."""
    for i, legacy in enumerate(P_LEGACY_DEFAULT_SYSTEM_PROMPTS):
        assert legacy != DEFAULT_SYSTEM_PROMPT, (
            f"legacy revision {i} is byte-identical to the current default, so its derivation "
            "silently no-opped, most likely because the anchor string it replaces was edited"
        )


def test_the_shipped_revisions_are_all_tracked():
    assert P_LEGACY_DEFAULT_SYSTEM_PROMPT in P_LEGACY_DEFAULT_SYSTEM_PROMPTS
    assert P_LEGACY_LADDER_V1 in P_LEGACY_DEFAULT_SYSTEM_PROMPTS
    assert len(set(P_LEGACY_DEFAULT_SYSTEM_PROMPTS)) == len(P_LEGACY_DEFAULT_SYSTEM_PROMPTS), (
        "duplicate legacy revisions mean one of the derivations collapsed onto another"
    )


def test_the_web_ladder_tells_the_agent_to_try_the_cheap_tools_first():
    """Eric's ask, and the reason the ladder step was rewritten: an agent given a plain reading task
    was driving a browser instead of searching, which is far slower. The old wording filed the web
    tools under 'No tool fits', which reads as a last resort."""
    assert "WebSearch / WebFetch first" in DEFAULT_SYSTEM_PROMPT
    assert "No tool fits." not in DEFAULT_SYSTEM_PROMPT, "the last-resort framing is back"
    ladder = DEFAULT_SYSTEM_PROMPT[DEFAULT_SYSTEM_PROMPT.index("5. **Reading the web.**"):]
    web_at = ladder.index("WebSearch")
    browser_at = ladder.index("BrowserAgent")
    assert web_at < browser_at, "the browser must not be named before the cheap tools"
    assert "Escalate to BrowserAgent only" in DEFAULT_SYSTEM_PROMPT, "the fallback must stay conditional"


def test_a_user_customized_prompt_is_never_mistaken_for_a_default():
    """The migration is a verbatim match, so an edited prompt must never collide with a shipped one."""
    customized = DEFAULT_SYSTEM_PROMPT + "\nAlways answer in French.\n"
    assert customized not in P_LEGACY_DEFAULT_SYSTEM_PROMPTS
