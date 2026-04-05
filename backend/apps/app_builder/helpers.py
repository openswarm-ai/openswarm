"""Pure helpers for data injection, validation, and directory walking."""

from __future__ import annotations

import base64
import json
import os

from jsonschema import validate as schema_validate, ValidationError as SchemaValidationError


def validate_against_schema(data: dict, schema: dict) -> str | None:
    """Validate *data* against *schema*. Return an error string or None."""
    try:
        schema_validate(instance=data, schema=schema)
        return None
    except SchemaValidationError as exc:
        path = " -> ".join(str(p) for p in exc.absolute_path) if exc.absolute_path else "(root)"
        return f"Schema validation failed at {path}: {exc.message}"


def build_data_injection(input_json: str, result_json: str) -> str:
    return (
        "<script>\n"
        "(function() {\n"
        "  window.APP_BUILDER_INPUT = " + input_json + ";\n"
        "  window.APP_BUILDER_BACKEND_RESULT = " + result_json + ";\n"
        "  window.addEventListener('message', function(e) {\n"
        "    if (e.data && e.data.type === 'APP_BUILDER_DATA') {\n"
        "      window.APP_BUILDER_INPUT = e.data.input || {};\n"
        "      window.APP_BUILDER_BACKEND_RESULT = e.data.backendResult || null;\n"
        "      window.dispatchEvent(new CustomEvent('app-builder-data-ready'));\n"
        "    }\n"
        "  });\n"
        "})();\n"
        "</script>"
    )


def inject_data_into_html(html: str, input_json: str = "{}", result_json: str = "null") -> str:
    injection = build_data_injection(input_json, result_json)
    if "</head>" in html:
        return html.replace("</head>", f"{injection}\n</head>", 1)
    if "<body" in html:
        return html.replace("<body", f"{injection}\n<body", 1)
    return f"{injection}\n{html}"


def decode_data_param(d: str) -> tuple[str, str]:
    try:
        decoded = json.loads(base64.b64decode(d))
        input_json = json.dumps(decoded.get("i", {}))
        result_json = json.dumps(decoded.get("r", None))
        return input_json, result_json
    except Exception:
        return "{}", "null"


def walk_directory(folder: str) -> dict[str, str]:
    files: dict[str, str] = {}
    if not os.path.isdir(folder):
        return files
    for root, _dirs, filenames in os.walk(folder):
        for fname in filenames:
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, folder)
            try:
                with open(full_path) as f:
                    files[rel_path] = f.read()
            except Exception:
                pass
    return files
