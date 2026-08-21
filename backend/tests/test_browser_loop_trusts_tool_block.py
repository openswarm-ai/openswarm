"""ENG-371: the browser loop must continue on a tool_use BLOCK, never on the router's stop_reason.

Wire-captured 2026-08-20: 9router stamps every Codex tool call stop_reason='end_turn' (6/6). The
old check `if response.stop_reason != "tool_use": break` therefore ended every ChatGPT-sub browser
child before its first tool ran. This pins the decision to the reply's content.
"""

import ast
import pathlib

SRC = pathlib.Path("backend/apps/agents/browser/browser_agent.py").read_text()


def test_the_loop_no_longer_keys_on_stop_reason():
    """A structural pin: the only remaining mention of stop_reason in the loop must not be a break
    condition. If someone reintroduces the label check, this fails before any drill has to."""
    assert 'if response.stop_reason != "tool_use":' not in SRC
    assert "if not tool_uses:\n                break" in SRC


def test_the_file_still_parses():
    ast.parse(SRC)
