"""AI-powered endpoints: vibe-code, auto-run, auto-run-agent."""

from __future__ import annotations

import json
import logging

from backend.apps.outputs.helpers import _validate_against_schema
from backend.apps.outputs.executor import execute_backend_code
from backend.apps.common.model_registry import resolve_model_id as _resolve_model
from backend.apps.outputs.models import (
    AutoRunRequest, AutoRunAgentRequest,
)
from backend.apps.settings.credentials import get_anthropic_client
from backend.apps.settings.settings import load_settings
from backend.apps.common.llm_helpers import _resolve_model as _resolve_9r
from backend.apps.settings.settings import load_settings as _ls
from backend.apps.agents.manager.agent_manager import agent_manager
from backend.apps.agents.execution.mcp_builder import FULL_TOOLS
from backend.apps.agents.models import AgentConfig

logger = logging.getLogger(__name__)


def _get_anthropic_client():
    return get_anthropic_client(load_settings())


AUTO_RUN_SYSTEM_PROMPT = """\
You generate structured JSON data matching a given schema.
The user provides a prompt describing what data to generate and a JSON Schema.
Return ONLY valid JSON that conforms to the schema. No markdown fences, no extra text, no explanation.
Every required field must be present. Use realistic, meaningful data.\
"""


async def auto_run_output(body: AutoRunRequest):

    schema_str = json.dumps(body.input_schema, indent=2)
    user_message = f"Schema:\n```json\n{schema_str}\n```\n\nGenerate data for: {body.prompt}"

    api_model = _resolve_model(body.model)
    api_model = _resolve_9r(api_model, _ls())
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
    try:
        await agent_manager.delete_session(session_id)
    except Exception as e:
        logger.warning(f"Auto-run agent cleanup failed for {session_id}: {e}")
    return {"ok": True}
