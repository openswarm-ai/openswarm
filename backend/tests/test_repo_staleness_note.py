"""An agent must know how old its checkout is before it diagnoses from it (ENG-280).

The incident: an agent read a tree 545 commits behind origin/main, formed a confident
diagnosis about code that had been replaced weeks earlier, and started editing. Nothing in
its context said the tree was stale, so the user had to notice and say so twice.

These build REAL git repositories rather than mocking subprocess, because the thing under
test is exactly whether the git plumbing is invoked correctly. A mocked git proves the mock.

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_repo_staleness_note.py -v
"""

import subprocess
from typing import Any, List

import pytest

from backend.apps.agents.manager.prompt.repo_staleness_note import (
    MIN_BEHIND_TO_WARN,
    repo_staleness_note,
)


def p_run(cwd: str, *args: str) -> None:
    subprocess.run(list(args), cwd=cwd, check=True, capture_output=True, text=True)


def p_commit(cwd: str, msg: str) -> None:
    with open(f"{cwd}/f.txt", "a") as fh:
        fh.write(msg + "\n")
    p_run(cwd, "git", "add", "f.txt")
    p_run(cwd, "git", "commit", "-m", msg, "--no-gpg-sign")


P_PAIR_SEQ = [0]


def p_repo_pair(tmp_path: Any, behind: int) -> str:
    """An origin with `behind` extra commits, and a clone parked before them.

    Each call gets its own subdirectory: two pairs in one test previously collided on the same
    path and raised FileExistsError, which read as a failure of the code under test.
    """
    P_PAIR_SEQ[0] += 1
    tmp_path = tmp_path / f"pair{P_PAIR_SEQ[0]}"
    tmp_path.mkdir()
    origin = tmp_path / "origin"
    origin.mkdir()
    p_run(str(origin), "git", "init", "-q", "-b", "main")
    p_run(str(origin), "git", "config", "user.email", "t@t.t")
    p_run(str(origin), "git", "config", "user.name", "t")
    p_commit(str(origin), "base")

    clone = tmp_path / "clone"
    p_run(str(tmp_path), "git", "clone", "-q", str(origin), str(clone))
    p_run(str(clone), "git", "config", "user.email", "t@t.t")
    p_run(str(clone), "git", "config", "user.name", "t")

    for i in range(behind):
        p_commit(str(origin), f"newer-{i}")
    if behind:
        p_run(str(clone), "git", "fetch", "-q", "origin")
    return str(clone)


def test_a_badly_stale_checkout_is_named_with_its_number(tmp_path: Any) -> None:
    note = repo_staleness_note(p_repo_pair(tmp_path, behind=30))
    assert note, "a 30-commit-behind checkout said nothing; this is the ENG-280 silence"
    assert "30 commits behind" in note, f"note did not carry the count: {note}"
    assert "check before diagnosing" in note


def test_an_up_to_date_checkout_says_nothing(tmp_path: Any) -> None:
    assert repo_staleness_note(p_repo_pair(tmp_path, behind=0)) is None


def test_ordinary_drift_stays_quiet(tmp_path: Any) -> None:
    """A note on every 2-commit gap is noise, and noise gets ignored when it matters."""
    assert repo_staleness_note(p_repo_pair(tmp_path, behind=MIN_BEHIND_TO_WARN - 1)) is None


def test_the_threshold_is_actually_exercised(tmp_path: Any) -> None:
    """Both sides of the boundary, so 'quiet' is never quiet because the check is broken."""
    assert repo_staleness_note(p_repo_pair(tmp_path, behind=MIN_BEHIND_TO_WARN)) is not None
    assert repo_staleness_note(p_repo_pair(tmp_path, behind=MIN_BEHIND_TO_WARN - 1)) is None


@pytest.mark.parametrize("cwd", [None, "", "/nonexistent-path-zzq", "/tmp"])
def test_a_non_repo_never_produces_a_note_or_an_error(cwd: Any) -> None:
    """Most agent sessions are not in a git repo at all; this must be silent and cheap there."""
    assert repo_staleness_note(cwd) is None


def test_it_never_reaches_the_network(tmp_path: Any, monkeypatch: Any) -> None:
    """A prompt builder that fetches would block every turn on someone's slow VPN."""
    repo = p_repo_pair(tmp_path, behind=25)   # built BEFORE patching; its own fetch is not ours
    seen: List[List[str]] = []
    real = subprocess.run

    def p_watch(args: Any, *a: Any, **k: Any) -> Any:
        if isinstance(args, list):
            seen.append(args)
        return real(args, *a, **k)

    monkeypatch.setattr(subprocess, "run", p_watch)
    repo_staleness_note(repo)
    assert seen, "the probe recorded no git calls at all, so it proves nothing"
    networked = [c for c in seen if any(x in ("fetch", "pull", "ls-remote") for x in c)]
    assert not networked, f"the note builder hit the network: {networked}"


def test_the_turn_prompt_actually_carries_the_note() -> None:
    """The note is only a fix if it reaches the model. A module nobody calls is the ENG-280 shape."""
    import inspect
    from backend.apps.agents.manager.prompt import compose_turn_system_prompt as mod

    src = inspect.getsource(mod)
    assert "repo_staleness_note(" in src, "nothing composes the note into the turn prompt"
    assert "composed_prompt" in src.split("repo_staleness_note(")[1][:400], (
        "the note is computed but never appended to the prompt the model sees"
    )
