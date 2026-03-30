import json
import os
import logging
from contextlib import asynccontextmanager
from fastapi import HTTPException
from backend.config.Apps import SubApp
from backend.apps.common.json_store import JsonStore
from backend.apps.templates.models import PromptTemplate, PromptTemplateCreate, PromptTemplateUpdate

logger = logging.getLogger(__name__)

from backend.config.paths import TEMPLATES_DIR as DATA_DIR

@asynccontextmanager
async def templates_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    yield

templates = SubApp("templates", templates_lifespan)

_store = JsonStore(PromptTemplate, DATA_DIR, not_found_detail="Template not found")

_load_all = _store.load_all
_save = _store.save
_load = _store.load
_delete = _store.delete

@templates.router.get("/list")
async def list_templates():
    return {"templates": [t.model_dump() for t in _load_all()]}

@templates.router.get("/{template_id}")
async def get_template(template_id: str):
    return _load(template_id).model_dump()

@templates.router.post("/create")
async def create_template(body: PromptTemplateCreate):
    template = PromptTemplate(
        name=body.name,
        description=body.description,
        template=body.template,
        fields=body.fields,
        tags=body.tags,
    )
    _save(template)
    from backend.apps.analytics.collector import record as _analytics
    _analytics("feature.used", {"feature": "template.created"})
    return {"ok": True, "template": template.model_dump()}

@templates.router.put("/{template_id}")
async def update_template(template_id: str, body: PromptTemplateUpdate):
    template = _load(template_id)
    update_data = body.model_dump(exclude_none=True)
    for k, v in update_data.items():
        setattr(template, k, v)
    _save(template)
    return {"ok": True, "template": template.model_dump()}

@templates.router.delete("/{template_id}")
async def delete_template(template_id: str):
    _delete(template_id)
    return {"ok": True}

@templates.router.post("/render")
async def render_template(body: dict):
    template_id = body.get("template_id", "")
    values = body.get("values", {})
    template = _load(template_id)
    rendered = template.template
    for field in template.fields:
        placeholder = "{{" + field.name + "}}"
        value = values.get(field.name, field.default or "")
        rendered = rendered.replace(placeholder, str(value))
    from backend.apps.analytics.collector import record as _analytics
    _analytics("feature.used", {"feature": "template.used"})
    return {"rendered": rendered}
