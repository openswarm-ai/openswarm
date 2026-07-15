"""Summarize who is connected, from the 9router connection rows we already fetch.

Reads only metadata the user's own OAuth grants put on disk (plan tier, email);
never calls a provider API and never touches chat history (none is accessible).
"""

import base64
import json
from typing import Dict, List, Optional

from typeguard import typechecked

from backend.apps.onboarding.models import IdentityResponse, ProviderIdentity

PROVIDER_LABELS: Dict[str, str] = {
    "claude": "Claude",
    "codex": "ChatGPT",
    "gemini-cli": "Gemini",
}

# The chatgpt_plan_type claim lives under this key in the codex idToken payload.
OPENAI_AUTH_CLAIM = "https://api.openai.com/auth"


@typechecked
def decode_jwt_payload(token: str) -> Dict[str, object]:
    """Best-effort local decode of a JWT payload. No signature check: the token
    came from the user's own keychain-equivalent store, we only read claims."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return {}
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
        data = json.loads(decoded)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


@typechecked
def p_identity_from_row(row: Dict[str, object]) -> Optional[ProviderIdentity]:
    provider = str(row.get("provider") or "")
    if provider not in PROVIDER_LABELS or not row.get("isActive"):
        return None
    email: Optional[str] = None
    plan: Optional[str] = None
    if provider == "codex":
        claims = decode_jwt_payload(str(row.get("idToken") or ""))
        raw_email = claims.get("email")
        email = str(raw_email) if isinstance(raw_email, str) else None
        auth = claims.get(OPENAI_AUTH_CLAIM)
        if isinstance(auth, dict):
            raw_plan = auth.get("chatgpt_plan_type")
            plan = str(raw_plan) if isinstance(raw_plan, str) else None
    elif provider == "gemini-cli":
        raw_email = row.get("email")
        email = str(raw_email) if isinstance(raw_email, str) else None
    return ProviderIdentity(provider=provider, label=PROVIDER_LABELS[provider], email=email, plan=plan)


@typechecked
def build_identity(rows: List[Dict[str, object]]) -> IdentityResponse:
    providers: List[ProviderIdentity] = []
    for row in rows:
        identity = p_identity_from_row(row)
        if identity is not None:
            providers.append(identity)
    return IdentityResponse(providers=providers)
