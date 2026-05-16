import json
from dataclasses import dataclass, field, asdict, fields
from typing import Any, Dict, List, Optional, Union, get_type_hints
from datetime import datetime

class BaseModel:
    def __init__(self, **data):
        for field_name, field_def in self.__dataclass_fields__.items():
            if field_name in data:
                setattr(self, field_name, data[field_name])
            elif not isinstance(field_def.default, type(field_def.default_factory)): # not exactly right but check if has default
                # dataclass handles default values
                pass

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

    @classmethod
    def model_validate(cls, data: Dict[str, Any]):
        # Very basic validation/conversion
        return cls(**data)

def Field(default=None, default_factory=None):
    if default_factory:
        return field(default_factory=default_factory)
    return field(default=default)
