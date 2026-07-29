"""The Windows cookie path, exercised against the real DPAPI on a real Windows machine.

`test_browser_cookies_windows.py` covers the same code with the OS calls mocked, which proves the
branching and nothing about the layout. Every assumption that could actually be wrong is an
agreement with Windows itself:

  - CryptUnprotectData through ctypes/crypt32 (struct layout, the LocalFree, the out-blob copy)
  - the "DPAPI" prefix on the base64 key in Local State
  - AES-256-GCM framing: nonce at [3:15], tag bundled at the tail
  - LOCALAPPDATA resolution for the four Chromium roots

A mock can agree with a wrong belief forever, so these skip everywhere except Windows and are run
by the windows-verify CI job. They build a Local State and a cookie blob with the OS's own
CryptProtectData, then read them back with the shipping code: if our idea of the layout is wrong
the round trip fails, which is exactly the signal that cannot be faked from a Mac.
"""
import base64
import json
import os

import pytest

from backend.apps.onboarding.usage import browser_cookies as bc

pytestmark = pytest.mark.skipif(not bc.IS_WIN, reason="real DPAPI; Windows only")


def p_dpapi_protect(data: bytes) -> bytes:
    """CryptProtectData, the exact mirror of the shipping unprotect. Deliberately written against
    the same ctypes surface so a struct-layout mistake shows up as a failed round trip."""
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    assert ok, "CryptProtectData failed; the test harness itself is broken"
    n = int(blob_out.cbData)
    out = ctypes.create_string_buffer(n)
    ctypes.memmove(out, blob_out.pbData, n)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return out.raw


def test_dpapi_round_trips_through_the_shipping_unprotect():
    secret = os.urandom(32)
    assert bc.win_dpapi_unprotect(p_dpapi_protect(secret)) == secret


def test_unprotecting_garbage_returns_none_rather_than_raising():
    """A corrupt or foreign-user blob must degrade to "no key", never take the process down."""
    assert bc.win_dpapi_unprotect(b"not a dpapi blob") is None


def test_storage_key_is_read_from_a_real_local_state(tmp_path, monkeypatch):
    """Local State holds base64("DPAPI" + protected key). This pins the prefix strip and the
    base64 handling against a file Windows itself produced."""
    key = os.urandom(32)
    root = tmp_path / "User Data"
    root.mkdir()
    (root / "Local State").write_text(json.dumps(
        {"os_crypt": {"encrypted_key": base64.b64encode(b"DPAPI" + p_dpapi_protect(key)).decode()}}),
        encoding="utf-8")
    monkeypatch.setitem(bc.CHROMIUM_ROOTS, "Chrome", str(root))
    assert bc.win_storage_key("Chrome") == key


def test_a_local_state_without_the_dpapi_prefix_is_refused(tmp_path, monkeypatch):
    root = tmp_path / "User Data"
    root.mkdir()
    (root / "Local State").write_text(json.dumps(
        {"os_crypt": {"encrypted_key": base64.b64encode(b"NOPE" + os.urandom(16)).decode()}}),
        encoding="utf-8")
    monkeypatch.setitem(bc.CHROMIUM_ROOTS, "Chrome", str(root))
    assert bc.win_storage_key("Chrome") is None


@pytest.mark.parametrize("version", [b"v10", b"v11"])
def test_a_v10_cookie_decrypts_with_the_windows_gcm_framing(version):
    """The framing claim: nonce at [3:15], ciphertext+tag from [15:]."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key, nonce = os.urandom(32), os.urandom(12)
    blob = version + nonce + AESGCM(key).encrypt(nonce, b"session-token-xyz", None)
    assert bc.decrypt_value(blob, key) == "session-token-xyz"


def test_the_32_byte_domain_hash_prefix_is_stripped():
    """Newer Chromium prepends a 32-byte domain hash inside the plaintext."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key, nonce = os.urandom(32), os.urandom(12)
    plain = os.urandom(32) + b"session-token-xyz"
    blob = b"v10" + nonce + AESGCM(key).encrypt(nonce, plain, None)
    assert bc.decrypt_value(blob, key) == "session-token-xyz"


def test_v20_is_reported_unreachable_rather_than_guessed():
    """App-bound encryption cannot be read without the browser. Saying so is the honest answer;
    returning a wrong string here would silently corrupt a borrowed session."""
    assert bc.decrypt_value(b"v20" + os.urandom(40), os.urandom(32)) is None


def test_the_wrong_key_fails_closed():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    blob = b"v10" + nonce + AESGCM(os.urandom(32)).encrypt(nonce, b"session-token-xyz", None)
    assert bc.decrypt_value(blob, os.urandom(32)) is None


def test_every_chromium_root_resolves_under_localappdata():
    """Path resolution is the other half a Mac cannot check: these must sit under the real
    LOCALAPPDATA, not a POSIX-shaped guess."""
    local = os.environ.get("LOCALAPPDATA", "")
    assert local, "LOCALAPPDATA is unset; the roots below would silently fall back"
    for name in ("Chrome", "Brave", "Edge"):
        root = bc.CHROMIUM_ROOTS[name]
        assert root.startswith(local), f"{name} root {root!r} is not under {local!r}"
        assert "\\" in root, f"{name} root {root!r} is not a Windows path"
