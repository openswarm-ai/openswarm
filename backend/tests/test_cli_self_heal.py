"""Putting the bundled runtime back, instead of asking the user to (ENG-422).

Every case here is the real failure simulated on disk: a quarantined binary is just a missing file,
and an installer package is just a zip, so the whole repair is exercisable on any platform even
though the class has only ever been seen on Windows."""

import os
import zipfile

import pytest

from backend.apps.agents.core import cli_self_heal as heal

MEMBER = "lib/net45/resources/python-env/Lib/site-packages/claude_agent_sdk/_bundled/claude.exe"
SUFFIX = "_bundled/claude.exe"


@pytest.fixture(autouse=True)
def p_fast(monkeypatch):
    """The re-take check is a real sleep in production; tests must not pay for it."""
    monkeypatch.setattr(heal, "RETAKEN_CHECK_SECONDS", 0.01)


def p_package(dirpath, body=b"PRISTINE-RUNTIME", name="openswarm-1.7.9-full.nupkg", member=MEMBER):
    p = os.path.join(dirpath, name)
    with zipfile.ZipFile(p, "w") as z:
        z.writestr(member, body)
    return p


def test_it_restores_the_binary_from_the_installer_package(tmp_path):
    cache = tmp_path / "packages"; cache.mkdir()
    p_package(str(cache))
    dest = tmp_path / "site-packages" / "claude_agent_sdk" / "_bundled" / "claude.exe"
    r = heal.repair_bundled_cli(str(dest), SUFFIX, [str(cache)])
    assert r.repaired and not r.retaken
    assert dest.read_bytes() == b"PRISTINE-RUNTIME"
    assert "restored" in r.detail


def test_a_restore_that_is_undone_is_NOT_reported_as_a_fix(tmp_path, monkeypatch):
    """The half that matters. Antivirus re-takes the file seconds later; calling that a repair sends
    the user back to a broken app believing it works."""
    cache = tmp_path / "packages"; cache.mkdir()
    p_package(str(cache))
    dest = tmp_path / "_bundled" / "claude.exe"

    p_real_sleep = heal.time.sleep

    def p_quarantine(_):
        p_real_sleep(0)
        if os.path.isfile(dest):
            os.remove(dest)          # the scanner takes it back
    monkeypatch.setattr(heal.time, "sleep", p_quarantine)

    r = heal.repair_bundled_cli(str(dest), SUFFIX, [str(cache)])
    assert r.repaired and r.retaken, "a re-taken file must say so"
    assert "exclusion" in r.detail, "and must name what would actually make it stay"


def test_no_package_on_disk_says_reinstall_rather_than_failing_silently(tmp_path):
    empty = tmp_path / "packages"; empty.mkdir()
    dest = tmp_path / "_bundled" / "claude.exe"
    r = heal.repair_bundled_cli(str(dest), SUFFIX, [str(empty)])
    assert not r.repaired and "reinstall" in r.detail
    assert not dest.exists()


def test_it_prefers_the_NEWEST_package(tmp_path):
    """An older package holds an older binary; restoring that silently turns one bug into a version
    mismatch nobody would think to look for."""
    cache = tmp_path / "packages"; cache.mkdir()
    old = p_package(str(cache), b"OLD-RUNTIME", "openswarm-1.7.8-full.nupkg")
    new = p_package(str(cache), b"NEW-RUNTIME", "openswarm-1.7.9-full.nupkg")
    os.utime(old, (1, 1))
    os.utime(new, (10_000_000, 10_000_000))
    dest = tmp_path / "_bundled" / "claude.exe"
    r = heal.repair_bundled_cli(str(dest), SUFFIX, [str(cache)])
    assert dest.read_bytes() == b"NEW-RUNTIME", "restored the stale copy"
    assert r.source == new


def test_a_package_without_the_binary_is_skipped_not_trusted(tmp_path):
    cache = tmp_path / "packages"; cache.mkdir()
    p_package(str(cache), b"irrelevant", "openswarm-1.7.9-full.nupkg", member="lib/net45/README.txt")
    good = p_package(str(cache), b"PRISTINE-RUNTIME", "openswarm-1.7.9-delta.nupkg")
    os.utime(good, (1, 1))
    dest = tmp_path / "_bundled" / "claude.exe"
    r = heal.repair_bundled_cli(str(dest), SUFFIX, [str(cache)])
    assert r.repaired and r.source == good


def test_a_corrupt_package_does_not_take_the_repair_down_with_it(tmp_path):
    cache = tmp_path / "packages"; cache.mkdir()
    (cache / "openswarm-broken.nupkg").write_bytes(b"not a zip at all")
    good = p_package(str(cache), b"PRISTINE-RUNTIME", "openswarm-ok.nupkg")
    os.utime(good, (1, 1))
    dest = tmp_path / "_bundled" / "claude.exe"
    assert heal.repair_bundled_cli(str(dest), SUFFIX, [str(cache)]).repaired
    assert dest.read_bytes() == b"PRISTINE-RUNTIME"


def test_a_present_binary_is_never_overwritten(tmp_path):
    """The innocent case: this runs on a healthy install too, and must not clobber a good file with
    an older packaged one."""
    cache = tmp_path / "packages"; cache.mkdir()
    p_package(str(cache), b"PACKAGED")
    dest = tmp_path / "_bundled" / "claude.exe"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"LIVE-AND-FINE")
    r = heal.repair_bundled_cli(str(dest), SUFFIX, [str(cache)])
    assert not r.repaired and dest.read_bytes() == b"LIVE-AND-FINE"


@pytest.mark.asyncio
async def test_detection_actually_CALLS_the_repair(monkeypatch):
    """A repair nothing calls is this codebase's recurring defect: present, reachable, doing nothing.
    Detection already existed and left 22 of 25 installs dead precisely because nothing acted on it.

    Behavioural, not a grep: an earlier version of this test asserted the NAME appeared in the
    source, and passed happily when the call was replaced with a raise."""
    import backend.apps.agents.core.bundled_cli_missing as det
    import backend.apps.agents.core.cli_self_heal as sh
    from backend.apps.agents.agents import subscriptions_health

    called = {}
    monkeypatch.setattr(det, "bundled_cli_missing", lambda: "/gone/claude.exe")
    def p_fake(dest, *a, **k):
        called["dest"] = dest
        return sh.RepairResult(repaired=True, detail="restored in the test")
    monkeypatch.setattr(sh, "repair_bundled_cli", p_fake)
    monkeypatch.setattr("backend.apps.nine_router.is_running", lambda: False)

    out = await subscriptions_health()
    assert called.get("dest") == "/gone/claude.exe", "the repair was never attempted"
    assert out.get("cli_repair") == "restored in the test", "the endpoint hid what the repair did"


def test_the_repair_never_heals_in_silence():
    """Every return path of the health endpoint carries what the repair did. A fix the user is not
    told about is indistinguishable from a flaky app that broke and un-broke itself."""
    src = open("backend/apps/agents/agents.py", encoding="utf-8").read()
    i = src.index("async def subscriptions_health")
    body = src[i:src.index("@agents.router", i + 10)]
    returns = [ln for ln in body.splitlines() if "return {" in ln and "cli_missing" in ln]
    assert returns, "the health endpoint stopped reporting cli_missing"
    for ln in returns:
        assert "cli_repair" in ln, f"a return path hides the repair: {ln.strip()[:80]}"


@pytest.mark.asyncio
async def test_a_MIDSESSION_quarantine_repairs_instead_of_carding(monkeypatch, tmp_path):
    """Boot-time repair only covers a quarantine that happened while the app was closed. The one
    that happens while someone is working still ended the turn with an antivirus card, which is the
    exact moment Kittie was in."""
    import backend.apps.agents.manager.run.handle_run_error as hre
    import backend.apps.agents.core.bundled_cli_missing as det
    import backend.apps.agents.core.cli_self_heal as sh
    from backend.apps.agents.core.models import AgentSession

    monkeypatch.setattr(det, "bundled_cli_missing", lambda: "/gone/claude.exe")
    monkeypatch.setattr(sh, "repair_bundled_cli",
                        lambda dest, *a, **k: sh.RepairResult(repaired=True, detail="restored"))
    sent = []
    async def p_send(sid, ev, payload): sent.append(payload)
    monkeypatch.setattr(hre.ws_manager, "send_to_session", p_send)

    s = AgentSession(name="t", model="opus-5")
    assert await hre.p_try_runtime_repair(s, "sess") is True
    assert sent and "restored" in str(sent[-1]).lower()
    assert "send that message again" in str(sent[-1]).lower(), "tell them what to do next"


@pytest.mark.asyncio
async def test_a_repair_that_does_not_stick_lets_the_card_stand(monkeypatch):
    """The ambiguous outcomes must NOT suppress the card: a half-repair that reads as success is
    worse than the card, because the user retries into the same wall with no explanation."""
    import backend.apps.agents.manager.run.handle_run_error as hre
    import backend.apps.agents.core.bundled_cli_missing as det
    import backend.apps.agents.core.cli_self_heal as sh
    from backend.apps.agents.core.models import AgentSession

    monkeypatch.setattr(det, "bundled_cli_missing", lambda: "/gone/claude.exe")
    for result in (sh.RepairResult(repaired=True, retaken=True, detail="taken again"),
                   sh.RepairResult(repaired=False, detail="no package")):
        monkeypatch.setattr(sh, "repair_bundled_cli", lambda dest, *a, r=result, **k: r)
        assert await hre.p_try_runtime_repair(AgentSession(name="t", model="opus-5"), "sess") is False
