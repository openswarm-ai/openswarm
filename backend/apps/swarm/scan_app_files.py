"""Best-effort safety read of imported app code. AST flags risky Python via the
existing executor allow/deny lists, and we note when an app will run real code
on the importer's machine (a webapp_template app spawns `bash run.sh`). This is
advisory and surfaced in the import preflight; the actual execution gates are the
user choosing to open/run the app and the flat-app /execute HITL. A full semantic
LLM scan is the separate App Publishing feature, not this."""
from __future__ import annotations

from backend.apps.outputs.executor import get_code_warnings

from .models import ReviewSummary


def scan_app_files(files: dict[str, bytes]) -> ReviewSummary:
    findings: list[str] = []
    scanned: list[str] = []
    runnable = False
    for path, data in files.items():
        low = path.lower()
        if low.endswith("/run.sh") or low.endswith("package.json") or "/backend/" in low:
            runnable = True
        if low.endswith(".py"):
            scanned.append(path)
            try:
                code = data.decode("utf-8", errors="replace")
            except Exception:
                continue
            for w in get_code_warnings(code):
                findings.append(f"{path}: {w}")
    verdict = "warn" if findings else "clean"
    if runnable:
        verdict = "warn"
        findings.insert(0, "This app runs code on your computer. Only import apps you trust.")
    return ReviewSummary(verdict=verdict, findings=findings, scanned_files=scanned)
