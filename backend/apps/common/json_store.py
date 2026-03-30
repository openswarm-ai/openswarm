"""Generic JSON-file CRUD store for Pydantic models.

Every sub-app in the backend persists entities as one JSON file per record
inside a data directory.  This module eliminates that copy-paste.
"""

from __future__ import annotations

import json
import os
from typing import Generic, TypeVar

from fastapi import HTTPException
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class JsonStore(Generic[T]):
    """One-JSON-file-per-entity CRUD backed by a flat directory.

    Parameters
    ----------
    model_cls:
        The Pydantic model to (de)serialise.
    data_dir:
        Filesystem directory that holds ``{id}.json`` files.
    id_field:
        Name of the attribute used as the unique key (default ``"id"``).
    dump_mode:
        Passed to ``model_dump(mode=...)`` when serialising.  Use ``"json"``
        for models that contain non-JSON-native types (e.g. ``datetime``).
    not_found_detail:
        Message for the ``HTTPException(404)`` raised by :meth:`load`.
    """

    def __init__(
        self,
        model_cls: type[T],
        data_dir: str,
        *,
        id_field: str = "id",
        dump_mode: str | None = None,
        not_found_detail: str = "Not found",
    ) -> None:
        self._cls = model_cls
        self._dir = data_dir
        self._id = id_field
        self._dump_mode = dump_mode
        self._detail = not_found_detail

    # -- helpers -------------------------------------------------------------

    def _path(self, item_id: str) -> str:
        return os.path.join(self._dir, f"{item_id}.json")

    def _dump(self, item: T) -> dict:
        if self._dump_mode:
            return item.model_dump(mode=self._dump_mode)
        return item.model_dump()

    # -- public API ----------------------------------------------------------

    def load_all(self) -> list[T]:
        result: list[T] = []
        if not os.path.exists(self._dir):
            return result
        for fname in os.listdir(self._dir):
            if fname.endswith(".json"):
                with open(os.path.join(self._dir, fname)) as f:
                    result.append(self._cls(**json.load(f)))
        return result

    def save(self, item: T) -> None:
        os.makedirs(self._dir, exist_ok=True)
        item_id = getattr(item, self._id)
        with open(self._path(item_id), "w") as f:
            json.dump(self._dump(item), f, indent=2)

    def load(self, item_id: str) -> T:
        path = self._path(item_id)
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail=self._detail)
        with open(path) as f:
            return self._cls(**json.load(f))

    def load_or_none(self, item_id: str) -> T | None:
        path = self._path(item_id)
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return self._cls(**json.load(f))

    def delete(self, item_id: str) -> None:
        path = self._path(item_id)
        if os.path.exists(path):
            os.remove(path)

    def exists(self, item_id: str) -> bool:
        return os.path.exists(self._path(item_id))


class SessionStore:
    """Specialised JSON store for agent session dicts (not Pydantic models).

    Sessions are stored as raw ``dict`` values keyed by ``session_id``.
    """

    def __init__(self, data_dir: str) -> None:
        self._dir = data_dir

    def _path(self, session_id: str) -> str:
        return os.path.join(self._dir, f"{session_id}.json")

    def save(self, session_id: str, doc_data: dict) -> None:
        os.makedirs(self._dir, exist_ok=True)
        with open(self._path(session_id), "w") as f:
            json.dump(doc_data, f, indent=2)

    def load(self, session_id: str) -> dict | None:
        path = self._path(session_id)
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)

    def delete(self, session_id: str) -> None:
        path = self._path(session_id)
        if os.path.exists(path):
            os.remove(path)

    def load_all(self) -> list[tuple[str, dict]]:
        results: list[tuple[str, dict]] = []
        if not os.path.exists(self._dir):
            return results
        for fname in os.listdir(self._dir):
            if fname.endswith(".json"):
                with open(os.path.join(self._dir, fname)) as f:
                    results.append((fname[:-5], json.load(f)))
        return results
