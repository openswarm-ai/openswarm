"""Generic JSON-file CRUD store for Pydantic models in a flat directory.

Every sub-app in the backend persists entities as one JSON file per record
inside a data directory.  This module eliminates that copy-paste.
"""

import json
import os
from typing import Generic, List, Optional, TypeVar

from fastapi import HTTPException
from pydantic import BaseModel
from typeguard import typechecked

T = TypeVar("T", bound=BaseModel)

class PydanticStore(BaseModel, Generic[T]):
    model_cls: type[T]
    data_dir: str
    id_field: str = "id"
    dump_mode: str | None = None
    not_found_detail: str = "Not found"

    # -- private methods ------------------------------------------------------

    @typechecked
    def p_path(self, item_id: str) -> str:
        return os.path.join(self.data_dir, f"{item_id}.json")

    @typechecked
    def p_dump(self, item: T) -> dict:
        if self.dump_mode:
            return item.model_dump(mode=self.dump_mode)
        return item.model_dump()

    # -- public methods ------------------------------------------------------

    @typechecked
    def load_all(self) -> list[T]:
        result: List[T] = []
        if not os.path.exists(self.data_dir):
            return result
        for fname in os.listdir(self.data_dir):
            if fname.endswith(".json"):
                with open(os.path.join(self.data_dir, fname)) as f:
                    result.append(self.model_cls(**json.load(f)))
        return result

    @typechecked
    def save(self, item: T) -> None:
        os.makedirs(self.data_dir, exist_ok=True)
        item_id = getattr(item, self.id_field)
        with open(self.p_path(item_id), "w") as f:
            json.dump(self.p_dump(item), f, indent=2)

    @typechecked
    def load(self, item_id: str) -> T:
        path = self.p_path(item_id)
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail=self.not_found_detail)
        with open(path) as f:
            return self.model_cls(**json.load(f))

    @typechecked
    def load_or_none(self, item_id: str) -> Optional[T]:
        path = self.p_path(item_id)
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return self.model_cls(**json.load(f))

    @typechecked
    def delete(self, item_id: str) -> None:
        path = self.p_path(item_id)
        if os.path.exists(path):
            os.remove(path)

    @typechecked
    def exists(self, item_id: str) -> bool:
        return os.path.exists(self.p_path(item_id))