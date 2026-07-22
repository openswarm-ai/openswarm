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

P_CONTAINER_SUBMIT_JS = r"""(() => {
  const PAYLOAD = %s;
  const LABELS = new Set(%s);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const vis = (el) => !!el && el.getClientRects().length > 0 && el.offsetParent !== null;
  const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const labelOf = (el) => norm(el.getAttribute('aria-label') || el.innerText || '');
  const holds = (el) => ((el.value || el.textContent || '').indexOf(PAYLOAD) !== -1);
  const ed = [...document.querySelectorAll('[contenteditable="true"],textarea,input')]
    .find((e) => vis(e) && holds(e));
  if (!ed) return { ok: false, why: 'no editable holding the payload' };
  const submitIn = (root) => [...root.querySelectorAll('button,[role="button"]')]
    .find((b) => vis(b) && enabled(b) && LABELS.has(labelOf(b)));
  const scope = ed.closest('[role="dialog"],[role="alertdialog"],form');
  let btn = null;
  if (scope) {
    btn = submitIn(scope);
  } else {
    // Nearest-scope-first walk: X's inline submit shares an ancestor 20 hops above the Draft.js
    // editable while foreign tweets' buttons only enter at 28 (measured live), so 24 finds the
    // composer's own submit and stops before any wider scope could.
    let node = ed.parentElement;
    for (let hop = 0; node && node !== document.body && hop < 24; hop++, node = node.parentElement) {
      btn = submitIn(node);
      if (btn) break;
    }
  }
  if (!btn) return { ok: false, why: 'no submit control in the composer container' };
  btn.click();
  return { ok: true, name: labelOf(btn) };
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
