import os
import subprocess
import json
import logging
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)

class AgentTools:
    @staticmethod
    def read_file(path: str) -> str:
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read()
        except Exception as e:
            return f"Error reading file: {e}"

    @staticmethod
    def write_file(path: str, content: str) -> str:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            return f"Successfully wrote to {path}"
        except Exception as e:
            return f"Error writing file: {e}"

    @staticmethod
    def list_files(path: str) -> str:
        try:
            files = os.listdir(path)
            return "\n".join(files)
        except Exception as e:
            return f"Error listing files: {e}"

    @staticmethod
    def run_command(command: str, cwd: Optional[str] = None) -> str:
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=60
            )
            return f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        except subprocess.TimeoutExpired:
            return "Command timed out after 60 seconds."
        except Exception as e:
            return f"Error running command: {e}"

    @staticmethod
    def get_tool_definitions() -> List[Dict[str, Any]]:
        return [
            {
                "name": "read_file",
                "description": "Read the content of a file",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to the file"}
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "write_file",
                "description": "Write content to a file",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to the file"},
                        "content": {"type": "string", "description": "Content to write"}
                    },
                    "required": ["path", "content"]
                }
            },
            {
                "name": "list_files",
                "description": "List files in a directory",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to the directory"}
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "run_command",
                "description": "Run a shell command",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Command to run"}
                    },
                    "required": ["command"]
                }
            }
        ]

    @classmethod
    def call_tool(cls, name: str, args: Dict[str, Any], cwd: Optional[str] = None) -> str:
        if name == "read_file":
            return cls.read_file(args["path"])
        elif name == "write_file":
            return cls.write_file(args["path"], args["content"])
        elif name == "list_files":
            return cls.list_files(args["path"])
        elif name == "run_command":
            return cls.run_command(args["command"], cwd=cwd)
        else:
            return f"Unknown tool: {name}"
