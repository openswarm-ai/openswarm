from typeguard import typechecked
from backend.apps.agents.utils.comms_utils.singeltons.singeltons import BROWSER_BRIDGE, FRONTEND_BROADCASTER
from uuid import uuid4

# TODO: add better type specing for the output of this function
@typechecked
async def send_browser_command(
    action: str, browser_id: str, tab_id: str, params: dict,
) -> dict:
    """BrowserCommandFn implementation that routes through the browser FutureBridge."""
    request_id: str = uuid4().hex
    if not FRONTEND_BROADCASTER.has_connections():
        return {"error": "No dashboard connected. Open the dashboard to use browser tools."}
    return await BROWSER_BRIDGE.request(
        request_id=request_id,
        send_fn=lambda: FRONTEND_BROADCASTER.broadcast("browser:command", {
            "request_id": request_id,
            "action": action,
            "browser_id": browser_id,
            "tab_id": tab_id,
            "params": params,
        }),
        timeout=30.0,
    )