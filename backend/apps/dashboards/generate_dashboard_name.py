from typing import List, Optional
from backend.core.llm.quick_llm_call import quick_llm_call
from typeguard import typechecked

SINGLE_AGENT_SYSTEM_PROMPT: str = "Generate a concise 2-5 word workspace name for a project based on this task. Return only the name with no markdown formatting, nothing else."
MULTI_AGENT_SYSTEM_PROMPT: str = "Generate a concise 2-5 word workspace name that captures the overall theme of these tasks. Return only the name with no markdown formatting, nothing else."

@typechecked
async def generate_dashboard_name(
    prompts: List[str],
    api_key: Optional[str] = None,
    nine_router_port: Optional[int] = None,
) -> str:
    """Given user prompts from a dashboard's sessions, generate a short name via LLM."""
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    if len(prompts) == 1:
        system_prompt = SINGLE_AGENT_SYSTEM_PROMPT
        user_prompt = prompts[0]
    else:
        system_prompt = MULTI_AGENT_SYSTEM_PROMPT
        user_prompt = "\n".join(f"- {p}" for p in prompts)
    
    assert system_prompt is not None, "System prompt cannot be None"
    assert user_prompt is not None, "User prompt cannot be None"

    result = await quick_llm_call(
        api_key=api_key,
        nine_router_port=nine_router_port,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model="claude-haiku-4-5-20251001",
        max_tokens=30,
    )
    return result.strip("\"'")