"""The Node children get the OS roots, because Node ignores the OS trust store.

ENG-407 armed truststore so the PYTHON backend trusts what the browser trusts. 9router and the claude
CLI are Node and verify against Node's compiled-in list, so on a machine with an endpoint tool's or a
corporate proxy's root, sign-in now works and the first model call still dies (ENG-408).

`NODE_USE_SYSTEM_CA=1` would make the whole file unnecessary; it landed in Node 22.15 and the bundled
runtime is v20.18.1, so we export the OS roots and point NODE_EXTRA_CA_CERTS at them.

DRILLED 2026-08-27 against a real Node TLS server signed by a throwaway root:
    stock Node                      -> REFUSED UNABLE_TO_VERIFY_LEAF_SIGNATURE   (the ThinkPad bug)
    NODE_EXTRA_CA_CERTS incl. root  -> OK 200                                    (the cure)
    NODE_EXTRA_CA_CERTS OS-only     -> REFUSED                                   (trust not widened)
"""

import os
import platform

import pytest

from backend.config import node_trust


@pytest.fixture(autouse=True)
def p_no_cache():
    """The export is cached once per process; a cached answer would make every case below a no-op."""
    node_trust.reset_cache_for_test()
    yield
    node_trust.reset_cache_for_test()

ROUTER = "backend/apps/nine_router/process.py"
CLI = "backend/apps/agents/manager/configure_provider_env.py"


def test_an_export_that_yields_nothing_sets_no_variable(tmp_path, monkeypatch):
    """Fail to today's behaviour. An unset variable is Node's bundled roots, which is every build
    before this; a broken export must never be louder than that."""
    monkeypatch.setattr(node_trust, "p_mac_roots", lambda: [])
    monkeypatch.setattr(node_trust, "p_windows_roots", lambda: [])
    monkeypatch.setattr(platform, "system", lambda: "Darwin")
    assert node_trust.node_ca_env(str(tmp_path / "r.pem")) == {}


def test_an_unwritable_destination_sets_no_variable(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Darwin")
    monkeypatch.setattr(node_trust, "p_mac_roots", lambda: ["-----BEGIN CERTIFICATE-----\nx\n"])
    assert node_trust.node_ca_env("/proc/nope/cannot/write.pem") == {}


def test_linux_is_left_alone(monkeypatch, tmp_path):
    """Node on Linux already reads OpenSSL's default paths, which IS the system store there."""
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    assert node_trust.export_os_roots(str(tmp_path / "r.pem")) is None


def test_an_absurd_store_is_refused_rather_than_handed_to_node(monkeypatch, tmp_path):
    monkeypatch.setattr(platform, "system", lambda: "Darwin")
    monkeypatch.setattr(node_trust, "p_mac_roots",
                        lambda: ["-----BEGIN CERTIFICATE-----\nx\n" * (node_trust.MAX_CERTS + 1)])
    assert node_trust.export_os_roots(str(tmp_path / "r.pem")) is None


def test_a_real_export_on_this_machine_produces_parseable_pem(tmp_path):
    """Skipped off the two platforms that need it; on them it must produce real certificates."""
    if platform.system() not in node_trust.NEEDS_EXPORT:
        return
    p = node_trust.export_os_roots(str(tmp_path / "roots.pem"))
    assert p and os.path.exists(p)
    body = open(p).read()
    assert body.count(node_trust.PEM_HEADER) > 10, "an OS root store is not this small"
    assert body.count(node_trust.PEM_HEADER) == body.count("-----END CERTIFICATE-----")


def test_both_node_children_are_wired_not_just_one():
    """The recurring defect: a fix applied to one spawn site and not the other. The router and the
    CLI are two separate Node processes and BOTH verify provider TLS."""
    for path in (ROUTER, CLI):
        src = open(path).read()
        assert "node_ca_env" in src, f"{path} spawns Node without the OS roots"


def test_it_is_additive_and_never_replaces_the_env():
    """setdefault, not assignment: a lane that deliberately set its own CA path keeps it, and this
    can never blank a variable someone else needed."""
    src = open(CLI).read()
    i = src.index("node_ca_env(")
    assert "p_env.setdefault(k, v)" in src[i:i + 300]


def test_the_export_happens_once_per_process(monkeypatch, tmp_path):
    """It used to shell out to `security` and rewrite ~250KB on EVERY spawn: measured three times in
    five seconds on one turn."""
    calls = {"n": 0}

    def p_count():
        calls["n"] += 1
        return ["-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n"]

    monkeypatch.setattr(platform, "system", lambda: "Darwin")
    monkeypatch.setattr(node_trust, "p_mac_roots", p_count)
    dest = str(tmp_path / "r.pem")
    a = node_trust.node_ca_env(dest)
    b = node_trust.node_ca_env(dest)
    c = node_trust.node_ca_env(dest)
    assert calls["n"] == 1, f"exported {calls['n']} times"
    assert a == b == c and a


def test_a_failed_export_is_cached_too_and_does_not_retry_every_spawn(monkeypatch, tmp_path):
    """The failure path is the one that would otherwise shell out forever on a machine where the
    store cannot be read at all."""
    calls = {"n": 0}

    def p_empty():
        calls["n"] += 1
        return []

    monkeypatch.setattr(platform, "system", lambda: "Darwin")
    monkeypatch.setattr(node_trust, "p_mac_roots", p_empty)
    dest = str(tmp_path / "r.pem")
    assert node_trust.node_ca_env(dest) == {}
    assert node_trust.node_ca_env(dest) == {}
    assert calls["n"] == 1


def test_the_caller_cannot_mutate_the_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(platform, "system", lambda: "Darwin")
    monkeypatch.setattr(node_trust, "p_mac_roots",
                        lambda: ["-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n"])
    dest = str(tmp_path / "r.pem")
    first = node_trust.node_ca_env(dest)
    first["NODE_EXTRA_CA_CERTS"] = "/tmp/evil.pem"
    assert node_trust.node_ca_env(dest)["NODE_EXTRA_CA_CERTS"] != "/tmp/evil.pem"
