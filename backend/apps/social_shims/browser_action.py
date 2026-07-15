"""Delegate a write to the user's own live browser card via the backend action bridge.

For sites that sign every request (TikTok), a shim can't POST writes over HTTP without
tripping anti-bot. Instead it asks the backend to drive the user's already-open, logged-in
card: navigate it to the target URL, then run a small click/type script. Same trust posture
as the cookie bridge (auth token + domain allowlist + only a card the user already has open).
stdlib-only so the subprocess stays light.
"""

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
AUTH_TOKEN = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
ACTION_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/browser-session/action"


class BrowserActionError(Exception):
    """The browser-card delegation could not complete (no card open, bridge down, JS failed)."""


def perform(domain: str, steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Run a navigate/evaluate/wait step sequence against the user's live <domain> card."""
    payload = json.dumps({"domain": domain, "steps": steps}).encode()
    headers = {"Content-Type": "application/json"}
    if AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {AUTH_TOKEN}"
    req = urllib.request.Request(ACTION_URL, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=45.0) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        raise BrowserActionError(f"Browser bridge HTTP {e.code}: {body[:200]}")
    except urllib.error.URLError as e:
        raise BrowserActionError(
            f"Browser bridge unreachable: {getattr(e, 'reason', e)}. Is the OpenSwarm dashboard open?"
        )
    if data.get("error"):
        raise BrowserActionError(str(data["error"]))
    return data


def last_json(result: Dict[str, Any]) -> Dict[str, Any]:
    """Pull the JSON the final evaluate step returned (handleEvaluate wraps it in .text)."""
    for r in reversed(result.get("results") or []):
        if isinstance(r, dict) and r.get("text"):
            try:
                return json.loads(r["text"])
            except (ValueError, TypeError):
                return {"raw": r["text"]}
    return result
