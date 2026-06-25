import os
from typing import List, Optional, Tuple

from typeguard import typechecked

from backend.apps.agents.manager.prompt.prompt_context import resolve_attached_skills, resolve_forced_tools


@typechecked
def build_dir_tree(root: str, max_depth: int = 4, prefix: str = "") -> List[str]:
    """Build a recursive directory tree listing."""
    lines = []
    try:
        entries = sorted(os.listdir(root))
    except PermissionError:
        return [f"{prefix}[permission denied]"]
    dirs = [e for e in entries if not e.startswith(".") and os.path.isdir(os.path.join(root, e))]
    files = [e for e in entries if not e.startswith(".") and os.path.isfile(os.path.join(root, e))]
    for f in files:
        lines.append(f"{prefix}{f}")
    for d in dirs:
        lines.append(f"{prefix}{d}/")
        if max_depth > 1:
            sub = build_dir_tree(os.path.join(root, d), max_depth - 1, prefix + "  ")
            lines.extend(sub)
    return lines


@typechecked
def build_prompt_content(prompt: str, images: Optional[List] = None, context_paths: Optional[List] = None, forced_tools: Optional[List[str]] = None, attached_skills: Optional[List] = None, api_type: str = "anthropic", model: str = ""):
    """Build message content for the Anthropic SDK's prompt stream.

    Routes attachments per provider:
      - Anthropic: native `image` + `document` blocks for the active
        Claude model. Text files inline as <context_file>. Binary that
        isn't PDF/image gets a refusal placeholder.
      - Gemini (api=gemini): we still talk to the SDK with Anthropic
        content-block shapes; the 9router translation layer (cc/gc/gpt
        lanes) converts to the provider's native shape. For Gemini's
        native multimodal we emit image/document blocks the same way
        and rely on 9router to rewrite to inline_data. Over 20MB
        payloads get refused at this layer (Gemini's inline cap).
      - OpenAI / Codex: image blocks pass through (image_url at the
        wire); PDFs handled as documents on multimodal models; non-
        multimodal models refuse.
      - OpenRouter, custom OpenAI-compatible: text fallback for
        anything binary, since native shape varies wildly. Caller can
        opt-in to the OR file-parser via a separate plugins config.
    """
    context_text, native_blocks, refusals = resolve_attachments(
        context_paths, api_type=api_type, model=model,
    )
    forced_tools_text = resolve_forced_tools(forced_tools)
    skills_text = resolve_attached_skills(attached_skills)

    refusal_text = "\n\n".join(refusals)
    parts = [p for p in (forced_tools_text, context_text, refusal_text, skills_text, prompt) if p]
    full_prompt = "\n\n".join(parts)

    has_native = bool(native_blocks)
    if not images and not has_native:
        return full_prompt
    content: List[dict] = [{"type": "text", "text": full_prompt}]
    for img in (images or []):
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": img.get("media_type", "image/png"),
                "data": img["data"],
            },
        })
    content.extend(native_blocks)
    return content


@typechecked
def resolve_attachments(context_paths: Optional[List], api_type: str, model: str) -> Tuple[str, List[dict], List[str]]:
    """Split context_paths into:
       - inline text (returned as the existing <context_file> block string)
       - native content blocks for this provider (PDFs/images)
       - refusal strings that get appended to the prompt as plain text

    Reuses the upload-time sniff (PDF magic / null-byte heuristic) so
    a renamed `.pdf` actually classifies right, and a `.txt` with
    binary garbage doesn't sneak through as text.

    Two layers of size guard:
      1) Per-file inline cap based on provider's raw size limit.
      2) Total base64-expanded size cap across all native attachments,
         because providers cap the WHOLE request body (Anthropic 32MB,
         Gemini 20MB, OpenAI 50MB). 4 medium PDFs that pass the
         per-file check can still collectively blow the request cap.
    The last document block gets cache_control:ephemeral so a follow-up
    turn on the same PDF reuses the cache prefix (Anthropic only).
    """
    if not context_paths:
        return "", [], []
    from backend.apps.settings.settings import sniff_file_kind
    import base64 as p_b64
    sections: List[str] = []
    native: List[dict] = []
    refusals: List[str] = []

    # The Claude Agent SDK speaks only Anthropic content-block shape. 9router 0.3.60 translates `image` blocks to the per-provider native shape; we trust that (the existing `images` param has shipped on every provider since v1.0.29). `document` (PDF) blocks: native on Anthropic upstream. For Gemini, anthropic-proxy rewrites document→image (keeping media_type=application/pdf), and Gemini's inline_data accepts that mime type natively. For OpenRouter, anthropic-proxy detects document blocks + injects the file-parser plugin. For OpenAI we refuse PDFs (no 9router translator path for the type:file shape, and Codex OAuth can't hit /v1/files anyway).
    api = (api_type or "anthropic").lower()
    supports_image = api in ("anthropic", "gemini", "openai", "openrouter", "gemini-cli")
    # PDFs flow per provider: - Anthropic: native document blocks pass through cleanly. - Gemini: anthropic_proxy rewrites document → image_url with data:application/pdf base64; 9router translates to Gemini inlineData natively. - OpenRouter: file-parser plugin injected in anthropic-proxy. - OpenAI direct (GPT-5.x non-codex): anthropic_proxy detects document block + bypasses 9router entirely, translating to OpenAI Chat Completions and streaming response back via anthropic_to_openai.py. Requires openai_api_key. - Codex (cx/): models don't support PDFs.
    supports_pdf = api in ("anthropic", "gemini", "gemini-cli", "openrouter", "openai")
    if api == "openai" and isinstance(model, str) and ("codex" in model.lower() or model.lower().startswith("cx/")):
        supports_pdf = False

    # Per-file inline caps (raw bytes, before base64). Going over means the request would 4xx, blow our 64MB SDK buffer, or exceed the API's per-request cap on its own.
    if api == "anthropic":
        per_file_cap = 24 * 1024 * 1024
        total_request_cap = 28 * 1024 * 1024  # under Anthropic's 32MB
    elif api == "gemini":
        per_file_cap = 14 * 1024 * 1024
        total_request_cap = 15 * 1024 * 1024  # under Gemini's 20MB
    elif api == "openai":
        per_file_cap = 24 * 1024 * 1024
        total_request_cap = 45 * 1024 * 1024  # under OpenAI's 50MB
    elif api == "openrouter":
        per_file_cap = 24 * 1024 * 1024
        total_request_cap = 45 * 1024 * 1024
    else:
        per_file_cap = 0
        total_request_cap = 0

    # Running total of base64-expanded bytes already committed to the request. Anything that would push us over total_request_cap gets refused with concrete recovery actions.
    b64_total = 0

    # Combined char budget across inline TEXT attachments. Per-file 512K read cap doesn't stop a user dropping 20 huge txt files in one turn and silently blowing the context window. Whole-file or refuse: partial files confuse the model and the user can't tell what's missing. Sized to roughly fit 1M-window models (~375K tokens at 4 chars/token) while leaving room for prior conversation, the prompt, and tool turns.
    text_total_chars = 0
    text_total_cap = 1_500_000

    for cp in context_paths:
        path = cp.get("path", "") or ""
        cp_type = cp.get("type", "file")
        if not path or not os.path.exists(path):
            sections.append(f"[Context: {path}, not found]")
            continue
        if cp_type == "directory" and os.path.isdir(path):
            tree_lines = build_dir_tree(path, max_depth=4)
            sections.append(
                f"<context_directory path=\"{path}\">\n{chr(10).join(tree_lines)}\n</context_directory>"
            )
            continue
        if cp_type != "file" or not os.path.isfile(path):
            sections.append(f"[Context: {path}, type mismatch]")
            continue
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                head = fh.read(4096)
            kind, media_type = sniff_file_kind(head, os.path.basename(path))

            if kind == "text":
                with open(path, "r", errors="replace") as f:
                    content = f.read(512_000)
                if text_total_chars + len(content) > text_total_cap:
                    room = max(0, text_total_cap - text_total_chars)
                    refusals.append(
                        f"[Attached text file {os.path.basename(path)} ({len(content) // 1000}K chars) "
                        f"skipped: would exceed combined text-attachment cap of {text_total_cap // 1000}K chars "
                        f"this turn (~{room // 1000}K left). Detach a file or split into separate turns.]"
                    )
                    continue
                text_total_chars += len(content)
                sections.append(
                    f"<context_file path=\"{path}\">\n{content}\n</context_file>"
                )
                continue

            # base64 expands ~4/3, ceil to be conservative.
            b64_size = ((size + 2) // 3) * 4

            if kind == "pdf":
                if not supports_pdf:
                    if api == "openai":
                        # Falls here only for Codex variants (gpt-5.3-codex etc.), which don't accept PDFs even though their family does.
                        refusals.append(
                            f"[Attached PDF {os.path.basename(path)} ({size // 1024} KB) cannot be read on Codex models. "
                            "Switch to a non-Codex GPT-5 (e.g. gpt-5.5), Claude, Gemini 3.x, or "
                            "any model via OpenRouter to read PDFs natively.]"
                        )
                    else:
                        refusals.append(
                            f"[Attached PDF {os.path.basename(path)} ({size // 1024} KB) cannot be read on this provider. "
                            "Switch to a Claude model (Sonnet 4.6, Opus 4.7, Haiku 4.5), Gemini 3.x, GPT-5 (non-Codex), "
                            "or any model through OpenRouter to read PDFs natively.]"
                        )
                    continue
                if size > per_file_cap:
                    refusals.append(
                        f"[Attached PDF {os.path.basename(path)} ({size // (1024*1024)} MB) exceeds the per-file cap "
                        f"of {per_file_cap // (1024*1024)} MB on this provider. Split the PDF or send a smaller excerpt.]"
                    )
                    continue
                if b64_total + b64_size > total_request_cap:
                    room_mb = max(0, total_request_cap - b64_total) // (1024 * 1024)
                    refusals.append(
                        f"[Attached PDF {os.path.basename(path)} would push the request over "
                        f"{total_request_cap // (1024*1024)} MB encoded (provider cap). "
                        f"Only ~{room_mb} MB of room left this turn. Detach a file, or send PDFs in separate turns.]"
                    )
                    continue
                with open(path, "rb") as fh:
                    data_b64 = p_b64.b64encode(fh.read()).decode("ascii")
                block = {
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": data_b64,
                    },
                }
                native.append(block)
                b64_total += b64_size
                continue

            if kind == "image":
                if not supports_image:
                    refusals.append(
                        f"[Attached image {os.path.basename(path)} cannot be displayed to this model. "
                        "Switch to a vision-capable model (Claude, GPT-4o/5, Gemini).]"
                    )
                    continue
                if size > per_file_cap:
                    refusals.append(
                        f"[Attached image {os.path.basename(path)} ({size // (1024*1024)} MB) exceeds per-file cap.]"
                    )
                    continue
                if b64_total + b64_size > total_request_cap:
                    room_mb = max(0, total_request_cap - b64_total) // (1024 * 1024)
                    refusals.append(
                        f"[Attached image {os.path.basename(path)} would push the request over "
                        f"{total_request_cap // (1024*1024)} MB encoded. ~{room_mb} MB of room left.]"
                    )
                    continue
                with open(path, "rb") as fh:
                    data_b64 = p_b64.b64encode(fh.read()).decode("ascii")
                native.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type or "image/png",
                        "data": data_b64,
                    },
                })
                b64_total += b64_size
                continue

            # binary, other
            refusals.append(
                f"[Attached binary file {os.path.basename(path)} not inlined. Convert to text first.]"
            )
        except Exception as e:
            sections.append(f"[Context: {path}, error reading: {e}]")

    # Anthropic prompt caching: tag the last document block as ephemeral so a follow-up turn referencing the same PDF stays cache-warm. Per Anthropic docs, only the trailing cache_control marker matters for cache prefix scope; earlier markers are ignored.
    if api == "anthropic" and native:
        for blk in reversed(native):
            if blk.get("type") == "document":
                blk["cache_control"] = {"type": "ephemeral"}
                break

    context_text = "\n\n".join(sections)
    return context_text, native, refusals


# Legacy entry point retained for any external caller; routes to the new attachment resolver with anthropic-default routing (no native blocks emitted, so behavior is the safe text-only old path).
@typechecked
def resolve_context_paths(context_paths: Optional[List]) -> str:
    text, p_native, refusals = resolve_attachments(context_paths, api_type="anthropic", model="")
    refusal_text = "\n\n".join(refusals)
    return "\n\n".join(p for p in (text, refusal_text) if p)
