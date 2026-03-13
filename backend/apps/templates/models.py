from pydantic import BaseModel, Field
from typing import Optional, Literal, Any
from uuid import uuid4

class TemplateField(BaseModel):
    name: str
    type: Literal["str", "int", "float", "select", "multi-select", "literal"]
    options: Optional[list[str]] = None
    default: Optional[Any] = None
    required: bool = True

class PromptTemplate(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    template: str  # with {{field_name}} placeholders
    fields: list[TemplateField] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

class PromptTemplateCreate(BaseModel):
    name: str
    description: str = ""
    template: str
    fields: list[TemplateField] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

class PromptTemplateUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    template: Optional[str] = None
    fields: Optional[list[TemplateField]] = None
    tags: Optional[list[str]] = None
