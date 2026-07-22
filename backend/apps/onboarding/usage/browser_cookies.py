"""Read the user's own logged-in provider cookies from their real browser, so
onboarding can harvest their actual chat history at first run without an in-app login.

Chromium (Chrome/Arc/Brave/Edge) on macOS AND Windows. We first find WHICH store holds the
session by counting cookie names in the SQLite (no decryption, no keychain/DPAPI), then decrypt
only that one store, so the secret key is fetched at most once per browser (cached for the
process). Per-OS decryption:
  - macOS: "Safe Storage" keychain password -> PBKDF2 -> AES-CBC (v10/v11).
  - Windows: DPAPI-unwrapped key from Local State -> AES-256-GCM (v10/v11).
v20 = app-bound encryption (modern Chrome), out of reach on both without the browser's own
elevation service. Fails open to {} on anything (no browser, app-bound cookies, denied
keychain/DPAPI, Safari-only user), so prep just falls back to the local scan.

Only ever reads the specific provider domain asked for; never a general cookie sweep.
The values are session secrets: used in-process for the harvest, never logged or stored.

NOTE: the Windows path is written to the well-documented Chromium/DPAPI scheme but is NOT
live-tested from this repo's dev machine (macOS); the macOS path is live-proven (490 real
Claude convos). Both fail open, so a Windows decryption miss degrades to the scan, never crashes.
"""

import base64
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple

from typeguard import typechecked

IS_WIN = sys.platform == "win32"

# Per-OS "User Data" roots (relative to the home dir), where profiles + Local State live.
if IS_WIN:
    p_local = os.environ.get("LOCALAPPDATA", os.path.expanduser("~/AppData/Local"))
    CHROMIUM_ROOTS = {
        "Chrome": os.path.join(p_local, "Google", "Chrome", "User Data"),
        "Arc": os.path.join(p_local, "Packages"),  # Arc/Windows is UWP-packaged + rare; best-effort
        "Brave": os.path.join(p_local, "BraveSoftware", "Brave-Browser", "User Data"),
        "Edge": os.path.join(p_local, "Microsoft", "Edge", "User Data"),
    }
else:
    p_home = os.path.expanduser("~")
    CHROMIUM_ROOTS = {
        "Chrome": os.path.join(p_home, "Library/Application Support/Google/Chrome"),
        "Arc": os.path.join(p_home, "Library/Application Support/Arc/User Data"),
        "Brave": os.path.join(p_home, "Library/Application Support/BraveSoftware/Brave-Browser"),
        "Edge": os.path.join(p_home, "Library/Application Support/Microsoft Edge"),
    }
KEYCHAIN_SERVICE = {
    "Chrome": "Chrome Safe Storage",
    "Arc": "Arc Safe Storage",
    "Brave": "Brave Safe Storage",
    "Edge": "Microsoft Edge Safe Storage",
}
PROFILES = ["Default"] + [f"Profile {i}" for i in range(1, 12)]

# One key fetch per browser per process; "Always Allow" (mac) / DPAPI (win) then never re-prompts.
p_key_cache: Dict[str, Optional[bytes]] = {}


@typechecked
def p_win_dpapi_unprotect(data: bytes) -> Optional[bytes]:
    """CryptUnprotectData via crypt32.dll (no pywin32 dependency). None on any failure."""
    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            p_fields = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]
            _fields_ = p_fields

        buf = ctypes.create_string_buffer(data, len(data))
        blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = DATA_BLOB()
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
        )
        if not ok:
            return None
        n = int(blob_out.cbData)
        out = ctypes.create_string_buffer(n)
        ctypes.memmove(out, blob_out.pbData, n)
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
        return out.raw
    except Exception:
        return None


@typechecked
def p_win_storage_key(browser: str) -> Optional[bytes]:
    """The AES key from a Chromium install's Local State: base64 -> strip 'DPAPI' -> CryptUnprotectData."""
    base = CHROMIUM_ROOTS.get(browser)
    if not base:
        return None
    local_state = os.path.join(base, "Local State")
    try:
        with open(local_state, "r", encoding="utf-8") as f:
            enc_b64 = json.load(f)["os_crypt"]["encrypted_key"]
        raw = base64.b64decode(enc_b64)
        if raw[:5] != b"DPAPI":
            return None
        return p_win_dpapi_unprotect(raw[5:])
    except Exception:
        return None


@typechecked
def p_mac_storage_key(browser: str) -> Optional[bytes]:
    try:
        r = subprocess.run(
            ["security", "find-generic-password", "-w", "-s", KEYCHAIN_SERVICE[browser]],
            capture_output=True, text=True, timeout=20,
        )
        pw = r.stdout.strip()
        if pw:
            return hashlib.pbkdf2_hmac("sha1", pw.encode(), b"saltysalt", 1003, 16)
    except Exception:
        pass
    return None


@typechecked
def p_safe_storage_key(browser: str) -> Optional[bytes]:
    if browser in p_key_cache:
        return p_key_cache[browser]
    key = p_win_storage_key(browser) if IS_WIN else p_mac_storage_key(browser)
    p_key_cache[browser] = key
    return key


@typechecked
def p_count_domain(db_path: str, domain: str) -> int:
    tmp = tempfile.mktemp()
    try:
        shutil.copy2(db_path, tmp)
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        cur = con.cursor()
        cur.execute("SELECT count(*) FROM cookies WHERE host_key LIKE ?", (f"%{domain}",))
        n = int(cur.fetchone()[0])
        con.close()
        return n
    except Exception:
        return 0
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


@typechecked
def p_best_store(domain: str) -> Optional[Tuple[str, str]]:
    """The (browser, db_path) holding the most cookies for `domain`, found WITHOUT the keychain."""
    best: Optional[Tuple[str, str]] = None
    best_score = (0, -1.0)
    for browser, base in CHROMIUM_ROOTS.items():
        if not os.path.isdir(base):
            continue
        for prof in PROFILES:
            for sub in ("Cookies", "Network/Cookies"):
                path = os.path.join(base, prof, sub)
                if not os.path.isfile(path):
                    continue
                n = p_count_domain(path, domain)
                if n:
                    score = (n, os.path.getmtime(path))
                    if score > best_score:
                        best, best_score = (browser, path), score
    return best


@typechecked
def p_decrypt(enc: bytes, key: bytes) -> Optional[str]:
    if enc[:3] not in (b"v10", b"v11"):
        return None  # v20 = app-bound encryption, out of reach without the browser
    try:
        if IS_WIN:
            # Windows Chromium: v10/v11 = AES-256-GCM, [3:15]=nonce, tail 16 bytes=tag (bundled with ct).
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM

            dec = AESGCM(key).decrypt(enc[3:15], enc[15:], None)
        else:
            from cryptography.hazmat.backends import default_backend
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

            c = Cipher(algorithms.AES(key), modes.CBC(b" " * 16), backend=default_backend())
            d = c.decryptor()
            dec = d.update(enc[3:]) + d.finalize()
            dec = dec[: -dec[-1]]  # strip PKCS7 padding
        for cut in (0, 32):  # newer Chromium prepends a 32-byte domain hash
            try:
                return dec[cut:].decode("utf-8")
            except UnicodeDecodeError:
                continue
    except Exception:
        return None
    return None


@typechecked
def read_provider_cookies(domain: str) -> Dict[str, str]:
    """Decrypted cookie jar for `domain`, from whichever browser store actually has the session. At most one keychain touch (that store's browser), cached for the process."""
    store = p_best_store(domain)
    if store is None:
        return {}
    browser, db_path = store
    key = p_safe_storage_key(browser)
    if key is None:
        return {}
    jar: Dict[str, str] = {}
    tmp = tempfile.mktemp()
    try:
        shutil.copy2(db_path, tmp)
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        cur = con.cursor()
        cur.execute("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?", (f"%{domain}",))
        for name, enc in cur.fetchall():
            if not enc:
                continue
            val = p_decrypt(bytes(enc), key)
            if val:
                jar[str(name)] = val
        con.close()
    except Exception:
        pass
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return jar


@typechecked
def read_provider_cookie_records(domain: str) -> List[Dict[str, Any]]:
    """Full cookie records ({name,value,domain,path,secure,httponly}) for `domain`, so Electron's offscreen browser can re-inject the session faithfully and pass Cloudflare with a real Chrome TLS handshake. Same one-store, one-keychain-touch path as read_provider_cookies."""
    store = p_best_store(domain)
    if store is None:
        return []
    browser, db_path = store
    key = p_safe_storage_key(browser)
    if key is None:
        return []
    records: List[Dict[str, Any]] = []
    tmp = tempfile.mktemp()
    try:
        shutil.copy2(db_path, tmp)
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        cur = con.cursor()
        cur.execute(
            "SELECT name, encrypted_value, host_key, path, is_secure, is_httponly FROM cookies WHERE host_key LIKE ?",
            (f"%{domain}",),
        )
        for name, enc, host_key, path, is_secure, is_httponly in cur.fetchall():
            if not enc:
                continue
            val = p_decrypt(bytes(enc), key)
            if val is None:
                continue
            records.append({
                "name": str(name), "value": val, "domain": str(host_key),
                "path": str(path) or "/", "secure": bool(is_secure), "httponly": bool(is_httponly),
            })
        con.close()
    except Exception:
        pass
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return records


# Gemini authenticates on the parent .google.com SSO domain, not gemini.google.com, so its
# session lives in these named cookies. We read ONLY these (never the whole google cookie
# jar) and only to load a Gemini page offscreen, keeping the ChatGPT/Claude trust frame.
GOOGLE_AUTH_COOKIE_NAMES = {
    "SID", "HSID", "SSID", "APISID", "SAPISID", "SIDCC", "NID",
    "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS",
    "__Secure-1PSIDCC", "__Secure-3PSIDCC", "__Secure-1PAPISID", "__Secure-3PAPISID",
}


@typechecked
def read_google_session_records() -> List[Dict[str, Any]]:
    """The named Google SSO cookies from .google.com, so the offscreen browser can load Gemini logged in. Scoped to the auth set by name, never a general google-cookie sweep."""
    return [r for r in read_provider_cookie_records(".google.com") if r.get("name") in GOOGLE_AUTH_COOKIE_NAMES]


@typechecked
def cookie_header(jar: Dict[str, str]) -> str:
    return "; ".join(f"{k}={v}" for k, v in jar.items())


@typechecked
def logged_in_providers() -> List[str]:
    """Which providers have a readable session, WITHOUT decrypting or touching the keychain: safe for a UI presence check."""
    out: List[str] = []
    for provider, domain in (("codex", "chatgpt.com"), ("claude", "claude.ai"), ("gemini", "gemini.google.com")):
        if p_best_store(domain) is not None:
            out.append(provider)
    return out
