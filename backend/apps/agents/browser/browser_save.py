"""Persist page-scraped data straight to a workspace file.

A big list (every comment, all N results) can't fit through the browser agent's
length-capped reply, so without this the agent burns a dispatch per 100-row chunk
just to funnel an array it already has back out. Here the page produces the
CONTENT (a JS expression) and Python owns the DESTINATION: a hostile or buggy page
can pick what to write but never WHERE, so the write stays sandboxed to one
workspace subdir. Returns a short receipt for the model, never the data itself.
"""
import json
import os

P_MAX_BYTES = 25 * 1024 * 1024  # a page can't realistically hold more scraped data
P_ALLOWED_EXT = {".json", ".ndjson", ".csv", ".tsv", ".txt", ".md"}
P_SUBDIR = "browser-data"  # never the workspace root, so we can't clobber project files


def p_dest_dir(cwd: str | None, session_id: str) -> str:
    base = cwd if (cwd and os.path.isdir(cwd)) else os.path.join(
        os.path.expanduser("~"), ".openswarm", "workspaces", session_id or "browser")
    dest = os.path.join(base, P_SUBDIR)
    os.makedirs(dest, exist_ok=True)
    return dest


def save_page_data(cwd: str | None, session_id: str, filename: str, content: str) -> str:
    """Write `content` to a sandboxed data file; return a one-line receipt for the
    model (the path + size, never the data). Every rejection is a plain message,
    this never raises into the agent loop."""
    name = os.path.basename((filename or "").strip())  # strips any dir parts / .. / abs path
    if not name:
        return "Save failed: give a plain filename like results.json."
    ext = os.path.splitext(name)[1].lower()
    if ext not in P_ALLOWED_EXT:
        return (f"Save failed: '{ext or 'no extension'}' isn't allowed; this tool is for data, "
                f"not code. Use one of: {', '.join(sorted(P_ALLOWED_EXT))}.")
    body = content or ""
    if len(body.encode("utf-8", "ignore")) > P_MAX_BYTES:
        return f"Save failed: that's over the {P_MAX_BYTES // (1024 * 1024)}MB cap; save fewer fields or rows."

    try:
        dest_dir = p_dest_dir(cwd, session_id)
        dest_real = os.path.realpath(dest_dir)
        full = os.path.realpath(os.path.join(dest_dir, name))
        # realpath + os.sep guard: defeats traversal, absolute paths, symlinks, AND a
        # prefix-collision sibling (browser-data vs browser-data-evil). basename already
        # neutralizes most of it; this is the belt to that suspenders.
        if full != dest_real and not full.startswith(dest_real + os.sep):
            return "Save failed: that filename escapes the workspace; use a plain name."
        with open(full, "w", encoding="utf-8") as f:
            f.write(body)
    except Exception as e:
        return f"Save failed: {type(e).__name__}."

    # best-effort item count so the receipt proves real data landed (not an empty array)
    note = ""
    try:
        parsed = json.loads(body)
        if isinstance(parsed, list):
            note = f", {len(parsed)} items"
        elif isinstance(parsed, dict):
            note = f", {len(parsed)} keys"
    except Exception:
        pass
    return f"Saved {len(body):,} chars{note} to {full}"
