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
  // Web-component sites (shreddit, YouTube) hide the item AND its menus in shadow roots, so every lookup pierces.
  const deep = (root, sel, out, depth) => {
    if (depth > 10 || out.length > 4000) return out;
    let hits; try { hits = root.querySelectorAll(sel); } catch (e) { hits = []; }
    for (const el of hits) out.push(el);
    let all; try { all = root.querySelectorAll('*'); } catch (e) { return out; }
    for (const el of all) { if (el.shadowRoot) deep(el.shadowRoot, sel, out, depth + 1); }
    return out;
  };
  const vis = (el) => el && el.offsetParent !== null && el.getClientRects().length > 0;
  const CONTAINERS = 'article,[role="article"],li,[role="listitem"],shreddit-post,'
    + '[data-testid*="tweet"],[data-testid*="post"],[data-testid*="comment"],[data-testid*="Post"],[id^="t3_"],[id^="t1_"]';
  const MORE = 'button[aria-label*="More" i],button[aria-label*="option" i],'
    + '[data-testid="caret"],button[aria-haspopup="menu"],[aria-label*="menu" i]';
  const holders = () => deep(document, CONTAINERS, [], 0)
    .filter((el) => el.textContent && el.textContent.includes(TARGET))
    .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);  // tightest match first
  if (!holders().length) return { stage: 'find', ok: false, msg: 'target text not on this page' };
  // The caret/overflow renders a beat late and may sit in a shadow root, so poll + pierce. Take the
  // first holding container that owns an overflow control, so the control belongs to THIS item.
  let item = null, more = null;
  for (let attempt = 0; attempt < 6 && !more; attempt++) {
    if (attempt) await sleep(500);
    for (const h of holders()) { const m = deep(h, MORE, [], 0).find(vis); if (m) { item = h; more = m; break; } }
  }
  if (!more) return { stage: 'more', ok: false, msg: 'found the item but no overflow/More control on it' };
  more.click();
  await sleep(1000);
  const DEL = /^\s*(delete|remove)\b/i;  // exact-ish: not "delete row" or "remove filter"
  const del = deep(document, '[role="menuitem"],[role="option"],button,a,li', [], 0)
    .find((m) => DEL.test(norm(m.innerText)) && vis(m));
  if (!del) return { stage: 'menuitem', ok: false,
    msg: 'no Delete/Remove entry in the menu (is this your own item?)',
    menu: deep(document, '[role="menuitem"],[role="option"]', [], 0).map((m) => norm(m.innerText)).filter(Boolean).slice(0, 10) };
  del.click();
  await sleep(1000);
  // Confirm dialog (pierce shadow DOM; Reddit's confirm is a faceplate/shreddit web component).
  const dlg = deep(document, '[role="dialog"],[role="alertdialog"],[data-testid="confirmationSheetDialog"],faceplate-dialog,shreddit-async-loader', [], 0)[0] || document;
  const CONF = /^\s*(delete|remove|yes|confirm)\b/i;
  const conf = deep(dlg, '[data-testid="confirmationSheetConfirm"]', [], 0)[0]
    || deep(dlg, 'button', [], 0).find((b) => CONF.test(norm(b.innerText)) && vis(b));
  if (conf) { conf.click(); await sleep(1800); }
  const still = holders().length > 0;
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
