"""Read the user's own ChatGPT conversation titles + Memory straight from ChatGPT's
backend using the codex connect token, no website login or browser session needed.

The token 9Router already holds from "Sign in with ChatGPT" is a valid bearer for
chatgpt.com/backend-api (that is how Codex runs); paired with the chatgpt-account-id
claim from the id token it reaches /conversations and /memories from the user's own
machine. Read-only, capped, and fails open to "" on anything (expired token,
Cloudflare, shape drift) so prep just falls back to the local scan.
"""

import asyncio
from typing import List, Optional, Tuple

import httpx
from typeguard import typechecked

from backend.apps.nine_router.process import read_persisted_connections
from backend.apps.onboarding.identity import decode_jwt_payload

BASE = "https://chatgpt.com/backend-api"
PAGE = 100
CAP_PAGES = 40
# Prep only reads ~150 titles; this endpoint is ~4s/page, so fetching 1000 cost 38s of onboarding
# runway for nothing. Cap the title pull; the real conversation total comes from the API's own count.
CAP_TITLES = 200
# Depth: full text of the most recent CONVO_N chats. Per-convo cap stops one marathon dominating; the
# total cap bounds the block (a clustering pass distills it downstream, so it can be generous).
CONVO_N = 10
CONVO_CHARS = 30000
TOTAL_CONVO_CHARS = 130000
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


@typechecked
def p_codex_creds() -> Optional[Tuple[str, Optional[str]]]:
    for c in read_persisted_connections():
        if c.get("provider") == "codex" and c.get("isActive") and c.get("accessToken"):
            claims = decode_jwt_payload(c.get("idToken") or "")
            auth = claims.get("https://api.openai.com/auth", {}) if isinstance(claims, dict) else {}
            acct = auth.get("chatgpt_account_id") if isinstance(auth, dict) else None
            return (str(c["accessToken"]), str(acct) if acct else None)
    return None


@typechecked
def summarize_chatgpt_usage(total: int, memories: List[str], titles: List[str], convos: List[str], capped: bool = False) -> str:
    parts: List[str] = []
    if total > 0:
        parts.append(f"They have {total}{'+' if capped else ''} past AI conversations.")
    if memories:
        parts.append("Facts their AI remembers about them: " + "; ".join(memories))
    if titles:
        parts.append("Recent conversation titles (breadth): " + "; ".join(titles[:150]))
    if convos:
        block: List[str] = []
        used = 0
        for cv in convos:
            if used + len(cv) > TOTAL_CONVO_CHARS:
                break
            block.append(cv)
            used += len(cv)
        if block:
            parts.append("Full text of their most recent conversations (their real asks + the exchange):\n\n" + "\n\n---\n\n".join(block))
    return "\n".join(parts)


@typechecked
async def p_fetch_chatgpt_convo(client: httpx.AsyncClient, cid: str) -> str:
    """One conversation's full text, both sides, ordered, capped. "" on any failure (convo skipped)."""
    try:
        r = await client.get(f"{BASE}/conversation/{cid}")
        if r.status_code != 200:
            return ""
        data = r.json()
        mapping = data.get("mapping") if isinstance(data, dict) else None
        if not isinstance(mapping, dict):
            return ""
        rows: List[Tuple[float, str]] = []
        for node in mapping.values():
            m = node.get("message") if isinstance(node, dict) else None
            if not isinstance(m, dict):
                continue
            role = (m.get("author") or {}).get("role")
            if role not in ("user", "assistant"):
                continue
            content = m.get("content") or {}
            if content.get("content_type") != "text":
                continue
            text = " ".join(str(p) for p in (content.get("parts") or []) if p).strip()
            if len(text) > 5:
                rows.append((float(m.get("create_time") or 0), ("You: " if role == "user" else "AI: ") + text))
        rows.sort(key=lambda x: x[0])
        return "\n".join(t for _, t in rows)[:CONVO_CHARS]
    except Exception:
        return ""


@typechecked
async def harvest_chatgpt_usage() -> str:
    creds = p_codex_creds()
    if creds is None:
        return ""
    token, acct = creds
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": UA,
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/",
    }
    if acct:
        headers["chatgpt-account-id"] = acct
    titles: List[str] = []
    conv_ids: List[str] = []
    seen: set = set()
    memories: List[str] = []
    convos: List[str] = []
    try:
        async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
            offset = 0
            for _ in range(CAP_PAGES):
                if len(titles) >= CAP_TITLES:
                    break
                r = await client.get(f"{BASE}/conversations", params={"offset": offset, "limit": PAGE, "order": "updated"})
                if r.status_code != 200:
                    return ""  # expired token / Cloudflare / shape drift: fail open, prep uses the scan
                items = (r.json() or {}).get("items") or []
                if not items:
                    break
                fresh = 0
                for it in items:
                    cid = it.get("id")
                    if cid and cid not in seen:
                        seen.add(cid)
                        conv_ids.append(str(cid))
                        title = it.get("title")
                        if title:
                            titles.append(str(title))
                        fresh += 1
                if fresh == 0 or len(items) < PAGE:
                    break
                offset += PAGE
            try:
                mr = await client.get(f"{BASE}/memories", params={"include_memory_entries": "true"})
                if mr.status_code == 200:
                    memories = [str(m.get("content")) for m in (mr.json() or {}).get("memories", []) if m.get("content")][:40]
            except Exception:
                pass
            # Depth pass: full text of the most recent few, fetched in parallel.
            convos = [c for c in await asyncio.gather(*(p_fetch_chatgpt_convo(client, cid) for cid in conv_ids[:CONVO_N])) if c]
    except Exception:
        return ""
    return summarize_chatgpt_usage(len(seen), memories, titles, convos, capped=len(titles) >= CAP_TITLES)
