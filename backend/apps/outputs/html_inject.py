"""HTML data-injection + relative-URL token rewriting for served outputs.

The token rewrite (`_inject_token_into_relative_urls`) is a security boundary:
iframe sub-resource fetches drop the parent's ?token= query, so the serve
routes re-stamp it onto every relative href/src or they 401. Keep it wired to
the serve routes."""

import base64
import json
import logging
import re

from jsonschema import validate as schema_validate, ValidationError as SchemaValidationError

logger = logging.getLogger(__name__)

MODEL_MAP = {
    "sonnet": "claude-sonnet-4-20250514",
    "opus": "claude-opus-4-20250514",
    "haiku": "claude-haiku-4-5-20251001",
}


def _resolve_model(short_name: str) -> str:
    return MODEL_MAP.get(short_name, short_name)


def _get_anthropic_client(api_model: str | None = None):
    """Create an AsyncAnthropic client using the API key from app settings.

    When `api_model` is provided and carries a 9Router prefix (cc/, cx/, gc/),
    the client is pointed at 9Router so non-Anthropic aux calls don't 400 on
    api.anthropic.com. Without an api_model we fall back to the default
    connection-mode-driven client.
    """
    from backend.apps.settings.credentials import (
        get_anthropic_client,
        get_anthropic_client_for_model,
    )
    from backend.apps.settings.settings import load_settings
    settings = load_settings()
    if api_model:
        return get_anthropic_client_for_model(settings, api_model)
    return get_anthropic_client(settings)


def _validate_against_schema(data: dict, schema: dict) -> str | None:
    """Validate *data* against *schema*. Return an error string or None."""
    try:
        schema_validate(instance=data, schema=schema)
        return None
    except SchemaValidationError as exc:
        path = " -> ".join(str(p) for p in exc.absolute_path) if exc.absolute_path else "(root)"
        return f"Schema validation failed at {path}: {exc.message}"


def _build_data_injection(input_json: str, result_json: str, backend_url_json: str = "null") -> str:
    """Build a <script> tag that sets OUTPUT_INPUT / OUTPUT_BACKEND_RESULT /
    OUTPUT_BACKEND_URL and listens for postMessage updates.

    OUTPUT_BACKEND_URL is `null` when the app has no live `backend.py`
    process; otherwise it's `http://localhost:<port>` and app code can
    `fetch(window.OUTPUT_BACKEND_URL + '/route')` to hit the persistent
    backend's endpoints."""
    return (
        "<script>\n"
        "(function() {\n"
        "  window.OUTPUT_INPUT = " + input_json + ";\n"
        "  window.OUTPUT_BACKEND_RESULT = " + result_json + ";\n"
        "  window.OUTPUT_BACKEND_URL = " + backend_url_json + ";\n"
        "  window.addEventListener('message', function(e) {\n"
        "    if (e.data && e.data.type === 'OUTPUT_DATA') {\n"
        "      window.OUTPUT_INPUT = e.data.input || {};\n"
        "      window.OUTPUT_BACKEND_RESULT = e.data.backendResult || null;\n"
        "      if (e.data.backendUrl !== undefined) window.OUTPUT_BACKEND_URL = e.data.backendUrl;\n"
        "      window.dispatchEvent(new CustomEvent('output-data-ready'));\n"
        "    }\n"
        "  });\n"
        "})();\n"
        "</script>"
    )


def _inject_data_into_html(html: str, input_json: str = "{}", result_json: str = "null", backend_url_json: str = "null") -> str:
    injection = _build_data_injection(input_json, result_json, backend_url_json)
    if "</head>" in html:
        return html.replace("</head>", f"{injection}\n</head>", 1)
    if "<body" in html:
        return html.replace("<body", f"{injection}\n<body", 1)
    return f"{injection}\n{html}"


def _backend_url_for_workspace(workspace_id: str) -> str:
    """Return the JSON-encoded backend URL for the given workspace, or
    "null" if no runtime is active. Cheap inline lookup so serve_workspace_file
    doesn't have to think about it."""
    try:
        from backend.apps.outputs.runtime import manager as runtime_manager
        rt = runtime_manager.get(workspace_id)
        if rt and rt.running and rt.port:
            return json.dumps(f"http://127.0.0.1:{rt.port}")
    except Exception:
        logger.exception("backend url lookup failed for %s", workspace_id)
    return "null"


# URL schemes / prefixes that must NOT have ?token= appended. These are either
# external (CDNs, mailto) or non-network references that the auth middleware
# never sees. Anything else is treated as a same-origin relative URL pointing
# at our /api/outputs/.../serve/ subtree, which DOES need the token.
_ABSOLUTE_URL_PREFIXES = (
    "http://", "https://", "//", "data:", "blob:",
    "mailto:", "tel:", "javascript:", "about:", "#",
)

_HREF_SRC_ATTR_RE = re.compile(
    r"""(\s(?:href|src))\s*=\s*(["'])([^"']+)\2""",
    re.IGNORECASE,
)


def _inject_token_into_relative_urls(html: str, token: str) -> str:
    """Append `?token=<t>` to every relative href/src in the served HTML.

    Browsers strip the parent iframe URL's query string before resolving
    relative `<link href="styles.css">` / `<script src="x.js">`, so without
    this rewrite the sub-resource fetch lands at the auth middleware with no
    credentials and gets a 401. Idempotent: skips URLs that already carry a
    `token=` param. Skips absolute URLs (CDN, data:, etc.); see prefix list.
    """
    if not token:
        return html

    def _patch(match: re.Match) -> str:
        attr, quote, url = match.group(1), match.group(2), match.group(3)
        lowered = url.lower().lstrip()
        if lowered.startswith(_ABSOLUTE_URL_PREFIXES):
            return match.group(0)
        if "token=" in url:
            return match.group(0)
        # Split off any hash fragment so `?token=` lands in the query, not in
        # the fragment: `page.html?v=1#sec` → `page.html?v=1&token=X#sec`.
        hash_idx = url.find("#")
        if hash_idx >= 0:
            base, frag = url[:hash_idx], url[hash_idx:]
        else:
            base, frag = url, ""
        sep = "&" if "?" in base else "?"
        return f'{attr}={quote}{base}{sep}token={token}{frag}{quote}'

    return _HREF_SRC_ATTR_RE.sub(_patch, html)


def _decode_data_param(d: str) -> tuple[str, str]:
    """Decode the base64-encoded _d query param into (input_json, result_json)."""
    try:
        decoded = json.loads(base64.b64decode(d))
        input_json = json.dumps(decoded.get("i", {}))
        result_json = json.dumps(decoded.get("r", None))
        return input_json, result_json
    except Exception:
        return "{}", "null"
