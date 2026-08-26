"""The backend's https trust follows the OS store on desktop platforms, and still fails closed.

Sign-in on Windows ThinkPads died with `unable to get local issuer certificate`: an endpoint tool's
root sat in the Windows store, the browser trusted it, and certifi (the only store httpx read) had
never heard of it. These pin that the OS store is armed before any client exists, that a failure to
arm is said out loud, and that a certificate nobody trusts is still refused with the OS store on.
"""

import datetime
import http.server
import logging
import platform
import ssl
import threading
from pathlib import Path

import httpx
import pytest
import truststore

from backend.config.os_trust import install_os_trust

P_REPO = Path(__file__).resolve().parents[2]

@pytest.fixture
def p_trust_logs():
    """Capture os_trust's own records, not root's.

    `backend/main.py` sets `logging.getLogger("backend").propagate = False`, so once ANY test has
    imported the app (every TestClient one does) caplog sees nothing here and these two liveness
    assertions fail purely on test order. Attaching to the logger itself makes them independent of
    whatever else configured logging; a guard test that goes green when the guard is silent would
    defeat its own purpose.
    """
    p_records: list = []

    class P_Sink(logging.Handler):
        def emit(self, record) -> None:
            p_records.append(record)

    p_logger = logging.getLogger("backend.config.os_trust")
    p_sink = P_Sink()
    p_prev = p_logger.level
    p_logger.addHandler(p_sink)
    p_logger.setLevel(logging.DEBUG)
    try:
        yield p_records
    finally:
        p_logger.removeHandler(p_sink)
        p_logger.setLevel(p_prev)




@pytest.fixture
def stock_ssl_afterwards():
    yield
    truststore.extract_from_ssl()


def test_desktop_platforms_arm_the_os_store_in_the_factory_httpx_calls(monkeypatch, stock_ssl_afterwards):
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    assert install_os_trust() == "os-store"
    # httpx builds its verify context with ssl.create_default_context(); that is the call that must change.
    assert type(ssl.create_default_context()) is truststore.SSLContext


def test_off_desktop_certifi_stays_and_says_so(monkeypatch, p_trust_logs):
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    before = ssl.SSLContext
    assert install_os_trust() == "certifi"
    assert ssl.SSLContext is before
    assert any("certifi bundle" in r.getMessage() for r in p_trust_logs)


def test_a_store_that_cannot_arm_is_reported_not_swallowed(monkeypatch, p_trust_logs):
    monkeypatch.setattr(platform, "system", lambda: "Darwin")

    def p_boom() -> None:
        raise OSError("Security.framework missing")

    monkeypatch.setattr(truststore, "inject_into_ssl", p_boom)
    assert install_os_trust() == "certifi"
    warned = [r for r in p_trust_logs if r.levelno == logging.WARNING]
    assert warned and "certifi bundle only" in warned[0].getMessage()


def p_self_signed_pem(tmp_path: Path) -> Path:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(__import__("ipaddress").ip_address("127.0.0.1"))]), critical=False)
        .sign(key, hashes.SHA256())
    )
    pem = tmp_path / "nobody-trusts-me.pem"
    pem.write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        + cert.public_bytes(serialization.Encoding.PEM)
    )
    return pem


class P_QuietHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"hello")

    def log_message(self, *args) -> None:
        pass


class P_QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        pass


@pytest.mark.skipif(platform.system() not in ("Darwin", "Windows"), reason="the OS store hook only arms on desktop platforms")
def test_the_os_store_still_refuses_a_certificate_nobody_trusts(tmp_path, stock_ssl_afterwards):
    pem = p_self_signed_pem(tmp_path)
    server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_ctx.load_cert_chain(pem)
    server = P_QuietServer(("127.0.0.1", 0), P_QuietHandler)
    server.socket = server_ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"https://127.0.0.1:{server.server_address[1]}/"
    try:
        assert install_os_trust() == "os-store"
        with pytest.raises(httpx.ConnectError):
            httpx.get(url, timeout=5)
        # Control: the server is really up, so the refusal above was verification and not a dead port.
        assert httpx.get(url, timeout=5, verify=False).text == "hello"
    finally:
        server.shutdown()


def test_main_arms_os_trust_before_the_first_app_import():
    """A client built at import time would keep the stock context forever, so the arming has to come
    before any backend.apps module loads. Index order in the source is the assertion."""
    src = (P_REPO / "backend" / "main.py").read_text()
    assert "install_os_trust()" in src, "backend/main.py never arms the OS trust store"
    assert src.index("install_os_trust()") < src.index("from backend.apps"), "OS trust is armed after an app import"
