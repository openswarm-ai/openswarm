import json
from backend.apps.skills.Skill import Skill
from typeguard import typechecked
from pydantic import BaseModel
import os
from typing import Dict, Optional


class SkillStore(BaseModel):
    """File-backed persistence layer for local skills."""
    skills_dir: str
    index_path: str

    @typechecked
    def __init__(self, skills_dir: str, index_filename: str = ".skills_index.json"):
        os.makedirs(skills_dir, exist_ok=True)
        super().__init__(
            skills_dir=skills_dir,
            index_path=os.path.join(skills_dir, index_filename),
        )

    @typechecked
    def p_load_index(self) -> Dict[str, dict]:
        if os.path.exists(self.index_path):
            with open(self.index_path) as f:
                return json.load(f)
        return {}

    @typechecked
    def p_save_index(self, index: Dict[str, dict]) -> None:
        with open(self.index_path, "w") as f:
            json.dump(index, f, indent=2)

    @staticmethod
    @typechecked
    def slug(name: str) -> str:
        return name.lower().replace(" ", "-")

    @typechecked
    def p_skill_path(self, skill_id: str) -> str:
        return os.path.join(self.skills_dir, f"{skill_id}.md")

    @typechecked
    def list_all(self) -> list[Skill]:
        index = self.p_load_index()
        result: list[Skill] = []
        if not os.path.exists(self.skills_dir):
            return result
        for fname in os.listdir(self.skills_dir):
            if not fname.endswith(".md"):
                continue
            fpath = os.path.join(self.skills_dir, fname)
            with open(fpath) as f:
                content = f.read()
            skill_id = fname.removesuffix(".md")
            meta = index.get(skill_id, {})
            result.append(Skill(
                id=skill_id,
                name=meta.get("name", skill_id.replace("-", " ").replace("_", " ").title()),
                description=meta.get("description", ""),
                content=content,
                file_path=fpath,
                command=meta.get("command", skill_id),
            ))
        return result

    @typechecked
    def get(self, skill_id: str) -> Optional[Skill]:
        for s in self.list_all():
            if s.id == skill_id:
                return s
        return None

    @typechecked
    def create(self, name: str, description: str, content: str, command: str = "") -> Skill:
        slug = self.slug(name)
        fpath = self.p_skill_path(slug)
        with open(fpath, "w") as f:
            f.write(content)
        index = self.p_load_index()
        index[slug] = {"name": name, "description": description, "command": command or slug}
        self.p_save_index(index)
        return Skill(id=slug, name=name, description=description,
                     content=content, file_path=fpath, command=command or slug)

    @typechecked
    def update(self, skill_id: str, *, name: Optional[str] = None,
               description: Optional[str] = None, content: Optional[str] = None,
               command: Optional[str] = None) -> Skill:
        fpath = self.p_skill_path(skill_id)
        if not os.path.exists(fpath):
            raise FileNotFoundError(skill_id)
        if content is not None:
            with open(fpath, "w") as f:
                f.write(content)
        index = self.p_load_index()
        meta = index.get(skill_id, {})
        if name is not None:
            meta["name"] = name
        if description is not None:
            meta["description"] = description
        if command is not None:
            meta["command"] = command
        index[skill_id] = meta
        self.p_save_index(index)
        with open(fpath) as f:
            content = f.read()
        return Skill(id=skill_id, name=meta.get("name", skill_id),
                     description=meta.get("description", ""),
                     content=content, file_path=fpath, command=meta.get("command", skill_id))

    @typechecked
    def delete(self, skill_id: str) -> None:
        fpath = self.p_skill_path(skill_id)
        if os.path.exists(fpath):
            os.remove(fpath)
        index = self.p_load_index()
        index.pop(skill_id, None)
        self.p_save_index(index)