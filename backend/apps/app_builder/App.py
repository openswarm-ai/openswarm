from pydantic import BaseModel, Field
from typing import Optional, Any
from uuid import uuid4
from datetime import datetime


class App(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    icon: str = "view_quilt"
    files: dict[str, str] = Field(default_factory=dict)
    thumbnail: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())


class AppCreate(BaseModel):
    name: str
    description: str = ""
    icon: str = "view_quilt"
    files: dict[str, str] = Field(default_factory=dict)
    thumbnail: Optional[str] = None


class AppUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    files: Optional[dict[str, str]] = None
    thumbnail: Optional[str] = None


class AppExecute(BaseModel):
    app_id: str


class AppExecuteResult(BaseModel):
    app_id: str
    app_name: str
    frontend_code: str
    backend_result: Optional[dict[str, Any]] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    error: Optional[str] = None


class WorkspaceSeedRequest(BaseModel):
    workspace_id: str
    files: Optional[dict[str, str]] = None
    meta: Optional[dict[str, Any]] = None
