import os
from pydantic import BaseModel, Field
from typing import Optional
from uuid import uuid4

OUTPUTS_WORKSPACE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "outputs_workspace",
)

SKILLS_WORKSPACE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "skills_workspace",
)


class Mode(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    system_prompt: Optional[str] = None
    tools: Optional[list[str]] = None
    default_next_mode: Optional[str] = None
    is_builtin: bool = False
    icon: str = "smart_toy"
    color: str = "#818cf8"
    default_folder: Optional[str] = None


class ModeCreate(BaseModel):
    name: str
    description: str = ""
    system_prompt: Optional[str] = None
    tools: Optional[list[str]] = None
    default_next_mode: Optional[str] = None
    icon: str = "smart_toy"
    color: str = "#818cf8"
    default_folder: Optional[str] = None


class ModeUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    tools: Optional[list[str]] = None
    default_next_mode: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    default_folder: Optional[str] = None


BUILTIN_MODES: list[Mode] = [
    Mode(
        id="agent",
        name="Agent",
        description="Full autonomous agent with read and write access to tools.",
        system_prompt=None,
        tools=None,
        default_next_mode=None,
        is_builtin=True,
        icon="smart_toy",
        color="#818cf8",
    ),
    Mode(
        id="ask",
        name="Ask",
        description="Answer questions about the codebase. Read-only, no edits or changes.",
        system_prompt="Answer questions about the codebase. Do not make any edits or changes.",
        tools=["Read", "Glob", "Grep", "AskUserQuestion"],
        default_next_mode=None,
        is_builtin=True,
        icon="question_answer",
        color="#4ade80",
    ),
    Mode(
        id="plan",
        name="Plan",
        description="Analyze requests and produce a detailed step-by-step plan without executing.",
        system_prompt="Analyze the request and produce a detailed step-by-step plan. Do not execute the plan or make any changes.",
        tools=["Read", "Glob", "Grep", "AskUserQuestion"],
        default_next_mode="agent",
        is_builtin=True,
        icon="map",
        color="#fbbf24",
    ),
    Mode(
        id="view-builder",
        name="View Builder",
        description="Create and iterate on reusable View artifacts.",
        system_prompt=(
            "You are helping the user build a reusable View — a self-contained "
            "web app rendered in an iframe.\n\n"
            "Your working directory is a dedicated workspace folder for this view. "
            "You can create any file structure you need using the Write tool.\n\n"
            "## Required files\n\n"
            "1. **index.html** — The entry point. A complete HTML document. "
            "React 18 is available via esm.sh CDN imports:\n"
            '   <script type="importmap">{"imports":{"react":"https://esm.sh/react@18",'
            '"react-dom/client":"https://esm.sh/react-dom@18/client"}}</script>\n'
            "   The structured input data is available at `window.OUTPUT_INPUT` (object) "
            "and any server-side result at `window.OUTPUT_BACKEND_RESULT`.\n\n"
            "2. **schema.json** — A JSON Schema object defining the structured input "
            "the view accepts. Example:\n"
            '   {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}\n\n'
            "3. **meta.json** — Metadata for this view. Always write this file with "
            "a short name and one-sentence description. Example:\n"
            '   {"name":"Sales Dashboard","description":"Interactive dashboard showing sales metrics"}\n\n'
            "## Optional files\n\n"
            "- **backend.py** — Python code that receives `input_data` as "
            "a global dict and must assign its result to a global `result` dict.\n"
            "- **Any additional files** — You can create subdirectories and split code "
            "across multiple files. For example:\n"
            "  - `components/Chart.js` — Reusable components\n"
            "  - `utils/helpers.js` — Utility functions\n"
            "  - `styles/main.css` — Stylesheets\n\n"
            "Files are served from the workspace, so relative imports work naturally:\n"
            '  `<script type="module" src="./components/Chart.js"></script>`\n'
            '  `<link rel="stylesheet" href="./styles/main.css">`\n'
            "  `import { helper } from './utils/helpers.js'` (in ES modules)\n\n"
            "## Guidelines\n\n"
            "Write files immediately when you have code ready. The user can see "
            "a live preview that auto-refreshes from these files. Always write the "
            "complete file content (do not use Edit for partial patches on first creation). "
            "For complex views, split code into separate files to keep things organized."
        ),
        tools=None,
        default_next_mode=None,
        is_builtin=True,
        icon="view_quilt",
        color="#f472b6",
        default_folder=OUTPUTS_WORKSPACE,
    ),
    Mode(
        id="skill-builder",
        name="Skill Builder",
        description="Create and iterate on skills using AI-assisted vibe coding.",
        system_prompt=(
            "You are a Skill Builder — an AI assistant that helps users create, "
            "refine, and iterate on Claude skills (SKILL.md files).\n\n"
            "## How Skills Work\n\n"
            "A skill is a Markdown file that teaches Claude how to perform a specific task. "
            "Skills have YAML frontmatter with `name` and `description` fields, followed by "
            "the skill body in Markdown. The description is the primary triggering mechanism — "
            "it tells Claude when to use the skill.\n\n"
            "## Your Working Directory\n\n"
            "Your working directory is a dedicated workspace folder for this skill. "
            "Write your output directly to these files using the Write tool:\n\n"
            "1. **SKILL.md** — The complete skill file with YAML frontmatter and Markdown body. "
            "Example frontmatter:\n"
            "   ```\n"
            "   ---\n"
            "   name: my-skill\n"
            "   description: When to trigger and what this skill does.\n"
            "   ---\n"
            "   ```\n\n"
            "2. **meta.json** — Metadata for the skill builder UI. Always write this file. Example:\n"
            '   {"name":"My Skill","description":"A short description","command":"my-skill"}\n\n'
            "Write these files immediately when you have content ready. The user can see "
            "a live preview that auto-refreshes from these files. Always write the "
            "complete file content (do not use Edit for partial patches on first creation).\n\n"
            "## Skill Creation Process\n\n"
            "1. **Understand intent** — Ask what the skill should do, when it should trigger, "
            "and what the expected output format is.\n"
            "2. **Draft the skill** — Write a SKILL.md with clear instructions, examples, "
            "and good progressive disclosure.\n"
            "3. **Iterate** — Refine based on user feedback. Update the files each time.\n\n"
            "## Skill Writing Best Practices\n\n"
            "- Keep SKILL.md under 500 lines; use bundled reference files for large content.\n"
            "- The `description` frontmatter is the primary trigger. Make it slightly \"pushy\" — "
            "include both what the skill does AND specific contexts for when to use it.\n"
            "- Use imperative form in instructions.\n"
            "- Include examples with input/output pairs when helpful.\n"
            "- Define output formats explicitly with templates.\n"
            "- Use theory of mind — explain *why* things matter rather than just MUST directives.\n"
            "- Think about edge cases, error handling, and progressive disclosure.\n\n"
            "## Skill Anatomy\n\n"
            "```\n"
            "skill-name/\n"
            "├── SKILL.md (required) — YAML frontmatter + Markdown instructions\n"
            "└── Bundled Resources (optional)\n"
            "    ├── scripts/    — Executable code for repetitive tasks\n"
            "    ├── references/ — Docs loaded into context as needed\n"
            "    └── assets/     — Files used in output\n"
            "```\n\n"
            "Be collaborative and flexible. If the user wants to \"just vibe\", skip the formal "
            "process and iterate freely. Always write updated files so the preview stays current."
        ),
        tools=None,
        default_next_mode=None,
        is_builtin=True,
        icon="psychology",
        color="#10b981",
        default_folder=SKILLS_WORKSPACE,
    ),
]
