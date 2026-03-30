# Structural Linter

A linter is a tool that automatically checks your code for problems. This one doesn't check for bugs — it enforces **structural rules** that keep the codebase organized and easy to navigate.

## What it checks

**1. File length** — Every source file must be under 250 lines.

Big files are hard to read, hard to review, and hard to maintain. If a file is getting long, it's a sign it should be split into smaller, more focused pieces.

**2. Folder size** — Every folder must contain fewer than 6 items (files or subfolders).

When a folder has dozens of files it becomes a junk drawer. Keeping folders small forces you to organize code into logical groups.

These rules apply to `.py`, `.ts`, `.tsx`, `.js`, and `.jsx` files. Non-code files (images, JSON data, configs, lock files, etc.) are ignored.

## How it runs

You don't need to do anything — it runs automatically.

When you open the project in Cursor/VS Code, a background task starts watching for file changes. Every time you save, it re-checks the codebase. Violations show up as errors in the **Problems panel** (`Cmd+Shift+M`) and as red badges on files in the sidebar, just like any other linter.

If you want to run it manually from the terminal:

```bash
# one-shot check (exits with code 1 if violations exist)
python3 linter/structlint.py --root .

# continuous watch mode
python3 linter/structlint.py --watch --root .
```

## Configuration

All config lives in `structlint.json` (this folder). Here's what each field does:

```json
{
  "rules": {
    "max-file-lines": 250,     // files with >= this many lines trigger an error
    "max-folder-items": 6      // folders with >= this many items trigger an error
  },
  "include_extensions": [".py", ".ts", ".tsx", ".js", ".jsx"],  // only these file types are line-counted
  "exclude": ["node_modules", ".venv", "..."],  // directories to skip entirely
  "exceptions": {
    "max-file-lines": [],      // glob patterns for files exempt from the line limit
    "max-folder-items": []     // glob patterns for folders exempt from the item limit
  }
}
```

## Adding exceptions

If a file or folder legitimately needs to exceed a limit, add a glob pattern to the `exceptions` list in `structlint.json`. For example:

```json
{
  "exceptions": {
    "max-file-lines": [
      "backend/tests/test_analytics.py"
    ],
    "max-folder-items": [
      "backend/apps/agents"
    ]
  }
}
```

You can use wildcards: `"backend/tests/*"` exempts all files in the tests folder.

## Type checking

This folder also contains `pyrightconfig.json`, which configures strict type checking for the Python backend. This works through the **Pylance** extension in Cursor/VS Code — it shows type errors in real-time as you type, the same way TypeScript checks the frontend. No setup needed beyond having Pylance installed.

## Files in this folder

| File | Purpose |
|---|---|
| `structlint.py` | The linter script |
| `structlint.json` | Rules, exclusions, and exceptions |
| `pyrightconfig.json` | Python type checking config (for CLI `pyright` usage) |
