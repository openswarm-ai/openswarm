"""Container-scoped submit click for the receipt-gated send path. Exists because the ranked
interactives listing caps at 60 rows and a composer's own submit can fall off it (X's compose
modal: covered feed rows behind the overlay ate the cap, so no "Post" row ever reached the index
picker, measured live 0/2 deliveries). Scope = the dialog/form ancestor of the editable holding
the payload when there is one, else a bounded nearest-scope-first upward walk, so a page-level
opener with the same label can never be chosen. A wrong resolution still fails the send receipt
downstream, never a false delivery claim."""

import json
from typing import Any, Dict, Optional

# BROAD submit vocabulary shared by the index picker (browser_agent) and the JS below, one source
# so the two tiers can never drift apart.
SEND_LABELS = frozenset({
    "send", "send now", "send message",              # LinkedIn / Gmail / DMs
    "post", "post all", "tweet", "reply",            # X / Threads compose + reply
    "publish", "comment", "share",                   # articles / YouTube+FB comments / shares
})

# Resolves the submit and returns its viewport center; the caller clicks it through the REAL
# input path (BrowserClickPoint). Synthetic el.click() is ignored by web-component sites
# (shreddit live), and a real click lands on whatever is topmost, so overlays can't be fooled.
P_CONTAINER_SUBMIT_JS = r"""(() => {
  const PAYLOAD = %s;
  const LABELS = new Set(%s);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const labelOf = (el) => norm(el.getAttribute('aria-label') || el.textContent || '');
  const holds = (el) => ((el.value || el.textContent || '').indexOf(PAYLOAD) !== -1);
  // Shadow piercing both ways: reddit's composer AND its submit live in shreddit shadow roots.
  const deep = (root, sel, out, depth) => {
    if (depth > 10 || out.length > 4000) return out;
    let hits; try { hits = root.querySelectorAll(sel); } catch (e) { hits = []; }
    for (const el of hits) out.push(el);
    let all; try { all = root.querySelectorAll('*'); } catch (e) { return out; }
    for (const el of all) { if (el.shadowRoot) deep(el.shadowRoot, sel, out, depth + 1); }
    return out;
  };
  const up = (el) => el.parentElement || (el.getRootNode() && el.getRootNode().host) || null;
  const ed = deep(document, '[contenteditable="true"],textarea,input', [], 0)
    .find((e) => vis(e) && holds(e));
  if (!ed) return { ok: false, why: 'no editable holding the payload' };
  const submitIn = (root) => deep(root, 'button,[role="button"]', [], 0)
    .find((b) => vis(b) && enabled(b) && LABELS.has(labelOf(b)));
  const isScope = (el) => { try { return el.matches('[role="dialog"],[role="alertdialog"],form'); } catch (e) { return false; } };
  let scope = null;
  for (let node = ed; node; node = up(node)) { if (isScope(node)) { scope = node; break; } }
  let btn = null;
  if (scope) {
    btn = submitIn(scope);
  } else {
    // Nearest-scope-first walk: X's inline submit shares an ancestor 20 hops above the Draft.js
    // editable while foreign tweets' buttons only enter at 28 (measured live), so 24 finds the
    // composer's own submit and stops before any wider scope could.
    let node = up(ed);
    for (let hop = 0; node && node !== document.body && hop < 24; hop++, node = up(node)) {
      btn = submitIn(node);
      if (btn) break;
    }
  }
  if (!btn) return { ok: false, why: 'no submit control in the composer container' };
  const r0 = btn.getBoundingClientRect();
  if (r0.top < 0 || r0.bottom > window.innerHeight) btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  return { ok: true, name: labelOf(btn),
           xPct: (r.left + r.width / 2) / window.innerWidth * 100,
           yPct: (r.top + r.height / 2) / window.innerHeight * 100 };
})()"""


def container_submit_expression(payload: str) -> str:
    """The container-scoped submit click for a composer holding `payload` (prefix-matched, same
    24-char truncation the fill verifier uses)."""
    return P_CONTAINER_SUBMIT_JS % (json.dumps((payload or "")[:24]), json.dumps(sorted(SEND_LABELS)))


def parse_eval_value(res: object) -> Optional[Dict[str, Any]]:
    """The dict a BrowserEvaluate returned, or None. Unreadable shapes are None (honest miss)."""
    val: object = None
    if isinstance(res, dict) and "error" not in res:
        val = res.get("value")
        if val is None and isinstance(res.get("text"), str):
            try:
                val = json.loads(res["text"])
            except (json.JSONDecodeError, ValueError):
                val = None
    return val if isinstance(val, dict) else None
