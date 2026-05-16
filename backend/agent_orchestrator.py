import asyncio
import json
import logging
from typing import List, Dict, Any, Optional

from backend.providers.base import get_provider, BaseProvider
from backend.agent_tools import AgentTools

# Optional C-extension fallback
try:
    import performance
except ImportError:
    class PerformanceMock:
        @staticmethod
        def estimate_tokens(text: str) -> int:
            return len(text) // 4
    performance = PerformanceMock()

logger = logging.getLogger(__name__)

class AgentOrchestrator:
    def __init__(self, session_id: str, provider: BaseProvider, model: str, cwd: str, context_window: int = 128000):
        self.session_id = session_id
        self.provider = provider
        self.model = model
        self.cwd = cwd
        self.messages: List[Dict[str, Any]] = []
        self.max_iterations = 10
        self.sub_agents: List['AgentOrchestrator'] = []
        self.tools = AgentTools(self)
        self.context_window = context_window
        self.summary: Optional[str] = None

    async def run(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        self.messages.append({"role": "user", "content": prompt})

        for i in range(self.max_iterations):
            await self._manage_context()

            logger.info(f"Iteration {i+1} for session {self.session_id}")

            effective_system = system_prompt or ""
            if self.summary:
                effective_system += f"\n\nSummary of earlier conversation:\n{self.summary}"

            response = await self.provider.chat(
                model=self.model,
                messages=self.messages,
                system=effective_system,
                tools=self.tools.get_tool_definitions()
            )

            if response.status != 200:
                return f"Error from provider: {response.body}"

            msg = self._extract_assistant_message(response.body)
            self.messages.append(msg)

            tool_calls = self._extract_tool_calls(msg)
            if not tool_calls:
                return self._extract_text(msg)

            for tool_call in tool_calls:
                tool_name = tool_call["name"]
                tool_args = tool_call["arguments"]
                result = await self.tools.call_tool(tool_name, tool_args)

                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.get("id", "none"),
                    "name": tool_name,
                    "content": result
                })

        return "Reached maximum iterations."

    async def _manage_context(self):
        total_content = "".join([str(m.get("content", "")) for m in self.messages])
        estimated_tokens = performance.estimate_tokens(total_content)

        if estimated_tokens > (self.context_window * 0.75):
            logger.info(f"Context pressure detected ({estimated_tokens} tokens). Summarizing...")
            await self._summarize_context()

    async def _summarize_context(self):
        if len(self.messages) < 4: return
        to_summarize = self.messages[1:-2]
        keep_messages = [self.messages[0]] + self.messages[-2:]

        summary_prompt = "Please summarize the following conversation concisely, retaining all key decisions, findings, and technical details:\n\n"
        for m in to_summarize:
            summary_prompt += f"{m['role'].upper()}: {m.get('content', '')}\n"

        resp = await self.provider.chat(
            model=self.model,
            messages=[{"role": "user", "content": summary_prompt}]
        )

        if resp.status == 200:
            new_summary = self._extract_text(self._extract_assistant_message(resp.body))
            if self.summary:
                self.summary = f"{self.summary}\n\nThen: {new_summary}"
            else:
                self.summary = new_summary

            self.messages = keep_messages
            logger.info("Context summarized and compacted.")

    def _extract_assistant_message(self, body: Any) -> Dict[str, Any]:
        """Robust extraction for different provider formats."""
        # OpenAI Format
        if "choices" in body and body["choices"]:
            return body["choices"][0]["message"]

        # Anthropic Format
        if "content" in body and isinstance(body["content"], list):
            return {"role": "assistant", "content": body["content"]}

        # Gemini Format
        if "candidates" in body and body["candidates"]:
            cand = body["candidates"][0]
            if "content" in cand:
                parts = cand["content"].get("parts", [])
                text = ""
                tool_calls = []
                for p in parts:
                    if "text" in p: text += p["text"]
                    if "functionCall" in p:
                        fc = p["functionCall"]
                        tool_calls.append({
                            "id": "gemini_call", # Gemini doesn't always provide an ID in simple format
                            "type": "function",
                            "function": {"name": fc["name"], "arguments": json.dumps(fc["args"])}
                        })
                msg = {"role": "assistant", "content": text}
                if tool_calls: msg["tool_calls"] = tool_calls
                return msg

        # Cohere Format
        if "text" in body and "generation_id" in body:
            return {"role": "assistant", "content": body["text"]}

        return {"role": "assistant", "content": str(body)}

    def _extract_tool_calls(self, msg: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Unified tool call extraction."""
        # Standard OpenAI/OpenRouter format
        if "tool_calls" in msg and msg["tool_calls"]:
            return [{"id": tc["id"], "name": tc["function"]["name"], "arguments": json.loads(tc["function"]["arguments"])} for tc in msg["tool_calls"]]

        # Anthropic format
        if isinstance(msg.get("content"), list):
            tool_calls = []
            for block in msg["content"]:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_calls.append({"id": block["id"], "name": block["name"], "arguments": block["input"]})
            return tool_calls

        return []

    def _extract_text(self, msg: Dict[str, Any]) -> str:
        content = msg.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join([b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"])
        return str(content)
