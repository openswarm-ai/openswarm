"""A browser sub-agent that talked itself out of its own tools locked the card forever (Haik,
2026-08-16, exp.9): the per-card BROWSER_HISTORY cache fed the refusing transcript to every next
dispatch as its own memory, and same-host reuse returned the same card even for a new URL, six
dispatches straight. Three seals: refusal-shaped runs clear the cache instead of persisting it,
ghost runs (the honesty gate's catch) clear it too, and CreateBrowserAgent grew a fresh=true
escape hatch that skips reuse entirely.
"""
import re

from backend.apps.agents.browser.browser_history import refusal_shaped_summary


def test_refusal_shapes_from_the_live_incident_are_caught():
    assert refusal_shaped_summary("I cannot execute BrowserEvaluate or any other tool calls. I'm a text-based AI.")
    assert refusal_shaped_summary("I can only execute synchronous expressions; please confirm promise support.")
    assert refusal_shaped_summary("Unfortunately I do not have access to tools in this environment.")


def test_honest_summaries_never_match():
    assert not refusal_shaped_summary("Found 3 tracks and saved them to tracks.md.")
    # The marker phrases are self-referential AI claims, not page content quotes.
    assert not refusal_shaped_summary("The page said 'cannot execute order' so I stopped at checkout.")
    assert not refusal_shaped_summary("Clicked Send; the site confirmed delivery.")


def test_refusal_run_clears_instead_of_persisting():
    src = open("backend/apps/agents/browser/browser_agent.py").read()
    i = src.index("if refusal_shaped_summary(summary):")
    block = src[i:i + 400]
    assert "clear_browser_history(browser_id)" in block, "a cached refusal becomes the next agent's own memory"
    # The write moved behind an accessor that stamps the owning chat (ENG-403); persisting at all
    # is still the point, because resume is a real optimization.
    assert "remember_history(" in src[i:i + 700], "honest runs must still persist"
    assert "parent_session_id" in src[i:i + 700], "and must record which chat produced it"


def test_ghost_run_clears_too():
    src = open("backend/apps/agents/browser/browser_agent.py").read()
    i = src.index("completion gate caught a ghost")
    assert "clear_browser_history(browser_id)" in src[i:i + 400], "a fabricated-completion transcript is exactly what the next agent must not inherit"


def test_fresh_param_wired_both_directions():
    mcp = open("backend/apps/agents/browser_agent_mcp_server.py").read()
    assert '"fresh"' in mcp and 'arguments.get("fresh", False)' in mcp, "schema + dispatch"
    agent = open("backend/apps/agents/browser/browser_agent.py").read()
    m = re.search(r"p_fresh = bool\(task_def\.get\(\"fresh\"\)\)", agent)
    assert m, "the flag must reach card allocation"
    assert "None if p_fresh else find_reusable_card" in agent, "fresh skips reuse, the whole point"


def test_reuse_is_never_silent():
    agent = open("backend/apps/agents/browser/browser_agent.py").read()
    assert "reused existing browser" in agent and "fresh=true" in agent, "silent reuse of a poisoned card is what made the incident unrecoverable"
