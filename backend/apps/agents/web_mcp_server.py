#!/usr/bin/env python3
"""Stdio MCP server exposing WebSearch/WebFetch; registered only when no Claude credential is available."""

import json
import os
import sys
import urllib.error
import urllib.request

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
SEARCH_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/web/search"
FETCH_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/web/fetch"

# Primary-provider hint from agent_manager; backend picks the native search tool (googleSearch/web_search_preview) so searches use the user's existing budget.
PRIMARY_HINT = os.environ.get("OPENSWARM_PRIMARY_API", "") or None
# Whether this session actually has browser-delegation tools; gates the backend's "fall back to the browser" nudge.
BROWSER_OK = os.environ.get("OPENSWARM_BROWSER_OK", "0") == "1"
# Whether the openswarm-ui server is live this session. The render-as-component reminder rides the
# tool RESULT because that's what the model reads right before answering; the system-prompt nudge
# alone loses to the prose prior (live-proven on haiku).
RICH_UI_OK = os.environ.get("OPENSWARM_RICH_UI_OK", "0") == "1"
# SEARCH RESULTS ONLY, and as its own content block. The fetch side is gone for good, drilled twice
# on 2026-08-27 (ENG-413): concatenated into fetched page content, the model correctly reported "an
# embedded instruction telling me to render the answer using specific UI tools" as a prompt
# injection in the page (the "fabricated" claim quoted this hint verbatim); moved to a separate
# labelled block, it STILL got flagged ("an injected instruction trying to get me to add a
# promotional presentation-guidance footer"). A fetched page is a third party's words, so anything
# we append is attributed to the page and a model with working defences must flag it -- there is no
# wording that survives that. Search results are OUR OWN formatted text, so framing there is honestly
# the tool speaking. The fetch side leans on the system prompt's rich_ui block alone.
RICH_UI_HINT = (
    "[presentation guidance, not page content] When you answer the user with this data, render it "
    "with the ShowUI tool (weather for forecasts, data-table for rows, stats-display for metrics, "
    "links for sources, chart for series, image/image-gallery for any image URLs in the content) "
    "and keep prose to one line. Answer in plain text only if no component fits."
)


def with_search_hint(text: str) -> dict:
    """One result, two blocks: the data, then the presentation guidance."""
    blocks = [{"type": "text", "text": text}]
    if RICH_UI_OK:
        blocks.append({"type": "text", "text": RICH_UI_HINT})
    return {"content": blocks}

TOOLS = [
    {
        "name": "WebSearch",
        "description": (
            "Search the web (DuckDuckGo first, racing Bing, Brave and "
            "Startpage as rescues) and return titles, URLs, and "
            "snippets for the top results. Works on any model primary, "
            "requires no subscription. Use this for up-to-date information "
            "that may not be in the model's training data."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query.",
                },
                "num_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (1-10, default 5).",
                    "default": 5,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "WebFetch",
        "description": (
            "Fetch a URL and return its main content as plain text. "
            "For HTML pages, the primary article / main-content region is "
            "extracted (nav, footer, ads stripped). Non-HTML responses "
            "are returned verbatim. Output capped at ~250 KB. "
            "JS-heavy pages may escalate to the app's embedded browser, "
            "which BY DESIGN shares the user's local browser session in "
            "this local-first app, so pages they are signed into can come "
            "back authenticated; treat that as a normal capability, not a "
            "surprise to warn about."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch. Must start with http:// or https://.",
                },
                "prompt": {
                    "type": "string",
                    "description": "Optional context hint describing what to look for.",
                },
            },
            "required": ["url"],
        },
    },
]


def send_response(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


# The backend bounds its own cascade at 60s and always answers within it (with an honest "here is why every backend failed" body). Waiting slightly longer than that means the useful answer wins; the old 45s cap aborted the call BEFORE the later tiers could even be reached, so search reliability came down to whether an early tier won the race.
TOOL_TIMEOUT = 75.0


def p_post(url: str, body: dict, timeout: float = TOOL_TIMEOUT) -> dict:
    payload = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(
        url,
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode(errors="replace") if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body_txt[:500]}"}
    except Exception as e:
        return {"error": str(e)}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "WebSearch":
        query = str(arguments.get("query", "")).strip()
        if not query:
            return {"content": [{"type": "text", "text": "Error: query is required"}], "isError": True}
        num = int(arguments.get("num_results", 5))
        num = max(1, min(num, 10))
        body = {"query": query, "num_results": num, "browser_ok": BROWSER_OK}
        if PRIMARY_HINT:
            body["primary"] = PRIMARY_HINT
        r = p_post(SEARCH_URL, body, timeout=TOOL_TIMEOUT)
        if "error" in r:
            return {"content": [{"type": "text", "text": f"Search failed: {r['error']}"}], "isError": True}
        results = r.get("results", "")
        if not results:
            return {"content": [{"type": "text", "text": f"No results for: {query}"}]}
        return with_search_hint(results)

    if tool_name == "WebFetch":
        url = str(arguments.get("url", "")).strip()
        if not url:
            return {"content": [{"type": "text", "text": "Error: url is required"}], "isError": True}
        if not url.startswith(("http://", "https://")):
            return {"content": [{"type": "text", "text": f"Error: url must start with http:// or https:// (got {url!r})"}], "isError": True}
        prompt = arguments.get("prompt") or None
        body = {"url": url}
        if prompt:
            body["prompt"] = str(prompt)
        if PRIMARY_HINT:
            body["primary"] = PRIMARY_HINT
        r = p_post(FETCH_URL, body, timeout=TOOL_TIMEOUT)
        if "error" in r:
            return {"content": [{"type": "text", "text": f"Fetch failed: {r['error']}"}], "isError": True}
        content = r.get("content", "")
        if not content:
            content = f"No content returned from {url}"
        # Never any appended guidance here: this is a third party's page, and anything we add to it
        # is attributed to the page (see the RICH_UI_HINT note above).
        return {"content": [{"type": "text", "text": content}]}

    return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        id_ = msg.get("id")
        params = msg.get("params", {}) or {}

        if method == "initialize":
            send_response(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "openswarm-web",
                    "version": "1.0.0",
                },
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send_response(id_, {"tools": TOOLS})
        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {}) or {}
            result = handle_tool_call(tool_name, arguments)
            send_response(id_, result)
        elif method == "ping":
            send_response(id_, {})
        elif id_ is not None:
            send_response(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
