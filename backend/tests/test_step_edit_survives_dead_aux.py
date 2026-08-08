"""Editing a workflow step must finish even when the aux label lane is dead.

`p_relabel_steps` is awaited INSIDE the PATCH request, and its aux call had no timeout at all (the
Anthropic SDK's own stream ceiling is minutes). A stalled lane therefore held the whole edit open:
the agent's EditWorkflowStep tool never returned and the editor just span, which is the
"agent edits a workflow and the app bricks" report. The labels are decoration with deterministic
fallbacks, so a dead lane must cost a nicer label, never the edit.
"""

import asyncio

import pytest

from backend.apps.workflows import workflows as wf_mod
from backend.apps.workflows.models import Workflow, WorkflowStep


def p_wf() -> Workflow:
    return Workflow(title="Untitled workflow", auto_named=True, steps=[WorkflowStep(text="do the first thing")])


def test_a_hung_aux_lane_cannot_hold_the_edit_open(monkeypatch):
    async def never_returns(*_a, **_k):
        await asyncio.sleep(3600)

    monkeypatch.setattr(wf_mod, "p_generate_metadata_for_steps", never_returns)
    monkeypatch.setattr(wf_mod, "AUX_LABEL_TIMEOUT_S", 0.05)

    wf = p_wf()
    steps = [WorkflowStep(text="a brand new instruction")]

    async def run():
        await asyncio.wait_for(
            wf_mod.p_relabel_steps(wf, [], steps, None),
            timeout=5.0,  # the assertion IS that we return well inside this
        )

    asyncio.run(run())


def test_a_hung_lane_still_leaves_a_usable_label_and_title(monkeypatch):
    """Falling through to the deterministic path matters: the old code returned early on any aux
    failure, which left the step showing its raw prompt as its own title."""
    async def never_returns(*_a, **_k):
        await asyncio.sleep(3600)

    monkeypatch.setattr(wf_mod, "p_generate_metadata_for_steps", never_returns)
    monkeypatch.setattr(wf_mod, "AUX_LABEL_TIMEOUT_S", 0.05)

    wf = p_wf()
    steps = [WorkflowStep(text="summarize my unread email and text me the digest")]
    asyncio.run(wf_mod.p_relabel_steps(wf, [], steps, None))

    assert steps[0].label, "a dead aux lane must still leave a label"
    assert steps[0].label != steps[0].text, "the label must not be the raw prompt"
    assert wf.title not in wf_mod._PLACEHOLDER_TITLES, "auto-name must fall back, not stay Untitled"


def test_an_erroring_aux_lane_behaves_the_same_as_a_hung_one(monkeypatch):
    async def blows_up(*_a, **_k):
        raise RuntimeError("provider 500")

    monkeypatch.setattr(wf_mod, "p_generate_metadata_for_steps", blows_up)
    wf = p_wf()
    steps = [WorkflowStep(text="pull the calendar and write a brief")]
    asyncio.run(wf_mod.p_relabel_steps(wf, [], steps, None))
    assert steps[0].label
    assert wf.title not in wf_mod._PLACEHOLDER_TITLES


def test_a_healthy_lane_still_wins(monkeypatch):
    """The timeout must not quietly replace good aux output with the fallback."""
    async def good(*_a, **_k):
        return "Summarize Daily Email", "Reads unread mail and texts a digest.", ["Summarize unread email"]

    monkeypatch.setattr(wf_mod, "p_generate_metadata_for_steps", good)
    wf = p_wf()
    steps = [WorkflowStep(text="summarize my unread email")]
    asyncio.run(wf_mod.p_relabel_steps(wf, [], steps, None))
    assert wf.title == "Summarize Daily Email"
    assert steps[0].label == "Summarize unread email"


@pytest.mark.parametrize("budget", [20.0])
def test_the_ceiling_is_bounded_and_sane(budget):
    assert 0 < wf_mod.AUX_LABEL_TIMEOUT_S <= budget
