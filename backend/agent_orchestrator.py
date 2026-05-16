import asyncio
import json
import logging
from typing import List, Dict, Any, Optional

from backend.providers.base import get_provider, BaseProvider
from backend.agent_tools import AgentTools

logger = logging.getLogger(__name__)

class AgentOrchestrator:
    def __init__(self, session_id: str, provider: BaseProvider, model: str, cwd: str):
        self.session_id = session_id
        self.provider = provider
        self.model = model
        self.cwd = cwd
        self.messages: List[Dict[str, Any]] = []
        self.max_iterations = 10

    async def run(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        self.messages.append({"role": "user", "content": prompt})

        for i in range(self.max_iterations):
            logger.info(f"Iteration {i+1} for session {self.session_id}")

            # 1. Get completion from LLM
            response = await self.provider.chat(
                model=self.model,
                messages=self.messages,
                system=system_prompt,
                tools=AgentTools.get_tool_definitions()
            )

            if response.status != 200:
                return f"Error from provider: {response.body}"

            # 2. Parse response (Simplified for now, assuming OpenAI/Anthropic format)
            # This needs to be robust for all 30+ providers
            msg = self._extract_assistant_message(response.body)
            self.messages.append(msg)

            # 3. Check for tool calls
            tool_calls = self._extract_tool_calls(msg)
            if not tool_calls:
                return self._extract_text(msg)

            # 4. Execute tool calls and add results
            for tool_call in tool_calls:
                tool_name = tool_call["name"]
                tool_args = tool_call["arguments"]
                logger.info(f"Calling tool {tool_name} with args {tool_args}")

                result = AgentTools.call_tool(tool_name, tool_args, cwd=self.cwd)

                # Add tool result to history
                # Format depends on provider, but let's use a common one
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.get("id", "none"),
                    "name": tool_name,
                    "content": result
                })

        return "Reached maximum iterations."

    def _extract_assistant_message(self, body: Any) -> Dict[str, Any]:
        # Implementation depends on the provider response format
        if "choices" in body: # OpenAI format
            return body["choices"][0]["message"]
        elif "content" in body: # Anthropic format
            content = body["content"]
            # Convert content list/str to common format
            return {"role": "assistant", "content": content}
        return {"role": "assistant", "content": str(body)}

    def _extract_tool_calls(self, msg: Dict[str, Any]) -> List[Dict[str, Any]]:
        # Extract tool calls from message
        if "tool_calls" in msg:
            return [{"id": tc["id"], "name": tc["function"]["name"], "arguments": json.loads(tc["function"]["arguments"])} for tc in msg["tool_calls"]]
        # Handle Anthropic style tool use blocks
        if isinstance(msg.get("content"), list):
            tool_calls = []
            for block in msg["content"]:
                if block.get("type") == "tool_use":
                    tool_calls.append({"id": block["id"], "name": block["name"], "arguments": block["input"]})
            return tool_calls
        return []

    def _extract_text(self, msg: Dict[str, Any]) -> str:
        content = msg.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join([b.get("text", "") for b in content if b.get("type") == "text"])
        return str(content)
