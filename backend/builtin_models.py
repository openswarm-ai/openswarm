import json
from dataclasses import dataclass, field, asdict, fields
from typing import Any, Dict, List, Optional, Union, get_type_hints
from datetime import datetime

class BaseModel:
    @classmethod
    def model_validate(cls, data: Dict[str, Any]):
        # Extract fields known to the dataclass
        field_names = {f.name for f in fields(cls)}
        filtered_data = {k: v for k, v in data.items() if k in field_names}

        # Handle nested lists/dicts if type hints are available
        # (This is a simplified version of Pydantic's recursive validation)

        return cls(**filtered_data)

    def model_dump(self, mode: str = "dict") -> Dict[str, Any]:
        d = asdict(self)
        if mode == "json":
            return self._serialize(d)
        return d

    def _serialize(self, obj):
        if isinstance(obj, dict):
            return {k: self._serialize(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._serialize(v) for v in obj]
        elif isinstance(obj, datetime):
            return obj.isoformat()
        elif hasattr(obj, 'model_dump'):
            return obj.model_dump(mode="json")
        return obj

def Field(default=None, default_factory=None):
    if default_factory:
        return field(default_factory=default_factory)
    return field(default=default)
