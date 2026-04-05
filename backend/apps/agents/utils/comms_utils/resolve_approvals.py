from typing import Optional, Literal, Dict, Any
from typeguard import typechecked
from backend.apps.agents.utils.comms_utils.singeltons.singeltons import APPROVAL_BRIDGE

# TODO: add better type specing for the dict values in the message arg
@typechecked
async def resolve_approval(
    request_id: str,
    behavior: Literal["allow", "deny"],
    message: Optional[str] = None,
    updated_input: Optional[Dict[str, Any]] = None,
) -> None:
    APPROVAL_BRIDGE.resolve(request_id, {
        "behavior": behavior,
        "message": message,
        "updated_input": updated_input,
    })
