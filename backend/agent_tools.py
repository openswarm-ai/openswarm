import os
import subprocess
import json
import logging
import sys
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)

class AgentTools:
    def __init__(self, orchestrator=None):
        self.orchestrator = orchestrator

    def read_file(self, path: str) -> str:
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read()
        except Exception as e:
            return f"Error reading file: {e}"

    def write_file(self, path: str, content: str) -> str:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            return f"Successfully wrote to {path}"
        except Exception as e:
            return f"Error writing file: {e}"

    def list_files(self, path: str) -> str:
        try:
            files = os.listdir(path)
            return "\n".join(files)
        except Exception as e:
            return f"Error listing files: {e}"

    def run_command(self, command: str, cwd: Optional[str] = None) -> str:
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=cwd or (self.orchestrator.cwd if self.orchestrator else None),
                capture_output=True,
                text=True,
                timeout=60
            )
            return f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        except subprocess.TimeoutExpired:
            return "Command timed out after 60 seconds."
        except Exception as e:
            return f"Error running command: {e}"

    async def create_sub_agent(self, prompt: str, model: Optional[str] = None) -> str:
        if not self.orchestrator:
            return "Error: Sub-agent creation requires an active orchestrator."
        from backend.agent_orchestrator import AgentOrchestrator
        sub_id = f"{self.orchestrator.session_id}_sub_{len(self.orchestrator.sub_agents)}"
        sub_model = model or self.orchestrator.model
        logger.info(f"Spawning sub-agent {sub_id} with model {sub_model}")
        sub_orchestrator = AgentOrchestrator(
            session_id=sub_id,
            provider=self.orchestrator.provider,
            model=sub_model,
            cwd=self.orchestrator.cwd
        )
        self.orchestrator.sub_agents.append(sub_orchestrator)
        result = await sub_orchestrator.run(prompt)
        return f"Sub-agent {sub_id} response: {result}"

    def git_operation(self, operation: str, args: List[str]) -> str:
        cmd = ["git", operation] + args
        return self.run_command(" ".join(cmd))

    def recursive_search(self, pattern: str, path: str = ".") -> str:
        try:
            matches = []
            for root, dirs, files in os.walk(path):
                for file in files:
                    if pattern in file:
                        matches.append(os.path.join(root, file))
            return "\n".join(matches) if matches else "No matches found."
        except Exception as e:
            return f"Error during search: {e}"

    def get_system_info(self) -> str:
        import platform
        info = {
            "os": platform.system(),
            "os_release": platform.release(),
            "python_version": sys.version,
            "cwd": os.getcwd()
        }
        return json.dumps(info, indent=2)

    def get_tool_definitions(self) -> List[Dict[str, Any]]:
        return [
            {"name": "read_file", "description": "Read file content", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
            {"name": "write_file", "description": "Write file content", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
            {"name": "list_files", "description": "List files in directory", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
            {"name": "run_command", "description": "Run shell command", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
            {"name": "create_sub_agent", "description": "Spawn a sub-agent", "parameters": {"type": "object", "properties": {"prompt": {"type": "string"}, "model": {"type": "string"}}, "required": ["prompt"]}},
            {"name": "git_operation", "description": "Perform Git tasks", "parameters": {"type": "object", "properties": {"operation": {"type": "string", "enum": ["status", "diff", "branch", "log", "add", "commit"]}, "args": {"type": "array", "items": {"type": "string"}}}, "required": ["operation", "args"]}},
            {"name": "recursive_search", "description": "Search files recursively", "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"]}},
            {"name": "get_system_info", "description": "Get host system information", "parameters": {"type": "object", "properties": {}}}
        ]

    async def call_tool(self, name: str, args: Dict[str, Any]) -> str:
        if name == "read_file": return self.read_file(args["path"])
        elif name == "write_file": return self.write_file(args["path"], args["content"])
        elif name == "list_files": return self.list_files(args["path"])
        elif name == "run_command": return self.run_command(args["command"])
        elif name == "create_sub_agent": return await self.create_sub_agent(args["prompt"], args.get("model"))
        elif name == "git_operation": return self.git_operation(args["operation"], args["args"])
        elif name == "recursive_search": return self.recursive_search(args["pattern"], args.get("path", "."))
        elif name == "get_system_info": return self.get_system_info()
        else: return f"Unknown tool: {name}"
