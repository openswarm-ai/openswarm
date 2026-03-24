"""System tools: Bash and AskUserQuestion."""

from __future__ import annotations

import asyncio

from backend.apps.agents.tools.base import BaseTool, ToolContext

_MAX_OUTPUT_BYTES = 100 * 1024  # ~100 KB cap


class BashTool(BaseTool):
    name = "Bash"
    description = (
        "Execute a shell command and return its output. The command runs in "
        "the session's working directory. Supports an optional timeout "
        "(default 120 000 ms). Stdout and stderr are captured and returned."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute.",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in milliseconds (default 120000, max 600000).",
                    "default": 120000,
                },
                "description": {
                    "type": "string",
                    "description": "Optional human-readable description of what this command does.",
                },
            },
            "required": ["command"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        command: str = input_data["command"]
        timeout_ms: int = min(input_data.get("timeout", 120000), 600000)
        timeout_s: float = timeout_ms / 1000.0

        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=context.cwd,
            )
        except Exception as exc:
            return [{"type": "text", "text": f"Error starting command: {exc}"}]

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            # Attempt to kill the process
            try:
                proc.kill()
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5)
            except Exception:
                stdout, stderr = b"", b""

            partial = self._decode(stdout, stderr)
            msg = (
                f"Command timed out after {timeout_ms}ms.\n"
                f"Partial output:\n{partial}"
            )
            return [{"type": "text", "text": self._truncate(msg)}]
        except Exception as exc:
            return [{"type": "text", "text": f"Error executing command: {exc}"}]

        output = self._decode(stdout, stderr)

        if proc.returncode != 0:
            output = f"Exit code: {proc.returncode}\n{output}"

        if not output.strip():
            output = f"(command completed with exit code {proc.returncode})"

        return [{"type": "text", "text": self._truncate(output)}]

    @staticmethod
    def _decode(stdout: bytes, stderr: bytes) -> str:
        parts: list[str] = []
        if stdout:
            parts.append(stdout.decode("utf-8", errors="replace"))
        if stderr:
            parts.append(stderr.decode("utf-8", errors="replace"))
        return "\n".join(parts)

    @staticmethod
    def _truncate(text: str) -> str:
        if len(text) > _MAX_OUTPUT_BYTES:
            return text[:_MAX_OUTPUT_BYTES] + "\n... (output truncated)"
        return text


class AskUserQuestionTool(BaseTool):
    name = "AskUserQuestion"
    description = (
        "Ask the user a clarifying question. The actual blocking/HITL "
        "interaction is handled by the agent loop's hitl_handler; this tool "
        "simply surfaces the question text."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question to ask the user.",
                },
            },
            "required": ["question"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        question: str = input_data.get("question", "")
        return [{"type": "text", "text": question}]
