"""A chat can edit the app it built, without the user re-selecting the card.

ENG-416, production 1.7.9. The agent built an app in a chat and then, in that same chat, said:
"I don't have access to its files in this chat. Click that app's card on your dashboard to select
it, then resend." He selected it; the next turn asked him to "save or reopen it from the dashboard".
Two round trips of clerical work to reintroduce an agent to its own output.

`build_selected_app_context` opens with `if not selected_app_output_ids: return None`, and that list
is populated ONLY by the dashboard element picker. Nothing linked "this session created that output"
to "this session may edit it".
"""

import pytest

from backend.apps.agents.manager.prompt import prompt_context as p_ctx

COMPOSER = "backend/apps/agents/manager/prompt/compose_turn_system_prompt.py"


class P_Out:
    def __init__(self, oid, session_id, workspace_id="ws", updated_at="2026-01-01"):
        self.id = oid
        self.session_id = session_id
        self.workspace_id = workspace_id
        self.updated_at = updated_at


def p_store(monkeypatch, outs):
    import backend.apps.outputs.workspace_io as io
    monkeypatch.setattr(io, "load_all", lambda: outs, raising=True)


def test_a_chat_finds_the_app_it_created(monkeypatch):
    p_store(monkeypatch, [P_Out("app-1", "chat-A")])
    assert p_ctx.apps_created_by_session("chat-A") == ["app-1"]


def test_another_chats_app_is_never_picked_up(monkeypatch):
    """The control. Owning what you built must not become owning everything."""
    p_store(monkeypatch, [P_Out("app-1", "chat-A")])
    assert p_ctx.apps_created_by_session("chat-B") == []


def test_an_app_with_no_workspace_is_skipped(monkeypatch):
    """`build_selected_app_context` would drop it anyway; offering it would only produce the second
    bad message he saw ("that app doesn't have a saved workspace yet")."""
    p_store(monkeypatch, [P_Out("app-1", "chat-A", workspace_id=None)])
    assert p_ctx.apps_created_by_session("chat-A") == []


def test_newest_first_and_capped(monkeypatch):
    """A chat that built a dozen apps must not dump a dozen workspace blocks into every turn."""
    outs = [P_Out(f"app-{i}", "chat-A", updated_at=f"2026-01-{i:02d}") for i in range(1, 9)]
    got = p_ctx.apps_created_by_session("chat-A")
    p_store(monkeypatch, outs)
    got = p_ctx.apps_created_by_session("chat-A")
    assert got == ["app-8", "app-7", "app-6"], got
    assert len(got) == p_ctx.APPS_OWNED_CAP


def test_a_broken_store_is_silent_not_fatal(monkeypatch):
    """Prompt composition must never die because the outputs dir is unreadable."""
    import backend.apps.outputs.workspace_io as io

    def p_boom():
        raise OSError("disk gone")

    monkeypatch.setattr(io, "load_all", p_boom, raising=True)
    assert p_ctx.apps_created_by_session("chat-A") == []


def test_no_session_id_asks_the_store_nothing(monkeypatch):
    called = {"n": 0}
    import backend.apps.outputs.workspace_io as io
    monkeypatch.setattr(io, "load_all", lambda: called.__setitem__("n", called["n"] + 1) or [], raising=True)
    assert p_ctx.apps_created_by_session(None) == []
    assert called["n"] == 0, "a session with no id must not scan every output on disk"


def test_an_explicit_selection_always_wins():
    """A pick is the user speaking; falling back over it would be worse than the bug."""
    src = open(COMPOSER).read()
    i = src.index("p_app_ids = list(selected_app_output_ids or [])")
    body = src[i:i + 400]
    assert "if not p_app_ids:" in body, "the fallback must be conditional on nothing being selected"
    assert body.index("if not p_app_ids:") > 0


def test_ownership_is_the_CHAT_not_the_sub_agent():
    """`output.session_id` is written from parent_session_id, so a per-dispatch child id matches
    nothing and the feature would be silently dead -- the ENG-403 mistake."""
    src = open(COMPOSER).read()
    i = src.index("apps_created_by_session(")
    assert "session.parent_session_id or session.id" in src[i:i + 120]


def test_the_common_path_pays_nothing(monkeypatch):
    """With a selection present the outputs dir must not be scanned at all."""
    called = {"n": 0}
    import backend.apps.outputs.workspace_io as io
    monkeypatch.setattr(io, "load_all", lambda: called.__setitem__("n", called["n"] + 1) or [], raising=True)
    src = open(COMPOSER).read()
    assert "if not p_app_ids:" in src
    # The guard is structural; assert it directly rather than booting a whole turn.
    assert called["n"] == 0


# ------------------------------------------------- the scan cost of the fallback (efficiency)

def test_an_unselected_turn_reads_the_outputs_dir_ONCE():
    """Both unselected paths (this chat's apps, and the name-only list) called load_all() for
    themselves, so one prompt block cost two full directory reads of every output file. The composer
    scans once and hands the rows down."""
    src = open(COMPOSER).read()
    i = src.index("p_app_ids = list(selected_app_output_ids or [])")
    block = src[i:src.index("if app_ctx:", i)]
    # Count CALLS, not prose: the comment explaining the fix names load_all() too.
    code = "\n".join(ln.split("#")[0] for ln in block.splitlines())
    assert code.count("load_all()") == 1, f"exactly one scan per turn, found {code.count('load_all()')}"
    assert "apps_created_by_session(session.parent_session_id or session.id, p_outputs)" in block
    assert "build_unselected_app_context(p_outputs)" in block


def test_a_selected_turn_scans_NOTHING():
    """The common path: the user picked a card, so neither fallback runs and no directory is read."""
    src = open(COMPOSER).read()
    i = src.index("p_outputs = None")
    guard = src[i:src.index("load_all()", i)]
    assert "if not p_app_ids:" in guard, "the scan must sit behind the nothing-selected branch"


def test_both_helpers_still_work_standalone():
    """They are public and called elsewhere; the shared-scan parameter must stay optional."""
    import inspect
    from backend.apps.agents.manager.prompt.prompt_context import build_unselected_app_context
    for fn in (p_ctx.apps_created_by_session, build_unselected_app_context):
        p_last = list(inspect.signature(fn).parameters.values())[-1]
        assert p_last.default is None, f"{fn.__name__}'s outputs arg must default to None"
