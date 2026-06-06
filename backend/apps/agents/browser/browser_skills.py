"""
Browser action-sequence skill cache (the "learn once, replay fast" layer),
now with cross-session persistence + text redaction.

The first time the full LLM agent completes a task, we distill the productive
action sequence and store it keyed by (host, normalized-task). A later identical
task on the same host REPLAYS that sequence with zero LLM round-trips (a ~50s
first run becomes ~1s on repeat, well under human time), and the library now
survives restarts so it keeps getting better over time.

Two properties we hold to extreme rigor:

1. CONTEXT ROT / TTFT: skills are RETRIEVAL-AS-EXECUTION, never
   retrieval-as-context. A matched skill is *run*, it is never injected into the
   prompt, so the skill library can grow to thousands of entries with ZERO
   effect on prompt size, TTFT, or context rot. Lookups are O(1) exact-key file
   reads (no corpus scan at boot or at lookup), with an in-memory hot cache, so
   cold-start and per-request latency stay flat as the library grows. And since
   a replay has zero LLM turns, it strictly REDUCES total context generated.

2. SECRETS NEVER HIT DISK: a `type` step carries the typed text, which can be a
   password / email / card / token. Any skill that touches sensitive-looking
   text (or a password-shaped field, or a tokenized URL) is kept IN-MEMORY ONLY
   and never persisted. Only fully non-sensitive skills are written to disk;
   URL userinfo + fragments are stripped before persisting regardless.

3. NOTHING IS TRUSTED UNTIL A REPLAY PROVES IT (the verify gate). A freshly
   learned or freshly edited skill is PROBATIONARY: it's allowed to replay (that
   is how it earns trust), but the first time a probationary replay fails it is
   QUARANTINED, not silently kept; quarantined skills never replay again (the
   task falls back to the pure-LLM baseline), so a lossy distillation can never
   make a task slower-than-baseline or ghost-succeed. Only a skill that has
   replayed end-to-end successfully becomes TRUSTED, and only a trusted skill
   gets the benefit of the doubt on a one-off transient miss. Re-deriving a task
   after a failed replay is an EDIT: if the new steps differ from the stored
   ones the skill is re-versioned (rev++) back to probation; if they're
   identical the miss was transient and trust is kept. State + rev persist.

Robustness (a stale replay that "succeeds" wrongly is the ghost-failure we must
avoid): clicks are recorded by (role, name) and re-resolved fresh at replay; a
skill is only recorded if every productive step is robustly replayable; the
replay executor (in browser_agent) verifies each step and falls back to the full
LLM agent on any miss, which re-records.
"""

import hashlib
import json
import logging
import os
import re
import tempfile
import time
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger(__name__)


def _event(kind: str, host: str, sig: str, rev: int = 0, state: str = "", **extra) -> None:
    """Mirror a lifecycle transition into the metrics sink so the analyzer can
    prove the skill layer helps vs. silently thrashes. Lazy + best-effort: this
    module never hard-depends on metrics, and a metrics failure never propagates."""
    try:
        from . import browser_metrics
        browser_metrics.record_skill_event(kind, host, sig, rev=rev, state=state, extra=extra or None)
    except Exception:
        pass


# In-memory hot cache: key "host::task_sig" -> skill dict. Bounded.
_skills: dict[str, dict] = {}
_MAX_MEM_SKILLS = 200
_MAX_DISK_SKILLS = 1000          # bound the on-disk library; evict oldest by mtime
_SKILL_FORMAT_VERSION = 1

# Trust state (the verify gate). A skill moves PROBATION -> TRUSTED only by a
# successful end-to-end replay; an unproven (probation) skill that fails a replay
# goes to QUARANTINE and is never replayed again (task falls back to pure LLM).
_PROBATION = "probation"
_TRUSTED = "trusted"
_QUARANTINE = "quarantine"
# A proven skill tolerates this many consecutive transient replay misses before
# it's demoted back to probation (forced to re-earn trust).
_FAIL_DEMOTE_THRESHOLD = 2

# Tools that change page state (worth replaying). Reads/meta are never recorded.
_PRODUCTIVE = {"BrowserType", "BrowserClickIndex", "BrowserClick", "BrowserPressKey", "BrowserScroll"}

_URL_RE = re.compile(r"https?://\S+")
_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^a-z0-9 ]+")
_STOP = {
    "the", "a", "an", "to", "into", "on", "this", "that", "page", "please",
    "then", "and", "go", "open", "browser", "tell", "me", "whether", "it",
    "of", "in", "for", "with", "your", "after", "if", "you", "can",
}

# --- sensitivity detection (gate for what may touch disk) ------------------
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_PHONE_RE = re.compile(r"\b(?:\+?\d[ -]?){10,15}\b")
_TOKEN_PREFIX_RE = re.compile(r"\b(sk-|ghp_|gho_|pk_|xox[bap]-|AIza|eyJ)")
_SENSITIVE_FIELD_RE = re.compile(
    r"pass|pwd|secret|otp|cvv|cvc|ssn|card|token|api[_-]?key|security"
    r"|user|login|sign[-_]?in|email|auth|seed|recovery|phrase|\bpin\b|2fa|verif|code",
    re.I,
)


def _looks_sensitive(text: str, selector: str = "") -> bool:
    """Conservative: err toward 'sensitive' so secrets never persist. Catches
    emails, SSNs, card/phone-shaped digit runs, known key prefixes, long
    high-entropy tokens, bare one-time-code digit runs, and anything typed into
    a credential-shaped field (a wrongly-blocked persist just keeps the skill
    in-memory, so false positives are cheap; a leak is not)."""
    if selector and _SENSITIVE_FIELD_RE.search(selector):
        return True
    if not text:
        return False
    if _EMAIL_RE.search(text) or _SSN_RE.search(text) or _CARD_RE.search(text):
        return True
    if _TOKEN_PREFIX_RE.search(text):
        return True
    if _PHONE_RE.search(text):
        return True
    stripped = text.strip()
    # bare 6-8 digit run: the shape of every 2FA/SMS code; never worth persisting
    if re.fullmatch(r"\d{6,8}", stripped):
        return True
    # long high-entropy token: >=20 chars with both letters and digits
    if len(stripped) >= 20 and any(c.isdigit() for c in stripped) and any(c.isalpha() for c in stripped) and " " not in stripped:
        return True
    return False


def _sanitize_url(url: str) -> str:
    """Strip userinfo (user:pass@) and fragment from a URL before it persists."""
    try:
        p = urlparse(url)
        netloc = p.hostname or ""
        if p.port:
            netloc = f"{netloc}:{p.port}"
        return urlunparse((p.scheme, netloc, p.path, p.params, p.query, ""))
    except Exception:
        return url


def normalize_task(task: str) -> str:
    """Stable task signature: lowercase, drop urls/punct/filler, collapse ws."""
    t = (task or "").lower()
    t = _URL_RE.sub(" ", t)
    t = _PUNCT_RE.sub(" ", t)
    toks = [w for w in _WS_RE.sub(" ", t).strip().split(" ") if w and w not in _STOP]
    return " ".join(toks)


# --- parameterization (reuse one skill for "the same task, different input") ---
# A quoted value in the task is treated as a SLOT: it's abstracted out of the
# skill key (so `search "shoes"` and `search "hats"` share one skill) and the
# value is filled from the LIVE task at replay (so the value is never stored on
# disk, a redaction win, and the skill generalizes). Quoting is the explicit,
# high-precision signal that this token is a parameter; we never guess.
# Lookarounds keep word-internal apostrophes (chen's, don't) from opening a
# span; without them every possessive made each task wording a unique sig and
# silently disabled skill matching for those tasks.
_QUOTE_RE = re.compile(r'(?<!\w)["“”‘’\']([^"“”‘’\']{1,200})["“”‘’\'](?!\w)')
_SLOT_TOKEN = " slotvalue "


def template_task(task: str) -> tuple[str, list[str]]:
    """Replace each quoted span with a fixed token; return (templated, [values])."""
    values: list[str] = []

    def _repl(m):
        values.append(m.group(1))
        return _SLOT_TOKEN

    return _QUOTE_RE.sub(_repl, task or ""), values


def _sig(task: str) -> str:
    """Skill key signature: template out quoted values, then normalize, so the
    same task with different quoted inputs maps to the same key."""
    templated, _ = template_task(task)
    return normalize_task(templated)


def _parameterize(steps: list[dict], task: str) -> list[dict]:
    """Convert any BrowserType whose text is a quoted task value into a slot
    step (value_slot index), so the value is sourced live at replay, not stored."""
    _, values = template_task(task)
    if not values:
        return steps
    vlower = [v.strip().lower() for v in values]
    out = []
    for s in steps:
        if s["tool"] == "BrowserType":
            t = (s["params"].get("text") or "").strip().lower()
            if t and t in vlower:
                out.append({"tool": "BrowserType", "params": {"selector": s["params"].get("selector"), "value_slot": vlower.index(t)}})
                continue
        out.append(s)
    return out


def rehydrate(skill: dict | None, task: str) -> list[dict] | None:
    """Fill a skill's value_slot steps from the current task's quoted values.
    Returns runnable steps, or None if any slot can't be filled (caller then
    falls back to the full LLM agent, never a wrong value)."""
    if not skill:
        return None
    _, values = template_task(task)
    out = []
    for s in skill["steps"]:
        p = s.get("params", {})
        if s["tool"] == "BrowserType" and "value_slot" in p:
            idx = p["value_slot"]
            if not isinstance(idx, int) or idx < 0 or idx >= len(values):
                return None  # slot has no matching live value -> abort replay
            out.append({"tool": "BrowserType", "params": {"selector": p.get("selector"), "text": values[idx]}})
        else:
            out.append({"tool": s["tool"], "params": dict(p)})
    return out


def host_of(url: str) -> str:
    """host:port of a url (so different sites/ports never share a skill)."""
    try:
        p = urlparse(url)
        return (p.netloc or "").lower()
    except Exception:
        return ""


def distill_steps(action_log: list[dict]) -> list[dict]:
    """Turn a successful task's action_log into a robust replayable step list,
    or [] if it can't be made safely replayable."""
    steps: list[dict] = []
    productive_count = 0

    def _emit_simple(tool, inp):
        nonlocal productive_count
        if tool in ("BrowserType", "type") and inp.get("selector") is not None:
            steps.append({"tool": "BrowserType", "params": {"selector": inp.get("selector"), "text": inp.get("text", "")}})
            productive_count += 1; return True
        if tool in ("BrowserClick", "click") and inp.get("selector"):
            steps.append({"tool": "BrowserClick", "params": {"selector": inp["selector"]}})
            productive_count += 1; return True
        if tool in ("BrowserPressKey", "press_key") and inp.get("key"):
            steps.append({"tool": "BrowserPressKey", "params": {"key": inp["key"]}})
            productive_count += 1; return True
        if tool in ("BrowserScroll", "scroll"):
            steps.append({"tool": "BrowserScroll", "params": {k: inp[k] for k in ("direction", "amount") if k in inp}})
            productive_count += 1; return True
        if tool in ("BrowserNavigate", "navigate") and inp.get("url"):
            steps.append({"tool": "BrowserNavigate", "params": {"url": inp["url"]}})
            return True
        if tool in ("wait", "BrowserWait"):
            return True
        return False

    for a in action_log:
        if not a.get("ok", True):
            continue
        tool = a.get("tool")
        inp = a.get("input") or {}
        if tool == "BrowserBatch":
            subs = inp.get("actions") or []
            sub_res = a.get("sub_results")
            by_idx = {r.get("index"): r for r in (sub_res or []) if isinstance(r, dict)}
            for j, sub in enumerate(subs):
                st = sub.get("type")
                sp = sub.get("params") or {}
                r = by_idx.get(j)
                # aligned shape knows which subs actually ran; record only those
                if sub_res is not None and (r is None or not r.get("ok", False)):
                    break
                if st == "list_interactives":
                    continue  # read, never recorded
                if st == "click_index":
                    name = (r or {}).get("clicked_name")
                    if not name:
                        return []  # index clicks need a re-resolvable identity
                    steps.append({"tool": "BrowserClickByName", "params": {"role": (r or {}).get("clicked_role", ""), "name": name}})
                    productive_count += 1
                    continue
                if not _emit_simple(st, sp):
                    return []
            continue
        if tool == "BrowserNavigate" and inp.get("url"):
            steps.append({"tool": "BrowserNavigate", "params": {"url": inp["url"]}})
        elif tool == "BrowserType" and inp.get("selector") is not None:
            steps.append({"tool": "BrowserType", "params": {"selector": inp.get("selector"), "text": inp.get("text", "")}})
            productive_count += 1
        elif tool == "BrowserClickIndex":
            name = a.get("clicked_name")
            if not name:
                return []
            steps.append({"tool": "BrowserClickByName", "params": {"role": a.get("clicked_role", ""), "name": name}})
            productive_count += 1
        elif tool == "BrowserClick" and inp.get("selector"):
            steps.append({"tool": "BrowserClick", "params": {"selector": inp["selector"]}})
            productive_count += 1
        elif tool == "BrowserPressKey" and inp.get("key"):
            steps.append({"tool": "BrowserPressKey", "params": {"key": inp["key"]}})
            productive_count += 1
        elif tool == "BrowserScroll":
            steps.append({"tool": "BrowserScroll", "params": {k: inp[k] for k in ("direction", "amount") if k in inp}})
            productive_count += 1
    if productive_count == 0:
        return []
    return steps


def first_unsafe_step(steps: list[dict]) -> tuple[int, str]:
    """Index of the first outward-facing step (click Send/Submit/Pay, type into
    a composer), -1 if none. Reuses the batch replayer's wordlist so there is
    exactly one definition of "irreversible"."""
    from backend.apps.agents.browser import browser_batch_replay
    for i, s in enumerate(steps):
        tool = s.get("tool", "")
        p = s.get("params", {}) or {}
        probe = None
        if tool in ("BrowserClickByName", "BrowserClick"):
            name = p.get("name") or p.get("selector") or ""
            # Real Send controls have short names ("Send", "Send InMail"); a
            # 100ch profile-card blob containing "Send a..." is not one, and
            # flagging it cut a 6-step prefix to 1 (measured, r19).
            if len(name) <= 40:
                probe = {"action": "click", "name": name}
        elif tool == "BrowserType":
            probe = {"action": "type", "selector": p.get("selector") or ""}
        if probe and browser_batch_replay.is_send_step(probe):
            what = probe.get("name") or probe.get("selector")
            return i, f"step {i+1} looks irreversible/outward-facing ({what!r})"
    return -1, ""


def replay_safety(steps: list[dict]) -> tuple[bool, str]:
    """A skill with an outward-facing step must never auto-replay with zero LLM
    and zero confirmation; only the live agent path confirms sends."""
    i, why = first_unsafe_step(steps)
    return (i < 0), why


def steps_are_persistable(steps: list[dict]) -> bool:
    """True only if NO step touches sensitive text / a password-shaped field /
    a tokenized URL. Sensitive skills stay in-memory; they never hit disk."""
    for s in steps:
        p = s.get("params", {})
        if s["tool"] == "BrowserType":
            if _looks_sensitive(p.get("text", ""), p.get("selector", "")):
                return False
        elif s["tool"] == "BrowserNavigate":
            url = p.get("url", "")
            # a tokenized/credentialed URL is both sensitive and non-reproducible
            if "@" in (urlparse(url).netloc or "") or _looks_sensitive(url):
                return False
    return True


def _step_key(s: dict) -> tuple:
    """Canonical identity of a step, ignoring volatile detail, so we can tell a
    real EDIT (page changed -> different steps) from a transient re-derivation
    (same steps, the miss was just a timing blip). A slot and a literal are
    distinct; a parameter's live value is not part of identity."""
    p = s.get("params", {})
    tool = s.get("tool")
    if tool == "BrowserType":
        if "value_slot" in p:
            return (tool, p.get("selector"), "slot", p.get("value_slot"))
        return (tool, p.get("selector"), "text", p.get("text", ""))
    if tool == "BrowserClickByName":
        return (tool, p.get("role", ""), p.get("name", ""))
    if tool == "BrowserClick":
        return (tool, p.get("selector"))
    if tool == "BrowserNavigate":
        return (tool, _sanitize_url(p.get("url", "")))
    if tool == "BrowserPressKey":
        return (tool, p.get("key"))
    if tool == "BrowserScroll":
        return (tool, p.get("direction"), p.get("amount"))
    return (tool, json.dumps(p, sort_keys=True, default=str))


def _steps_equal(a: list[dict], b: list[dict]) -> bool:
    return [_step_key(s) for s in a] == [_step_key(s) for s in b]


def _sanitized_steps_for_disk(steps: list[dict]) -> list[dict]:
    """Copy of steps safe to persist: navigate URLs stripped of userinfo+fragment."""
    out = []
    for s in steps:
        if s["tool"] == "BrowserNavigate":
            out.append({"tool": "BrowserNavigate", "params": {"url": _sanitize_url(s["params"].get("url", ""))}})
        else:
            out.append({"tool": s["tool"], "params": dict(s.get("params", {}))})
    return out


# --- persistence ----------------------------------------------------------
def _skills_dir() -> str | None:
    override = os.environ.get("OPENSWARM_BROWSER_SKILLS_DIR")
    base = override
    if not base:
        try:
            from backend.config.paths import DATA_ROOT
            base = os.path.join(DATA_ROOT, "browser_skills")
        except Exception:
            return None
    try:
        os.makedirs(base, mode=0o700, exist_ok=True)
    except Exception:
        return None
    return base


def _key(host: str, sig: str) -> str:
    return f"{host}::{sig}"


def _skill_path(host: str, sig: str) -> str | None:
    d = _skills_dir()
    if not d:
        return None
    h = hashlib.sha256(_key(host, sig).encode("utf-8")).hexdigest()[:32]
    return os.path.join(d, f"{h}.json")


def _persist(host: str, sig: str, skill: dict) -> None:
    """Atomic per-skill write. Best-effort; never raises. Evicts oldest on cap."""
    path = _skill_path(host, sig)
    if not path:
        return
    payload = {
        "version": _SKILL_FORMAT_VERSION,
        "host": host, "task_sig": sig,
        "steps": _sanitized_steps_for_disk(skill["steps"]),
        "recorded_at": skill.get("recorded_at", time.time()),
        "replays": skill.get("replays", 0),
        "rev": skill.get("rev", 1),
        "state": skill.get("state", _PROBATION),
        "fails": skill.get("fails", 0),
        "composed_of": skill.get("composed_of", []),
    }
    try:
        d = os.path.dirname(path)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, path)  # atomic; a reader never sees a half-written file
        _evict_disk_if_over_cap(d)
    except Exception as e:
        logger.debug(f"[browser-skills] persist failed: {e}")


def _evict_disk_if_over_cap(d: str) -> None:
    try:
        files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".json")]
        if len(files) <= _MAX_DISK_SKILLS:
            return
        files.sort(key=lambda p: os.path.getmtime(p))  # oldest first
        for p in files[: len(files) - _MAX_DISK_SKILLS]:
            try:
                os.remove(p)
            except Exception:
                pass
    except Exception:
        pass


def _load_from_disk(host: str, sig: str) -> dict | None:
    path = _skill_path(host, sig)
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") != _SKILL_FORMAT_VERSION:
            return None  # format changed -> ignore stale file
        if not data.get("steps"):
            return None
        return {
            "host": data.get("host", host), "task_sig": data.get("task_sig", sig),
            "steps": data["steps"], "recorded_at": data.get("recorded_at", 0),
            "replays": data.get("replays", 0), "persisted": True,
            "rev": data.get("rev", 1), "state": data.get("state", _PROBATION),
            "fails": data.get("fails", 0), "composed_of": data.get("composed_of", []),
        }
    except Exception as e:
        logger.debug(f"[browser-skills] load failed: {e}")
        return None


def _host_skills(host: str) -> dict[str, dict]:
    """Every skill for one host, keyed by task_sig, in-memory authoritative over
    disk. One flat scan of the library dir (same cost list_skills always paid);
    callers that run per-record gate on cheap pre-checks before calling."""
    out: dict[str, dict] = {}
    d = _skills_dir()
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
                if data.get("host") == host and data.get("task_sig"):
                    out[data["task_sig"]] = {**data, "persisted": True}
        except Exception:
            pass
    for s in _skills.values():
        if s.get("host") == host and s.get("task_sig"):
            out[s["task_sig"]] = s
    return out


# --- composition (build on what's already proven) --------------------------
# When a freshly learned skill's steps OPEN with the full step list of an
# already-TRUSTED skill on the same host, we record that it "builds on" the
# sub-skill. The big steps stay inline (the skill is self-contained and robust on
# its own); the link is provenance + a safety wire: if that foundation is later
# deprecated or goes stale, every skill built on it is knocked back to probation
# so it must re-prove instead of silently riding a now-broken sub-sequence.
_COMPOSE_MIN_SUB_STEPS = 2


def _detect_composition(host: str, sig: str, steps: list[dict]) -> list[str]:
    """Sigs of TRUSTED host skills whose full step list is a strict opening
    prefix of `steps`. Gated: needs a tail, so only runs for >=3-step skills."""
    if len(steps) < _COMPOSE_MIN_SUB_STEPS + 1:
        return []
    keys = [_step_key(s) for s in steps]
    found: list[str] = []
    for other_sig, other in _host_skills(host).items():
        if other_sig == sig or other.get("state") != _TRUSTED:
            continue
        osteps = other.get("steps", [])
        if len(osteps) < _COMPOSE_MIN_SUB_STEPS or len(osteps) >= len(steps):
            continue
        if [_step_key(s) for s in osteps] == keys[: len(osteps)]:
            found.append(other_sig)
    return found


def _invalidate_dependents(host: str, sub_sig: str) -> None:
    """Knock every skill that builds on `sub_sig` back to probation: its proven
    foundation just moved (edited/deprecated/demoted), so it must re-earn trust
    rather than ghost-ride a sub-sequence that may no longer hold."""
    for dep_sig, dep in _host_skills(host).items():
        if sub_sig in dep.get("composed_of", []) and dep.get("state") == _TRUSTED:
            k = _key(host, dep_sig)
            live = _skills.get(k) or dep
            live["state"] = _PROBATION
            live["fails"] = 0
            _skills[k] = live
            if live.get("persisted"):
                _persist(host, dep_sig, live)
            _event("invalidate", host, dep_sig, rev=live.get("rev", 1), state=_PROBATION, foundation=sub_sig)
            logger.info(f"[browser-skills] {host}::{dep_sig} knocked to probation "
                        f"(its foundation {sub_sig} changed)")


def record_skill(host: str, task: str, action_log: list[dict]) -> bool:
    """Record (or EDIT) a replayable skill. Non-sensitive skills persist to disk;
    sensitive ones stay in-memory only. Edit-aware: if a skill already exists for
    this (host, task) and the freshly distilled steps DIFFER, this is a real edit
    (the page changed) so we re-version it (rev++) back to probation; if they're
    IDENTICAL the prior replay miss was transient, so we keep the existing trust
    and just clear the fail streak. Returns True if a skill is in place after the
    call. Best-effort; never raises into the caller."""
    try:
        if not host:
            return False
        steps = distill_steps(action_log)
        if not steps:
            return False
        sig = _sig(task)
        if not sig:
            return False
        steps = _parameterize(steps, task)  # quoted values -> slots (not stored)
        persistable = steps_are_persistable(steps)
        k = _key(host, sig)
        existing = _skills.get(k) or _load_from_disk(host, sig)

        if existing and _steps_equal(existing.get("steps", []), steps):
            # Same skill re-derived: the replay that triggered this was a transient
            # miss, not a stale skill. Keep rev + trust; just clear the fail streak.
            # If it was quarantined (a known-bad distillation), leave it quarantined
            # so the task keeps running on the pure-LLM baseline, never re-replayed.
            existing["fails"] = 0
            existing["recorded_at"] = time.time()
            existing["persisted"] = persistable
            _skills[k] = existing
            if persistable:
                _persist(host, sig, existing)
            logger.info(f"[browser-skills] re-derived identical {len(steps)}-step skill for {host} "
                        f"(rev {existing.get('rev', 1)}, state={existing.get('state')}, transient miss)")
            return True

        rev = (existing.get("rev", 1) + 1) if existing else 1
        skill = {
            "host": host, "task_sig": sig, "steps": steps,
            "recorded_at": time.time(), "replays": 0, "persisted": persistable,
            "rev": rev, "state": _PROBATION, "fails": 0,
            "composed_of": _detect_composition(host, sig, steps),
        }
        _skills[k] = skill
        if len(_skills) > _MAX_MEM_SKILLS:
            oldest = min(_skills, key=lambda kk: _skills[kk]["recorded_at"])
            _skills.pop(oldest, None)
        if persistable:
            _persist(host, sig, skill)
        verb = "EDITED" if existing else "learned"
        comp = f", builds on {skill['composed_of']}" if skill["composed_of"] else ""
        logger.info(f"[browser-skills] {verb} {len(steps)}-step skill for {host} "
                    f"(rev {rev}, probationary{', persisted' if persistable else ', in-memory only: sensitive'}{comp})")
        _event("edit" if existing else "learn", host, sig, rev=rev, state=_PROBATION,
               steps=len(steps), composed_of=skill["composed_of"], persisted=persistable)
        if skill["composed_of"]:
            _event("compose", host, sig, rev=rev, state=_PROBATION, builds_on=skill["composed_of"])
        if existing:
            _invalidate_dependents(host, sig)  # anything built on the OLD version must re-prove
        return True
    except Exception as e:
        logger.debug(f"[browser-skills] record failed: {e}")
        return False


def find_skill(host: str, task: str) -> dict | None:
    """Exact-key lookup for REPLAY: in-memory hot cache first, then a single lazy
    disk read (no corpus scan). A QUARANTINED skill (unproven and already failed)
    is never handed back, so the task runs on the pure-LLM baseline instead of
    re-attempting a known-bad replay. Cheap + flat as the library grows."""
    if not host:
        return None
    sig = _sig(task)
    if not sig:
        return None
    k = _key(host, sig)
    hit = _skills.get(k)
    if not hit:
        loaded = _load_from_disk(host, sig)
        if loaded:
            _skills[k] = loaded  # warm the hot cache (even if quarantined)
            hit = loaded
    if not hit or hit.get("state") == _QUARANTINE:
        return None
    return hit


# --- route hints (advisory reuse when mechanical replay can't run) ---------
# Replay is exact-key and refuses send-class flows, so a known route often sits
# unused while the model re-explores it. A route HINT closes that gap: the best
# similar skill is rendered as advisory text the live agent adapts and verifies,
# so it generalizes across wordings and stays send-safe (the agent still
# confirms everything; a stale hint just wastes one glance).
_HINT_MIN_OVERLAP = 0.5
_HINT_MAX_STEPS = 10


def find_similar_skill(host: str, task: str) -> tuple[dict | None, float]:
    """Best non-quarantined skill on this host by templated-sig token overlap
    (Jaccard). Returns (skill, score) or (None, 0.0). ADVISORY ONLY: replay
    stays exact-key; this feeds route hints, never mechanical execution."""
    if not host:
        return None, 0.0
    sig = _sig(task)
    stoks = set(sig.split())
    if not stoks:
        return None, 0.0
    best, best_score = None, 0.0
    for other_sig, s in _host_skills(host).items():
        if s.get("state") == _QUARANTINE or not s.get("steps"):
            continue
        otoks = set(other_sig.split())
        if not otoks:
            continue
        score = len(stoks & otoks) / len(stoks | otoks)
        # a proven skill wins ties against an unproven one
        if score > best_score or (score == best_score and best is not None
                                  and s.get("state") == _TRUSTED and best.get("state") != _TRUSTED):
            best, best_score = s, score
    if best and best_score >= _HINT_MIN_OVERLAP:
        return best, best_score
    return None, 0.0


def _hint_step_line(step: dict, values: list[str]) -> str:
    tool = step.get("tool", "")
    p = step.get("params", {}) or {}
    if tool == "BrowserNavigate":
        return f"Navigate to {p.get('url', '')}"
    if tool == "BrowserClickByName":
        name = (p.get("name") or "")[:60]
        role = p.get("role") or "element"
        return f"Click the {role} named \"{name}\""
    if tool == "BrowserClick":
        return f"Click the element matching {p.get('selector', '')!r}"
    if tool == "BrowserType":
        if "value_slot" in p:
            idx = p["value_slot"]
            val = values[idx] if isinstance(idx, int) and 0 <= idx < len(values) else None
            shown = f'"{val[:80]}"' if val else "the quoted text from your task"
            return f"Type {shown} into {str(p.get('selector') or 'the input')[:50]}"
        return f"Type \"{str(p.get('text') or '')[:80]}\" into {str(p.get('selector') or 'the input')[:50]}"
    if tool == "BrowserPressKey":
        return f"Press {p.get('key', '')}"
    if tool == "BrowserScroll":
        return f"Scroll {p.get('direction', 'down')}"
    return f"{tool}({str(p)[:60]})"


def render_route_hint(skill: dict, task: str, score: float) -> tuple[str, list[tuple]]:
    """Compact advisory route block from a skill's steps, plus the step keys for
    adoption measurement. Slots are filled from the LIVE task's quoted values
    (never from disk); the first irreversible step is flagged solo-only."""
    steps = (skill.get("steps") or [])[:_HINT_MAX_STEPS]
    if not steps:
        return "", []
    from backend.apps.agents.browser import browser_batch_replay
    _, values = template_task(task)
    # first_unsafe_step is the batching boundary (it stops at composer typing
    # too); the IRREVERSIBLE flag goes only on genuinely outward-facing clicks
    unsafe_i, _why = first_unsafe_step(steps)
    lines = []
    for i, s in enumerate(steps):
        mark = ""
        if s.get("tool") in ("BrowserClickByName", "BrowserClick"):
            p = s.get("params", {}) or {}
            name = p.get("name") or p.get("selector") or ""
            if len(name) <= 40 and browser_batch_replay.is_send_step({"action": "click", "name": name}):
                mark = " [IRREVERSIBLE: do this SOLO with `expect` proof, never in a batch]"
        lines.append(f"{i + 1}. {_hint_step_line(s, values)}{mark}")
    trust = "proven by a verified rerun" if skill.get("state") == _TRUSTED else "from one verified success"
    safe_until = unsafe_i if unsafe_i >= 0 else len(steps)
    batch_line = (
        f"Steps 1-{safe_until} are routine; combine them into ONE BrowserBatch where the page allows."
        if safe_until >= 2 else ""
    )
    hint = (
        f"\n\n[route hint, {int(score * 100)}% similar task done before on this site, {trust}] "
        "Adapt where the live page differs and verify each step as usual:\n"
        + "\n".join(lines) + (f"\n{batch_line}" if batch_line else "")
    )
    return hint, [_step_key(s) for s in steps]


def hint_step_adopted(step_key: tuple, action_log: list[dict]) -> bool:
    """Did any executed action match this hinted step? Loose identity on
    purpose: name/url/selector containment, because the live page re-resolves
    details. Powers the adoption metric only, never control flow."""
    tool = step_key[0] if step_key else ""
    for a in action_log:
        atool = a.get("tool", "")
        inp = a.get("input") or {}
        if tool == "BrowserNavigate" and atool == "BrowserNavigate":
            hinted = str(step_key[1] or "")
            if hinted and str(inp.get("url", "")).split("?")[0] == hinted.split("?")[0]:
                return True
        elif tool == "BrowserClickByName":
            hinted_name = str(step_key[2] or "").lower()
            clicked = str(a.get("clicked_name") or inp.get("name") or "").lower()
            if hinted_name and clicked and (hinted_name in clicked or clicked in hinted_name):
                return True
            for sub in (a.get("sub_results") or []):
                sname = str((sub or {}).get("clicked_name") or "").lower()
                if hinted_name and sname and (hinted_name in sname or sname in hinted_name):
                    return True
        elif tool == "BrowserType" and atool in ("BrowserType", "BrowserBatch"):
            return True  # any typing counts; payloads vary by design
        elif tool in ("BrowserPressKey", "BrowserScroll") and atool == tool:
            return True
    return False


def mark_replay_succeeded(host: str, task: str) -> None:
    """A replay ran end to end. Count it and, if the skill was still on
    probation, PROMOTE it to trusted (the verify gate just passed)."""
    s = find_skill(host, task)
    if not s:
        return
    s["replays"] = s.get("replays", 0) + 1
    s["fails"] = 0
    promoted = s.get("state") != _TRUSTED
    s["state"] = _TRUSTED
    if s.get("persisted"):
        _persist(host, s["task_sig"], s)  # keep the on-disk count + state fresh
    if promoted:
        logger.info(f"[browser-skills] {host}::{s['task_sig']} PROVEN by replay (rev {s.get('rev', 1)}) -> trusted")
        _event("promote", host, s["task_sig"], rev=s.get("rev", 1), state=_TRUSTED, replays=s["replays"])


def mark_replay_failed(host: str, task: str) -> str:
    """A replay failed mid-way. Update trust and report what happened so the
    caller can log it; the caller then falls through to the full LLM agent (which
    re-records, edit-aware). Returns one of:
      'quarantined' - skill was unproven (probation) and failed -> never replay it
                      again; the task runs on the pure-LLM baseline from now on.
      'demoted'     - a trusted skill crossed the transient-miss threshold -> back
                      to probation (must re-earn trust).
      'kept'        - a trusted skill's first transient miss; left in place.
      'none'        - no live (non-quarantined) skill for this task."""
    s = find_skill(host, task)
    if not s:
        return "none"
    sig = s["task_sig"]
    if s.get("state") != _TRUSTED:
        s["state"] = _QUARANTINE
        s["fails"] = s.get("fails", 0) + 1
        if s.get("persisted"):
            _persist(host, sig, s)
        _event("quarantine", host, sig, rev=s.get("rev", 1), state=_QUARANTINE)
        _invalidate_dependents(host, sig)
        logger.info(f"[browser-skills] {host}::{sig} (unproven) failed replay -> quarantined (baseline from here)")
        return "quarantined"
    s["fails"] = s.get("fails", 0) + 1
    if s["fails"] >= _FAIL_DEMOTE_THRESHOLD:
        s["state"] = _PROBATION
        if s.get("persisted"):
            _persist(host, sig, s)
        _event("demote", host, sig, rev=s.get("rev", 1), state=_PROBATION, fails=s["fails"])
        _invalidate_dependents(host, sig)
        logger.info(f"[browser-skills] {host}::{sig} failed {s['fails']}x -> demoted to probation")
        return "demoted"
    if s.get("persisted"):
        _persist(host, sig, s)
    logger.info(f"[browser-skills] {host}::{sig} transient replay miss ({s['fails']}/{_FAIL_DEMOTE_THRESHOLD}), trust kept")
    return "kept"


def list_skills(host: str) -> list[dict]:
    """Compact summaries of the skills learned for a host (task + step count +
    replay count + trust state + what it builds on), NOT full step dumps, so the
    agent can ask "what shortcuts do I have here?" without pulling a wall of
    detail into context. Reads in-memory + the on-disk library for this host."""
    out = []
    for sig, s in _host_skills(host).items():
        out.append({
            "task": sig, "steps": len(s.get("steps", [])),
            "replays": s.get("replays", 0), "persisted": s.get("persisted", False),
            "state": s.get("state", _PROBATION), "rev": s.get("rev", 1),
            "builds_on": list(s.get("composed_of", [])),
        })
    # trusted first, then most-reused
    return sorted(out, key=lambda x: (x["state"] != _TRUSTED, -x["replays"]))


def deprecate_skill(host: str, task: str) -> bool:
    """Remove a skill (in-memory + disk) so it stops being replayed, and knock
    any skill that was built on it back to probation. The agent calls this when
    it judges a saved shortcut is stale / wrong (page changed). Accepts either the
    raw task or the task_sig from list_skills (sig is idempotent under _sig).
    Returns True if something was removed."""
    if not host:
        return False
    sig = _sig(task)
    removed = _skills.pop(_key(host, sig), None) is not None
    path = _skill_path(host, sig)
    if path and os.path.exists(path):
        try:
            os.remove(path)
            removed = True
        except Exception:
            pass
    if removed:
        _invalidate_dependents(host, sig)
        logger.info(f"[browser-skills] deprecated skill {host}::{sig}")
    return removed


def forget_host(host: str) -> int:
    """Remove ALL learned skills for a host (memory + disk). For the user-facing
    'forget this site' control. Returns how many were removed."""
    if not host:
        return 0
    n = 0
    for sig in list(_host_skills(host).keys()):
        removed = _skills.pop(_key(host, sig), None) is not None
        path = _skill_path(host, sig)
        if path and os.path.exists(path):
            try:
                os.remove(path)
                removed = True
            except Exception:
                pass
        if removed:
            n += 1
    if n:
        logger.info(f"[browser-skills] forgot all {n} skill(s) for {host}")
    return n


def clear(wipe_disk: bool = False) -> None:
    """Clear the in-memory cache. With wipe_disk, also remove persisted files
    in the current skills dir (used by tests for isolation)."""
    _skills.clear()
    if wipe_disk:
        d = _skills_dir()
        if d:
            try:
                for f in os.listdir(d):
                    if f.endswith(".json"):
                        os.remove(os.path.join(d, f))
            except Exception:
                pass
