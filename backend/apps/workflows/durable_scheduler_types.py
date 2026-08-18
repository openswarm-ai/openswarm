"""Closed data types for the durable scheduler reference contract."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import NamedTuple


class JobState(StrEnum):
    PENDING = "pending"
    LEASED = "leased"
    RUNNING = "running"
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELED = "canceled"
    DEAD = "dead"


class EffectRetryClass(StrEnum):
    RETRY_SAFE = "retry_safe"
    AT_MOST_ONCE = "at_most_once"


class OutcomeCode(StrEnum):
    APPLIED = "applied"
    IDEMPOTENT = "idempotent"
    NOT_FOUND = "not_found"
    TENANT_MISMATCH = "tenant_mismatch"
    ID_CONFLICT = "id_conflict"
    CAPACITY_EXCEEDED = "capacity_exceeded"
    NOT_DUE = "not_due"
    ILLEGAL_TRANSITION = "illegal_transition"
    STALE_OWNER = "stale_owner"
    STALE_LEASE_EPOCH = "stale_lease_epoch"
    STALE_CONTROL_PLANE_EPOCH = "stale_control_plane_epoch"
    LEASE_EXPIRED = "lease_expired"
    LEASE_ACTIVE = "lease_active"
    TERMINAL_STATE = "terminal_state"
    ACK_BEFORE_TERMINAL = "ack_before_terminal"


TERMINAL_STATES = frozenset({JobState.SUCCESS, JobState.FAILURE, JobState.CANCELED, JobState.DEAD})


SlotIdentity = NamedTuple("SlotIdentity", [("tenant_id", str), ("workflow_id", str),
                                           ("schedule_revision", int), ("scheduled_for", datetime)])
AttemptIdentity = NamedTuple("AttemptIdentity", [("job_id", str), ("run_id", str), ("attempt_number", int)])
LeaseToken = NamedTuple("LeaseToken", [("owner_id", str), ("lease_epoch", int), ("control_plane_epoch", int)])
Lease = NamedTuple("Lease", [("token", LeaseToken), ("expires_at", datetime)])


@dataclass(frozen=True, slots=True)
class JobRecord:
    job_id: str
    slot: SlotIdentity
    state: JobState
    lease_duration: timedelta
    max_attempts: int
    effect_retry_class: EffectRetryClass
    not_before: datetime
    last_lease_epoch: int = 0
    attempt: AttemptIdentity | None = None
    lease: Lease | None = None
    last_lease_token: LeaseToken | None = None
    last_error: str | None = None
    result: str | None = None
    result_committed: bool = False
    acknowledged: bool = False


@dataclass(frozen=True, slots=True)
class OperationResult:
    code: OutcomeCode
    job: JobRecord | None = None
