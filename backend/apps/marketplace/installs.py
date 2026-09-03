"""What this machine installed from the marketplace, by listing id.

The App Store knows what is installed; without a record every package showed Install again after a
restart, and Open had nothing to open. The importer creates a fresh entity per commit and returns its
id, so the record is written at commit time and maps a listing to the thing it became. A record whose
entity has since been deleted is stale by design: the store re-checks the live lists before showing Open.
"""

import json
import os
import time
from typing import Dict, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.config.paths import DATA_ROOT

INSTALLS_PATH = os.path.join(DATA_ROOT, "marketplace_installs.json")


class InstallRecord(BaseModel):
    """One pointer per importable root, typed, so an id can never point at a kind nobody can resolve."""

    model_config = ConfigDict(validate_assignment=True)

    listing_id: str
    root_type: str
    output_id: Optional[str] = None
    skill_id: Optional[str] = None
    workflow_id: Optional[str] = None
    dashboard_id: Optional[str] = None
    session_id: Optional[str] = None
    version: str = ""
    installed_at: float = 0.0

    def root_id(self) -> Optional[str]:
        return self.output_id or self.skill_id or self.workflow_id or self.dashboard_id or self.session_id


@typechecked
def load_installs(path: Optional[str] = None) -> Dict[str, InstallRecord]:
    p = path or INSTALLS_PATH
    try:
        with open(p, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    out: Dict[str, InstallRecord] = {}
    for key, value in (raw or {}).items():
        try:
            out[key] = InstallRecord.model_validate(value)
        except Exception:
            continue
    return out


@typechecked
def record_install(rec: InstallRecord, path: Optional[str] = None) -> Dict[str, InstallRecord]:
    p = path or INSTALLS_PATH
    installs = load_installs(p)
    if rec.installed_at == 0.0:
        rec = rec.model_copy(update={"installed_at": time.time()})
    installs[rec.listing_id] = rec
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({k: v.model_dump() for k, v in installs.items()}, f, indent=1)
    os.replace(tmp, p)
    return installs
