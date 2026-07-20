"""Read the user's real Claude history from claude.ai using their own logged-in browser
cookies (see browser_cookies), no in-app login. Claude's website session is the only way
in (its API token is a different realm), and a plain request carries it fine (unlike
ChatGPT, claude.ai does not fingerprint-block). We pull the recent conversation titles for
breadth AND the FULL text of the most recent few for depth: their actual asks + the exchange
are far stronger signal than a vague title. Capped, read-only, fails open to "" on anything.
"""

import asyncio
from typing import List

import httpx
from typeguard import typechecked

from backend.apps.onboarding.usage.browser_cookies import cookie_header, read_provider_cookies

BASE = "https://claude.ai"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
PAGE = 100
CAP_PAGES = 40
CAP_TITLES = 1000
# Depth: full text of the most recent CONVO_N chats. A per-convo cap keeps one marathon from
# dominating; the total cap bounds the whole block (a clustering pass distills it downstream, so
# this can be generous). ~130K chars is ~32K tokens, a couple cents for the cheap aux model.
CONVO_N = 10
CONVO_CHARS = 30000
TOTAL_CONVO_CHARS = 130000


@typechecked
def summarize_claude_usage(total: int, titles: List[str], convos: List[str]) -> str:
    parts: List[str] = []
    if total > 0:
        parts.append(f"They have {total} past Claude conversations.")
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
async def p_fetch_claude_convo(client: httpx.AsyncClient, org: str, cid: str) -> str:
    """One conversation's full text, both sides, capped. "" on any failure so a bad convo is skipped."""
    try:
        r = await client.get(
            f"{BASE}/api/organizations/{org}/chat_conversations/{cid}",
            params={"tree": "True", "rendering_mode": "raw"},
        )
        if r.status_code != 200:
            return ""
        data = r.json()
        msgs = data.get("chat_messages") if isinstance(data, dict) else None
        if not isinstance(msgs, list):
            return ""
        lines: List[str] = []
        for m in msgs:
            if not isinstance(m, dict):
                continue
            sender = m.get("sender")
            if sender not in ("human", "assistant"):
                continue
            text = m.get("text") or ""
            if not text and isinstance(m.get("content"), list):
                text = " ".join(str(x.get("text", "")) for x in m["content"] if isinstance(x, dict) and x.get("text"))
            text = str(text).strip()
            if len(text) > 5:
                lines.append(("You: " if sender == "human" else "AI: ") + text)
        return "\n".join(lines)[:CONVO_CHARS]
    except Exception:
        return ""


@typechecked
async def harvest_claude_usage() -> str:
    jar = read_provider_cookies("claude.ai")
    if not jar:
        return ""
    headers = {"Cookie": cookie_header(jar), "User-Agent": UA, "Accept": "application/json"}
    titles: List[str] = []
    conv_ids: List[str] = []
    seen: set = set()
    try:
        async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
            org_res = await client.get(f"{BASE}/api/organizations")
            if org_res.status_code != 200:
                return ""
            orgs = org_res.json()
            if not isinstance(orgs, list) or not orgs:
                return ""
            org = orgs[0].get("uuid")
            offset = 0
            for _ in range(CAP_PAGES):
                if len(titles) >= CAP_TITLES:
                    break
                cr = await client.get(
                    f"{BASE}/api/organizations/{org}/chat_conversations",
                    params={"limit": PAGE, "offset": offset},
                )
                if cr.status_code != 200:
                    break
                items = cr.json()
                if not isinstance(items, list) or not items:
                    break
                fresh = 0
                for it in items:
                    cid = it.get("uuid")
                    if cid and cid not in seen:
                        seen.add(cid)
                        conv_ids.append(str(cid))
                        name = it.get("name")
                        if name:
                            titles.append(str(name))
                        fresh += 1
                if fresh == 0 or len(items) < PAGE:
                    break
                offset += PAGE
            # Depth pass: full text of the most recent few, fetched in parallel.
            top = conv_ids[:CONVO_N]
            convos = [c for c in await asyncio.gather(*(p_fetch_claude_convo(client, org, cid) for cid in top)) if c]
    except Exception:
        return ""
    return summarize_claude_usage(len(seen), titles, convos)
