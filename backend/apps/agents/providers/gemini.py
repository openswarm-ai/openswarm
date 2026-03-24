"""Gemini provider adapter using the new google-genai SDK."""

from __future__ import annotations

import base64
import json
import logging
from copy import deepcopy
from typing import Any, AsyncIterator
from uuid import uuid4

from google import genai
from google.genai import types

from backend.apps.agents.providers.base import (
    BaseProvider,
    ContentBlock,
    ModelResponse,
    ProviderMessage,
    StreamEvent,
    ToolCall,
    ToolSchema,
)

logger = logging.getLogger(__name__)

MODEL_MAP = {
    "flash": "gemini-2.5-flash",
    "pro": "gemini-2.5-pro",
}

# JSON Schema keywords that Gemini does not support
_UNSUPPORTED_VALIDATION_KEYS = frozenset({
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "multipleOf",
    "format",
    "const",
})

_UNSUPPORTED_STRUCTURAL_KEYS = frozenset({
    "$ref",
    "$defs",
    "patternProperties",
})


# ---------------------------------------------------------------------------
# Schema cleaning — port of OpenClaw's clean-for-gemini.ts logic
# ---------------------------------------------------------------------------

def _resolve_ref(ref: str, root_defs: dict[str, Any]) -> dict[str, Any]:
    """Attempt to resolve a $ref pointer like '#/$defs/Foo'."""
    if ref.startswith("#/$defs/"):
        name = ref[len("#/$defs/"):]
        if name in root_defs:
            return deepcopy(root_defs[name])
    # Cannot resolve — return empty object
    return {"type": "object"}


def _clean_schema_node(node: dict[str, Any], root_defs: dict[str, Any]) -> dict[str, Any]:
    """Recursively clean a single JSON Schema node for Gemini compatibility."""
    if not isinstance(node, dict):
        return node

    # If this node is just a $ref, resolve it first then clean the result
    if "$ref" in node and len(node) <= 2:  # $ref possibly with description
        resolved = _resolve_ref(node["$ref"], root_defs)
        # Carry over description if the ref node had one
        if "description" in node:
            resolved["description"] = node["description"]
        return _clean_schema_node(resolved, root_defs)

    result: dict[str, Any] = {}

    for key, value in node.items():
        # Drop unsupported keys
        if key in _UNSUPPORTED_VALIDATION_KEYS:
            continue
        if key in _UNSUPPORTED_STRUCTURAL_KEYS:
            continue

        # Handle additionalProperties: drop if boolean, recurse if schema
        if key == "additionalProperties":
            if isinstance(value, bool):
                continue
            # It's a schema dict — clean and keep it
            result[key] = _clean_schema_node(value, root_defs)
            continue

        # Handle anyOf / oneOf: flatten into something Gemini can use
        if key in ("anyOf", "oneOf"):
            if isinstance(value, list):
                flattened = _flatten_union(value, root_defs)
                if flattened is not None:
                    result.update(flattened)
            continue

        # Handle allOf: merge all members
        if key == "allOf":
            if isinstance(value, list):
                merged = _merge_all_of(value, root_defs)
                result.update(merged)
            continue

        # Recurse into properties
        if key == "properties" and isinstance(value, dict):
            result[key] = {
                prop_name: _clean_schema_node(prop_schema, root_defs)
                for prop_name, prop_schema in value.items()
            }
            continue

        # Recurse into items
        if key == "items":
            if isinstance(value, dict):
                result[key] = _clean_schema_node(value, root_defs)
            elif isinstance(value, list):
                result[key] = [_clean_schema_node(item, root_defs) for item in value]
            else:
                result[key] = value
            continue

        # Keep everything else (type, description, title, default, enum, required, etc.)
        result[key] = value

    return result


def _flatten_union(
    variants: list[dict[str, Any]],
    root_defs: dict[str, Any],
) -> dict[str, Any] | None:
    """Collapse anyOf/oneOf into a Gemini-compatible schema.

    Strategies (applied in order):
    1. If all variants are literal types (with const or single-value enums),
       collapse into a single enum.
    2. If there's a null variant mixed with non-null variants, strip the null
       variant and return the remaining schema (nullable).
    3. If only one non-null variant remains after stripping, unwrap it.
    4. Otherwise return the first variant (best-effort).
    """
    if not variants:
        return None

    # Clean each variant first (resolve refs, etc.)
    cleaned = [_clean_schema_node(v, root_defs) for v in variants]

    # Strategy 1: all literal types → collapse to enum
    enum_values: list[Any] = []
    all_literals = True
    for v in cleaned:
        if "const" in v:
            enum_values.append(v["const"])
        elif "enum" in v and isinstance(v["enum"], list) and len(v["enum"]) == 1:
            enum_values.append(v["enum"][0])
        else:
            all_literals = False
            break
    if all_literals and enum_values:
        return {"type": "string", "enum": enum_values}

    # Strategy 2 & 3: strip null variants
    non_null = [v for v in cleaned if v.get("type") != "null"]

    if len(non_null) == 0:
        # All variants are null
        return {"type": "string"}

    if len(non_null) == 1:
        # Single non-null variant — unwrap it, mark as nullable
        result = non_null[0].copy()
        result["nullable"] = True
        return result

    # Strategy 4: multiple non-null variants, just use first (best-effort)
    return non_null[0]


def _merge_all_of(
    members: list[dict[str, Any]],
    root_defs: dict[str, Any],
) -> dict[str, Any]:
    """Merge allOf members into a single cleaned schema."""
    merged: dict[str, Any] = {}
    for member in members:
        cleaned = _clean_schema_node(member, root_defs)
        for key, value in cleaned.items():
            if key == "properties" and key in merged:
                merged[key].update(value)
            elif key == "required" and key in merged:
                existing = set(merged[key])
                existing.update(value)
                merged[key] = sorted(existing)
            else:
                merged[key] = value
    return merged


def clean_schema_for_gemini(schema: dict[str, Any]) -> dict[str, Any]:
    """Top-level entry point: clean a full JSON Schema for Gemini compatibility."""
    root_defs = schema.get("$defs", schema.get("definitions", {}))
    return _clean_schema_node(schema, root_defs)


# ---------------------------------------------------------------------------
# Provider implementation
# ---------------------------------------------------------------------------

class GeminiProvider(BaseProvider):
    """Provider adapter for Google Gemini via the google-genai SDK."""

    def __init__(self, api_key: str):
        self.client = genai.Client(api_key=api_key)

    def get_model_id(self, short_name: str) -> str:
        return MODEL_MAP.get(short_name, short_name)

    def clean_tool_schema(self, schema: ToolSchema) -> dict:
        """Convert a ToolSchema to Gemini function declaration format.

        Cleans the JSON Schema of unsupported features before sending.
        """
        cleaned_params = clean_schema_for_gemini(schema.input_schema)
        return {
            "name": schema.name,
            "description": schema.description,
            "parameters": cleaned_params,
        }

    def format_tool_result(self, tool_use_id: str, content: list[dict]) -> dict:
        """Format a tool result for Gemini conversation history.

        Gemini uses FunctionResponse parts; we store enough info to reconstruct them.
        """
        # Extract text content for the function response
        text_parts = []
        for block in content:
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "image":
                text_parts.append("[image]")
            else:
                text_parts.append(json.dumps(block))

        return {
            "tool_use_id": tool_use_id,
            "output": "\n".join(text_parts) if text_parts else "Done.",
        }

    def format_user_message(self, content: Any) -> ProviderMessage:
        if isinstance(content, str):
            return ProviderMessage(role="user", content=content)
        return ProviderMessage(role="user", content=content)

    def format_assistant_message(self, response: ModelResponse) -> ProviderMessage:
        """Convert a ModelResponse into a ProviderMessage for conversation history."""
        blocks = []
        for block in response.content:
            if block.type == "text":
                blocks.append({"type": "text", "text": block.text})
            elif block.type == "tool_use" and block.tool_call:
                blocks.append({
                    "type": "tool_use",
                    "id": block.tool_call.id,
                    "name": block.tool_call.name,
                    "input": block.tool_call.input,
                })
        return ProviderMessage(role="assistant", content=blocks)

    # ------------------------------------------------------------------
    # Internal helpers for building Gemini API messages
    # ------------------------------------------------------------------

    def _build_tools(self, tools: list[ToolSchema]) -> list[types.Tool] | None:
        """Convert ToolSchemas to Gemini Tool objects."""
        if not tools:
            return None
        declarations = []
        for t in tools:
            cleaned = self.clean_tool_schema(t)
            declarations.append(types.FunctionDeclaration(
                name=cleaned["name"],
                description=cleaned["description"],
                parameters=cleaned["parameters"],
            ))
        return [types.Tool(function_declarations=declarations)]

    def _build_contents(
        self, messages: list[ProviderMessage],
    ) -> list[types.Content]:
        """Convert ProviderMessages into a list of Gemini Content objects.

        Gemini requires:
        - Conversation starts with a user message
        - Strict alternating user/model turns
        We merge consecutive same-role messages to satisfy this.
        """
        raw_contents: list[types.Content] = []

        for msg in messages:
            if msg.role == "user":
                parts = self._user_content_to_parts(msg.content)
                raw_contents.append(types.Content(role="user", parts=parts))

            elif msg.role == "assistant":
                parts = self._assistant_content_to_parts(msg.content)
                raw_contents.append(types.Content(role="model", parts=parts))

            elif msg.role == "tool_result":
                # Tool results become user turns with FunctionResponse parts
                parts = self._tool_result_to_parts(msg.content)
                raw_contents.append(types.Content(role="user", parts=parts))

        # Ensure conversation starts with user
        if raw_contents and raw_contents[0].role != "user":
            raw_contents.insert(
                0,
                types.Content(
                    role="user",
                    parts=[types.Part.from_text("Hello.")],
                ),
            )

        # Merge consecutive same-role turns
        merged: list[types.Content] = []
        for content in raw_contents:
            if merged and merged[-1].role == content.role:
                merged[-1].parts.extend(content.parts)
            else:
                merged.append(content)

        return merged

    def _user_content_to_parts(self, content: Any) -> list[types.Part]:
        """Convert user message content to Gemini Part objects."""
        if isinstance(content, str):
            return [types.Part.from_text(content)]
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, str):
                    parts.append(types.Part.from_text(block))
                elif isinstance(block, dict):
                    if block.get("type") == "text":
                        parts.append(types.Part.from_text(block.get("text", "")))
                    elif block.get("type") == "image":
                        source = block.get("source", {})
                        media_type = source.get("media_type", "image/png")
                        data = source.get("data", "")
                        parts.append(types.Part.from_bytes(
                            data=base64.b64decode(data),
                            mime_type=media_type,
                        ))
                    else:
                        parts.append(types.Part.from_text(json.dumps(block)))
            return parts if parts else [types.Part.from_text("")]
        return [types.Part.from_text(str(content))]

    def _assistant_content_to_parts(self, content: Any) -> list[types.Part]:
        """Convert assistant message content to Gemini Part objects."""
        if isinstance(content, str):
            return [types.Part.from_text(content)]
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        if text:
                            parts.append(types.Part.from_text(text))
                    elif block.get("type") == "tool_use":
                        parts.append(types.Part(
                            function_call=types.FunctionCall(
                                name=block.get("name", ""),
                                args=block.get("input", {}),
                            )
                        ))
            return parts if parts else [types.Part.from_text("")]
        return [types.Part.from_text(str(content))]

    def _tool_result_to_parts(self, content: Any) -> list[types.Part]:
        """Convert tool result content to Gemini FunctionResponse parts."""
        parts = []
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and "tool_use_id" in item:
                    # The tool_use_id is the function name in our format_tool_result
                    func_name = item.get("tool_use_id", "unknown")
                    output = item.get("output", "Done.")
                    parts.append(types.Part(
                        function_response=types.FunctionResponse(
                            name=func_name,
                            response={"result": output},
                        )
                    ))
        elif isinstance(content, dict) and "tool_use_id" in content:
            func_name = content.get("tool_use_id", "unknown")
            output = content.get("output", "Done.")
            parts.append(types.Part(
                function_response=types.FunctionResponse(
                    name=func_name,
                    response={"result": output},
                )
            ))

        return parts if parts else [types.Part.from_text("Tool result unavailable.")]

    # ------------------------------------------------------------------
    # Non-streaming message creation
    # ------------------------------------------------------------------

    async def create_message(
        self,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list[ToolSchema],
        max_tokens: int = 8192,
    ) -> ModelResponse:
        contents = self._build_contents(messages)
        gemini_tools = self._build_tools(tools)

        config = types.GenerateContentConfig(
            max_output_tokens=max_tokens,
        )
        if system:
            config.system_instruction = system
        if gemini_tools:
            config.tools = gemini_tools

        resp = await self.client.aio.models.generate_content(
            model=self.get_model_id(model),
            contents=contents,
            config=config,
        )

        return self._parse_response(resp)

    def _parse_response(self, resp: Any) -> ModelResponse:
        """Parse a Gemini GenerateContentResponse into a ModelResponse."""
        content: list[ContentBlock] = []
        has_tool_calls = False

        if resp.candidates:
            candidate = resp.candidates[0]
            if candidate.content and candidate.content.parts:
                for part in candidate.content.parts:
                    if part.text is not None:
                        content.append(ContentBlock(type="text", text=part.text))
                    elif part.function_call is not None:
                        has_tool_calls = True
                        fc = part.function_call
                        content.append(ContentBlock(
                            type="tool_use",
                            tool_call=ToolCall(
                                id=uuid4().hex,
                                name=fc.name,
                                input=dict(fc.args) if fc.args else {},
                            ),
                        ))

        stop_reason = "tool_use" if has_tool_calls else "end_turn"

        usage = {}
        if resp.usage_metadata:
            usage = {
                "input_tokens": getattr(resp.usage_metadata, "prompt_token_count", 0) or 0,
                "output_tokens": getattr(resp.usage_metadata, "candidates_token_count", 0) or 0,
            }

        return ModelResponse(content=content, stop_reason=stop_reason, usage=usage)

    # ------------------------------------------------------------------
    # Streaming message creation
    # ------------------------------------------------------------------

    async def stream_message(
        self,
        model: str,
        system: str | None,
        messages: list[ProviderMessage],
        tools: list[ToolSchema],
        max_tokens: int = 8192,
    ) -> AsyncIterator[StreamEvent]:
        contents = self._build_contents(messages)
        gemini_tools = self._build_tools(tools)

        config = types.GenerateContentConfig(
            max_output_tokens=max_tokens,
        )
        if system:
            config.system_instruction = system
        if gemini_tools:
            config.tools = gemini_tools

        stream = self.client.aio.models.generate_content_stream(
            model=self.get_model_id(model),
            contents=contents,
            config=config,
        )

        # Track streaming state
        block_index = 0
        text_block_open = False
        tool_blocks: dict[str, int] = {}  # tool_name -> block_index (for dedup)

        async for chunk in stream:
            if not chunk.candidates:
                continue

            candidate = chunk.candidates[0]
            if not candidate.content or not candidate.content.parts:
                continue

            for part in candidate.content.parts:
                if part.text is not None:
                    text = part.text
                    if not text_block_open:
                        text_block_open = True
                        yield StreamEvent(
                            type="content_block_start",
                            index=block_index,
                            block_type="text",
                        )

                    yield StreamEvent(
                        type="content_block_delta",
                        index=block_index,
                        delta_type="text_delta",
                        text=text,
                    )

                elif part.function_call is not None:
                    fc = part.function_call

                    # Close text block if open
                    if text_block_open:
                        yield StreamEvent(
                            type="content_block_stop",
                            index=block_index,
                        )
                        block_index += 1
                        text_block_open = False

                    tool_id = uuid4().hex
                    tool_block_idx = block_index
                    block_index += 1

                    args = dict(fc.args) if fc.args else {}
                    args_json = json.dumps(args)

                    yield StreamEvent(
                        type="content_block_start",
                        index=tool_block_idx,
                        block_type="tool_use",
                        tool_name=fc.name,
                        tool_id=tool_id,
                    )
                    yield StreamEvent(
                        type="content_block_delta",
                        index=tool_block_idx,
                        delta_type="input_json_delta",
                        text=args_json,
                    )
                    yield StreamEvent(
                        type="content_block_stop",
                        index=tool_block_idx,
                    )

        # Close any remaining open text block
        if text_block_open:
            yield StreamEvent(
                type="content_block_stop",
                index=block_index,
            )

        # Emit usage from the last chunk if available
        if chunk and hasattr(chunk, 'usage_metadata') and chunk.usage_metadata:
            um = chunk.usage_metadata
            usage_data = {
                "input_tokens": getattr(um, "prompt_token_count", 0) or 0,
                "output_tokens": getattr(um, "candidates_token_count", 0) or 0,
            }
            if any(v > 0 for v in usage_data.values()):
                yield StreamEvent(type="usage", usage=usage_data)

        yield StreamEvent(type="message_stop")
