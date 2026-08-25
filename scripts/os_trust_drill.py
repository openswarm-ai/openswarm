#!/usr/bin/env python3
"""Closed-loop drill for ENG-407: does this machine's Python trust what its OS trusts, and does sign-in reach the cloud?

  mint <dir>      write root.pem and leaf.pem (SAN localhost + 127.0.0.1) signed under that root
  verify <dir>    serve leaf.pem on 127.0.0.1; stock certifi MUST refuse it, the armed backend trust MUST accept it
                  (the workflow installed root.pem into the OS store first), and https://api.openswarm.com MUST verify armed
  signin <mode>   POST the real /api/auth/signin-activate (no lifespan) with a junk token:
                    armed             -> a 4xx FROM THE CLOUD (TLS passed, the service answered our junk token)
                    armed-foreign-ca  -> still a cloud 4xx with SSL_CERT_FILE pointing at a CA file that cannot verify anything;
                                         only the OS store can have done the verifying
                    stock-foreign-ca  -> 502 CERTIFICATE_VERIFY_FAILED, the field failure reproduced on demand
Exit 0 only when every direction holds; every assertion prints what it saw.
"""

import datetime
import http.server
import ipaddress
import os
import ssl
import sys
import tempfile
import threading
from pathlib import Path

CLOUD = "https://api.openswarm.com/api/health"


def p_say(ok: bool, what: str) -> None:
    print(("PASS  " if ok else "FAIL  ") + what, flush=True)
    if not ok:
        sys.exit(1)


def p_mint(out: Path) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.datetime.now(datetime.timezone.utc)
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "OpenSwarm ENG-407 throwaway drill root")])
    root = (
        x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name).public_key(root_key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False, key_encipherment=False, data_encipherment=False, key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()), critical=False)
        .sign(root_key, hashes.SHA256())
    )
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf = (
        x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])).issuer_name(root_name)
        .public_key(leaf_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), critical=False)
        .sign(root_key, hashes.SHA256())
    )
    out.mkdir(parents=True, exist_ok=True)
    (out / "root.pem").write_bytes(root.public_bytes(serialization.Encoding.PEM))
    (out / "leaf.pem").write_bytes(
        leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        + leaf.public_bytes(serialization.Encoding.PEM)
        + root.public_bytes(serialization.Encoding.PEM)
    )
    print(f"minted {out / 'root.pem'} and {out / 'leaf.pem'}")


class P_Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"hello")

    def log_message(self, *args) -> None:
        pass


class P_Server(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        pass


def p_serve(leaf: Path) -> str:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(leaf)
    server = P_Server(("127.0.0.1", 0), P_Handler)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"https://localhost:{server.server_address[1]}/"


def p_get(url: str) -> str:
    import httpx
    try:
        r = httpx.get(url, timeout=15)
        return f"HTTP {r.status_code}"
    except Exception as e:
        return f"{type(e).__name__}: {str(e)[:160]}"


def p_verify(d: Path) -> None:
    import platform
    url = p_serve(d / "leaf.pem")
    stock = p_get(url)
    p_say("HTTP" not in stock, f"stock certifi refuses the OS-only root: {stock}")
    from backend.config.os_trust import install_os_trust
    source = install_os_trust()
    p_say(source == "os-store", f"backend trust armed on {platform.system()}: {source}")
    armed = p_get(url)
    p_say(armed == "HTTP 200", f"armed backend trust accepts a leaf under the root the OS trusts: {armed}")
    cloud = p_get(CLOUD)
    p_say(cloud.startswith("HTTP"), f"armed backend trust verifies the sign-in service: {cloud}")


def p_signin(mode: str) -> None:
    data_root = tempfile.mkdtemp(prefix="osw-drill-")
    os.environ["OPENSWARM_DATA_ROOT"] = data_root
    os.environ["OPENSWARM_HEADLESS"] = "1"
    if mode.endswith("foreign-ca"):
        foreign = Path(data_root) / "foreign-ca"
        p_mint(foreign)
        os.environ["SSL_CERT_FILE"] = str(foreign / "root.pem")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import backend.main as main
    if mode.startswith("stock"):
        import truststore
        truststore.extract_from_ssl()
    from fastapi.testclient import TestClient
    r = TestClient(main.app).post("/api/auth/signin-activate", json={"token": "drill-" * 8, "signin_method": "google"})
    detail = str(r.json().get("detail", ""))[:200] if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]
    seen = f"{mode}: HTTP {r.status_code} {detail}"
    if mode.startswith("stock"):
        p_say(r.status_code == 502 and "CERTIFICATE_VERIFY_FAILED" in detail, "field failure reproduced, " + seen)
    else:
        # A junk token earns a 4xx FROM THE CLOUD; the failure being drilled is our own 502 before any byte reached it.
        p_say(r.status_code in (400, 401) and "Could not reach" not in detail, "sign-in reached the cloud over TLS, " + seen)


if __name__ == "__main__":
    cmd, arg = (sys.argv + [None, None])[1:3]
    if cmd == "mint" and arg:
        p_mint(Path(arg))
    elif cmd == "verify" and arg:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        p_verify(Path(arg))
    elif cmd == "signin" and arg in ("armed", "armed-foreign-ca", "stock-foreign-ca"):
        p_signin(arg)
    else:
        print(__doc__)
        sys.exit(2)
