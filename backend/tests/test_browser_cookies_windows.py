"""The Windows cookie path, proven as far as a Mac can prove it.

browser_cookies.py carries a Windows branch (DPAPI key unwrap, then AES-256-GCM) that has only ever
run on macOS hardware. Its own docstring admits it is written-to-spec and unverified, which is
honest but leaves the riskiest part, the crypto layout, resting on a reading of the Chromium source.

That part does not actually need Windows. AES-GCM is AES-GCM, and Chromium's on-disk shape is a
fixed byte layout: b"v10" + 12-byte nonce + ciphertext||tag. So this builds a real blob in exactly
that layout and shows the branch recovers the plaintext, which narrows the genuinely unverified
surface down to two things a Mac cannot fake: CryptUnprotectData, and where the files live.

What still needs a real Windows machine, stated plainly so nobody reads these greens as more than
they are: DPAPI itself, the LOCALAPPDATA store paths, and app-bound (v20) profiles, which are out
of reach on every platform by design.
"""
import base64
import json
import os

import pytest

from backend.apps.onboarding.usage import browser_cookies as bc

KEY = bytes(range(32))  # AES-256
NONCE = b"\x00" * 12


def p_win_blob(plaintext: bytes, key: bytes = KEY, prefix: bytes = b"") -> bytes:
    """A cookie value encrypted the way Windows Chromium writes it."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    return b"v10" + NONCE + AESGCM(key).encrypt(NONCE, prefix + plaintext, None)


@pytest.fixture
def on_windows(monkeypatch):
    monkeypatch.setattr(bc, "IS_WIN", True)


# --- the crypto layout -----------------------------------------------------------------------

def test_a_real_windows_blob_decrypts(on_windows):
    """The whole point: the byte offsets in the GCM branch are right."""
    assert bc.decrypt_cookie_value(p_win_blob(b"sessionid=abc123"), KEY) == "sessionid=abc123"


def test_the_32_byte_domain_hash_prefix_is_stripped(on_windows):
    """Newer Chromium prepends a 32-byte domain hash. Miss it and every cookie value is silently
    corrupted at the front, which would send a mangled session cookie rather than fail loudly."""
    assert bc.decrypt_cookie_value(p_win_blob(b"tok=xyz", prefix=b"\xa5" * 32), KEY) == "tok=xyz"


def test_a_wrong_key_returns_none_instead_of_raising(on_windows):
    """A DPAPI key from the wrong profile must degrade, not crash the import."""
    assert bc.decrypt_cookie_value(p_win_blob(b"secret"), bytes(32)) is None


def test_app_bound_v20_is_refused_on_windows_too(on_windows):
    """v20 is app-bound encryption; it is out of reach and must never be half-decoded."""
    assert bc.decrypt_cookie_value(b"v20" + NONCE + b"whatever", KEY) is None


def test_truncated_ciphertext_degrades(on_windows):
    assert bc.decrypt_cookie_value(b"v10" + NONCE, KEY) is None


def test_the_mac_branch_does_not_try_gcm(monkeypatch):
    """Same bytes, no Windows flag: the CBC branch must not accidentally accept a GCM blob."""
    # Pin the flag rather than the host: on a Windows runner IS_WIN is naturally True and the GCM branch would (correctly) decrypt.
    monkeypatch.setattr(bc, "IS_WIN", False)
    assert bc.decrypt_cookie_value(p_win_blob(b"sessionid=abc123"), KEY) is None


# --- the key unwrap, minus DPAPI itself ------------------------------------------------------

def test_local_state_key_is_base64_decoded_and_the_dpapi_magic_stripped(monkeypatch, tmp_path):
    """Everything up to the CryptUnprotectData call is plain parsing and can be checked here: the
    key must arrive base64-decoded with the 5-byte b'DPAPI' prefix removed."""
    (tmp_path / "Local State").write_text(json.dumps(
        {"os_crypt": {"encrypted_key": base64.b64encode(b"DPAPI" + b"\x11" * 32).decode()}}))
    monkeypatch.setitem(bc.CHROMIUM_ROOTS, "Chrome", str(tmp_path))

    seen = []

    def fake_unprotect(blob: bytes) -> bytes:
        seen.append(blob)
        return KEY

    monkeypatch.setattr(bc, "win_dpapi_unprotect", fake_unprotect)

    assert bc.win_storage_key("Chrome") == KEY
    assert seen == [b"\x11" * 32], "the DPAPI magic must be stripped before unwrapping"


def test_dpapi_failure_yields_no_key_rather_than_an_exception(monkeypatch, tmp_path):
    """Wrong user account, roamed profile, corrupted blob: all of it must fail open."""
    (tmp_path / "Local State").write_text(json.dumps(
        {"os_crypt": {"encrypted_key": base64.b64encode(b"DPAPI" + b"\x11" * 32).decode()}}))
    monkeypatch.setitem(bc.CHROMIUM_ROOTS, "Chrome", str(tmp_path))
    monkeypatch.setattr(bc, "win_dpapi_unprotect", lambda d: None)

    assert bc.win_storage_key("Chrome") is None


def test_a_non_dpapi_local_state_is_refused(monkeypatch, tmp_path):
    """Chrome on macOS writes a key with no DPAPI prefix; handing that to CryptUnprotectData is
    nonsense, so the magic check is what keeps the platforms from crossing."""
    (tmp_path / "Local State").write_text(json.dumps(
        {"os_crypt": {"encrypted_key": base64.b64encode(b"v10" + b"\x11" * 32).decode()}}))
    monkeypatch.setitem(bc.CHROMIUM_ROOTS, "Chrome", str(tmp_path))
    monkeypatch.setattr(bc, "win_dpapi_unprotect", lambda d: KEY)

    assert bc.win_storage_key("Chrome") is None


def test_a_missing_local_state_degrades(monkeypatch, tmp_path):
    monkeypatch.setitem(bc.CHROMIUM_ROOTS, "Chrome", str(tmp_path / "nope"))
    assert bc.win_storage_key("Chrome") is None


def test_an_unknown_browser_has_no_key():
    assert bc.win_storage_key("Netscape") is None


def test_windows_stores_are_rooted_in_localappdata():
    """Not a behaviour test, a documentation lock: if someone re-points the Windows roots at the
    macOS Application Support layout, every Windows user silently gets the scan floor instead."""
    src = bc.__file__
    with open(src) as f:
        text = f.read()
    assert "LOCALAPPDATA" in text
    assert 'os.path.expanduser("~/AppData/Local")' in text, "the LOCALAPPDATA fallback went missing"


def test_the_module_still_imports_on_this_platform():
    """ctypes/wintypes only exist on Windows; the import must stay inside the function so the whole
    onboarding package does not explode on macOS."""
    assert callable(bc.win_dpapi_unprotect)
    assert bc.win_dpapi_unprotect(b"not really a blob") is None
    assert os.path.basename(bc.__file__) == "browser_cookies.py"
