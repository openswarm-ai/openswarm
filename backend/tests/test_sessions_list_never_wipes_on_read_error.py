"""A transient read error must surface as an error, never as an empty board.

The wipe chain, reproduced live on 2026-08-12 (it destroyed a real dev dashboard): the sessions
list answering [] is treated as AUTHORITY by the renderer, which strips its store, deletes every
card, and the debounced layout save persists the wipe. Card-less sessions are never promoted from
disk again, so one wrong [] is permanent. p_dashboard_card_ids used to swallow every exception into
an empty set, which turned a garbled or half-written dashboard file (a crash mid-save is exactly
the world ENG-244/246 live in) into that wrong []. Missing file stays a real empty board.
"""

import json
import os
from typing import Any
import pytest
import backend.config.paths as config_paths
from backend.apps.agents.agent_manager import agent_manager


@pytest.fixture()
def dash_dir(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> str:
    d = tmp_path / "dashboards"
    d.mkdir()
    monkeypatch.setattr(config_paths, "DASHBOARDS_DIR", str(d))
    return str(d)


def test_a_missing_dashboard_file_is_a_real_empty_board(dash_dir: str) -> None:
    assert agent_manager.p_dashboard_card_ids("no-such-dashboard") == set()


def test_a_readable_dashboard_yields_its_card_ids(dash_dir: str) -> None:
    with open(os.path.join(dash_dir, "d1.json"), "w", encoding="utf-8") as f:
        json.dump({"layout": {"cards": {"s1": {"session_id": "s1"}, "s2": {"session_id": "s2"}}}}, f)
    assert agent_manager.p_dashboard_card_ids("d1") == {"s1", "s2"}


def test_a_garbled_dashboard_file_fails_loud_instead_of_answering_empty(dash_dir: str) -> None:
    """The whole point: corrupt must NOT read as empty, because empty is a delete instruction."""
    with open(os.path.join(dash_dir, "d2.json"), "w", encoding="utf-8") as f:
        f.write('{"layout": {"cards": {')
    with pytest.raises(Exception):
        agent_manager.p_dashboard_card_ids("d2")


def test_get_all_sessions_propagates_the_read_error(dash_dir: str) -> None:
    """And the caller must not quietly catch it back into a [] either."""
    with open(os.path.join(dash_dir, "d3.json"), "w", encoding="utf-8") as f:
        f.write("not json at all")
    with pytest.raises(Exception):
        agent_manager.get_all_sessions(dashboard_id="d3")
