"""Give the Node children the OS roots, because Node ignores the OS trust store.

ENG-407 armed `truststore` so THIS process trusts what the user's browser trusts. That was only the
first wall. 9router and the claude CLI are Node, and Node verifies against its own compiled-in root
list on both Windows and macOS, so on a machine whose endpoint tool or corporate proxy installed a
root, sign-in now succeeds and the first model call still dies with the ENG-218 certificate card
(ENG-408).

`NODE_USE_SYSTEM_CA=1` would make this file unnecessary, and it is the right long-term answer, but it
landed in Node 22.15 and the bundled runtime is v20.18.1 (`scripts/build-app.sh`). So we export the
OS roots to a PEM and point `NODE_EXTRA_CA_CERTS` at it.

Two properties this must have, and both are the reason it is safe to ship:

- **Additive, never substitutive.** `NODE_EXTRA_CA_CERTS` ADDS to Node's bundled roots rather than
  replacing them, so a machine that works today cannot be broken by this. Trust becomes "what Node
  shipped, plus what this machine's own OS store already trusts", and nothing wider.
- **Fails to today's behaviour.** Any failure (no export, empty export, unwritable path) leaves the
  variable unset, which is exactly the current build. A guard that cannot arm says so and gets out of
  the way; it never guesses.
"""

import logging
import os
import platform
import subprocess
from typing import List, Optional

from typeguard import typechecked

logger = logging.getLogger(__name__)

# Linux Node already reads OpenSSL's default paths, which is the system store there.
NEEDS_EXPORT = frozenset({"Darwin", "Windows"})

# macOS keeps the shipped roots and the admin-installed ones in different keychains, and an endpoint
# tool can land in either. The user's login keychain is included because that is where a per-user
# proxy root goes.
P_MAC_KEYCHAINS = (
    "/System/Library/Keychains/SystemRootCertificates.keychain",
    "/Library/Keychains/System.keychain",
)

PEM_HEADER = "-----BEGIN CERTIFICATE-----"
# A store this size is a sign we read something that is not a root list; refuse rather than hand Node
# a multi-megabyte file to parse on every spawn.
MAX_CERTS = 1000


@typechecked
def p_mac_roots() -> List[str]:
    """Every PEM block in the system keychains plus the user's login keychain."""
    p_out: List[str] = []
    p_chains = list(P_MAC_KEYCHAINS)
    p_login = os.path.expanduser("~/Library/Keychains/login.keychain-db")
    if os.path.exists(p_login):
        p_chains.append(p_login)
    for chain in p_chains:
        if not os.path.exists(chain):
            continue
        try:
            r = subprocess.run(
                ["security", "find-certificate", "-a", "-p", chain],
                capture_output=True, text=True, timeout=20,
            )
        except Exception as e:
            logger.debug("node trust: could not read %s (%s)", chain, e)
            continue
        if r.returncode == 0 and PEM_HEADER in r.stdout:
            p_out.append(r.stdout)
    return p_out


@typechecked
def p_windows_roots() -> List[str]:
    """The Windows ROOT and CA stores, via stdlib; no shelling out and no extra dependency."""
    import ssl
    p_out: List[str] = []
    # enum_certificates exists only on Windows, so it is fetched by name; a checker on any other
    # platform is right that the attribute is absent, and this function never runs there.
    p_enum = getattr(ssl, "enum_certificates", None)
    if p_enum is None:
        return p_out
    for store in ("ROOT", "CA"):
        try:
            for cert, enc, p_trust in p_enum(store):
                if enc == "x509_asn" and p_trust:
                    p_out.append(ssl.DER_cert_to_PEM_cert(cert))
        except Exception as e:
            logger.debug("node trust: could not read the %s store (%s)", store, e)
    return p_out


@typechecked
def export_os_roots(dest: str) -> Optional[str]:
    """Write the OS roots to `dest` and return the path, or None when there is nothing to hand Node.

    None is the safe answer everywhere: the caller leaves NODE_EXTRA_CA_CERTS unset, and Node keeps
    exactly the roots it ships with, which is what every build does today.
    """
    system = platform.system()
    if system not in NEEDS_EXPORT:
        return None
    p_blocks = p_mac_roots() if system == "Darwin" else p_windows_roots()
    p_pem = "\n".join(b.strip() for b in p_blocks if b.strip())
    p_count = p_pem.count(PEM_HEADER)
    if p_count == 0:
        logger.warning(
            "node trust: read no roots out of the %s store, so 9router and the CLI keep Node's "
            "bundled roots only; a proxy or security-tool root will still be refused by them", system,
        )
        return None
    if p_count > MAX_CERTS:
        logger.warning("node trust: %d certificates is not a root list; refusing to export", p_count)
        return None
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(p_pem + "\n")
    except Exception as e:
        logger.warning(
            "node trust: could not write %s (%s); 9router and the CLI keep Node's bundled roots only",
            dest, e,
        )
        return None
    logger.info("node trust: exported %d OS roots for the Node children -> %s", p_count, dest)
    return dest


# Exported once per process. Every spawn used to shell out to `security find-certificate` and rewrite
# ~250KB; measured three times in five seconds on one turn. The OS store does not change mid-session,
# and if a user installs a root while the app is open, a restart picks it up -- the same contract
# truststore already has for this process.
P_CACHED: Optional[dict] = None


@typechecked
def node_ca_env(dest: str) -> dict:
    """`{NODE_EXTRA_CA_CERTS: <path>}` when there is something to add, else `{}`.

    Returning a dict rather than mutating os.environ keeps this out of the parent process: the
    backend's own TLS is truststore's job, and two mechanisms for one concern is how they drift.
    """
    global P_CACHED
    if P_CACHED is not None:
        return dict(P_CACHED)
    p_path = export_os_roots(dest)
    P_CACHED = {"NODE_EXTRA_CA_CERTS": p_path} if p_path else {}
    return dict(P_CACHED)


@typechecked
def reset_cache_for_test() -> None:
    global P_CACHED
    P_CACHED = None
