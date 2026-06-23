"""The in-flight streamed assistant text for one session, mirrored off the stream so a stop can
commit the partial reply instantly instead of waiting out the SDK teardown. A fixed-shape
record, so it's a model, not a dict."""

from typing import Optional

from pydantic import BaseModel, ConfigDict


class LivePartial(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    msg_id: Optional[str] = None
    text: str = ""
    branch_id: Optional[str] = None
