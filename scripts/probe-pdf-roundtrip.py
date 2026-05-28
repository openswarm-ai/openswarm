#!/usr/bin/env python3
"""Empirical end-to-end PDF roundtrip probe.

Verifies that an Anthropic-shape `document` content block flows through
anthropic_proxy → 9router → upstream provider → response. Use one of
the model presets below; the script picks the right backend lane.

Usage:
  1. Configure the matching API key in OpenSwarm Settings (or env).
  2. Start the dev stack: bash run.sh
  3. python3 scripts/probe-pdf-roundtrip.py <provider> <pdf-path>

Providers:
  anthropic    direct Anthropic API key (claude-opus-4-7)
  gemini       direct Google AI Studio key (gemini-3-pro-preview)
  openai       direct OpenAI key (gpt-5.5)
  openrouter   OpenRouter free model with file-parser plugin (openrouter/openai/gpt-5)

A 2xx response with non-empty content blocks confirms the full
translator chain works for that provider. A 4xx with a provider-specific
error message tells you exactly which step broke.
"""
import base64
import json
import os
import sys
import urllib.request
import urllib.error

# Each model_id below targets a SPECIFIC routing lane so a probe failure
# pinpoints exactly which auth path is broken. "anthropic" uses the SDK
# model_id form that lands on the cc/ OAuth subscription lane; if you
# only have an Anthropic API key (no Pro subscription), use the explicit
# direct-API model_id by editing PRESETS or pass --model.
PRESETS = {
    "anthropic": "claude-opus-4-7",  # cc/ lane via 9router; needs Pro OAuth
    "anthropic-api": "claude-opus-4-7",  # same wire shape; routes by settings
    "gemini": "gemini-3-pro-preview",
    "openai": "gpt-5.5",
    "openrouter": "openrouter/openai/gpt-5",
}
PROVIDER_CAPS_MB = {
    "anthropic": 28,
    "gemini": 14,
    "openai": 45,
    "openrouter": 45,
}


def probe(provider: str, pdf_path: str) -> int:
    if provider not in PRESETS:
        print(f"FAIL: unknown provider '{provider}'. Use one of: {', '.join(PRESETS)}", file=sys.stderr)
        return 2
    if not os.path.isfile(pdf_path):
        print(f"FAIL: file not found: {pdf_path}", file=sys.stderr)
        return 2
    size = os.path.getsize(pdf_path)
    cap = PROVIDER_CAPS_MB[provider] * 1024 * 1024
    if size > cap:
        print(f"FAIL: PDF is {size // (1024*1024)} MB, over {provider}'s {PROVIDER_CAPS_MB[provider]} MB inline cap.", file=sys.stderr)
        return 2

    with open(pdf_path, "rb") as fh:
        data_b64 = base64.b64encode(fh.read()).decode("ascii")

    token_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "backend", "data", "auth.token",
    )
    if not os.path.exists(token_path):
        print(f"FAIL: auth.token not found at {token_path}. Start the dev backend first (bash run.sh).", file=sys.stderr)
        return 2
    with open(token_path) as fh:
        token = fh.read().strip()

    body = {
        "model": PRESETS[provider],
        "max_tokens": 300,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "In one sentence, what is this PDF about?"},
                {"type": "document", "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": data_b64,
                }},
            ],
        }],
    }

    req = urllib.request.Request(
        "http://127.0.0.1:8324/api/anthropic-proxy/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": token,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = resp.status
            payload = resp.read(4096).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        payload = e.read(4096).decode("utf-8", errors="replace")
    except Exception as e:
        print(f"FAIL: network error: {e}", file=sys.stderr)
        return 3

    print(f"=== {provider} ({PRESETS[provider]}) ===")
    print(f"HTTP {status}")
    print(payload[:800])
    if 200 <= status < 300:
        if any(k in payload.lower() for k in ("content", "text", "completion", "choice")):
            print(f"\n✓ {provider} accepted the PDF document block end-to-end.")
            return 0
        print(f"\n⚠ HTTP 200 but no recognizable content; inspect response above.")
        return 1
    print(f"\n✗ {provider} PDF roundtrip failed at HTTP {status}. See response above.")
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"usage: probe-pdf-roundtrip.py <{'|'.join(PRESETS)}> path/to/test.pdf", file=sys.stderr)
        sys.exit(2)
    sys.exit(probe(sys.argv[1], sys.argv[2]))
