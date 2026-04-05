import json
import os
from typing import Optional

from backend.apps.tools.shared_utils.ToolDefinition import ToolDefinition
from typeguard import typechecked

# TODO: better type specing of this whole func
@typechecked
def inject_credentials(
    tool_def: ToolDefinition,
    config: dict,
    oauth_providers: Optional[dict],
) -> None:
    """Mutate config in-place to inject credentials and OAuth tokens."""
    transport = config.get("type", "")

    if tool_def.credentials:
        if transport in ("http", "sse"):
            headers = config.setdefault("headers", {})
            for key, val in tool_def.credentials.items():
                if key.lower() in ("authorization", "api_key", "api-key"):
                    headers.setdefault("Authorization", f"Bearer {val}")
        else:
            env = config.setdefault("env", {})
            env.update(tool_def.credentials)

    if tool_def.auth_type != "oauth2" or not tool_def.oauth_tokens.get("access_token"):
        return

    if transport in ("http", "sse"):
        headers = config.setdefault("headers", {})
        headers["Authorization"] = f"Bearer {tool_def.oauth_tokens['access_token']}"
        return

    env = config.setdefault("env", {})
    provider_key = tool_def.oauth_provider or "google"
    provider = (oauth_providers or {}).get(provider_key)

    if not provider:
        env["OAUTH_ACCESS_TOKEN"] = tool_def.oauth_tokens["access_token"]
        return

    for token_field, env_var in provider.token_env_mapping.items():
        if token_field.startswith("_client_id"):
            val = os.environ.get(provider.client_id_env, "")
        elif token_field.startswith("_client_secret"):
            val = os.environ.get(provider.client_secret_env, "")
        else:
            val = tool_def.oauth_tokens.get(token_field, "")
        if val:
            if provider.env_value_transform == "notion_headers" and token_field == "access_token":
                val = json.dumps({
                    "Authorization": f"Bearer {val}",
                    "Notion-Version": "2022-06-28",
                })
            env[env_var] = val

    for _, env_var in provider.extra_token_fields.items():
        val = tool_def.oauth_tokens.get(env_var, "")
        if val:
            env[env_var] = val

    if provider_key == "figma" and tool_def.oauth_tokens.get("access_token"):
        args = config.get("args", [])
        if "--figma-api-key" not in args:
            config["args"] = args + ["--figma-api-key", tool_def.oauth_tokens["access_token"]]