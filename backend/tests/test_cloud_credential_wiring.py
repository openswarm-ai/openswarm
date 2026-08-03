"""A cloud workflow may never exist without a credential the cloud can sign it with.

Before this wiring, `lease_to_cloud` had zero callers outside its own unit tests. Every part
worked and nothing joined them, so every cloud run in existence died at dispatch with
`no_cloud_credential` and the user found out at 9am. These tests pin the join.
"""
import pytest

from backend.apps.nine_router.credential_lease import LeaseOutcome
from backend.apps.workflows.cloud import credential_readiness, handover


@pytest.fixture
def p_oauth(monkeypatch):
    def set_ids(ids):
        monkeypatch.setattr(
            credential_readiness.credential_store, "list_oauth_connection_ids", lambda: list(ids)
        )
        monkeypatch.setattr(
            handover.credential_store, "list_oauth_connection_ids", lambda: list(ids)
        )
    return set_ids


@pytest.fixture
def p_lease(monkeypatch):
    calls = []

    def set_result(*statuses):
        seq = list(statuses)

        async def fake(connection_id: str) -> LeaseOutcome:
            calls.append(connection_id)
            return LeaseOutcome(status=seq.pop(0) if seq else "cloud_rejected")

        monkeypatch.setattr(handover.credential_lease, "lease_to_cloud", fake)
        return calls

    return set_result


def test_an_account_with_only_api_keys_cannot_use_cloud_runs(p_oauth):
    # Gemini AI Studio and a raw OpenAI key are apikey rows: no refresh token, nothing to lend.
    p_oauth([])
    r = credential_readiness.cloud_credential_readiness()
    assert r.ok is False
    assert r.state == "none_eligible"
    assert "Claude or ChatGPT" in (r.reason or ""), "must name what to connect, not just refuse"
    assert "API key" in (r.reason or ""), "the API-key user needs to know why theirs will not do"


def test_an_oauth_connection_reads_as_ready(p_oauth):
    p_oauth(["conn-claude"])
    r = credential_readiness.cloud_credential_readiness()
    assert r.ok is True
    assert r.connection_ids == ["conn-claude"]
    assert r.reason is None


@pytest.mark.asyncio
async def test_lending_succeeds_on_the_first_usable_connection(p_oauth, p_lease):
    p_oauth(["conn-a", "conn-b"])
    calls = p_lease("leased")
    out = await handover.lend_credential_for_cloud()
    assert out.ok is True
    assert calls == ["conn-a"], "one lease covers every cloud workflow; do not lend them all"


@pytest.mark.asyncio
async def test_an_already_stripped_connection_counts_as_lent(p_oauth, p_lease):
    # not_rotatable means the local refresh token is already gone, i.e. the cloud has it.
    p_oauth(["conn-a"])
    p_lease("not_rotatable")
    assert (await handover.lend_credential_for_cloud()).ok is True


@pytest.mark.asyncio
async def test_a_refused_connection_falls_through_to_the_next(p_oauth, p_lease):
    p_oauth(["conn-dead", "conn-good"])
    calls = p_lease("cloud_rejected", "leased")
    out = await handover.lend_credential_for_cloud()
    assert out.ok is True
    assert calls == ["conn-dead", "conn-good"]


@pytest.mark.asyncio
async def test_every_connection_failing_refuses_with_words_a_user_can_act_on(p_oauth, p_lease):
    p_oauth(["conn-a"])
    p_lease("cloud_rejected")
    out = await handover.lend_credential_for_cloud()
    assert out.ok is False
    assert "still runs on this device" in (out.message or ""), "say what DID happen, not just what failed"


@pytest.mark.asyncio
async def test_signed_out_says_sign_in_rather_than_a_lease_error(p_oauth, p_lease):
    p_oauth(["conn-a"])
    p_lease("not_signed_in")
    out = await handover.lend_credential_for_cloud()
    assert out.ok is False
    assert out.message == handover.SIGN_IN_MESSAGE


@pytest.mark.asyncio
async def test_an_unknown_lease_outcome_tells_the_user_to_reconnect(p_oauth, p_lease):
    # The token is off this device and we cannot prove the cloud took it. Silence here strands them.
    p_oauth(["conn-a"])
    p_lease("ownership_unknown")
    out = await handover.lend_credential_for_cloud()
    assert out.ok is False
    assert "reconnect" in (out.message or "").lower()


@pytest.mark.asyncio
async def test_no_eligible_connection_refuses_before_anything_is_lent(p_oauth, p_lease):
    p_oauth([])
    calls = p_lease("leased")
    out = await handover.lend_credential_for_cloud()
    assert out.ok is False
    assert calls == [], "nothing to lend, so nothing should have been attempted"
    assert "Claude or ChatGPT" in (out.message or "")


# The join itself. Everything above passes even if hand_to_cloud never calls any of it, which is
# exactly the shape of the bug being fixed: the parts all worked and nothing wired them together.

from backend.apps.workflows import storage
from backend.apps.workflows.cloud import client as cloud
from backend.apps.workflows.models import ScheduleConfig, Workflow, WorkflowStep

pytestmark = pytest.mark.usefixtures("isolated_workflows_data")


def p_wf() -> Workflow:
    wf = Workflow(
        title="Morning digest",
        steps=[WorkflowStep(text="summarize the news")],
        schedule=ScheduleConfig(
            enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0, timezone="UTC"
        ),
    )
    storage.save_workflow(wf)
    return wf


@pytest.mark.asyncio
async def test_a_workflow_never_reaches_the_cloud_without_a_credential(monkeypatch, p_oauth):
    """The 9am bug, pinned: no lendable account means the push must not happen at all."""
    p_oauth([])
    wf = p_wf()
    talked: list = []

    async def p_call(method, path, body=None):
        talked.append(path)
        raise AssertionError("pushed a workflow the cloud could never run")

    monkeypatch.setattr(cloud, "p_call", p_call)

    out = await handover.hand_to_cloud(wf, enabled=True)
    assert out.ok is False
    assert talked == [], "the credential check has to come BEFORE the push"
    assert wf.execution_target == "device", "a refused handover leaves it running here"
    assert "Claude or ChatGPT" in (out.message or "")


@pytest.mark.asyncio
async def test_a_refused_push_gives_the_account_back(monkeypatch, p_oauth, p_lease):
    """A hobby user clicking Cloud leases fine (leasing does not check plan) and is then refused by
    the server. Without giving it back, their account stays lent for a workflow that never went up
    and this device can no longer refresh its own token."""
    p_oauth(["conn-a"])
    p_lease("leased")
    wf = p_wf()
    reclaimed: list = []

    async def p_call(method, path, body=None):
        raise cloud.CloudRefused("Cloud workflows need a Pro plan or higher.", 402)

    async def fake_release(connection_id: str):
        reclaimed.append(connection_id)
        return LeaseOutcome(status="released")

    monkeypatch.setattr(cloud, "p_call", p_call)
    monkeypatch.setattr(handover.credential_lease, "release_to_device", fake_release)

    out = await handover.hand_to_cloud(wf, enabled=True)
    assert out.ok is False
    assert out.message == "Cloud workflows need a Pro plan or higher."
    assert reclaimed == ["conn-a"], "the account must come home when the workflow never went up"


@pytest.mark.asyncio
async def test_a_reclaim_spares_an_account_another_cloud_workflow_still_needs(monkeypatch, p_oauth, p_lease):
    p_oauth(["conn-a"])
    p_lease("leased")
    keeper = p_wf()
    keeper.execution_target = "cloud"
    storage.save_workflow(keeper)
    wf = p_wf()
    reclaimed: list = []

    async def p_call(method, path, body=None):
        raise cloud.CloudRefused("nope", 402)

    async def fake_release(connection_id: str):
        reclaimed.append(connection_id)
        return LeaseOutcome(status="released")

    monkeypatch.setattr(cloud, "p_call", p_call)
    monkeypatch.setattr(handover.credential_lease, "release_to_device", fake_release)

    await handover.hand_to_cloud(wf, enabled=True)
    assert reclaimed == [], "another cloud workflow still needs it; taking it back would break that one"


@pytest.mark.asyncio
async def test_a_failed_lease_leaves_the_workflow_on_this_device(monkeypatch, p_oauth, p_lease):
    p_oauth(["conn-a"])
    p_lease("cloud_rejected")
    wf = p_wf()

    async def p_call(method, path, body=None):
        raise AssertionError("pushed despite the lease failing")

    monkeypatch.setattr(cloud, "p_call", p_call)

    out = await handover.hand_to_cloud(wf, enabled=True)
    assert out.ok is False
    assert wf.execution_target == "device"
    assert storage.get_workflow(wf.id).execution_target == "device", "and it stayed that way on disk"
