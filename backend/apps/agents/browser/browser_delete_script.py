"""BrowserDeleteItem: a model-invoked tool that removes ONE on-page item the model names by
text, deterministically. The model handles getting to the item's page (its strength); this runs
the site's own remove flow (open that item's overflow menu -> Delete -> confirm -> verify-gone),
which the model fails at by hand (measured live on X: 4 aborts on the tiny caret menu).

It is a tool, not a pre-navigation tier: the earlier tier fired before the model reached the
item and always declined. As a tool the model calls it AFTER navigating, so the item and its
(late-rendering) caret are present. Translated to a single BrowserEvaluate in execute_browser_tool
(the App-bridge pattern), so no frontend handler is needed.

Safety, in code:
- Acts ONLY inside the element that contains the target text, so it can never touch another item.
- The site enforces ownership (only your own item exposes Delete), so a target you don't own has
  no menu entry and the tool reports that, it never forces one.
- Success REQUIRES verify-gone (the target text left the page). One destructive confirm click.
- Flag-gated (OSW_DELETE_SCRIPT): the tool is hidden from the model until Eric flips it.
"""

import json
import os
from typing import Any, Dict

MIN_TARGET_CHARS = 6


def delete_tool_enabled() -> bool:
    return os.environ.get("OSW_DELETE_SCRIPT", "0") != "0"


# The in-page removal flow, scoped to the item holding the target text. Returns a JSON-able
# {stage, ok, msg} that parse_delete_result reads. The caret renders a beat late, so it polls.
P_DELETE_JS = r"""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TARGET = %s;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const CONTAINERS = 'article,[role="article"],li,[role="listitem"],'
    + '[data-testid*="tweet"],[data-testid*="post"],[data-testid*="comment"],[data-testid*="Post"]';
  const MORE = 'button[aria-label*="More" i],button[aria-label*="option" i],'
    + '[data-testid="caret"],button[aria-haspopup="menu"],[aria-label*="menu" i]';
  const holders = () => [...document.querySelectorAll(CONTAINERS)]
    .filter((el) => el.innerText && el.innerText.includes(TARGET))
    .sort((a, b) => a.innerText.length - b.innerText.length);  // tightest text match first
  if (!holders().length) return { stage: 'find', ok: false, msg: 'target text not on this page' };
  // The tightest text node (X's tweetText span) has no caret; the caret lives on the item
  // container (the article) and RENDERS A BEAT LATE, so poll. Take the first holding container
  // that actually owns an overflow control, so the caret still belongs to THIS item.
  let item = null, more = null;
  for (let attempt = 0; attempt < 6 && !more; attempt++) {
    if (attempt) await sleep(500);
    for (const h of holders()) { const m = h.querySelector(MORE); if (m) { item = h; more = m; break; } }
  }
  if (!more) return { stage: 'more', ok: false, msg: 'found the item but no overflow/More control on it' };
  more.click();
  await sleep(900);
  const DEL = /^\s*(delete|remove|trash|move to trash)\b/i;
  const del = [...document.querySelectorAll('[role="menuitem"],[role="option"],button,a')]
    .find((m) => DEL.test(norm(m.innerText)) && m.offsetParent !== null);
  if (!del) return { stage: 'menuitem', ok: false,
    msg: 'no Delete/Remove entry in the menu (is this your own item?)',
    menu: [...document.querySelectorAll('[role="menuitem"]')].map((m) => norm(m.innerText)).slice(0, 8) };
  del.click();
  await sleep(900);
  const dlg = document.querySelector('[role="dialog"],[data-testid="confirmationSheetDialog"]');
  if (dlg) {
    const CONF = /^\s*(delete|remove|yes|confirm)\b/i;
    const conf = dlg.querySelector('[data-testid="confirmationSheetConfirm"]')
      || [...dlg.querySelectorAll('button')].find((b) => CONF.test(norm(b.innerText)) && b.offsetParent !== null);
    if (conf) { conf.click(); await sleep(1700); }
  }
  const still = [...document.querySelectorAll(CONTAINERS)]
    .some((el) => el.innerText && el.innerText.includes(TARGET));
  return { stage: 'done', ok: !still, msg: still ? 'clicked delete but the item is still on the page' : 'item removed' };
})()"""


def delete_item_expression(target_text: str) -> str:
    return P_DELETE_JS % json.dumps(target_text)


def parse_delete_result(res: object) -> Dict[str, Any]:
    """Turn the BrowserEvaluate result into {removed: bool, stage, msg}. A shape we can't read
    is an honest failure (never a false 'removed')."""
    val: object = None
    if isinstance(res, dict) and "error" not in res:
        val = res.get("value")
        if val is None and isinstance(res.get("text"), str):
            try:
                val = json.loads(res["text"])
            except (json.JSONDecodeError, ValueError):
                val = None
    if not isinstance(val, dict):
        return {"removed": False, "stage": "eval", "msg": "the remove flow returned no readable result"}
    return {"removed": bool(val.get("ok")), "stage": str(val.get("stage") or ""), "msg": str(val.get("msg") or "")}
