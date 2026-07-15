"""Consented first-run local recon: app names and folder shapes, never contents.

Reads only basenames and counts (top-level scandir, hard caps), so the summary
is safe to show the user and to hand to their own configured model for prep.
Results are returned to the caller and never persisted or sent to analytics.
"""

import os
from collections import Counter
from pathlib import Path
from typing import List

from typeguard import typechecked

from backend.apps.onboarding.models import FolderSummary, ScanResult

MAX_APPS = 120
MAX_ENTRIES_PER_FOLDER = 5000
MAX_REPO_SCAN_ENTRIES = 400
SCAN_FOLDERS = ("Downloads", "Desktop", "Documents")
REPO_PARENT_CANDIDATES = ("dev", "code", "projects", "src", "repos", "Documents/GitHub")
SCREENSHOT_PREFIXES = ("screenshot", "screen shot", "screen recording")


@typechecked
def p_list_apps() -> List[str]:
    apps_dir = Path("/Applications")
    if not apps_dir.is_dir():
        return []
    names: List[str] = []
    try:
        with os.scandir(apps_dir) as entries:
            for entry in entries:
                if entry.name.endswith(".app"):
                    names.append(entry.name[: -len(".app")])
                if len(names) >= MAX_APPS:
                    break
    except OSError:
        return []
    return sorted(names)


@typechecked
def p_summarize_folder(folder: Path) -> FolderSummary:
    summary = FolderSummary(name=folder.name)
    if not folder.is_dir():
        return summary
    extensions: Counter = Counter()
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if entry.name.startswith("."):
                    continue
                summary.entry_count += 1
                lower = entry.name.lower()
                if lower.startswith(SCREENSHOT_PREFIXES):
                    summary.screenshot_count += 1
                ext = os.path.splitext(entry.name)[1].lower().lstrip(".")
                if ext and entry.is_file(follow_symlinks=False):
                    extensions[ext] += 1
                if summary.entry_count >= MAX_ENTRIES_PER_FOLDER:
                    break
    except OSError:
        return summary
    summary.top_extensions = [ext for ext, count in extensions.most_common(5)]
    return summary


@typechecked
def p_count_git_repos(home: Path) -> int:
    count = 0
    for candidate in REPO_PARENT_CANDIDATES:
        parent = home / candidate
        if not parent.is_dir():
            continue
        try:
            with os.scandir(parent) as entries:
                scanned = 0
                for entry in entries:
                    scanned += 1
                    if scanned > MAX_REPO_SCAN_ENTRIES:
                        break
                    if entry.is_dir(follow_symlinks=False) and (parent / entry.name / ".git").is_dir():
                        count += 1
        except OSError:
            continue
    return count


@typechecked
def run_local_scan(home: Path) -> ScanResult:
    folders = [p_summarize_folder(home / name) for name in SCAN_FOLDERS]
    return ScanResult(
        apps=p_list_apps(),
        folders=folders,
        git_repo_count=p_count_git_repos(home),
        has_gitconfig=(home / ".gitconfig").is_file(),
    )
