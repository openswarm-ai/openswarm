"""
Durable, reflective per-site strategy playbook (browser memory tier 2).

Tier 1 (`browser_skills`) REPLAYS mechanical action sequences with zero LLM, the
instant path for deterministic repeats. This tier remembers STRATEGY as text:
"on linkedin, generic 'design engineer' = hardware engineers; search Vercel/
Linear+React instead; the add-a-role wall is fine, read the top card." That can't
be replayed (it's judgment), but seeding it into the next run's prompt lets the
model skip re-discovery, so judgment tasks (find/evaluate/rank) get FASTER and
WISER each time instead of starting cold every run.

Folded from the best OSS, read from source (not guessed):
  - mem0 (`configs/prompts.py`): distill a run into atomic facts, then reconcile
    against existing memory with ADD/UPDATE/DELETE/NONE (accumulate + dedup +
    self-correct, never blind-overwrite, never unbounded). We collapse mem0's two
    LLM calls into ONE cheap aux call for cost: hand it the existing bullets + the
    run, get back the reconciled bullet list.
  - Stagehand/Skyvern/Voyager: only learn from a VERIFIED success, self-heal.

Two properties we hold to:
1. FAIL-SAFE: the playbook is ADVISORY TEXT, seeded into the prompt and re-verified
   by the agent, never auto-executed. A wrong bullet can only mislead (and gets
   corrected on the next run's reconcile), never ghost-succeed like a bad skill.
2. CHEAP + PROVIDER-AGNOSTIC: one cheap-tier aux call, only on a substantive
   verified success (rare relative to the work), via the caller's resolved aux
   model. Reads are O(1) disk, no LLM, so seeding stays free.
"""

import json
import logging
import os
import re
import tempfile
import time
from urllib.parse import urlparse

from backend.apps.agents.browser.seed_for import seed_for

logger = logging.getLogger(__name__)

P_PLAYBOOK_FORMAT_VERSION = 1
MAX_BULLETS = 8          # cap per site; reconcile keeps the most useful
P_MAX_BULLET_CHARS = 160
P_MAX_DISK_PLAYBOOKS = 500
P_MIN_TURNS_TO_LEARN = 4   # a 1-3 turn run taught nothing worth a durable bullet

# In-memory hot cache: host -> list[str] bullets.
CACHE: dict[str, list[str]] = {}

# Same sensitivity guard the skill layer uses: a strategy bullet must never carry
# a secret (email/token/etc.). We scrub bullets through this before persisting.
P_SECRET_RE = re.compile(
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"      # email
    r"|\b(sk-|ghp_|gho_|pk_|xox[bap]-|AIza|eyJ)[A-Za-z0-9._-]+"  # token prefixes
    r"|\b(?:\d[ -]?){13,19}\b"                              # card-ish
    r"|\b\d{3}-\d{2}-\d{4}\b"                               # ssn
)


def host_of(url: str) -> str:
    try:
        return (urlparse(url).netloc or "").lower()
    except Exception:
        return ""


def p_has_secret(text: str) -> bool:
    return bool(P_SECRET_RE.search(text or ""))


def clean_bullet(b: str) -> str | None:
    b = re.sub(r"\s+", " ", str(b or "")).strip().lstrip("-*• ").strip()
    if not b or p_has_secret(b):
        return None
    return b[:P_MAX_BULLET_CHARS]


# --- persistence (mirrors browser_skills, separate dir) -------------------
def p_dir() -> str | None:
    base = os.environ.get("OPENSWARM_BROWSER_PLAYBOOK_DIR")
    if not base:
        try:
            from backend.config.paths import DATA_ROOT
            base = os.path.join(DATA_ROOT, "browser_playbook")
        except Exception:
            return None
    try:
        os.makedirs(base, mode=0o700, exist_ok=True)
    except Exception:
        return None
    return base


def p_path(host: str) -> str | None:
    import hashlib
    d = p_dir()
    if not d:
        return None
    h = hashlib.sha256(host.encode("utf-8")).hexdigest()[:32]
    return os.path.join(d, f"{h}.json")


def persist(host: str, bullets: list[str]) -> None:
    path = p_path(host)
    if not path:
        return
    payload = {"version": P_PLAYBOOK_FORMAT_VERSION, "host": host,
               "bullets": bullets, "updated_at": time.time()}
    try:
        d = os.path.dirname(path)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, path)  # atomic; a reader never sees a half-written file
        p_evict_if_over_cap(d)
    except Exception as e:
        logger.debug(f"[browser-playbook] persist failed: {e}")


def p_evict_if_over_cap(d: str) -> None:
    try:
        files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".json")]
        if len(files) <= P_MAX_DISK_PLAYBOOKS:
            return
        files.sort(key=lambda p: os.path.getmtime(p))
        for p in files[: len(files) - P_MAX_DISK_PLAYBOOKS]:
            try:
                os.remove(p)
            except Exception:
                pass
    except Exception:
        pass


def load(host: str) -> list[str]:
    path = p_path(host)
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") != P_PLAYBOOK_FORMAT_VERSION:
            return []
        return [b for b in (data.get("bullets") or []) if isinstance(b, str)]
    except Exception:
        return []


def get_playbook(host: str) -> list[str]:
    """Durable strategy bullets for a host (cheap, no LLM). For seeding + UX.

    Falls back to a shipped seed when the user has no learned playbook yet, so a
    fresh install isn't fully cold on a popular site's first task. The seed is
    advisory like any bullet; the next verified run reconciles against it and
    writes a learned playbook that supersedes it."""
    if not host:
        return []
    if host in CACHE:
        return CACHE[host]
    bullets = load(host) or seed_for(host)
    CACHE[host] = bullets
    return bullets


def format_for_prompt(host: str) -> str:
    """The seed block injected into a fresh run's system prompt, or '' if none."""
    bullets = get_playbook(host)
    if not bullets:
        return ""
    lines = "\n".join(f"- {b}" for b in bullets[:MAX_BULLETS])
    return (
        f"\n\n## What you learned about {host} on past visits\n"
        "Use these as a head start to skip re-discovery, but re-verify since the "
        "site can change:\n" + lines
    )


def p_store(host: str, bullets: list[str]) -> list[str]:
    """Clean, cap, persist, warm cache. Returns the stored list."""
    cleaned: list[str] = []
    seen = set()
    for b in bullets:
        cb = clean_bullet(b)
        if cb and cb.lower() not in seen:
            seen.add(cb.lower())
            cleaned.append(cb)
        if len(cleaned) >= MAX_BULLETS:
            break
    CACHE[host] = cleaned
    persist(host, cleaned)
    return cleaned


# --- the reflective distill+reconcile (mem0 pattern, one cheap call) ------
def should_learn(honest: bool, turns: int) -> bool:
    """Only learn from a verified, substantive success: a ghost teaches nothing,
    and a 1-3 turn run has no durable site strategy worth a bullet."""
    return bool(honest) and turns >= P_MIN_TURNS_TO_LEARN


def p_build_prompt(host: str, task: str, working_memory: str, summary: str,
                  existing: list[str]) -> str:
    ex = "\n".join(f"{i+1}. {b}" for i, b in enumerate(existing)) or "(empty)"
    return (
        f"You maintain a short STRATEGY PLAYBOOK for using the website {host} "
        "efficiently. A fresh agent reads it before each task to skip re-discovery.\n\n"
        f"EXISTING PLAYBOOK for {host}:\n{ex}\n\n"
        f"A task just SUCCEEDED on {host}. Here is what the agent did and learned:\n"
        f"TASK: {task}\n"
        f"AGENT NOTES: {working_memory[:1500]}\n"
        f"RESULT: {summary[:800]}\n\n"
        "Return JSON: {\"playbook\": [\"...\"], \"universal\": [\"...\"]}, where "
        "`playbook` is the UPDATED per-site playbook and `universal` is the SUBSET of "
        "lessons that are SITE-AGNOSTIC (true on ANY website, e.g. how composers/Send "
        "buttons behave in general), so other sites can reuse them. `universal` may be "
        "empty; never put site-specific URLs, selectors, or names in it. Rules:\n"
        f"- At most {MAX_BULLETS} bullets, each under {P_MAX_BULLET_CHARS} chars, "
        "atomic and REUSABLE for ANY task on this site.\n"
        "- Keep only durable site strategy: which queries/filters/URLs work, what "
        "to avoid, where things live, walls that are safe to ignore.\n"
        "- ALWAYS keep interaction mechanics that cost the agent a retry, e.g. "
        "'Enter inserts a newline in the message composer; click the Send button "
        "instead' or 'the filter opens a dropdown, not a new page'.\n"
        "- ALWAYS keep PERCEPTION TRAPS: something that LOOKED wrong or ambiguous "
        "but was actually fine, so the next agent is not fooled into a detour, e.g. "
        "'a 1:1 chat is titled \"<Other> and <You>\"; that IS the direct thread, do "
        "not try to start a new one'.\n"
        "- DROP anything specific to THIS task's data (names, the actual answer), "
        "one-offs, secrets, or obvious facts.\n"
        "- MERGE duplicates; if a new lesson CONTRADICTS an old bullet, keep the "
        "corrected one and drop the stale one.\n"
        "- If nothing durable was learned, return the existing playbook unchanged.\n"
        "Return ONLY the JSON object, nothing else."
    )


def p_parse(text: str) -> list[str] | None:
    """Pull the bullet list out of the aux reply. Tolerant of code fences/prose."""
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except Exception:
        return None
    pb = data.get("playbook")
    if not isinstance(pb, list):
        return None
    return [str(x) for x in pb if isinstance(x, (str, int, float))]


def p_parse_universal(text: str) -> list[str]:
    """The site-agnostic subset the distill flagged, for the cross-site meta-playbook.
    Tolerant: missing/garbled `universal` just yields nothing (the site distill still runs)."""
    if not text:
        return []
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except Exception:
        return []
    uni = data.get("universal")
    if not isinstance(uni, list):
        return []
    return [str(x) for x in uni if isinstance(x, (str, int, float))]


async def distill_and_store(host, task, working_memory, summary,
                            aux_client, aux_model) -> bool:
    """One cheap aux call: distill this successful run + reconcile against the
    existing playbook (mem0 ADD/UPDATE/DELETE/NONE, collapsed). Persists the
    result. Best-effort: any failure leaves the prior playbook untouched and
    never raises into the caller. Returns True if the playbook changed."""
    try:
        if not host or not aux_client or not aux_model:
            return False
        existing = get_playbook(host)
        prompt = p_build_prompt(host, task or "", working_memory or "", summary or "", existing)
        resp = await aux_client.messages.create(
            model=aux_model, max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(getattr(b, "text", "") for b in (resp.content or []))
        new_bullets = p_parse(text)
        if new_bullets is None:
            return False
        stored = p_store(host, new_bullets)
        changed = stored != existing
        # Fold any site-agnostic lessons into the cross-site meta-playbook (no extra
        # LLM call, they rode along in this same reply). Best-effort, never fatal.
        try:
            from backend.apps.agents.browser import browser_meta_playbook
            browser_meta_playbook.absorb(p_parse_universal(text))
        except Exception:
            pass
        if changed:
            logger.info(f"[browser-playbook] {host}: {len(stored)} strategy bullet(s) "
                        f"(was {len(existing)})")
        return changed
    except Exception as e:
        logger.debug(f"[browser-playbook] distill failed: {e}")
        return False


# --- UX / maintenance -----------------------------------------------------
def list_hosts() -> list[dict]:
    """Every site we have a playbook for, for a 'what has it learned' view."""
    out = []
    d = p_dir()
    if d:
        try:
            for f in os.listdir(d):
                if not f.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(d, f), encoding="utf-8") as fh:
                        data = json.load(fh)
                except Exception:
                    continue
                if data.get("host") and data.get("bullets"):
                    out.append({"host": data["host"], "bullets": data["bullets"],
                                "updated_at": data.get("updated_at", 0)})
        except Exception:
            pass
    return sorted(out, key=lambda x: -x["updated_at"])


def forget(host: str) -> bool:
    """User-facing: drop a site's learned strategy (it re-learns next success)."""
    if not host:
        return False
    CACHE.pop(host, None)
    path = p_path(host)
    if path and os.path.exists(path):
        try:
            os.remove(path)
            logger.info(f"[browser-playbook] forgot {host}")
            return True
        except Exception:
            pass
    return False


def clear(wipe_disk: bool = False) -> None:
    """Clear the in-memory cache (tests). With wipe_disk, also remove files."""
    CACHE.clear()
    if wipe_disk:
        d = p_dir()
        if d:
            try:
                for f in os.listdir(d):
                    if f.endswith(".json"):
                        os.remove(os.path.join(d, f))
            except Exception:
                pass
