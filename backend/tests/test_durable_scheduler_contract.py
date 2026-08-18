from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from backend.apps.workflows.durable_scheduler_contract import (
    EffectRetryClass,
    InMemoryDurableScheduler,
    JobState,
    LeaseToken,
    OperationResult,
    OutcomeCode,
)


class ManualClock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, delta: timedelta) -> None:
        self.now += delta


class SteppingClock:
    def __init__(self, *values: datetime) -> None:
        self.values = list(values)
        self.calls = 0

    def __call__(self) -> datetime:
        value = self.values[self.calls]
        self.calls += 1
        return value


class DurableSchedulerContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualClock(datetime(2026, 1, 1, tzinfo=timezone.utc))
        self.queue = InMemoryDurableScheduler(clock=self.clock, control_plane_epoch=7, max_jobs=16)

    def enqueue(
        self, *, tenant_id: str = "tenant-a", workflow_id: str = "workflow-a",
        schedule_revision: int = 3, job_id: str = "job-a",
        scheduled_for: datetime | None = None, max_attempts: int = 2,
        retry_class: EffectRetryClass = EffectRetryClass.RETRY_SAFE,
    ) -> OperationResult:
        return self.queue.enqueue(
            tenant_id=tenant_id, workflow_id=workflow_id, schedule_revision=schedule_revision,
            scheduled_for=scheduled_for or self.clock.now, job_id=job_id,
            lease_duration=timedelta(seconds=30), max_attempts=max_attempts,
            effect_retry_class=retry_class,
        )

    @staticmethod
    def token(owner: str = "worker-a", lease_epoch: int = 1, plane: int = 7) -> LeaseToken:
        return LeaseToken(owner, lease_epoch, plane)

    def claim(
        self, *, job_id: str = "job-a", run_id: str = "run-a",
        owner_id: str = "worker-a", plane: int = 7,
    ) -> OperationResult:
        return self.queue.claim(
            tenant_id="tenant-a", job_id=job_id, run_id=run_id,
            owner_id=owner_id, control_plane_epoch=plane,
        )

    def start(self, *, job_id: str = "job-a", token: LeaseToken | None = None) -> OperationResult:
        return self.queue.start(tenant_id="tenant-a", job_id=job_id, token=token or self.token())

    def retry(self, *, job_id: str = "job-a", token: LeaseToken | None = None) -> OperationResult:
        return self.queue.retry_or_dead(
            tenant_id="tenant-a", job_id=job_id, token=token or self.token(),
            retry_not_before=self.clock.now, error="attempt failed",
        )

    def commit(self, state: JobState = JobState.SUCCESS) -> OperationResult:
        return self.queue.commit_terminal(
            tenant_id="tenant-a", job_id="job-a", token=self.token(), state=state, result="result",
        )

    def test_duplicate_slot_enqueue_is_idempotent_and_revision_scoped(self) -> None:
        first = self.enqueue()
        duplicate = self.enqueue(job_id="job-duplicate")
        revision = self.enqueue(job_id="job-revision", schedule_revision=4)
        self.assertEqual(first.code, OutcomeCode.APPLIED)
        self.assertEqual(duplicate.code, OutcomeCode.IDEMPOTENT)
        self.assertEqual(duplicate.job, first.job)
        self.assertEqual(revision.code, OutcomeCode.APPLIED)
        self.assertEqual(self.queue.job_count, 2)

    def test_job_and_run_identities_reject_cross_slot_reuse(self) -> None:
        self.enqueue()
        job_collision = self.enqueue(job_id="job-a", workflow_id="workflow-b")
        self.enqueue(job_id="job-b", workflow_id="workflow-b")
        self.claim(run_id="run-shared")
        run_collision = self.claim(job_id="job-b", run_id="run-shared")
        self.assertEqual(job_collision.code, OutcomeCode.ID_CONFLICT)
        self.assertEqual(run_collision.code, OutcomeCode.ID_CONFLICT)

    def test_slot_identity_and_every_lookup_are_tenant_scoped(self) -> None:
        first = self.enqueue()
        other = self.enqueue(tenant_id="tenant-b", job_id="job-b")
        hidden = self.queue.get(tenant_id="tenant-b", job_id="job-a")
        denied = self.queue.cancel(tenant_id="tenant-b", job_id="job-a", reason="wrong tenant")
        self.assertEqual((first.code, other.code), (OutcomeCode.APPLIED, OutcomeCode.APPLIED))
        self.assertEqual(hidden.code, OutcomeCode.TENANT_MISMATCH)
        self.assertIsNone(hidden.job)
        self.assertEqual(denied.code, OutcomeCode.TENANT_MISMATCH)
        self.assertEqual(self.queue.get(tenant_id="tenant-a", job_id="job-a").job.state, JobState.PENDING)

    def test_stale_owner_cannot_start_or_mutate_job(self) -> None:
        self.enqueue()
        self.claim()
        stale = self.start(token=self.token(owner="worker-b"))
        self.assertEqual(stale.code, OutcomeCode.STALE_OWNER)
        self.assertEqual(self.queue.get(tenant_id="tenant-a", job_id="job-a").job.state, JobState.LEASED)

    def test_stale_lease_epoch_cannot_mutate_reclaimed_job(self) -> None:
        self.enqueue()
        self.claim()
        self.clock.advance(timedelta(seconds=31))
        self.queue.expire_lease(
            tenant_id="tenant-a", job_id="job-a", observed_token=self.token(),
            control_plane_epoch=7, retry_not_before=self.clock.now, error="worker lost",
        )
        reclaimed = self.claim(run_id="run-b", owner_id="worker-b")
        stale = self.start(token=self.token(owner="worker-b"))
        self.assertEqual(reclaimed.job.lease.token.lease_epoch, 2)
        self.assertEqual(stale.code, OutcomeCode.STALE_LEASE_EPOCH)

    def test_restore_epoch_fences_old_plane_and_allows_expired_recovery(self) -> None:
        self.enqueue()
        self.claim()
        fenced = self.queue.fence_control_plane(8)
        stale = self.queue.heartbeat(tenant_id="tenant-a", job_id="job-a", token=self.token())
        self.clock.advance(timedelta(seconds=31))
        stale_observation = self.queue.expire_lease(
            tenant_id="tenant-a", job_id="job-a", observed_token=self.token(plane=6),
            control_plane_epoch=8, retry_not_before=self.clock.now, error="wrong observed plane",
        )
        recovered = self.queue.expire_lease(
            tenant_id="tenant-a", job_id="job-a", observed_token=self.token(),
            control_plane_epoch=8, retry_not_before=self.clock.now, error="old plane fenced",
        )
        self.assertEqual(fenced.code, OutcomeCode.APPLIED)
        self.assertEqual(stale.code, OutcomeCode.STALE_CONTROL_PLANE_EPOCH)
        self.assertEqual(stale_observation.code, OutcomeCode.STALE_CONTROL_PLANE_EPOCH)
        self.assertEqual((recovered.code, recovered.job.state), (OutcomeCode.APPLIED, JobState.PENDING))

    def test_heartbeat_after_expiry_is_rejected_without_renewal(self) -> None:
        self.enqueue()
        claimed = self.claim()
        original_expiry = claimed.job.lease.expires_at
        self.clock.advance(timedelta(seconds=31))
        heartbeat = self.queue.heartbeat(tenant_id="tenant-a", job_id="job-a", token=self.token())
        self.assertEqual(heartbeat.code, OutcomeCode.LEASE_EXPIRED)
        self.assertEqual(heartbeat.job.lease.expires_at, original_expiry)

    def test_heartbeat_renews_from_injected_time(self) -> None:
        self.enqueue()
        claimed = self.claim()
        self.clock.advance(timedelta(seconds=5))
        renewed = self.queue.heartbeat(tenant_id="tenant-a", job_id="job-a", token=self.token())
        self.assertEqual(renewed.code, OutcomeCode.APPLIED)
        self.assertGreater(renewed.job.lease.expires_at, claimed.job.lease.expires_at)
        self.assertEqual(renewed.job.lease.expires_at, self.clock.now + timedelta(seconds=30))

    def test_heartbeat_uses_one_atomic_clock_sample(self) -> None:
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        clock = SteppingClock(base, base + timedelta(seconds=29), base + timedelta(seconds=31))
        queue = InMemoryDurableScheduler(clock=clock, control_plane_epoch=7, max_jobs=1)
        queue.enqueue(
            tenant_id="tenant-a", workflow_id="workflow-a", schedule_revision=1,
            scheduled_for=base, job_id="job-a", lease_duration=timedelta(seconds=30),
            max_attempts=1, effect_retry_class=EffectRetryClass.RETRY_SAFE,
        )
        queue.claim(
            tenant_id="tenant-a", job_id="job-a", run_id="run-a",
            owner_id="worker-a", control_plane_epoch=7,
        )
        renewed = queue.heartbeat(tenant_id="tenant-a", job_id="job-a", token=self.token())
        self.assertEqual((renewed.code, clock.calls), (OutcomeCode.APPLIED, 2))
        self.assertEqual(renewed.job.lease.expires_at, base + timedelta(seconds=59))

    def test_lost_claim_response_replay_is_idempotent(self) -> None:
        self.enqueue()
        first = self.claim()
        replay = self.claim()
        self.assertEqual((first.code, replay.code), (OutcomeCode.APPLIED, OutcomeCode.IDEMPOTENT))
        self.assertEqual(replay.job, first.job)

    def test_lost_start_response_replay_is_idempotent(self) -> None:
        self.enqueue()
        self.claim()
        first = self.start()
        replay = self.start()
        self.assertEqual((first.code, replay.code), (OutcomeCode.APPLIED, OutcomeCode.IDEMPOTENT))
        self.assertEqual(replay.job, first.job)

    def test_lost_terminal_commit_response_replay_is_idempotent(self) -> None:
        self.enqueue()
        self.claim()
        self.start()
        first = self.commit()
        replay = self.commit()
        conflict = self.queue.commit_terminal(
            tenant_id="tenant-a", job_id="job-a", token=self.token(),
            state=JobState.SUCCESS, result="different",
        )
        self.assertEqual((first.code, replay.code), (OutcomeCode.APPLIED, OutcomeCode.IDEMPOTENT))
        self.assertEqual(replay.job, first.job)
        self.assertEqual(conflict.code, OutcomeCode.TERMINAL_STATE)

    def test_terminal_state_cannot_regress(self) -> None:
        self.enqueue()
        self.claim()
        self.start()
        committed = self.commit()
        regression = self.queue.cancel(tenant_id="tenant-a", job_id="job-a", reason="too late")
        self.assertEqual(committed.code, OutcomeCode.APPLIED)
        self.assertEqual(regression.code, OutcomeCode.TERMINAL_STATE)
        self.assertEqual(regression.job.state, JobState.SUCCESS)

    def test_cancel_blocks_success_and_retry(self) -> None:
        self.enqueue()
        self.claim()
        self.start()
        canceled = self.queue.cancel(tenant_id="tenant-a", job_id="job-a", reason="user canceled")
        success = self.commit()
        retry = self.retry()
        self.assertEqual(canceled.job.state, JobState.CANCELED)
        self.assertEqual(success.code, OutcomeCode.TERMINAL_STATE)
        self.assertEqual(retry.code, OutcomeCode.TERMINAL_STATE)

    def test_ack_requires_terminal_commit_and_is_idempotent(self) -> None:
        self.enqueue()
        early = self.queue.acknowledge(tenant_id="tenant-a", job_id="job-a")
        self.claim()
        self.start()
        self.commit(JobState.FAILURE)
        acked = self.queue.acknowledge(tenant_id="tenant-a", job_id="job-a")
        replay = self.queue.acknowledge(tenant_id="tenant-a", job_id="job-a")
        self.assertEqual(early.code, OutcomeCode.ACK_BEFORE_TERMINAL)
        self.assertEqual((acked.code, acked.job.acknowledged), (OutcomeCode.APPLIED, True))
        self.assertEqual(replay.code, OutcomeCode.IDEMPOTENT)

    def test_retry_budget_and_effect_policy_end_dead(self) -> None:
        self.enqueue(max_attempts=1)
        self.claim()
        self.start()
        exhausted = self.retry()
        self.enqueue(
            job_id="job-once", workflow_id="workflow-once",
            retry_class=EffectRetryClass.AT_MOST_ONCE,
        )
        self.claim(job_id="job-once", run_id="run-once")
        self.start(job_id="job-once")
        no_retry = self.retry(job_id="job-once")
        self.assertEqual(exhausted.job.state, JobState.DEAD)
        self.assertEqual(no_retry.job.state, JobState.DEAD)

    def test_injected_clock_controls_due_time_and_lease_expiry(self) -> None:
        due = self.clock.now + timedelta(minutes=5)
        self.enqueue(scheduled_for=due)
        early = self.claim()
        self.clock.advance(timedelta(minutes=5))
        due_claim = self.claim()
        self.assertEqual(early.code, OutcomeCode.NOT_DUE)
        self.assertEqual(due_claim.code, OutcomeCode.APPLIED)
        self.assertEqual(due_claim.job.lease.expires_at, self.clock.now + timedelta(seconds=30))

    def test_reference_repository_is_bounded(self) -> None:
        queue = InMemoryDurableScheduler(clock=self.clock, control_plane_epoch=1, max_jobs=1)
        values = dict(
            tenant_id="tenant-a", schedule_revision=1, scheduled_for=self.clock.now,
            lease_duration=timedelta(seconds=1), max_attempts=1,
            effect_retry_class=EffectRetryClass.RETRY_SAFE,
        )
        queue.enqueue(workflow_id="workflow-a", job_id="job-a", **values)
        full = queue.enqueue(workflow_id="workflow-b", job_id="job-b", **values)
        self.assertEqual(full.code, OutcomeCode.CAPACITY_EXCEEDED)

    def test_lost_ack_redelivery_returns_same_terminal_job(self) -> None:
        first = self.enqueue()
        self.claim()
        self.start()
        terminal = self.commit()
        redelivery = self.enqueue(job_id="redelivery")
        self.assertFalse(terminal.job.acknowledged)
        self.assertEqual(redelivery.code, OutcomeCode.IDEMPOTENT)
        self.assertEqual(redelivery.job.job_id, first.job.job_id)
        self.assertEqual(redelivery.job.state, JobState.SUCCESS)


if __name__ == "__main__":
    unittest.main()
