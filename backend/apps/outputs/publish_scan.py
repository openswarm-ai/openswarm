"""Pre-publish security scan: a free AST pass (reuses the executor's
`get_code_warnings`) plus a required aux-LLM semantic pass, both on the user's
OWN creds so it costs us nothing and the code never leaves the machine until they
ship. The JSON shape matches the frontend `ReviewSummary`.

The full scan (`scan_for_publish`) is memoized on a hash of the collected source:
reopening the publish modal on unchanged code returns the cached review instead of
billing the user's aux model again."""
from __future__ import annotations

import hashlib
import json
import logging
import os
from collections import OrderedDict
from typing import Literal

from backend.apps.outputs.code_safety import get_code_warnings
from backend.apps.outputs.models import Output, PublishReview
from backend.apps.outputs.publish_capability import merge_capability
from backend.apps.outputs.publish_common import is_webapp, workspace_dir
from backend.apps.outputs.workspace_io import WALK_SKIP_DIRS

logger = logging.getLogger(__name__)

P_SCAN_CODE_BUDGET = 60_000  # chars of source we hand the aux model
P_SCAN_EXTS = (".py", ".html", ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".css")
P_MEMO_MAX = 32

P_SCAN_SYSTEM_PROMPT = (
    "You are a security reviewer for a no-code app host. The app below will be "
    "served publicly at a *.openswarm.host subdomain. Read the source and report "
    "only concrete, real risks a reviewer would act on: hardcoded secrets or API "
    "keys, phishing or credential-harvesting forms, sending user data to a "
    "third-party endpoint, obvious XSS or injection, or anything malicious. Do "
    "NOT nitpick style or speculate. Reply ONLY with JSON: "
    '{"severity": "clean|warn|block", "findings": ["short dev-readable line", ...]}. '
    "Use block only for clearly malicious or credential-harvesting code. Empty "
    "findings means clean."
)

# slug-content-hash -> PublishReview, so a reopened modal doesn't re-bill the LLM.
memo: "OrderedDict[str, PublishReview]" = OrderedDict()


def collect_source(output: Output) -> dict[str, str]:
    """Gather human-readable source text for the scan. Flat apps come from the
    files dict; webapp apps walk the workspace skipping node_modules/.venv/dist."""
    src: dict[str, str] = {}
    for name, content in (output.files or {}).items():
        if name.lower().endswith(P_SCAN_EXTS):
            src[name] = content
    if is_webapp(output):
        root = workspace_dir(output)
        for base, p_dirs, fnames in os.walk(root):
            p_dirs[:] = [d for d in p_dirs if d not in WALK_SKIP_DIRS]
            for fn in fnames:
                if not fn.lower().endswith(P_SCAN_EXTS):
                    continue
                full = os.path.join(base, fn)
                if os.path.islink(full):
                    continue
                try:
                    if os.path.getsize(full) > 512 * 1024:
                        continue
                    with open(full, "r", encoding="utf-8", errors="replace") as f:
                        rel = os.path.relpath(full, root).replace(os.sep, "/")
                        src[rel] = f.read()
                except OSError:
                    continue
    return src


def p_source_hash(src: dict[str, str]) -> str:
    h = hashlib.sha256()
    for path in sorted(src):
        h.update(path.encode("utf-8"))
        h.update(b"\0")
        h.update(src[path].encode("utf-8", errors="replace"))
        h.update(b"\0")
    return h.hexdigest()


def p_scan_blob(src: dict[str, str]) -> str:
    parts: list[str] = []
    total = 0
    for path, code in src.items():
        chunk = f"=== {path} ===\n{code}\n"
        if total + len(chunk) > P_SCAN_CODE_BUDGET:
            chunk = chunk[: max(0, P_SCAN_CODE_BUDGET - total)]
        parts.append(chunk)
        total += len(chunk)
        if total >= P_SCAN_CODE_BUDGET:
            break
    return "".join(parts)


def p_ast_findings(src: dict[str, str]) -> tuple[list[str], list[str]]:
    findings: list[str] = []
    scanned: list[str] = []
    for path, code in src.items():
        if path.lower().endswith(".py"):
            scanned.append(path)
            for w in get_code_warnings(code):
                findings.append(f"{path}: {w}")
    return findings, scanned


async def llm_findings(src: dict[str, str], settings) -> tuple[list[str], str, bool]:
    """Run the aux-tier semantic pass on the user's credentials.

    The final boolean reports whether the review completed successfully. Public
    publishing treats an incomplete review as a security block and does not memoize
    it, allowing a later attempt to recover after credentials or the provider do.
    """
    blob = p_scan_blob(src)
    if not blob.strip():
        return ["No supported source files were available for security review."], "block", False
    from backend.apps.agents.providers.registry import resolve_aux_model
    from backend.apps.settings.credentials import get_anthropic_client_for_model
    from backend.apps.agents.core.aux_llm import safe_resp_text
    try:
        model, p_base = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, model)
        resp = await client.messages.create(
            model=model,
            max_tokens=1200,
            system=P_SCAN_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": blob}],
        )
    except Exception:
        logger.exception("publish LLM security scan unavailable")
        return ["Automated security review could not run; public publishing is blocked."], "block", False
    try:
        text = safe_resp_text(resp).strip()
    except Exception:
        logger.exception("publish LLM security scan returned an unreadable response")
        return ["Automated security review returned an invalid result; public publishing is blocked."], "block", False
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return ["Automated security review returned invalid JSON; public publishing is blocked."], "block", False
    if not isinstance(parsed, dict) or not isinstance(parsed.get("findings"), list):
        return ["Automated security review returned an invalid result; public publishing is blocked."], "block", False
    findings = [str(f) for f in parsed["findings"] if str(f).strip()][:20]
    severity = parsed.get("severity")
    if severity not in ("clean", "warn", "block"):
        return ["Automated security review returned an invalid verdict; public publishing is blocked."], "block", False
    return findings, severity, True


async def scan_for_publish(output: Output, settings) -> PublishReview:
    src = collect_source(output)
    key = p_source_hash(src)
    cached = memo.get(key)
    if cached is not None:
        memo.move_to_end(key)
        return merge_capability(output, cached)
    ast_findings, scanned = p_ast_findings(src)
    llm_list, llm_sev, llm_complete = await llm_findings(src, settings)
    findings = ast_findings + llm_list
    verdict: Literal["clean", "warn", "block"] = "clean"
    if findings:
        verdict = "warn"
    if ast_findings or llm_sev == "block" or not llm_complete:
        verdict = "block"
    review = PublishReview(
        verdict=verdict,
        findings=findings,
        scanned_files=scanned or sorted(src.keys()),
    )
    if llm_complete:
        memo[key] = review
        memo.move_to_end(key)
        while len(memo) > P_MEMO_MAX:
            memo.popitem(last=False)
    return merge_capability(output, review)


def quick_ast_gate(output: Output) -> list[str]:
    """Return AST-visible findings for callers that need a cheap local preview."""
    findings, _ = p_ast_findings(collect_source(output))
    return findings
