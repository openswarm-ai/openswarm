"""AI-powered endpoints: vibe-code, auto-run, auto-run-agent."""

from __future__ import annotations

import json
import logging

from backend.apps.outputs.helpers import _validate_against_schema
from backend.apps.outputs.executor import execute_backend_code
from backend.apps.common.model_registry import resolve_model_id as _resolve_model
from backend.apps.outputs.models import (
    VibeCodeRequest, AutoRunRequest, AutoRunAgentRequest,
)

logger = logging.getLogger(__name__)


def _get_anthropic_client():
    from backend.apps.settings.credentials import get_anthropic_client
    from backend.apps.settings.settings import load_settings
    return get_anthropic_client(load_settings())


VIBE_CODE_SYSTEM_PROMPT = """\
You are an expert at building self-contained HTML/JS/CSS applications that run in an iframe.

The user will describe what they want, and you will generate:
1. **frontend_code**: A complete HTML document. React 18 is available via esm.sh CDN.
   - Use: <script type="importmap">{"imports":{"react":"https://esm.sh/react@18","react-dom/client":"https://esm.sh/react-dom@18/client"}}</script>
   - Input data is at window.OUTPUT_INPUT (object), backend result at window.OUTPUT_BACKEND_RESULT.
2. **input_schema**: A JSON Schema object defining the structured input.
3. **backend_code** (optional): Python code where input_data is a global dict and result is a global dict to assign to.
4. **name**: A short name for the view.
5. **description**: A one-sentence description.
6. **message**: A brief explanation of what you did/changed.

Return ONLY valid JSON with these keys. No markdown fences, no extra text.\
"""


async def vibe_code(body: VibeCodeRequest):
    from backend.apps.analytics.collector import record as _analytics
    _analytics("feature.used", {"feature": "vibe_code.used"})
    try:
        import anthropic
    except ImportError:
        return {
            "message": "anthropic SDK not installed. Install with: pip install anthropic",
            "frontend_code": body.current_frontend_code,
            "backend_code": body.current_backend_code,
            "input_schema": body.current_schema,
        }

    context_parts = []
    if body.current_frontend_code:
        context_parts.append(f"Current frontend code:\n```html\n{body.current_frontend_code}\n```")
    if body.current_backend_code:
        context_parts.append(f"Current backend code:\n```python\n{body.current_backend_code}\n```")
    if body.current_schema:
        context_parts.append(f"Current input schema:\n```json\n{body.current_schema}\n```")
    if body.name:
        context_parts.append(f"Current name: {body.name}")
    if body.description:
        context_parts.append(f"Current description: {body.description}")

    user_message = body.prompt
    if context_parts:
        user_message = "\n\n".join(context_parts) + "\n\nUser request: " + body.prompt

    client = _get_anthropic_client()
    try:
        resp = await client.messages.create(
            model="claude-sonnet-4-20250514", max_tokens=8000,
            system=VIBE_CODE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]
        result = json.loads(raw)
        return {
            "message": result.get("message", "View updated."),
            "frontend_code": result.get("frontend_code", body.current_frontend_code),
            "backend_code": result.get("backend_code", body.current_backend_code),
            "input_schema": result.get("input_schema", body.current_schema),
            "name": result.get("name", body.name),
            "description": result.get("description", body.description),
        }
    except json.JSONDecodeError:
        return {
            "message": "I generated code but couldn't parse the response. Please try again.",
            "frontend_code": body.current_frontend_code,
            "backend_code": body.current_backend_code,
            "input_schema": body.current_schema,
        }
    except Exception as e:
        logger.exception("Vibe code generation failed")
        return {
            "message": f"Error: {str(e)}",
            "frontend_code": body.current_frontend_code,
            "backend_code": body.current_backend_code,
            "input_schema": body.current_schema,
        }


AUTO_RUN_SYSTEM_PROMPT = """\
You generate structured JSON data matching a given schema.
The user provides a prompt describing what data to generate and a JSON Schema.
Return ONLY valid JSON that conforms to the schema. No markdown fences, no extra text, no explanation.
Every required field must be present. Use realistic, meaningful data.\
"""


async def auto_run_output(body: AutoRunRequest):
    try:
        import anthropic
    except ImportError:
        return {"error": "anthropic SDK not installed", "input_data": None, "backend_result": None}

    schema_str = json.dumps(body.input_schema, indent=2)
    user_message = f"Schema:\n```json\n{schema_str}\n```\n\nGenerate data for: {body.prompt}"

    api_model = _resolve_model(body.model)
    client = _get_anthropic_client()
    try:
        resp = await client.messages.create(
            model=api_model, max_tokens=4000,
            system=AUTO_RUN_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]
        input_data = json.loads(raw)

        validation_err = _validate_against_schema(input_data, body.input_schema)
        if validation_err:
            return {"input_data": input_data, "backend_result": None, "error": validation_err}

        backend_result = None
        stdout_text = None
        stderr_text = None
        error = None
        if body.backend_code:
            try:
                exec_result = await execute_backend_code(body.backend_code, input_data)
                backend_result = exec_result.result
                stdout_text = exec_result.stdout
                stderr_text = exec_result.stderr
            except Exception as e:
                error = str(e)

        return {"input_data": input_data, "backend_result": backend_result, "stdout": stdout_text, "stderr": stderr_text, "error": error}
    except json.JSONDecodeError:
        return {"error": "Failed to parse generated data as JSON", "input_data": None, "backend_result": None}
    except Exception as e:
        logger.exception("Auto-run failed")
        return {"error": str(e), "input_data": None, "backend_result": None}


AUTO_RUN_AGENT_SYSTEM_PROMPT = """\
You are a data-gathering agent. Your job is to use the available tools to collect \
real data, then render it into a structured View.

You have access to MCP tools (e.g. Gmail, calendar, etc.) that let you fetch live data. \
Use them as needed to fulfil the user's request.

When you have gathered enough data, call the **RenderOutput** tool with:
- `output_id`: `{output_id}`
- `input_data`: a JSON object conforming to this schema:
```json
{schema}
```

Do NOT fabricate data. Use the tools to get real information, then structure it to match \
the schema above. If a tool call fails, report the error clearly.\
"""


async def auto_run_agent(body: AutoRunAgentRequest):
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.mcp_builder import FULL_TOOLS
    from backend.apps.agents.models import AgentConfig
    from backend.apps.outputs.outputs import _load

    output = _load(body.output_id)
    schema_str = json.dumps(body.input_schema or output.input_schema, indent=2)

    system_prompt = AUTO_RUN_AGENT_SYSTEM_PROMPT.format(
        output_id=body.output_id, schema=schema_str,
    )

    allowed_tools = list(FULL_TOOLS)
    for tool_name in body.forced_tools:
        if tool_name not in allowed_tools:
            allowed_tools.append(tool_name)

    config = AgentConfig(
        name=f"AutoRun: {output.name}", model=body.model,
        mode="agent", system_prompt=system_prompt,
        allowed_tools=allowed_tools, max_turns=20,
    )

    session = await agent_manager.launch_agent(config)
    await agent_manager.send_message(
        session.id, body.prompt,
        context_paths=body.context_paths if body.context_paths else None,
        forced_tools=body.forced_tools if body.forced_tools else None,
    )
    return {"session_id": session.id}


async def cleanup_auto_run_agent(session_id: str):
    from backend.apps.agents.agent_manager import agent_manager
    try:
        await agent_manager.delete_session(session_id)
    except Exception as e:
        logger.warning(f"Auto-run agent cleanup failed for {session_id}: {e}")
    return {"ok": True}
