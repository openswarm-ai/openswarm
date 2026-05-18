#!/usr/bin/env python3
"""Spotify integration diagnostic.

Loads the saved refresh_token from OpenSwarm's tool config, refreshes
against Spotify, then hits every endpoint we care about and reports
exactly which one fails. Strips speculation — you see the real Spotify
response codes.

Run from the openswarm repo root:
    backend/.venv/bin/python scripts/diagnose-spotify.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Pull env from backend/.env even if running outside backend.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / "backend" / ".env")
except Exception:
    pass

import httpx

REPO = Path(__file__).resolve().parent.parent
TOOLS_DIR = REPO / "backend" / "data" / "tools"

CYAN = "\033[36m"; GREEN = "\033[32m"; RED = "\033[31m"; YELLOW = "\033[33m"; DIM = "\033[2m"; RESET = "\033[0m"

def section(text): print(f"\n{CYAN}=== {text} ==={RESET}")
def ok(text): print(f"{GREEN}✓{RESET} {text}")
def bad(text): print(f"{RED}✗{RESET} {text}")
def warn(text): print(f"{YELLOW}⚠{RESET} {text}")


def find_spotify_tool() -> dict | None:
    if not TOOLS_DIR.is_dir():
        return None
    for f in TOOLS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            if (data.get("name") or "").lower() == "spotify":
                return data
        except Exception:
            continue
    return None


def main() -> int:
    section("1. App credentials from backend/.env")
    cid = os.environ.get("OPENSWARM_SPOTIFY_CLIENT_ID", "").strip()
    csec = os.environ.get("OPENSWARM_SPOTIFY_CLIENT_SECRET", "").strip()
    if not cid or not csec:
        bad("OPENSWARM_SPOTIFY_CLIENT_ID/_SECRET not set in backend/.env")
        return 1
    ok(f"client_id loaded ({cid[:8]}...)")
    ok("client_secret loaded")

    section("2. Saved Spotify tool config")
    tool = find_spotify_tool()
    if not tool:
        bad(f"No Spotify tool config in {TOOLS_DIR} — click Connect Spotify in OpenSwarm first.")
        return 1
    print(f"  {DIM}tool id:{RESET} {tool.get('id')}")
    print(f"  {DIM}auth_status:{RESET} {tool.get('auth_status')}")
    print(f"  {DIM}connected as:{RESET} {tool.get('connected_account_email')}")
    creds = tool.get("credentials") or {}
    rt = creds.get("SPOTIFY_REFRESH_TOKEN") or ""
    if not rt:
        bad("No SPOTIFY_REFRESH_TOKEN saved. Reconnect via Tools page.")
        return 1
    ok(f"refresh_token saved ({len(rt)} chars)")
    saved_scopes = creds.get("SPOTIFY_GRANTED_SCOPES", "") or "(not stored)"
    print(f"  {DIM}saved granted_scopes:{RESET} {saved_scopes}")

    section("3. Refresh token against Spotify")
    import base64
    basic = base64.b64encode(f"{cid}:{csec}".encode()).decode()
    try:
        resp = httpx.post(
            "https://accounts.spotify.com/api/token",
            headers={"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"},
            data={"grant_type": "refresh_token", "refresh_token": rt},
            timeout=15.0,
        )
    except Exception as e:
        bad(f"HTTP error: {e}")
        return 1
    if resp.status_code != 200:
        bad(f"Spotify rejected refresh: {resp.status_code} {resp.text[:300]}")
        return 1
    payload = resp.json()
    access_token = payload.get("access_token", "")
    granted_scopes_now = (payload.get("scope") or "").split()
    ok(f"refresh OK — token expires in {payload.get('expires_in')}s")
    print(f"  {DIM}scopes ACTUALLY on the access_token right now ({len(granted_scopes_now)}):{RESET}")
    for s in sorted(granted_scopes_now):
        print(f"    - {s}")

    required_playlist = {"playlist-modify-private", "playlist-modify-public"}
    missing = required_playlist - set(granted_scopes_now)
    if missing:
        bad(f"Missing playlist write scopes on the live access_token: {sorted(missing)}")
        print(f"\n{YELLOW}This is the root cause of your 403. The token Spotify just gave us")
        print(f"does not include playlist write permission. We need a fresh OAuth.{RESET}\n")
    else:
        ok("playlist-modify-private and playlist-modify-public BOTH present on live token")

    section("4. /me — confirm account identity")
    h = {"Authorization": f"Bearer {access_token}"}
    me = httpx.get("https://api.spotify.com/v1/me", headers=h, timeout=15.0)
    if me.status_code != 200:
        bad(f"/me failed: {me.status_code} {me.text[:200]}")
        return 1
    me_json = me.json()
    user_id = me_json.get("id")
    print(f"  {DIM}id:{RESET} {user_id}")
    print(f"  {DIM}display_name:{RESET} {me_json.get('display_name')}")
    print(f"  {DIM}product:{RESET} {me_json.get('product')}  {DIM}(must be 'premium' for playback control){RESET}")
    print(f"  {DIM}country:{RESET} {me_json.get('country')}")
    print(f"  {DIM}email verified:{RESET} {me_json.get('email')}")
    ok("/me works — auth is valid for read")

    section("5. /me/playlists — verify playlist-read works")
    pls = httpx.get("https://api.spotify.com/v1/me/playlists?limit=1", headers=h, timeout=15.0)
    if pls.status_code == 200:
        ok(f"/me/playlists works — you own/follow {pls.json().get('total', '?')} playlists")
    else:
        bad(f"/me/playlists failed: {pls.status_code} {pls.text[:200]}")

    section("6. POST /users/{me}/playlists — the actual write that's 403ing")
    create_body = {"name": "OpenSwarm Diagnostic — Delete Me", "public": False, "description": "diagnostic"}
    cr = httpx.post(
        f"https://api.spotify.com/v1/users/{user_id}/playlists",
        headers={**h, "Content-Type": "application/json"},
        json=create_body,
        timeout=15.0,
    )
    if cr.status_code in (200, 201):
        pl = cr.json()
        ok(f"✓✓✓ playlist creation WORKS. id={pl.get('id')}")
        print(f"\n{GREEN}Playlist '{pl.get('name')}' created successfully.")
        print(f"You can delete it from your Spotify library.{RESET}\n")
        return 0
    bad(f"Playlist creation 403'd: {cr.status_code}")
    try:
        err = cr.json()
        print(f"  {DIM}Spotify error JSON:{RESET}")
        print(f"  {json.dumps(err, indent=2)}")
    except Exception:
        print(f"  {DIM}raw body:{RESET} {cr.text[:500]}")

    section("Diagnosis summary")
    if missing:
        bad("Confirmed: the access_token does not carry playlist write scopes.")
        print()
        print(f"{YELLOW}Fix (definitive sequence):{RESET}")
        print("  1. Open https://www.spotify.com/account/apps — REMOVE the OpenSwarm app")
        print("  2. Stop OpenSwarm (Ctrl+C)")
        print("  3. Delete the saved Spotify tool config to force a clean state:")
        spot_id = tool.get("id")
        print(f"     rm {TOOLS_DIR / (str(spot_id) + '.json')}")
        print("  4. bash run.sh")
        print("  5. Connect Spotify again — the consent screen should now list every permission")
        print("     including 'Modify your private playlists' and 'Modify your public playlists'")
        print("  6. Re-run this script to confirm. All sections should be green.")
    else:
        warn("Scopes look right but Spotify still refused the write.")
        print(f"\n{YELLOW}This is unusual. Likely causes (in order):{RESET}")
        print("  - Your Spotify account is a Family/Kids/restricted sub-account that can't create playlists")
        print("  - Regional restriction (try VPN-disabled in your account's country)")
        print(f"  - The user_id in the URL ('{user_id}') doesn't match the token's account — file a bug")
        print(f"\nSend this entire diagnostic output to debug further.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
