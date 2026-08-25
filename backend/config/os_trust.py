"""Route every outbound TLS verification in this process through the OS trust store.

httpx, and everything built on it, verifies against certifi's bundled CA file, which never sees a
root that an endpoint security tool or a corporate proxy installed into the Windows or macOS store.
Chromium and the updater honor those roots, so the app looks healthy while the Python backend refuses
every https call it makes: sign-in, the cloud, telemetry. Arming the OS store here, before any client
exists, makes the backend trust exactly what the user's browser trusts and nothing more; an untrusted,
self-signed or expired certificate still fails closed.
"""

import logging
import platform
import ssl
from typing import Literal

from typeguard import typechecked

logger = logging.getLogger(__name__)

TrustSource = Literal["os-store", "certifi"]

# Linux keeps certifi: truststore there only reads OpenSSL's default paths, which a bare container may not have.
P_OS_STORE_PLATFORMS = frozenset({"Darwin", "Windows"})


@typechecked
def install_os_trust() -> TrustSource:
    system = platform.system()
    if system not in P_OS_STORE_PLATFORMS:
        logger.info("tls trust: certifi bundle (%s has no OS store hook)", system)
        return "certifi"
    try:
        import truststore
        truststore.inject_into_ssl()
        # The factory httpx calls must hand back the OS-store class, or "armed" would be a lie.
        if type(ssl.create_default_context()) is not truststore.SSLContext:
            raise RuntimeError("ssl.create_default_context() still builds the stock SSLContext")
    except Exception as e:
        logger.warning(
            "tls trust: OS store unavailable on %s (%s); https from this process trusts the certifi bundle only, so a proxy or security-tool root will be refused",
            system, e,
        )
        return "certifi"
    logger.info("tls trust: OS store on %s", system)
    return "os-store"
