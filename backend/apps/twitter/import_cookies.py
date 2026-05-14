"""One-shot CLI for importing browser-extracted cookies into the pool.

When Cloudflare's bot detection blocks ``POST /accounts/login`` (the
underlying ``httpx`` TLS fingerprint gets flagged even after the UA +
``sec-ch-ua-*`` header patches in :mod:`._twikit_patches`), the operator
can still get a working session by:

1. Logging in via a real browser on the same machine.
2. Copying ``auth_token`` and ``ct0`` from DevTools (Application →
   Cookies → ``https://x.com``).
3. Running this script with those two values.

The script writes a twikit-format cookies file (twikit's
``save_cookies`` just dumps ``dict(self.http.cookies)`` to JSON, so any
JSON dict of name->value works) and registers a matching account record
in ``accounts.json``. The next backend restart will pick it up via
``_hydrate_pool``; the operator can then confirm with
``POST /api/twitter/accounts/{id}/verify``, which calls the much softer
``client.user()`` endpoint that historically survives Cloudflare even
when the login POST does not.

This is intentionally a CLI script and not a route: accepting raw
session cookies over an HTTP endpoint widens the attack surface (any
request that can authenticate to the backend could exfiltrate a session
into the pool), and the import use case is rare enough that paying the
"restart the backend" cost is fine.

Usage
-----

::

    python -m backend.apps.twitter.import_cookies \\
        --auth-token AAA... \\
        --ct0 BBB... \\
        --label "personal" \\
        [--handle myname] \\
        [--role primary|read_only] \\
        [--id <existing-uuid>]

If ``--id`` is omitted, a fresh uuid4 is generated. If ``--id`` matches
an existing account, that account's cookies are overwritten in place
(re-login path) and its label/handle are updated if supplied.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from uuid import uuid4

from backend.apps.twitter import persistence
from backend.apps.twitter.models import TwitterAccount


def _build_cookie_dict(auth_token: str, ct0: str, extra: dict | None = None) -> dict:
    """Minimum cookie set that x.com's GraphQL endpoints accept.

    ``auth_token`` is the session secret; ``ct0`` is the CSRF token X
    cross-checks against the ``x-csrf-token`` header twikit sends on
    every authenticated request. Anything else (``guest_id``, ``kdt``,
    ``att``) is nice-to-have for fingerprint consistency but not
    required for the API to authorize the call.
    """
    cookies = {"auth_token": auth_token, "ct0": ct0}
    if extra:
        cookies.update(extra)
    return cookies


def _upsert_account_record(
    account_id: str,
    label: str,
    handle: str | None,
    role: str,
) -> TwitterAccount:
    """Find or create the matching record in ``accounts.json``.

    We treat this as an upsert: re-running the script with the same
    ``--id`` (e.g. to refresh cookies after they expire) updates the
    label/handle on the existing row instead of duplicating it. State
    is forced back to ``active`` so the next hydrate doesn't skip the
    account; the smoke probe / verify will downgrade it if the imported
    cookies are stale.
    """
    accounts_raw = persistence.load_accounts()
    for i, raw in enumerate(accounts_raw):
        if raw.get("id") == account_id:
            record = TwitterAccount(**raw)
            record.label = label or record.label
            if handle:
                record.handle = handle
            record.role = role  # type: ignore[assignment]
            record.state = "active"
            record.last_error = None
            record.last_verified_at = 0.0  # let /verify stamp this
            accounts_raw[i] = record.model_dump()
            persistence.save_accounts(accounts_raw)
            return record

    record = TwitterAccount(
        id=account_id,
        label=label or (handle or "imported"),
        handle=handle,
        role=role,  # type: ignore[arg-type]
    )
    record.state = "active"
    record.last_verified_at = 0.0
    accounts_raw.append(record.model_dump())
    persistence.save_accounts(accounts_raw)
    return record


def _write_cookies(account_id: str, cookies: dict) -> str:
    """Drop cookies file at the canonical path with mode 0600.

    Atomic via tmp-then-rename so a crash mid-write can't leave the
    pool hydrating from a half-written JSON file at next startup.
    """
    persistence.ensure_dirs()
    final = persistence.cookies_path(account_id)
    tmp = final + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cookies, f)
    os.replace(tmp, final)
    persistence.chmod_cookies(final)
    return final


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Import browser-extracted x.com cookies into the OpenSwarm "
            "Twitter account pool. Use when /accounts/login is being "
            "Cloudflare-blocked but the same account works in a real "
            "browser on the same machine."
        ),
    )
    parser.add_argument("--auth-token", required=True, help="auth_token cookie value")
    parser.add_argument("--ct0", required=True, help="ct0 cookie value (CSRF)")
    parser.add_argument("--label", default="", help="human-readable label for the account")
    parser.add_argument("--handle", default=None, help="screen name (optional; /verify will fill this in)")
    parser.add_argument(
        "--role",
        default="primary",
        choices=("primary", "read_only"),
        help="account role; defaults to primary",
    )
    parser.add_argument(
        "--id",
        default=None,
        help="reuse an existing account id (re-import path); omit to mint a fresh uuid",
    )
    args = parser.parse_args(argv)

    auth_token = args.auth_token.strip()
    ct0 = args.ct0.strip()
    if not auth_token or not ct0:
        print("error: --auth-token and --ct0 must both be non-empty", file=sys.stderr)
        return 2

    account_id = args.id or uuid4().hex
    cookies = _build_cookie_dict(auth_token, ct0)

    cookie_path = _write_cookies(account_id, cookies)
    record = _upsert_account_record(
        account_id=account_id,
        label=args.label,
        handle=args.handle,
        role=args.role,
    )

    print(json.dumps({
        "ok": True,
        "id": record.id,
        "label": record.label,
        "handle": record.handle,
        "role": record.role,
        "state": record.state,
        "cookies_path": cookie_path,
        "imported_at": time.time(),
        "next_steps": [
            "Restart the backend so _hydrate_pool picks up the new account.",
            f"Call POST /api/twitter/accounts/{record.id}/verify to confirm "
            "the cookies are live (uses client.user(), which is much softer "
            "than the login POST).",
        ],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
