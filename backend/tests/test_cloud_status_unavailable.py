"""A 404 on the cloud's preflight route means the signed-in cloud has no workflows API: this app is
ahead of it. That is a blocked state with the honest words, not "The cloud declined this request"."""

import asyncio

from backend.apps.workflows.cloud import client as cloud
from backend.apps.workflows.cloud import status as status_mod
from backend.apps.workflows.models import Workflow


def p_wf() -> Workflow:
    return Workflow(name="probe", steps=[])


def test_a_404_preflight_is_unavailable_and_says_nothing_was_sent(monkeypatch):
    async def refuse(definition, hosted_id=None):
        raise cloud.CloudRefused("The cloud declined this request.", 404)
    monkeypatch.setattr(cloud, "preflight", refuse)
    st = asyncio.run(status_mod.compute_status(p_wf()))
    assert st.state == "unavailable" and "not available on your OpenSwarm Cloud yet" in st.reason and "Nothing was sent" in st.reason


def test_any_other_refusal_stays_unknown_with_the_clouds_words(monkeypatch):
    async def refuse(definition, hosted_id=None):
        raise cloud.CloudRefused("Your plan does not include cloud runs.", 403)
    monkeypatch.setattr(cloud, "preflight", refuse)
    st = asyncio.run(status_mod.compute_status(p_wf()))
    assert st.state == "unknown" and st.detail == "Your plan does not include cloud runs."
