"""DuckDuckGo lite-endpoint search: the free fallback when html.duckduckgo.com
throttles (HTTP 202) or its markup drifts. lite.duckduckgo.com is a separate
frontend with simpler, stabler HTML and direct result URLs (no uddg redirect).

Returns None on a throttle (caller decides whether that means rate-limited
overall) and a formatted results string (possibly empty) on success."""

import html
import re
from typing import List, Optional

import httpx
from typeguard import typechecked

P_LITE_URL = "https://lite.duckduckgo.com/lite/"
P_TIMEOUT = 12.0
P_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
P_TAG_RE = re.compile(r"<[^>]+>")
# Lite uses single-quoted class attrs today; accept either quote style so a cosmetic flip doesn't kill the parser.
P_LINK_RE = re.compile(
    r"""<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>(.*?)</a>""",
    flags=re.DOTALL,
)
P_SNIPPET_RE = re.compile(
    r"""<td[^>]*class=['"]result-snippet['"][^>]*>(.*?)</td>""",
    flags=re.DOTALL,
)


@typechecked
def p_strip(text: str) -> str:
    return html.unescape(P_TAG_RE.sub("", text)).strip()


@typechecked
def parse_lite_results(body: str, num_results: int) -> str:
    """Format lite's result rows; links and snippets appear in document order and pair up positionally."""
    links = P_LINK_RE.findall(body)
    snippets = [p_strip(s) for s in P_SNIPPET_RE.findall(body)]
    entries: List[str] = []
    for i, (url, raw_title) in enumerate(links[:num_results]):
        title = p_strip(raw_title)
        entry = f"[{i + 1}] {title}\n    {html.unescape(url)}"
        if i < len(snippets) and snippets[i]:
            entry += f"\n    {snippets[i]}"
        entries.append(entry)
    return "\n\n".join(entries)


@typechecked
async def search_ddg_lite(query: str, num_results: int) -> Optional[str]:
    """None = throttled (202), string = parsed results (may be empty on no hits)."""
    async with httpx.AsyncClient(
        timeout=P_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": P_USER_AGENT},
    ) as client:
        resp = await client.post(P_LITE_URL, data={"q": query})
        if resp.status_code == 202:
            return None
        resp.raise_for_status()
    return parse_lite_results(resp.text, num_results)
