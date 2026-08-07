"""Handing a workflow's timer to the cloud, and taking it back.

The two things worth breaking a test over: the local timer and the cloud timer must never both be
live (that runs a workflow twice), and a cloud we could not reach must never render as a cloud that
said no (that is a paywall built out of a dropped packet).
"""
import pytest
from fastapi import HTTPException

from backend.apps.workflows import storage
from backend.apps.workflows.cloud import client as cloud
from backend.apps.workflows.cloud.routes import TargetRequest, set_workflow_target
from backend.apps.workflows.workflows import delete_workflow
from backend.apps.workflows.cloud.status import compute_status
from backend.apps.workflows.models import ScheduleConfig, Workflow, WorkflowStep

pytestmark = pytest.mark.usefixtures("isolated_workflows_data")


@pytest.fixture(autouse=True)
def p_credential_already_lent(monkeypatch):
    """These tests are about the timer, not credential custody. Without this they would reach the
    real lease, which reads settings this harness never signs in, and every handover would refuse
    with a sign-in message instead of the answer under test. Custody has its own file:
    test_cloud_credential_wiring.py."""
    from backend.apps.workflows.cloud import handover

    async def lent():
        return handover.TargetOutcome(ok=True)

    async def reclaimed(leaving_id: str) -> None:
        return None

    monkeypatch.setattr(handover, "lend_credential_for_cloud", lent)
    monkeypatch.setattr(handover, "p_reclaim_credential_if_last", reclaimed)


def p_sched(**overrides) -> ScheduleConfig:
    base = dict(enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0, timezone="UTC")
    base.update(overrides)
    return ScheduleConfig(**base)


def p_wf(**overrides) -> Workflow:
    base = dict(title="Morning digest", steps=[WorkflowStep(text="summarize the news")], schedule=p_sched())
    base.update(overrides)
    wf = Workflow(**base)
    storage.save_workflow(wf)
    return wf


def p_hosted(**overrides) -> dict:
    row = {"id": "cloud-1", "enabled": True, "next_run_at": 1893499200000}
    row.update(overrides)
    return row


def p_preflight_body(**overrides) -> dict:
    body = {
        "plan": "pro",
        "limits": {"workflows": 3, "runsPerMonth": 100, "concurrent": 1},
        "usage": {"enabled": 1, "runs_this_month": 12},
        "capability": {"ok": True, "reason": None},
        "hosted": None,
    }
    body.update(overrides)
    return body


def p_answer(monkeypatch, handler) -> list:
    """Replace the single network chokepoint. Every call is recorded so a test can assert we did
    NOT talk to the cloud as well as what we said."""
    seen: list = []

    async def p_call(method: str, path: str, body=None):
        seen.append((method, path, body))
        return handler(method, path, body)

    monkeypatch.setattr(cloud, "p_call", p_call)
    return seen


@pytest.mark.asyncio
async def test_signed_out_is_a_known_answer_and_carries_no_numbers(monkeypatch):
    wf = p_wf()

    def handler(method, path, body):
        raise cloud.SignedOut()

    p_answer(monkeypatch, handler)
    status = await compute_status(wf)
    assert status.state == "signed_out"
    assert not hasattr(status, "limits") and not hasattr(status, "usage")


@pytest.mark.asyncio
async def test_an_unreachable_cloud_is_unknown_not_denied(monkeypatch):
    wf = p_wf()

    def handler(method, path, body):
        raise cloud.CloudUnreachable("ConnectError")

    p_answer(monkeypatch, handler)
    status = await compute_status(wf)
    assert status.state == "unknown"
    # The whole point: nothing here can be read as "you have no plan" or "0 runs left".
    assert not hasattr(status, "limits")
    assert status.schedule_supported is True


@pytest.mark.asyncio
async def test_a_ready_status_reports_the_plan_the_server_named(monkeypatch):
    wf = p_wf()
    p_answer(monkeypatch, lambda method, path, body: p_preflight_body())
    status = await compute_status(wf)
    assert status.state == "ready"
    assert status.plan == "pro"
    assert status.limits.workflows == 3
    assert status.usage.runs_this_month == 12
    assert status.hosted is None


@pytest.mark.asyncio
async def test_a_refused_flip_leaves_the_workflow_on_this_device(monkeypatch):
    wf = p_wf()

    def handler(method, path, body):
        raise cloud.CloudRefused("Cloud workflows need a Pro plan or higher.", 402)

    p_answer(monkeypatch, handler)
    outcome = await set_workflow_target(wf.id, TargetRequest(target="cloud", enabled=True))
    assert outcome.ok is False
    assert outcome.message == "Cloud workflows need a Pro plan or higher."
    assert storage.get_workflow(wf.id).execution_target == "device"
    assert storage.get_workflow(wf.id).cloud_workflow_id is None


@pytest.mark.asyncio
async def test_an_unsupported_schedule_never_reaches_the_network(monkeypatch):
    wf = p_wf(schedule=p_sched(repeat_unit="month", day_of_month=1))
    seen = p_answer(monkeypatch, lambda method, path, body: p_preflight_body())
    outcome = await set_workflow_target(wf.id, TargetRequest(target="cloud", enabled=True))
    assert outcome.ok is False
    assert seen == []
    assert storage.get_workflow(wf.id).execution_target == "device"


@pytest.mark.asyncio
async def test_weekdays_go_up_with_the_days_the_user_picked(monkeypatch):
    """"Every weekday at 9am" is the schedule people actually write, and it used to be refused."""
    wf = p_wf(schedule=p_sched(repeat_unit="week", on_days=[5, 1, 2, 3, 4], timezone="America/Los_Angeles"))
    seen = p_answer(monkeypatch, lambda method, path, body: p_hosted())
    outcome = await set_workflow_target(wf.id, TargetRequest(target="cloud", enabled=True))
    assert outcome.ok is True
    sent = seen[-1][2]["schedule"]
    assert sent == {"kind": "weekly", "days": [1, 2, 3, 4, 5], "hour": 9, "minute": 0,
                    "timezone": "America/Los_Angeles"}
    assert storage.get_workflow(wf.id).execution_target == "cloud"


@pytest.mark.asyncio
async def test_a_capped_schedule_hands_over_its_cap_and_what_it_has_already_spent(monkeypatch):
    wf = p_wf(schedule=p_sched(max_runs=5, runs_count=2))
    seen = p_answer(monkeypatch, lambda method, path, body: p_hosted())
    assert (await set_workflow_target(wf.id, TargetRequest(target="cloud", enabled=True))).ok is True
    body = seen[-1][2]
    assert body["schedule"]["max_runs"] == 5
    # Without this the cloud would give a schedule with 3 runs left a fresh 5.
    assert body["runs_before"] == 2


@pytest.mark.asyncio
async def test_runs_the_cloud_performed_come_back_onto_our_own_counter(monkeypatch):
    wf = p_wf(schedule=p_sched(max_runs=5, runs_count=2), execution_target="cloud",
              cloud_workflow_id="cloud-1")
    storage.save_workflow(wf)
    p_answer(monkeypatch, lambda method, path, body: p_preflight_body(hosted=p_hosted(runs_done=4)))
    await compute_status(wf)
    assert storage.get_workflow(wf.id).schedule.runs_count == 4


@pytest.mark.asyncio
async def test_an_accepted_flip_records_which_copy_is_up_there(monkeypatch):
    wf = p_wf()
    p_answer(monkeypatch, lambda method, path, body: p_hosted())
    outcome = await set_workflow_target(wf.id, TargetRequest(target="cloud", enabled=True))
    assert outcome.ok is True

    saved = storage.get_workflow(wf.id)
    assert saved.execution_target == "cloud"
    assert saved.cloud_workflow_id == "cloud-1"
    assert saved.cloud_definition_signature is not None
    # The cloud owns the clock now, so the app shows the cloud's next fire and not our frozen one.
    assert saved.next_run_at is not None
    assert saved.next_run_at.timestamp() * 1000 == p_hosted()["next_run_at"]


@pytest.mark.asyncio
async def test_an_unreachable_cloud_cannot_take_the_timer_back(monkeypatch):
    wf = p_wf(execution_target="cloud", cloud_workflow_id="cloud-1")
    storage.save_workflow(wf)

    def handler(method, path, body):
        raise cloud.CloudUnreachable("ReadTimeout")

    p_answer(monkeypatch, handler)
    outcome = await set_workflow_target(wf.id, TargetRequest(target="device", enabled=True))
    assert outcome.ok is False
    # Flipping the local timer on while the cloud still holds one is how a workflow runs twice.
    assert storage.get_workflow(wf.id).execution_target == "cloud"
    assert storage.get_workflow(wf.id).cloud_workflow_id == "cloud-1"


@pytest.mark.asyncio
async def test_taking_the_timer_back_clears_every_trace_of_the_cloud_copy(monkeypatch):
    wf = p_wf(execution_target="cloud", cloud_workflow_id="cloud-1", cloud_definition_signature="abc")
    storage.save_workflow(wf)
    seen = p_answer(monkeypatch, lambda method, path, body: {"ok": True})
    outcome = await set_workflow_target(wf.id, TargetRequest(target="device", enabled=True))
    assert outcome.ok is True
    assert seen == [("POST", "/cloud-1/delete", {})]

    saved = storage.get_workflow(wf.id)
    assert saved.execution_target == "device"
    assert saved.cloud_workflow_id is None
    assert saved.cloud_definition_signature is None
    assert saved.next_run_at is not None, "the local timer has to be armed again on the way back"


@pytest.mark.asyncio
async def test_a_hosted_copy_that_vanished_shows_as_hosted_nothing(monkeypatch):
    wf = p_wf(execution_target="cloud", cloud_workflow_id="cloud-gone")
    storage.save_workflow(wf)
    p_answer(monkeypatch, lambda method, path, body: p_preflight_body(hosted=None))
    status = await compute_status(wf)
    assert status.state == "ready"
    assert status.target == "cloud" and status.hosted is None
    assert storage.get_workflow(wf.id).next_run_at is None, "nothing is going to run it, so do not promise a time"


@pytest.mark.asyncio
async def test_an_edited_workflow_reads_as_out_of_sync(monkeypatch):
    wf = p_wf()
    p_answer(monkeypatch, lambda method, path, body: p_hosted())
    await set_workflow_target(wf.id, TargetRequest(target="cloud", enabled=True))

    p_answer(monkeypatch, lambda method, path, body: p_preflight_body(hosted=p_hosted()))
    assert (await compute_status(storage.get_workflow(wf.id))).hosted.in_sync is True

    edited = storage.get_workflow(wf.id)
    edited.steps = [WorkflowStep(text="summarize the sports news instead")]
    storage.save_workflow(edited)
    assert (await compute_status(edited)).hosted.in_sync is False


@pytest.mark.asyncio
async def test_an_old_control_plane_leaves_capability_unknown_rather_than_ok(monkeypatch):
    wf = p_wf()

    def handler(method, path, body):
        if path == "/preflight":
            raise cloud.CloudRefused("Not Found", 404)
        return {
            "workflows": [],
            "limits": {"workflows": 3, "runsPerMonth": 100, "concurrent": 1},
            "usage": {"enabled": 0, "runs_this_month": 0},
        }

    seen = p_answer(monkeypatch, handler)
    status = await compute_status(wf)
    assert status.state == "ready"
    assert status.capability is None
    assert status.limits.workflows == 3
    # The cloud router is mounted AT /api/workflows and a trailing slash 404s there, which would turn this fallback into a second refusal.
    assert seen[-1][1] == "", "the collection path must not carry a trailing slash"


@pytest.mark.asyncio
async def test_trashing_a_cloud_workflow_stops_the_cloud_copy(monkeypatch):
    wf = p_wf()
    p_answer(monkeypatch, lambda method, path, body: p_hosted())
    await set_workflow_target(wf.id, TargetRequest(target="cloud", enabled=True))

    seen = p_answer(monkeypatch, lambda method, path, body: {"ok": True})
    await delete_workflow(storage.get_workflow(wf.id).id)
    assert seen == [("POST", "/cloud-1/delete", {})]
    trashed = storage.get_workflow(wf.id)
    assert trashed.deleted_at is not None
    assert trashed.cloud_workflow_id is None


@pytest.mark.asyncio
async def test_a_workflow_the_cloud_still_holds_cannot_be_trashed_into_a_ghost(monkeypatch):
    wf = p_wf()
    p_answer(monkeypatch, lambda method, path, body: p_hosted())
    await set_workflow_target(wf.id, TargetRequest(target="cloud", enabled=True))

    def handler(method, path, body):
        raise cloud.CloudUnreachable("ConnectError")

    p_answer(monkeypatch, handler)
    with pytest.raises(HTTPException) as caught:
        await delete_workflow(wf.id)
    assert caught.value.status_code == 409
    # Deleting it locally would leave a hosted copy running on its own schedule, billing a user who cannot see it.
    assert storage.get_workflow(wf.id).deleted_at is None


@pytest.mark.asyncio
async def test_toggling_a_cloud_schedule_off_pauses_the_cloud_copy(monkeypatch):
    """The live report this seals: schedule toggled off, the workflow still ran. The cloud held the
    timer and the PATCH edited only the local copy, which pauses nothing."""
    from backend.apps.workflows.models import WorkflowUpdate
    from backend.apps.workflows.workflows import update_workflow

    wf = p_wf(execution_target="cloud", cloud_workflow_id="cloud-1")
    seen = p_answer(
        monkeypatch,
        lambda method, path, body: p_hosted(enabled=False, next_run_at=None)
        if path.endswith("/enable")
        else p_hosted(),
    )
    await update_workflow(wf.id, WorkflowUpdate(schedule=p_sched(enabled=False)), if_match=None)
    enable_calls = [(p, b) for _, p, b in seen if p.endswith("/enable")]
    assert enable_calls, f"the cloud row was never paused; calls: {[p for _, p, _ in seen]}"
    assert enable_calls[-1][1] == {"enabled": False}
    fresh = storage.get_workflow(wf.id)
    assert fresh.schedule.enabled is False
    assert fresh.next_run_at is None


@pytest.mark.asyncio
async def test_an_unreachable_cloud_fails_the_toggle_instead_of_lying(monkeypatch):
    """A toggle the cloud never heard must not render as Off while the cloud keeps firing."""
    from backend.apps.workflows.models import WorkflowUpdate
    from backend.apps.workflows.workflows import update_workflow

    wf = p_wf(execution_target="cloud", cloud_workflow_id="cloud-1")

    def boom(method, path, body):
        raise cloud.CloudUnreachable("no route")

    p_answer(monkeypatch, boom)
    with pytest.raises(HTTPException) as exc:
        await update_workflow(wf.id, WorkflowUpdate(schedule=p_sched(enabled=False)), if_match=None)
    assert exc.value.status_code == 502
    # The shared cached instance was mutated before the push; disk truth must win back.
    assert storage.get_workflow(wf.id).schedule.enabled is True


@pytest.mark.asyncio
async def test_a_device_schedule_patch_never_talks_to_the_cloud(monkeypatch):
    from backend.apps.workflows.models import WorkflowUpdate
    from backend.apps.workflows.workflows import update_workflow

    wf = p_wf()
    seen = p_answer(monkeypatch, lambda method, path, body: p_hosted())
    await update_workflow(wf.id, WorkflowUpdate(schedule=p_sched(enabled=False)), if_match=None)
    assert seen == []
    assert storage.get_workflow(wf.id).schedule.enabled is False
