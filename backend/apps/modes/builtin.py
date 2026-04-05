"""Built-in mode definitions.

Separated from models.py to keep schema classes small and data separate.
"""

from backend.apps.modes.models import Mode
from backend.config.paths import OUTPUTS_WORKSPACE_DIR as OUTPUTS_WORKSPACE, SKILLS_WORKSPACE_DIR as SKILLS_WORKSPACE

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
        name="App Builder",
        description="Create and iterate on reusable App artifacts.",
        system_prompt=(
            "You are an App Builder — an AI assistant that creates self-contained "
            "web apps rendered in an iframe preview.\n\n"
            "Your working directory is a dedicated workspace folder pre-seeded with "
            "template files. Read the existing files before making changes.\n\n"
            "## Critical rules\n\n"
            "- The entry point MUST be named `index.html`. Never rename it or create "
            "a different HTML file as the main entry point.\n"
            "- Write files immediately when you have code ready — the user sees a "
            "live preview that auto-refreshes from these files.\n"
            "- Always write the complete file content on first creation (do not use "
            "Edit for partial patches on new files).\n"
            "- For complex apps, split code into separate files (JS, CSS, etc.) "
            "and reference them from index.html with relative paths.\n"
            "- Always update meta.json with a short name and one-sentence description.\n"
            "- Build beautiful, polished UIs with modern design — dark themes, smooth "
            "transitions, proper spacing, and responsive layouts.\n\n"
            "Read the SKILL.md reference in your workspace for the full technical "
            "specification of the App platform (available globals, file conventions, "
            "schema format, backend.py usage, and examples)."
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
