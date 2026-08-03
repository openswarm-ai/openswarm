"""Whether this account has an AI connection the cloud could actually run with.

A cloud run signs its LLM calls with the user's OWN subscription, handed up by
`credential_lease`. Only a rotating OAuth connection can be handed up: an API key has no
refresh token, and the runner cannot mint one. So an account whose only provider is a
Gemini or OpenAI key can never run in the cloud, and the honest moment to say so is
before the user schedules anything, not at 9am when the run refuses.
"""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.nine_router import credential_store

CONNECT_HINT = (
    "Cloud runs sign in with your own Claude or ChatGPT subscription, so connect one in "
    "Settings to run a workflow in the cloud. An API key alone can't be used up there."
)


class CredentialReadiness(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    # ready: something is leasable or already lent. none_eligible: only API keys, or nothing at all.
    state: Literal["ready", "none_eligible"]
    connection_ids: List[str] = []
    # Written for the user, present only when they cannot proceed.
    reason: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.state == "ready"


@typechecked
def cloud_credential_readiness() -> CredentialReadiness:
    ids = credential_store.list_oauth_connection_ids()
    if not ids:
        return CredentialReadiness(state="none_eligible", reason=CONNECT_HINT)
    return CredentialReadiness(state="ready", connection_ids=ids)
