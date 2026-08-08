"""Shared plumbing for the 1.7.5 verification scripts."""

import json
import os
import urllib.request
from typing import List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROWS: List[Tuple[str, str, str]] = []


def row(name: str, verdict: str, detail: str) -> None:
    ROWS.append((name, verdict, detail))
    print(f"  {verdict:5}  {name:38} {detail}", flush=True)


def p_api(path: str, token: str, body: Optional[dict] = None, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        "http://127.0.0.1:8324/api" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")
