"""A learned skill must not disarm the fast write path.

Measured live on x.com 2026-07-28. A skill had been learned for the host, so every write took the
"skill exists ... skipping prestage (replay owns the nav)" branch. Prestage is also what hands the
send-script its composer perception, so with it skipped the whole fill/click/receipt tail was
unreachable and the model fell back to 4-5 turns:

    with a skill (replay owns nav)   5/5 writes, 41-146s, median ~57s, receipt never spoke
    with the send-script armed       19.4s, receipt correct

The skip was a real optimisation for READS, where the replayed prefix genuinely replaces prestage's
navigation. It just was never true for sends. Prestage on an already-loaded page measured 1.9-5.0s,
so a send trades a few seconds to save tens.

This is the second time this exact interaction bit: the removal case was already carved out because
a stale delete-"skill" of scrolls could hijack a destructive one-shot. Same shape, so it is worth a
pure predicate with a test rather than a condition buried in a 2000-line function.
"""
from backend.apps.agents.browser import browser_skills as bs


def test_a_read_with_a_learned_skill_lets_replay_own_the_nav():
    """The optimisation this branch exists for must survive."""
    assert bs.replay_owns_nav("x.com", has_skill=True, task_is_removal=False, task_is_send=False)


def test_a_send_keeps_its_prestage_even_when_a_skill_exists():
    """The regression: skipping here costs the send-script its composer perception."""
    assert not bs.replay_owns_nav("x.com", has_skill=True, task_is_removal=False, task_is_send=True)


def test_a_removal_never_replays_a_skill():
    """A delete is a destructive one-shot, not a replayable nav prefix."""
    assert not bs.replay_owns_nav("x.com", has_skill=True, task_is_removal=True, task_is_send=False)


def test_no_skill_means_nothing_to_replay():
    assert not bs.replay_owns_nav("x.com", has_skill=False, task_is_removal=False, task_is_send=False)


def test_no_host_means_nothing_to_replay():
    """host_of returns "" for a task with no resolvable URL; that must not read as a skill hit."""
    assert not bs.replay_owns_nav("", has_skill=True, task_is_removal=False, task_is_send=False)


def test_a_send_that_is_also_a_removal_still_stands_down():
    """is_removal_task and task_is_send both fire on "delete the post that says X" (the classifier
    keys on the verb). Either one alone must be enough to keep replay out."""
    assert not bs.replay_owns_nav("x.com", has_skill=True, task_is_removal=True, task_is_send=True)


def test_the_predicate_returns_a_real_bool():
    """It feeds an `if`; a truthy string or None would still work by accident and then stop working
    the moment someone logs or serialises it."""
    for send in (True, False):
        got = bs.replay_owns_nav("x.com", True, False, send)
        assert got is True or got is False


def test_the_agent_uses_the_predicate_rather_than_reinventing_the_condition():
    """The whole point of extracting it. If someone re-inlines the check, these tests would keep
    passing while the live path regressed, which is exactly how this bug survived the first time."""
    src = (bs.__file__).replace("browser_skills.py", "browser_agent.py")
    with open(src) as f:
        text = f.read()
    assert "browser_skills.replay_owns_nav(" in text
    assert "p_skip_prestage_for_skill = bool(" not in text, "the condition was re-inlined"
