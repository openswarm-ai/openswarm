"""The send script's own action_log must be able to become a skill.

Measured across 2026-08 sweeps: 95 runs passed the skill record gate (`honest=True
informational=False removal=False unconfirmed_send=False`) and all 95 came back
`NOT recorded (host empty or no robust steps)`. Nothing was wrong with the gate. The send script
appended its opener and composer clicks with the element name in `result_summary` prose only, and
`distill_steps` reads `clicked_name`. An unnameable click truncates the distillation, the truncation
branch then drops the typing steps, and what is left is navigation-only, which `productive_count`
correctly refuses. Zero recordings, forever, from four missing dict keys.

The class of bug is "one side writes prose, the other side reads a field", so the test is written
against the SHAPE the send script appends rather than against any one call site.
"""

from backend.apps.agents.browser import browser_skills as bs


def p_sendscript_log() -> list:
    """The action_log a fast-path write leaves behind: navigate, open the composer, fill it.

    Mirrors browser_send_script.py's own appends. `send click` is deliberately included and
    deliberately not distillable: its tool name matches no branch, which is what keeps a replay from
    ever re-firing a send.
    """
    return [
        {"tool": "BrowserNavigate", "input": {"url": "https://www.linkedin.com/feed/"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {"index": 12}, "ok": True,
         "clicked_role": "button", "clicked_name": "Start a post",
         "result_summary": "script opened composer via 'Start a post'"},
        {"tool": "BrowserClickIndex", "input": {"index": 31, "text": "hello there"}, "ok": True,
         "clicked_role": "textbox", "clicked_name": "Text editor for creating content",
         "result_summary": "script fill into 'Text editor for creating content'"},
        {"tool": "send click", "input": {"via": "index"}, "ok": True,
         "clicked_role": "button", "clicked_name": "Post"},
    ]


def test_a_fast_path_write_distills_into_a_replayable_prefix():
    """The regression: this returned [] on every single fast-path write."""
    steps = bs.distill_steps(p_sendscript_log())
    assert steps, "a completed fast-path write must be recordable"
    assert [s["tool"] for s in steps] == [
        "BrowserNavigate", "BrowserClickByName", "BrowserClickByName"]


def test_the_payload_never_rides_into_the_recorded_skill():
    """A skill that carries last week's text re-posts last week's text. The composer click is
    recorded as role+name, and the send script fills it fresh on every replay."""
    blob = repr(bs.distill_steps(p_sendscript_log()))
    assert "hello there" not in blob


def test_the_send_click_is_never_recorded():
    """The one step a replay must never perform mechanically."""
    steps = bs.distill_steps(p_sendscript_log())
    names = [(s.get("params") or {}).get("name") for s in steps]
    assert "Post" not in names


def test_an_unnameable_click_still_truncates():
    """The guard that made the old behaviour correct-but-useless has to stay correct: a click we
    cannot name is a step we cannot replay, and keeping it would replay the wrong element."""
    log = p_sendscript_log()
    del log[1]["clicked_name"]
    steps = bs.distill_steps(log)
    assert all(s["tool"] == "BrowserNavigate" for s in steps) or steps == []
