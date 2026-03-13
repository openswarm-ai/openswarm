import json
import os
import logging
from contextlib import asynccontextmanager
from fastapi import HTTPException
from backend.config.Apps import SubApp
from backend.apps.templates.models import PromptTemplate, PromptTemplateCreate, PromptTemplateUpdate

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "templates")

@asynccontextmanager
async def templates_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    yield

templates = SubApp("templates", templates_lifespan)

def _load_all() -> list[PromptTemplate]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(DATA_DIR, fname)) as f:
                result.append(PromptTemplate(**json.load(f)))
    return result

def _save(template: PromptTemplate):
    path = os.path.join(DATA_DIR, f"{template.id}.json")
    with open(path, "w") as f:
        json.dump(template.model_dump(), f, indent=2)

def _load(template_id: str) -> PromptTemplate:
    path = os.path.join(DATA_DIR, f"{template_id}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Template not found")
    with open(path) as f:
        return PromptTemplate(**json.load(f))

def _delete(template_id: str):
    path = os.path.join(DATA_DIR, f"{template_id}.json")
    if os.path.exists(path):
        os.remove(path)

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
    return {"rendered": rendered}
