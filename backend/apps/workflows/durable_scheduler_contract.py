"""Deterministic durable at-least-once scheduler contract and reference model.

It does not prove exactly-once effects; callers supply idempotency or at-most-once policy.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from backend.apps.workflows.durable_scheduler_types import (
    TERMINAL_STATES,
    AttemptIdentity,
    EffectRetryClass,
    JobRecord,
    JobState,
    Lease,
    LeaseToken,
    OperationResult,
    OutcomeCode,
    SlotIdentity,
)


def p_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("scheduler instants must be timezone-aware")
    return value.astimezone(timezone.utc)


def p_nonempty(name: str, value: str) -> str:
    if not value:
        raise ValueError(f"{name} must be non-empty")
    return value


class InMemoryDurableScheduler:
    """Bounded synchronous model of atomic durable-store operations."""

    def __init__(self, *, clock: Callable[[], datetime], control_plane_epoch: int, max_jobs: int) -> None:
        if control_plane_epoch < 1 or max_jobs < 1:
            raise ValueError("control-plane epoch and capacity must be positive")
        self.p_clock, self.p_control_plane_epoch = clock, control_plane_epoch
        self.p_max_jobs = max_jobs
        self.p_jobs: dict[str, JobRecord] = {}
        self.p_slots: dict[SlotIdentity, str] = {}
        self.p_run_ids: set[str] = set()

    @property
    def job_count(self) -> int:
        return len(self.p_jobs)

    def p_now(self) -> datetime:
        return p_utc(self.p_clock())

    def p_store(self, job: JobRecord) -> OperationResult:
        self.p_jobs[job.job_id] = job
        return OperationResult(OutcomeCode.APPLIED, job)

    def p_lookup(self, tenant_id: str, job_id: str) -> OperationResult:
        job = self.p_jobs.get(job_id)
        if job is None:
            return OperationResult(OutcomeCode.NOT_FOUND)
        if job.slot.tenant_id != tenant_id:
            return OperationResult(OutcomeCode.TENANT_MISMATCH)
        return OperationResult(OutcomeCode.IDEMPOTENT, job)

    def get(self, *, tenant_id: str, job_id: str) -> OperationResult:
        return self.p_lookup(tenant_id, job_id)

    def enqueue(
        self, *, tenant_id: str, workflow_id: str, schedule_revision: int, scheduled_for: datetime,
        job_id: str, lease_duration: timedelta, max_attempts: int, effect_retry_class: EffectRetryClass,
    ) -> OperationResult:
        if schedule_revision < 1 or max_attempts < 1 or lease_duration <= timedelta(0):
            raise ValueError("revision, attempts, and lease duration must be positive")
        slot = SlotIdentity(p_nonempty("tenant_id", tenant_id), p_nonempty("workflow_id", workflow_id),
            schedule_revision, p_utc(scheduled_for))
        existing = self.p_slots.get(slot)
        if existing is not None:
            return OperationResult(OutcomeCode.IDEMPOTENT, self.p_jobs[existing])
        if job_id in self.p_jobs:
            return OperationResult(OutcomeCode.ID_CONFLICT)
        if len(self.p_jobs) >= self.p_max_jobs:
            return OperationResult(OutcomeCode.CAPACITY_EXCEEDED)
        job = JobRecord(p_nonempty("job_id", job_id), slot, JobState.PENDING, lease_duration,
                        max_attempts, effect_retry_class, slot.scheduled_for)
        self.p_jobs[job_id], self.p_slots[slot] = job, job_id
        return OperationResult(OutcomeCode.APPLIED, job)

    def p_active(
        self, tenant_id: str, job_id: str, token: LeaseToken, *, now: datetime | None = None,
    ) -> OperationResult:
        found, current_epoch = self.p_lookup(tenant_id, job_id), self.p_control_plane_epoch
        job = found.job
        if job is None:
            return found
        if job.state in TERMINAL_STATES:
            return OperationResult(OutcomeCode.TERMINAL_STATE, job)
        if token.control_plane_epoch != current_epoch:
            return OperationResult(OutcomeCode.STALE_CONTROL_PLANE_EPOCH, job)
        lease = job.lease
        if lease is None:
            return OperationResult(OutcomeCode.ILLEGAL_TRANSITION, job)
        if lease.token.owner_id != token.owner_id:
            return OperationResult(OutcomeCode.STALE_OWNER, job)
        if lease.token.lease_epoch != token.lease_epoch:
            return OperationResult(OutcomeCode.STALE_LEASE_EPOCH, job)
        if lease.token.control_plane_epoch != token.control_plane_epoch:
            return OperationResult(OutcomeCode.STALE_CONTROL_PLANE_EPOCH, job)
        checked_at = self.p_now() if now is None else p_utc(now)
        if checked_at >= lease.expires_at:
            return OperationResult(OutcomeCode.LEASE_EXPIRED, job)
        return OperationResult(OutcomeCode.IDEMPOTENT, job)

    def claim(
        self, *, tenant_id: str, job_id: str, run_id: str, owner_id: str, control_plane_epoch: int,
    ) -> OperationResult:
        found, now = self.p_lookup(tenant_id, job_id), self.p_now()
        job = found.job
        if job is None:
            return found
        run_id, owner_id = p_nonempty("run_id", run_id), p_nonempty("owner_id", owner_id)
        if control_plane_epoch != self.p_control_plane_epoch:
            return OperationResult(OutcomeCode.STALE_CONTROL_PLANE_EPOCH, job)
        if job.attempt is not None and job.attempt.run_id == run_id:
            previous = job.last_lease_token
            if previous is None:
                return OperationResult(OutcomeCode.ILLEGAL_TRANSITION, job)
            if previous.owner_id != owner_id:
                return OperationResult(OutcomeCode.STALE_OWNER, job)
            if previous.control_plane_epoch != control_plane_epoch:
                return OperationResult(OutcomeCode.STALE_CONTROL_PLANE_EPOCH, job)
            if job.state in TERMINAL_STATES:
                return OperationResult(OutcomeCode.IDEMPOTENT, job)
            if job.state not in {JobState.LEASED, JobState.RUNNING} or job.lease is None:
                return OperationResult(OutcomeCode.ID_CONFLICT, job)
            if now >= job.lease.expires_at:
                return OperationResult(OutcomeCode.LEASE_EXPIRED, job)
            return OperationResult(OutcomeCode.IDEMPOTENT, job)
        if job.state in TERMINAL_STATES:
            return OperationResult(OutcomeCode.TERMINAL_STATE, job)
        if job.state is not JobState.PENDING:
            return OperationResult(OutcomeCode.ILLEGAL_TRANSITION, job)
        if now < job.not_before:
            return OperationResult(OutcomeCode.NOT_DUE, job)
        if run_id in self.p_run_ids:
            return OperationResult(OutcomeCode.ID_CONFLICT, job)
        attempt_no = 1 if job.attempt is None else job.attempt.attempt_number + 1
        lease_epoch = job.last_lease_epoch + 1
        attempt = AttemptIdentity(job.job_id, run_id, attempt_no)
        token = LeaseToken(owner_id, lease_epoch, control_plane_epoch)
        self.p_run_ids.add(run_id)
        return self.p_store(replace(job, state=JobState.LEASED, attempt=attempt,
                                   lease=Lease(token, now + job.lease_duration), last_lease_epoch=lease_epoch,
                                   last_lease_token=token))

    def heartbeat(self, *, tenant_id: str, job_id: str, token: LeaseToken) -> OperationResult:
        now = self.p_now()
        active = self.p_active(tenant_id, job_id, token, now=now)
        job = active.job
        if active.code is not OutcomeCode.IDEMPOTENT or job is None:
            return active
        if job.state not in {JobState.LEASED, JobState.RUNNING} or job.lease is None:
            return OperationResult(OutcomeCode.ILLEGAL_TRANSITION, job)
        lease = Lease(job.lease.token, now + job.lease_duration)
        return self.p_store(replace(job, lease=lease))

    def start(self, *, tenant_id: str, job_id: str, token: LeaseToken) -> OperationResult:
        active = self.p_active(tenant_id, job_id, token)
        job = active.job
        if active.code is not OutcomeCode.IDEMPOTENT or job is None:
            return active
        if job.state is JobState.RUNNING:
            return OperationResult(OutcomeCode.IDEMPOTENT, job)
        if job.state is not JobState.LEASED:
            return OperationResult(OutcomeCode.ILLEGAL_TRANSITION, job)
        return self.p_store(replace(job, state=JobState.RUNNING))

    def cancel(self, *, tenant_id: str, job_id: str, reason: str) -> OperationResult:
        found, canceled = self.p_lookup(tenant_id, job_id), JobState.CANCELED
        job = found.job
        if job is None:
            return found
        if job.state is canceled:
            return OperationResult(OutcomeCode.IDEMPOTENT, job)
        if job.state in TERMINAL_STATES:
            return OperationResult(OutcomeCode.TERMINAL_STATE, job)
        return self.p_store(replace(job, state=canceled, lease=None, result=reason, result_committed=True))

    def commit_terminal(
        self, *, tenant_id: str, job_id: str, token: LeaseToken, state: JobState, result: str,
    ) -> OperationResult:
        if state not in {JobState.SUCCESS, JobState.FAILURE}:
            raise ValueError("terminal commit state must be success or failure")
        found = self.p_lookup(tenant_id, job_id)
        job = found.job
        if job is None:
            return found
        if job.state in TERMINAL_STATES:
            if (job.state is state and job.result == result and job.result_committed
                    and job.last_lease_token == token):
                return OperationResult(OutcomeCode.IDEMPOTENT, job)
            return OperationResult(OutcomeCode.TERMINAL_STATE, job)
        active = self.p_active(tenant_id, job_id, token)
        job = active.job
        if active.code is not OutcomeCode.IDEMPOTENT or job is None:
            return active
        if job.state is not JobState.RUNNING:
            return OperationResult(OutcomeCode.ILLEGAL_TRANSITION, job)
        return self.p_store(replace(job, state=state, lease=None, result=result, result_committed=True))

    def p_retry(self, job: JobRecord, due: datetime, error: str) -> OperationResult:
        attempt = 0 if job.attempt is None else job.attempt.attempt_number
        if job.effect_retry_class is EffectRetryClass.RETRY_SAFE and attempt < job.max_attempts:
            return self.p_store(replace(job, state=JobState.PENDING, lease=None,
                                        not_before=p_utc(due), last_error=error))
        return self.p_store(replace(job, state=JobState.DEAD, lease=None, last_error=error,
                                   result=error, result_committed=True))

    def retry_or_dead(
        self, *, tenant_id: str, job_id: str, token: LeaseToken, retry_not_before: datetime, error: str,
    ) -> OperationResult:
        active = self.p_active(tenant_id, job_id, token)
        job = active.job
        if active.code is not OutcomeCode.IDEMPOTENT or job is None:
            return active
        if job.state is not JobState.RUNNING:
            return OperationResult(OutcomeCode.ILLEGAL_TRANSITION, job)
        return self.p_retry(job, retry_not_before, error)

    def expire_lease(
        self, *, tenant_id: str, job_id: str, observed_token: LeaseToken, control_plane_epoch: int,
        retry_not_before: datetime, error: str,
    ) -> OperationResult:
        found = self.p_lookup(tenant_id, job_id)
        job = found.job
        if job is None:
            return found
        if job.state in TERMINAL_STATES:
            return OperationResult(OutcomeCode.TERMINAL_STATE, job)
        if control_plane_epoch != self.p_control_plane_epoch:
            return OperationResult(OutcomeCode.STALE_CONTROL_PLANE_EPOCH, job)
        lease = job.lease
        if lease is None:
            return OperationResult(OutcomeCode.ILLEGAL_TRANSITION, job)
        if lease.token.owner_id != observed_token.owner_id:
            return OperationResult(OutcomeCode.STALE_OWNER, job)
        if lease.token.lease_epoch != observed_token.lease_epoch:
            return OperationResult(OutcomeCode.STALE_LEASE_EPOCH, job)
        if lease.token.control_plane_epoch != observed_token.control_plane_epoch:
            return OperationResult(OutcomeCode.STALE_CONTROL_PLANE_EPOCH, job)
        if self.p_now() < lease.expires_at:
            return OperationResult(OutcomeCode.LEASE_ACTIVE, job)
        return self.p_retry(job, retry_not_before, error)

    def acknowledge(self, *, tenant_id: str, job_id: str) -> OperationResult:
        found = self.p_lookup(tenant_id, job_id)
        job = found.job
        if job is None:
            return found
        if job.acknowledged:
            return OperationResult(OutcomeCode.IDEMPOTENT, job)
        if job.state not in TERMINAL_STATES or not job.result_committed:
            return OperationResult(OutcomeCode.ACK_BEFORE_TERMINAL, job)
        return self.p_store(replace(job, acknowledged=True))

    def fence_control_plane(self, next_epoch: int) -> OperationResult:
        if next_epoch <= self.p_control_plane_epoch:
            return OperationResult(OutcomeCode.STALE_CONTROL_PLANE_EPOCH)
        self.p_control_plane_epoch = next_epoch
        return OperationResult(OutcomeCode.APPLIED)
