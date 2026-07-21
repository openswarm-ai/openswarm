#!/usr/bin/env python3
"""Stdio MCP server exposing ShowUI: render a rich inline component in the chat transcript.

Display-only. The frontend renders the component straight from the tool_call input it already
has in the transcript, so this server just validates the payload and acknowledges; there is no
backend round-trip and nothing here can mutate state.
"""

import json
import os
import sys
import urllib.error
import urllib.request

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
WAIT_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/ui-requests/wait"
ASK_TIMEOUT_S = 600

MAX_PROPS_BYTES = 20_000

# Hints + JSON Schemas for the vendored tool-ui set are GENERATED from the shipped zod contracts
# (frontend/scripts/gen-toolui-hints.ts writes toolui_schemas.json next to this file). Loading them
# here means the tool description and the server-side validation can never drift from what renders.
def p_load_generated():
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "toolui_schemas.json")) as f:
            return json.load(f)
    except Exception:
        return {}


GENERATED = p_load_generated()

COMPONENT_SPECS = {
    "weather": "props: {id?: str, location: str, temp: number, unit?: 'F'|'C', high?: number, low?: number, condition?: str, forecast?: [{day: str, condition?: str, high?: number, low?: number}] (max 7)}",
    "stats": "props: {title?: str, stats: [{label: str, value: str, delta?: str, direction?: 'up'|'down'}] (max 8)}",
    "links": "props: {links: [{title: str, url: str, description?: str}] (max 10)}",
}

COMPONENT_SPECS.update({name: entry["hint"] for name, entry in GENERATED.items()})


INTERACTIVE_COMPONENTS = (
    "option-list", "question-flow", "parameter-slider", "preferences-panel", "approval-card",
)

TOOLS = [
    {
        "name": "AskUI",
        "description": (
            "Render an INTERACTIVE component in the chat and WAIT for the user's answer (up to 10 "
            "minutes); the tool result is their response. Use this instead of plain-text questions "
            "when the choice fits a component. Components: "
            + ", ".join(f"'{name}'" for name in INTERACTIVE_COMPONENTS)
            + ". Props follow the same shapes as ShowUI (props.id is REQUIRED, it correlates the "
            "answer). The response contains the action taken and the user's selection/values. "
            "The user may also answer in their own words instead of picking an option; then the "
            "result is {action: 'free_text', value: {text}}, treat that text as their answer."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "component": {
                    "type": "string",
                    "enum": list(INTERACTIVE_COMPONENTS),
                    "description": "Which interactive component to render.",
                },
                "props": {
                    "type": "object",
                    "description": "Data for the component; must include a stable string id.",
                },
            },
            "required": ["component", "props"],
        },
    },
    {
        "name": "ShowUI",
        "description": (
            "Render a rich inline UI component in the chat instead of describing data as text. "
            "Use it whenever a result fits one of the shapes. Supported components:\n"
            + "\n".join(f"- '{name}': {spec}" for name, spec in COMPONENT_SPECS.items())
            + "\nCall it with the component name and a props object matching that shape. "
            "The component renders in place of raw text; still give a one-line text summary after. "
            "LIVE UPDATES: calling ShowUI again with the SAME component and props.id updates that "
            "card in place. Use this to advance progress-tracker/plan step statuses AS you complete "
            "each step of real work, or to refresh data; never mint a new id for an update."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "component": {
                    "type": "string",
                    "enum": list(COMPONENT_SPECS.keys()),
                    "description": "Which component to render.",
                },
                "props": {
                    "type": "object",
                    "description": "Data for the component, matching its documented shape.",
                },
            },
            "required": ["component", "props"],
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


def validate(component: str, props: dict) -> str:
    if component not in COMPONENT_SPECS:
        return f"Unknown component {component!r}. Supported: {', '.join(COMPONENT_SPECS)}."
    try:
        size = len(json.dumps(props))
    except (TypeError, ValueError):
        return "props must be JSON-serializable."
    if size > MAX_PROPS_BYTES:
        return f"props too large ({size} bytes; max {MAX_PROPS_BYTES})."
    if component == "weather" and not (isinstance(props.get("location"), str) and isinstance(props.get("temp"), (int, float))):
        return f"weather needs at least location + temp. {COMPONENT_SPECS['weather']}"
    if component == "stats" and not (isinstance(props.get("stats"), list) and props["stats"]):
        return f"stats needs a non-empty stats list. {COMPONENT_SPECS['stats']}"
    if component == "links" and not (isinstance(props.get("links"), list) and props["links"]):
        return f"links needs a non-empty links list. {COMPONENT_SPECS['links']}"
    # Vendored components: validate against the GENERATED JSON Schema so a bad payload comes back
    # as a teaching error the model can fix in-turn, instead of a dead render it never hears about.
    entry = GENERATED.get(component)
    if entry and isinstance(entry.get("schema"), dict):
        errors = []
        p_check(props, entry["schema"], "props", errors)
        if errors:
            return (
                f"{component} payload invalid: " + "; ".join(errors[:4])
                + f". Full shape: {COMPONENT_SPECS[component]}. Fix the props and call the tool again."
            )
    return ""


def p_type_ok(value, t: str) -> bool:
    if t == "string":
        return isinstance(value, str)
    if t in ("number", "integer"):
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "boolean":
        return isinstance(value, bool)
    if t == "object":
        return isinstance(value, dict)
    if t == "array":
        return isinstance(value, list)
    if t == "null":
        return value is None
    return True


def p_check(value, schema: dict, path: str, errors: list) -> None:
    """Minimal JSON Schema walk: required keys, primitive types, enums, anyOf. Anything it can't
    interpret passes; the client zod contract stays the deep authority."""
    if len(errors) >= 6 or not isinstance(schema, dict):
        return
    branches = schema.get("anyOf")
    if isinstance(branches, list) and branches:
        for branch in branches:
            trial = []
            p_check(value, branch, path, trial)
            if not trial:
                return
        errors.append(f"{path} matches none of its allowed shapes")
        return
    enum = schema.get("enum")
    if isinstance(enum, list) and enum and value not in enum:
        errors.append(f"{path} must be one of {enum[:6]}")
        return
    t = schema.get("type")
    if isinstance(t, str) and not p_type_ok(value, t):
        errors.append(f"{path} must be a {t}")
        return
    if t == "object" and isinstance(value, dict):
        for key in schema.get("required", []) or []:
            if key not in value:
                errors.append(f"{path}.{key} is required")
        props = schema.get("properties") or {}
        for key, sub in props.items():
            if key in value:
                p_check(value[key], sub, f"{path}.{key}", errors)
    elif t == "array" and isinstance(value, list):
        items = schema.get("items")
        if isinstance(items, dict):
            for i, item in enumerate(value):
                p_check(item, items, f"{path}[{i}]", errors)


def p_post(url: str, body: dict, timeout: float) -> dict:
    payload = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode(errors="replace") if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body_txt[:300]}"}
    except Exception as e:
        return {"error": str(e)}


def handle_ask_ui(arguments: dict) -> dict:
    component = str(arguments.get("component", "")).strip()
    props = arguments.get("props")
    if not isinstance(props, dict):
        return {"content": [{"type": "text", "text": "props must be an object."}], "isError": True}
    if component not in INTERACTIVE_COMPONENTS:
        return {"content": [{"type": "text", "text": f"AskUI only supports: {', '.join(INTERACTIVE_COMPONENTS)}. Use ShowUI for display-only components."}], "isError": True}
    component_id = str(props.get("id", "")).strip()
    if not component_id:
        return {"content": [{"type": "text", "text": "props.id (a stable string) is required so the answer can be correlated."}], "isError": True}
    problem = validate(component, props)
    if problem:
        return {"content": [{"type": "text", "text": f"Not rendered: {problem}"}], "isError": True}
    r = p_post(WAIT_URL, {"session_id": PARENT_SESSION_ID, "component_id": component_id, "timeout_s": ASK_TIMEOUT_S}, timeout=ASK_TIMEOUT_S + 20)
    if "error" in r:
        return {"content": [{"type": "text", "text": f"AskUI failed: {r['error']}"}], "isError": True}
    if not r.get("ok"):
        return {"content": [{"type": "text", "text": "The user didn't respond within 10 minutes. Continue without their input or ask again."}], "isError": True}
    return {"content": [{"type": "text", "text": json.dumps(r.get("response"))}]}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "AskUI":
        return handle_ask_ui(arguments)
    if tool_name != "ShowUI":
        return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}
    component = str(arguments.get("component", "")).strip()
    props = arguments.get("props")
    if not isinstance(props, dict):
        return {"content": [{"type": "text", "text": "props must be an object."}], "isError": True}
    problem = validate(component, props)
    if problem:
        return {"content": [{"type": "text", "text": f"Not rendered: {problem}"}], "isError": True}
    return {"content": [{"type": "text", "text": f"Rendered a '{component}' component inline."}]}


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
                    "name": "openswarm-ui",
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
