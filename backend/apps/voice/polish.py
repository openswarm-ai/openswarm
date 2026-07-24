"""Dictation cleanup: raw whisper text -> punctuated, filler-free prose via the cheap aux tier.

One fast call on whatever lane the user has configured (provider-agnostic per the aux registry).
Every failure path returns the RAW text so dictation never breaks when the aux is unreachable.
"""

from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.config.Apps import SubApp


@asynccontextmanager
async def voice_lifespan() -> AsyncIterator[None]:
    yield


voice = SubApp("voice", voice_lifespan)

P_POLISH_SYSTEM = (
    "You clean up raw speech-to-text dictation. Return ONLY the cleaned text, nothing else. "
    "Fix punctuation, capitalization, and obvious homophone errors. Remove filler words (um, uh, "
    "like when used as filler, you know) and false starts. Apply spoken formatting commands: "
    "'new line'/'new paragraph' become real breaks, 'period'/'comma'/'question mark' become the "
    "mark when clearly dictated as punctuation. NEVER add content, never answer questions in the "
    "text, never translate, never wrap in quotes, never use em-dashes. Keep the speaker's words "
    "and tone; this is transcription cleanup, not rewriting."
)

POLISH_INPUT_CAP = 8_000


class PolishRequest(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    text: str
    # A one-line hint about where the user is dictating (e.g. a page title), so names spell right.
    context: Optional[str] = None


class PolishResponse(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    text: str
    polished: bool


@voice.router.post("/polish")
@typechecked
async def polish(body: PolishRequest) -> dict:
    raw = (body.text or "").strip()
    if not raw:
        return PolishResponse(text="", polished=False).model_dump()
    try:
        from backend.apps.agents.core.aux_llm import aux_max_tokens_for, safe_resp_text
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.settings.store import load_settings

        settings = load_settings()
        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, aux_model)
        prompt = raw[:POLISH_INPUT_CAP]
        if body.context:
            prompt = f"[Dictating into: {body.context[:200]}]\n{prompt}"
        resp = await client.messages.create(
            model=aux_model,
            max_tokens=aux_max_tokens_for(aux_model, base=1000),
            system=P_POLISH_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
            # Dictation is interactive; a slow aux must never hold the paste hostage.
            timeout=6.0,
        )
        cleaned = safe_resp_text(resp).strip()
        if cleaned:
            return PolishResponse(text=cleaned, polished=True).model_dump()
    except Exception:
        pass
    return PolishResponse(text=raw, polished=False).model_dump()
