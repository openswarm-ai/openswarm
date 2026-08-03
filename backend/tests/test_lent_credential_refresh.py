"""Local work must survive the cloud borrowing your login.

Lending strips this device's refresh token so only one holder can rotate. 9Router's refresh
dispatcher then bails on the falsy refreshToken WITHOUT calling the provider, so nothing
renews the access token: a few hours after a successful handover every local agent starts
failing, with no error that names the cause. This file pins the other half of the trade.

The two ways to get it wrong are opposite and both bad: never pulling (local dies), and
pulling constantly (every pull stops and restarts the router, so a 2-minute cadence would
make the app unusable).
"""
import time

import pytest

from backend.apps.nine_router import lent_credential_refresh as lcr
from backend.apps.nine_router.credential_lease import LeaseOutcome
from backend.apps.nine_router.credential_store import ProviderCredential


def p_iso(seconds_from_now: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(time.time() + seconds_from_now, tz=timezone.utc).isoformat()


@pytest.fixture
def p_connections(monkeypatch):
    """Install a fake 9router db. `refresh` present means this device still owns it."""

    def install(rows):
        creds = {
            r["id"]: ProviderCredential(
                connection_id=r["id"],
                provider=r.get("provider", "claude"),
                access_token="at",
                refresh_token=r.get("refresh"),
                expires_at=r.get("expires"),
            )
            for r in rows
        }
        monkeypatch.setattr(lcr.credential_store, "list_oauth_connection_ids", lambda: list(creds))
        monkeypatch.setattr(lcr.credential_store, "read_credential", lambda cid: creds.get(cid))
        return creds

    return install


@pytest.fixture
def p_pull(monkeypatch):
    def install(*statuses):
        seq = list(statuses)
        calls = []

        async def fake(connection_id: str) -> LeaseOutcome:
            calls.append(connection_id)
            return LeaseOutcome(status=seq.pop(0) if seq else "refreshed")

        monkeypatch.setattr(lcr.credential_lease, "pull_access_token", fake)
        return calls

    return install


def test_a_connection_this_device_still_owns_is_never_touched(p_connections):
    # It has its own refresh token, so 9Router renews it. Pulling would fight the router for no reason.
    p_connections([{"id": "mine", "refresh": "rt", "expires": p_iso(30)}])
    assert lcr.lent_connections_needing_a_pull() == []


def test_a_lent_connection_with_hours_left_is_left_alone(p_connections):
    # Every pull costs a router stop and start, so acting early would be worse than acting late.
    p_connections([{"id": "lent", "refresh": None, "expires": p_iso(6 * 3600)}])
    assert lcr.lent_connections_needing_a_pull() == []


def test_a_lent_connection_inside_the_margin_is_due(p_connections):
    p_connections([{"id": "lent", "refresh": None, "expires": p_iso(lcr.REFRESH_MARGIN_S - 60)}])
    assert lcr.lent_connections_needing_a_pull() == ["lent"]


def test_an_already_expired_lent_connection_is_due(p_connections):
    p_connections([{"id": "lent", "refresh": None, "expires": p_iso(-3600)}])
    assert lcr.lent_connections_needing_a_pull() == ["lent"]


def test_an_unreadable_expiry_is_treated_as_due(p_connections):
    # One wasted pull beats a token that silently stops working because we could not read a date.
    p_connections([{"id": "lent", "refresh": None, "expires": "not-a-date"}])
    assert lcr.lent_connections_needing_a_pull() == ["lent"]


def test_a_missing_expiry_is_treated_as_due(p_connections):
    p_connections([{"id": "lent", "refresh": None, "expires": None}])
    assert lcr.lent_connections_needing_a_pull() == ["lent"]


def test_only_the_due_lent_ones_are_selected_out_of_a_mixed_set(p_connections):
    p_connections([
        {"id": "mine", "refresh": "rt", "expires": p_iso(10)},
        {"id": "lent-fresh", "refresh": None, "expires": p_iso(4 * 3600)},
        {"id": "lent-due", "refresh": None, "expires": p_iso(60)},
        {"id": "lent-dead", "refresh": None, "expires": p_iso(-99)},
    ])
    assert lcr.lent_connections_needing_a_pull() == ["lent-due", "lent-dead"]


@pytest.mark.asyncio
async def test_a_due_connection_gets_pulled(p_connections, p_pull):
    p_connections([{"id": "lent", "refresh": None, "expires": p_iso(-1)}])
    calls = p_pull("refreshed")
    assert await lcr.refresh_lent_credentials() == 1
    assert calls == ["lent"]


@pytest.mark.asyncio
async def test_nothing_due_means_no_router_restart(p_connections, p_pull):
    p_connections([{"id": "lent", "refresh": None, "expires": p_iso(6 * 3600)}])
    calls = p_pull("refreshed")
    assert await lcr.refresh_lent_credentials() == 0
    assert calls == [], "a pull rewrites db.json and bounces the router; do not do it for nothing"


@pytest.mark.asyncio
async def test_an_offline_pull_fails_without_raising(p_connections, p_pull):
    # Being offline is normal. It must not take the loop down, and it must not be silent either.
    p_connections([{"id": "lent", "refresh": None, "expires": p_iso(-1)}])
    p_pull("cloud_rejected")
    assert await lcr.refresh_lent_credentials() == 0


@pytest.mark.asyncio
async def test_one_dead_connection_does_not_block_the_others(p_connections, p_pull):
    p_connections([
        {"id": "a", "refresh": None, "expires": p_iso(-1)},
        {"id": "b", "refresh": None, "expires": p_iso(-1)},
    ])
    calls = p_pull("cloud_rejected", "refreshed")
    assert await lcr.refresh_lent_credentials() == 1
    assert calls == ["a", "b"]


@pytest.mark.asyncio
async def test_a_signed_out_user_is_reported_not_retried_into_a_storm(p_connections, p_pull, caplog):
    p_connections([{"id": "lent", "refresh": None, "expires": p_iso(-1)}])
    p_pull("not_signed_in")
    assert await lcr.refresh_lent_credentials() == 0


@pytest.mark.asyncio
async def test_a_failure_never_writes_a_token_into_the_log(monkeypatch):
    # Not caplog: backend/main.py pins propagate=False on the 'backend' logger and caplog listens
    # at the root, so these records only exist if you sit on the logger itself.
    import io
    import logging

    # A distinctive secret, so this cannot pass by luck.
    secret = "sk-ant-oat01-NEVER-LOG-ME-9f3c2b"
    monkeypatch.setattr(
        lcr.credential_store,
        "list_oauth_connection_ids",
        lambda: ["lent"],
    )
    monkeypatch.setattr(
        lcr.credential_store,
        "read_credential",
        lambda cid: ProviderCredential(
            connection_id="lent", provider="claude", access_token=secret,
            refresh_token=None, expires_at=p_iso(-1),
        ),
    )

    async def leaky(connection_id: str) -> LeaseOutcome:
        return LeaseOutcome(status="cloud_rejected", detail="HTTP 500")

    monkeypatch.setattr(lcr.credential_lease, "pull_access_token", leaky)
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setLevel(logging.WARNING)
    lcr.logger.addHandler(handler)
    try:
        await lcr.refresh_lent_credentials()
    finally:
        lcr.logger.removeHandler(handler)

    written = buf.getvalue()
    assert secret not in written, "the access token must never reach a log line"
    assert "lent" in written, "but which connection failed has to be diagnosable"


# The join. Everything above passes even if nothing ever runs the loop, which is exactly how
# lease_to_cloud sat unwired for its whole life.

@pytest.mark.asyncio
async def test_the_cloud_subsystem_actually_starts_the_refresh_loop(monkeypatch):
    import asyncio

    from backend.apps.workflows.cloud import routes

    started = asyncio.Event()

    async def fake_loop():
        started.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(routes, "lent_credential_loop", fake_loop)

    async with routes.cloud_workflows_lifespan():
        await asyncio.wait_for(started.wait(), timeout=2.0)


@pytest.mark.asyncio
async def test_shutting_the_subsystem_down_stops_the_loop(monkeypatch):
    import asyncio

    from backend.apps.workflows.cloud import routes

    running = asyncio.Event()
    cancelled = asyncio.Event()

    async def fake_loop():
        running.set()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(routes, "lent_credential_loop", fake_loop)

    async with routes.cloud_workflows_lifespan():
        await asyncio.wait_for(running.wait(), timeout=2.0)
    await asyncio.sleep(0)
    assert cancelled.is_set(), "a leaked task would keep bouncing the router after shutdown"


# Revocation, restart and network interruption. These are the states a long-lived lease actually
# meets in the wild, and each has a distinct right answer: revocation must stop trying and say so,
# a restart must resume without a second holder appearing, and a dropped network must back off
# instead of bouncing the router every two minutes.

@pytest.mark.asyncio
async def test_a_revoked_credential_stops_the_pull_instead_of_hammering(p_connections, p_pull):
    """Anthropic revokes the whole grant family on a replayed refresh token. Once that has happened
    no amount of retrying helps, so the pull must fail cleanly rather than spin."""
    p_connections([{"id": "revoked", "refresh": None, "expires": p_iso(-1)}])
    calls = p_pull("cloud_rejected")
    assert await lcr.refresh_lent_credentials() == 0
    assert calls == ["revoked"], "one attempt per pass, not a retry storm inside one pass"


@pytest.mark.asyncio
async def test_a_revoked_credential_is_still_reported_every_pass(p_connections, p_pull):
    # It stays due, so the next pass tries again. That is deliberate: the user may reconnect.
    p_connections([{"id": "revoked", "refresh": None, "expires": p_iso(-1)}])
    p_pull("cloud_rejected", "cloud_rejected")
    await lcr.refresh_lent_credentials()
    assert lcr.lent_connections_needing_a_pull() == ["revoked"], "still due, so recovery is possible"


@pytest.mark.asyncio
async def test_a_restart_re_reads_custody_from_disk_and_never_assumes(p_connections, p_pull):
    """The loop keeps no state across a restart. Whether a connection is lent is re-derived from
    db.json every pass, so a backend that restarts mid-lease cannot decide it owns something the
    cloud is holding."""
    install = p_connections
    install([{"id": "c", "refresh": None, "expires": p_iso(-1)}])
    calls = p_pull("refreshed")
    assert await lcr.refresh_lent_credentials() == 1

    # The release lands while we are down: the token is back on disk. Nothing cached may override it.
    install([{"id": "c", "refresh": "restored-rt", "expires": p_iso(-1)}])
    assert lcr.lent_connections_needing_a_pull() == [], "device owns it again, so hands off"
    assert await lcr.refresh_lent_credentials() == 0
    assert calls == ["c"], "no second pull after custody came home"


@pytest.mark.asyncio
async def test_a_dropped_network_backs_off_instead_of_bouncing_the_router(p_connections, monkeypatch):
    """Every pull rewrites db.json, which stops and restarts 9Router. On a dead network the loop
    must widen its interval, or an offline laptop restarts the router every two minutes forever."""
    p_connections([{"id": "c", "refresh": None, "expires": p_iso(-1)}])

    async def offline(connection_id: str) -> LeaseOutcome:
        return LeaseOutcome(status="cloud_rejected", detail="ConnectError")

    monkeypatch.setattr(lcr.credential_lease, "pull_access_token", offline)

    import asyncio
    delays: list[float] = []

    async def capture(d):
        delays.append(d)
        raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "sleep", capture)
    with pytest.raises(asyncio.CancelledError):
        await lcr.lent_credential_loop()

    assert delays == [lcr.FAILURE_BACKOFF_S], f"expected the long backoff, got {delays}"
    assert lcr.FAILURE_BACKOFF_S > lcr.CHECK_INTERVAL_S * 4, "backoff has to be meaningfully longer"


@pytest.mark.asyncio
async def test_a_healthy_pass_keeps_the_normal_cadence(p_connections, p_pull, monkeypatch):
    p_connections([{"id": "c", "refresh": None, "expires": p_iso(-1)}])
    p_pull("refreshed")

    import asyncio
    delays: list[float] = []

    async def capture(d):
        delays.append(d)
        raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "sleep", capture)
    with pytest.raises(asyncio.CancelledError):
        await lcr.lent_credential_loop()

    assert delays == [lcr.CHECK_INTERVAL_S], "a success must not punish the next check"


@pytest.mark.asyncio
async def test_an_unexpected_exception_never_kills_the_loop(p_connections, monkeypatch):
    """A loop that dies on one bad pass leaves the device unable to renew, silently, forever."""
    p_connections([{"id": "c", "refresh": None, "expires": p_iso(-1)}])

    async def boom(connection_id: str) -> LeaseOutcome:
        raise RuntimeError("disk full")

    monkeypatch.setattr(lcr.credential_lease, "pull_access_token", boom)

    import asyncio
    delays: list[float] = []

    async def capture(d):
        delays.append(d)
        raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "sleep", capture)
    with pytest.raises(asyncio.CancelledError):
        await lcr.lent_credential_loop()

    assert delays == [lcr.FAILURE_BACKOFF_S], "it survived and backed off"


@pytest.mark.asyncio
async def test_two_passes_overlapping_do_not_pull_the_same_connection_twice(p_connections, monkeypatch):
    """The loop is one task, but a manual refresh and a scheduled pass can overlap. Each pull
    rewrites db.json and bounces the router, so a duplicate is not merely wasteful: two writers
    racing the same file is how an edit gets lost."""
    import asyncio

    install = p_connections
    install([{"id": "c", "refresh": None, "expires": p_iso(-1)}])
    inflight = 0
    peak = 0

    async def slow_pull(connection_id: str) -> LeaseOutcome:
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        await asyncio.sleep(0.05)
        # A real pull ends with the device owning a fresh token, so the row stops being due.
        install([{"id": "c", "refresh": None, "expires": p_iso(3 * 3600)}])
        inflight -= 1
        return LeaseOutcome(status="refreshed")

    monkeypatch.setattr(lcr.credential_lease, "pull_access_token", slow_pull)

    await asyncio.gather(lcr.refresh_lent_credentials(), lcr.refresh_lent_credentials())
    assert peak <= 1, f"{peak} pulls were in flight at once for the same connection"


@pytest.mark.asyncio
async def test_a_second_pass_after_a_successful_pull_is_a_no_op(p_connections, p_pull):
    """Idempotency in the shape it actually occurs: once a pull lands, the connection is no longer
    due, so the next pass must not touch it again."""
    install = p_connections
    install([{"id": "c", "refresh": None, "expires": p_iso(-1)}])
    calls = p_pull("refreshed")
    assert await lcr.refresh_lent_credentials() == 1

    install([{"id": "c", "refresh": None, "expires": p_iso(4 * 3600)}])
    assert await lcr.refresh_lent_credentials() == 0
    assert calls == ["c"], "a fresh token must not be pulled again"
