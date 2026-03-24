"""Filesystem tools: Read, Write, Edit, Glob, Grep."""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
import re
from pathlib import Path
from typing import Any

from backend.apps.agents.tools.base import BaseTool, ToolContext

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
_MAX_OUTPUT_BYTES = 50 * 1024  # ~50 KB cap for grep output


def _resolve(file_path: str, cwd: str) -> Path:
    """Resolve *file_path* against *cwd* when it is relative."""
    p = Path(file_path)
    if not p.is_absolute():
        p = Path(cwd) / p
    return p.resolve()


def _text_block(text: str) -> list[dict]:
    return [{"type": "text", "text": text}]


# ───────────────────────────────────────────────────────────────────────────
# ReadTool
# ───────────────────────────────────────────────────────────────────────────


class ReadTool(BaseTool):
    name = "Read"
    description = (
        "Read a file from the filesystem. Returns lines with line numbers "
        "(cat -n style). For image files returns base64 content. Supports "
        "offset and limit parameters for reading portions of large files."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute or relative path to the file to read.",
                },
                "offset": {
                    "type": "integer",
                    "description": "1-based line number to start reading from.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of lines to return (default 2000).",
                },
            },
            "required": ["file_path"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        file_path = _resolve(input_data["file_path"], context.cwd)

        if not file_path.exists():
            return _text_block(f"Error: file not found: {file_path}")

        if not file_path.is_file():
            return _text_block(f"Error: not a regular file: {file_path}")

        # Binary / image files → base64
        ext = file_path.suffix.lower()
        if ext in _IMAGE_EXTENSIONS:
            try:
                raw = file_path.read_bytes()
                b64 = base64.b64encode(raw).decode("ascii")
                media = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
                return [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media,
                            "data": b64,
                        },
                    }
                ]
            except Exception as exc:
                return _text_block(f"Error reading image {file_path}: {exc}")

        # Text files
        offset = max(input_data.get("offset", 1), 1)
        limit = input_data.get("limit", 2000)
        if limit <= 0:
            limit = 2000

        try:
            with open(file_path, "r", errors="replace") as fh:
                lines: list[str] = []
                for lineno, line in enumerate(fh, start=1):
                    if lineno < offset:
                        continue
                    if len(lines) >= limit:
                        break
                    # cat -n style: right-justified line number + tab + content
                    lines.append(f"{lineno:>6}\t{line.rstrip()}")
            if not lines:
                return _text_block(f"(file is empty or offset beyond end of file: {file_path})")
            return _text_block("\n".join(lines))
        except Exception as exc:
            return _text_block(f"Error reading {file_path}: {exc}")


# ───────────────────────────────────────────────────────────────────────────
# WriteTool
# ───────────────────────────────────────────────────────────────────────────


class WriteTool(BaseTool):
    name = "Write"
    description = (
        "Write content to a file. Creates parent directories if they do not "
        "exist. Overwrites the file if it already exists."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute or relative path to the file to write.",
                },
                "content": {
                    "type": "string",
                    "description": "The full content to write to the file.",
                },
            },
            "required": ["file_path", "content"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        file_path = _resolve(input_data["file_path"], context.cwd)
        content: str = input_data["content"]

        try:
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding="utf-8")
            return _text_block(f"Successfully wrote {len(content)} bytes to {file_path}")
        except Exception as exc:
            return _text_block(f"Error writing {file_path}: {exc}")


# ───────────────────────────────────────────────────────────────────────────
# EditTool
# ───────────────────────────────────────────────────────────────────────────


class EditTool(BaseTool):
    name = "Edit"
    description = (
        "Perform exact string replacements in a file. By default the "
        "old_string must appear exactly once (not unique → error). Pass "
        "replace_all=true to replace every occurrence."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute or relative path to the file to edit.",
                },
                "old_string": {
                    "type": "string",
                    "description": "The exact text to find in the file.",
                },
                "new_string": {
                    "type": "string",
                    "description": "The text to replace old_string with.",
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "If true, replace all occurrences. Default false.",
                    "default": False,
                },
            },
            "required": ["file_path", "old_string", "new_string"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        file_path = _resolve(input_data["file_path"], context.cwd)
        old_string: str = input_data["old_string"]
        new_string: str = input_data["new_string"]
        replace_all: bool = input_data.get("replace_all", False)

        if not file_path.exists():
            return _text_block(f"Error: file not found: {file_path}")
        if not file_path.is_file():
            return _text_block(f"Error: not a regular file: {file_path}")

        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception as exc:
            return _text_block(f"Error reading {file_path}: {exc}")

        count = content.count(old_string)
        if count == 0:
            return _text_block(
                f"Error: old_string not found in {file_path}. "
                "Make sure the string matches exactly, including whitespace and indentation."
            )

        if not replace_all and count > 1:
            return _text_block(
                f"Error: old_string appears {count} times in {file_path}. "
                "Provide more surrounding context to make the match unique, "
                "or set replace_all=true to replace every occurrence."
            )

        if replace_all:
            new_content = content.replace(old_string, new_string)
        else:
            # Replace only the first (and only) occurrence
            new_content = content.replace(old_string, new_string, 1)

        try:
            file_path.write_text(new_content, encoding="utf-8")
        except Exception as exc:
            return _text_block(f"Error writing {file_path}: {exc}")

        replacements = count if replace_all else 1
        return _text_block(
            f"Successfully edited {file_path} ({replacements} replacement{'s' if replacements != 1 else ''})."
        )


# ───────────────────────────────────────────────────────────────────────────
# GlobTool
# ───────────────────────────────────────────────────────────────────────────


class GlobTool(BaseTool):
    name = "Glob"
    description = (
        "Fast file pattern matching. Supports glob patterns like '**/*.py'. "
        "Returns matching file paths sorted by modification time (newest first)."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to match files (e.g. '**/*.py', 'src/**/*.ts').",
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in. Defaults to the working directory.",
                },
            },
            "required": ["pattern"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        pattern: str = input_data["pattern"]
        base = Path(input_data.get("path") or context.cwd)

        if not base.is_dir():
            return _text_block(f"Error: directory not found: {base}")

        try:
            matches: list[Path] = []
            for p in base.glob(pattern):
                if p.is_file():
                    matches.append(p)
                if len(matches) >= 500:
                    break

            # Sort by modification time, newest first
            matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)

            if not matches:
                return _text_block(f"No files matched pattern '{pattern}' in {base}")

            result = "\n".join(str(p) for p in matches)
            return _text_block(result)
        except Exception as exc:
            return _text_block(f"Error during glob '{pattern}' in {base}: {exc}")


# ───────────────────────────────────────────────────────────────────────────
# GrepTool
# ───────────────────────────────────────────────────────────────────────────


class GrepTool(BaseTool):
    name = "Grep"
    description = (
        "Search file contents using regular expressions. Uses ripgrep (rg) "
        "when available, otherwise falls back to Python's re module. "
        "Supports output modes: files_with_matches, content, count."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regular expression pattern to search for.",
                },
                "path": {
                    "type": "string",
                    "description": "File or directory to search in. Defaults to the working directory.",
                },
                "glob": {
                    "type": "string",
                    "description": "Glob pattern to filter files (e.g. '*.py', '*.{ts,tsx}').",
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["files_with_matches", "content", "count"],
                    "description": "Output mode. Default: files_with_matches.",
                    "default": "files_with_matches",
                },
            },
            "required": ["pattern"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        pattern: str = input_data["pattern"]
        search_path: str = input_data.get("path") or context.cwd
        file_glob: str | None = input_data.get("glob")
        output_mode: str = input_data.get("output_mode", "files_with_matches")

        # Try ripgrep first
        try:
            result = await self._run_rg(pattern, search_path, file_glob, output_mode)
            if result is not None:
                return result
        except FileNotFoundError:
            pass  # rg not installed, fall through to Python fallback

        # Python fallback
        return await self._python_grep(pattern, search_path, file_glob, output_mode)

    async def _run_rg(
        self,
        pattern: str,
        search_path: str,
        file_glob: str | None,
        output_mode: str,
    ) -> list[dict] | None:
        """Run ripgrep and return results, or None if rg is not available."""
        cmd = ["rg", "--no-heading", "--color=never"]

        if output_mode == "files_with_matches":
            cmd.append("--files-with-matches")
        elif output_mode == "count":
            cmd.append("--count")
        else:
            cmd.extend(["--line-number"])

        if file_glob:
            cmd.extend(["--glob", file_glob])

        cmd.append(pattern)
        cmd.append(search_path)

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        except FileNotFoundError:
            raise  # re-raise so caller knows rg is missing
        except asyncio.TimeoutError:
            return _text_block("Error: grep timed out after 30 seconds.")
        except Exception as exc:
            return _text_block(f"Error running ripgrep: {exc}")

        output = stdout.decode("utf-8", errors="replace")

        if proc.returncode not in (0, 1):
            err = stderr.decode("utf-8", errors="replace").strip()
            if err:
                return _text_block(f"Grep error: {err}")

        if not output.strip():
            return _text_block(f"No matches found for pattern '{pattern}'.")

        # Truncate if too large
        if len(output) > _MAX_OUTPUT_BYTES:
            output = output[:_MAX_OUTPUT_BYTES] + "\n... (output truncated)"

        return _text_block(output.rstrip())

    async def _python_grep(
        self,
        pattern: str,
        search_path: str,
        file_glob: str | None,
        output_mode: str,
    ) -> list[dict]:
        """Pure-Python grep fallback using the re module."""
        try:
            regex = re.compile(pattern)
        except re.error as exc:
            return _text_block(f"Invalid regex pattern: {exc}")

        base = Path(search_path)
        if base.is_file():
            files = [base]
        elif base.is_dir():
            glob_pat = file_glob or "**/*"
            files = [p for p in base.glob(glob_pat) if p.is_file()]
        else:
            return _text_block(f"Error: path not found: {search_path}")

        lines_out: list[str] = []
        total_bytes = 0
        truncated = False

        for fp in sorted(files):
            try:
                text = fp.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue

            file_matches: list[tuple[int, str]] = []
            for lineno, line in enumerate(text.splitlines(), start=1):
                if regex.search(line):
                    file_matches.append((lineno, line))

            if not file_matches:
                continue

            if output_mode == "files_with_matches":
                entry = str(fp)
            elif output_mode == "count":
                entry = f"{fp}:{len(file_matches)}"
            else:
                parts = [f"{fp}:{ln}:{txt}" for ln, txt in file_matches]
                entry = "\n".join(parts)

            total_bytes += len(entry)
            if total_bytes > _MAX_OUTPUT_BYTES:
                truncated = True
                break

            lines_out.append(entry)

        if not lines_out:
            return _text_block(f"No matches found for pattern '{pattern}'.")

        result = "\n".join(lines_out)
        if truncated:
            result += "\n... (output truncated)"

        return _text_block(result)
