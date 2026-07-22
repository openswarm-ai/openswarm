"""BrowserDeleteItem: a model-invoked tool that removes ONE on-page item the model names by
text, deterministically. The model handles getting to the item's page (its strength); this runs
the site's own remove flow (open that item's overflow menu -> Delete -> confirm -> verify-gone),
which the model fails at by hand (measured live on X: 4 aborts on the tiny caret menu).

Resolve-in-JS, click-with-real-input: each step RESOLVES the next control's viewport position in
a pierced-shadow DOM query, and the click is dispatched through the OS-level input path
(BrowserClickPoint). Synthetic el.click() is ignored by web-component sites (shreddit live:
the flow reached Delete yet nothing happened; the model's trusted clicks on the same controls
worked), and a real click also lands on whatever is topmost, so overlays can't be mis-clicked.

Safety, in code:
- Resolution happens ONLY inside the element that contains the target text, so it can never
  touch another item.
- The site enforces ownership (only your own item exposes Delete), so a target you don't own has
  no menu entry and the tool reports that, it never forces one.
- Success REQUIRES verify-gone (the target text left the page). One destructive confirm click.
- Flag-gated (OSW_DELETE_SCRIPT): the tool is hidden from the model until Eric flips it.
"""

import asyncio
import json
import logging
import os
from typing import Any, Awaitable, Callable, Dict

from backend.apps.agents.browser import browser_submit_click

logger = logging.getLogger(__name__)

MIN_TARGET_CHARS = 6

ToolRunner = Callable[[str, dict, str, str], Awaitable[dict]]


def delete_tool_enabled() -> bool:
    return os.environ.get("OSW_DELETE_SCRIPT", "0") != "0"


# One resolver, four steps. Each call re-queries the live DOM (pierced), scrolls the control into
# view when needed, and returns the control's viewport center as percents for BrowserClickPoint.
# 'verify' returns gone-ness instead of a position. Controls render a beat late, so steps poll.
P_RESOLVE_JS = r"""(async () => {
  const STEP = %s;
  const TARGET = %s;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const center = (el) => {
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > window.innerHeight) el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { xPct: (r.left + r.width / 2) / window.innerWidth * 100,
             yPct: (r.top + r.height / 2) / window.innerHeight * 100,
             label: norm(el.getAttribute('aria-label') || el.textContent || '').slice(0, 40) };
  };
  const CONTAINERS = 'article,[role="article"],li,[role="listitem"],shreddit-post,'
    + '[data-testid*="tweet"],[data-testid*="post"],[data-testid*="comment"],[data-testid*="Post"],[id^="t3_"],[id^="t1_"]';
  const MORE = 'button[aria-label*="More" i],button[aria-label*="option" i],'
    + '[data-testid="caret"],button[aria-haspopup="menu"],button[aria-haspopup="true"],[aria-label*="menu" i]';
  const holders = () => deep(document, CONTAINERS, [], 0)
    .filter((el) => el.textContent && el.textContent.includes(TARGET))
    .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);  // tightest match first

  if (STEP === 'verify') {
    // Gone = the text left the page, OR every remaining holder is a deletion TOMBSTONE (reddit
    // swaps the tile for a "Post deleted" placeholder that keeps the title text). The substance
    // gate stops a still-loading page (post-refresh) from reading as gone: never a false removed.
    const TOMB = /post deleted|comment deleted|\[deleted\]|deleted by|removed by/i;
    for (let attempt = 0; attempt < 7; attempt++) {
      if (attempt) await sleep(1000);
      if ((document.body.innerText || '').length < 500) continue;
      const hs = holders();
      if (!hs.length || hs.every((h) => TOMB.test(h.textContent || ''))) return { ok: true, stage: 'verify' };
    }
    return { ok: false, stage: 'verify' };
  }
  if (STEP === 'more') {
    if (!holders().length) return { ok: false, stage: 'find', msg: 'target text not on this page' };
    // A post tile carries OTHER kebabs too (reddit's user-attribution row: 'Open user actions',
    // measured live opening the wrong menu). Rank: named overflow first, then reddit's unlabeled
    // haspopup kebab, then generic; user/share/moderation controls never.
    const rank = (el) => {
      // Reddit quirks, all measured live: the post kebab is LABELED 'Open user actions' (inside
      // shreddit-post-overflow-menu, so the host outranks the misleading label), a 0x0 DECOY
      // lives in mod-content-state-indicators, and Share/mod controls also carry haspopup.
      const host = (el.getRootNode() && el.getRootNode().host) ? el.getRootNode().host.tagName : '';
      if (/^MOD-/.test(host)) return 4;
      const l = norm(el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
      if (/overflow|more/.test(l) || /OVERFLOW/.test(host)) return 0;
      if (!l && el.getAttribute('aria-haspopup')) return 1;
      if (/share|award|vote|join|follow|moderat|approve/.test(l)) return 4;
      if (/user|profile|author/.test(l)) return 3;
      return 2;
    };
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await sleep(500);
      for (const h of holders()) {
        const cands = deep(h, MORE, [], 0).filter((c) => rank(c) < 4);
        const visBest = cands.filter(vis).sort((a, b) => rank(a) - rank(b))[0];
        if (visBest) { h.scrollIntoView({ block: 'center' }); return { ok: true, stage: 'more', ...center(visBest) }; }
        // Hover-revealed kebab: exists but zero rects until the tile is hovered with REAL input.
        // Only when NOTHING visible qualifies; hand the tile position back for a hover + retry.
        const hid = cands.find((c) => !vis(c) && rank(c) <= 1);
        if (hid) {
          h.scrollIntoView({ block: 'center' });
          const hr = h.getBoundingClientRect();
          return { ok: false, stage: 'more', hoverFirst: true,
                   xPct: (hr.left + hr.width / 2) / window.innerWidth * 100,
                   yPct: (hr.top + Math.min(40, hr.height / 2)) / window.innerHeight * 100,
                   msg: 'overflow control hidden until hover' };
        }
      }
    }
    return { ok: false, stage: 'more', msg: 'found the item but no overflow/More control on it' };
  }
  if (STEP === 'menuitem') {
    const DEL = /^\s*(delete|remove)\b/i;  // exact-ish: not "delete row" or "remove filter"
    const MENUS = '[role="menu"],[role="listbox"],faceplate-menu,faceplate-dropdown-menu,[data-testid="Dropdown"]';
    // Long poll: shreddit's menu content arrives through an async loader, measured up to ~20s
    // after the kebab click on a cold page; X resolves on the first attempt so the tail is free.
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt) await sleep(900);
      // Only entries inside an OPEN menu count; a page-wide 'Delete' from another context must
      // never be clicked (measured live after the wrong kebab opened).
      const menus = deep(document, MENUS, [], 0).filter(vis);
      for (const s of (menus.length ? menus : [document])) {
        const del = deep(s, '[role="menuitem"],[role="option"],button,a,li', [], 0)
          .find((m) => DEL.test(norm(m.textContent)) && vis(m));
        if (del) return { ok: true, stage: 'menuitem', ...center(del) };
      }
    }
    return { ok: false, stage: 'menuitem',
      msg: 'no Delete/Remove entry in the menu (is this your own item?)',
      menu: deep(document, '[role="menuitem"],[role="option"]', [], 0)
        .map((m) => norm(m.textContent)).filter(Boolean).slice(0, 10) };
  }
  if (STEP === 'confirm') {
    const CONF = /^\s*(delete|remove|yes|confirm)\b/i;
    // Scan EVERY visible dialog candidate then the whole document; taking [0] once grabbed a
    // random lazy-loader wrapper and looked straight past the real open dialog (measured live).
    const DLG = '[role="dialog"],[role="alertdialog"],[data-testid="confirmationSheetDialog"],faceplate-dialog';
    for (let attempt = 0; attempt < 7; attempt++) {
      if (attempt) await sleep(700);
      const scopes = [...deep(document, DLG, [], 0).filter(vis), document];
      for (const dlg of scopes) {
        const conf = deep(dlg, '[data-testid="confirmationSheetConfirm"]', [], 0).find(vis)
          || deep(dlg, 'button', [], 0).find((b) => CONF.test(norm(b.textContent)) && vis(b));
        if (conf) return { ok: true, stage: 'confirm', ...center(conf) };
      }
    }
    return { ok: false, stage: 'confirm', optional: true, msg: 'no confirm dialog appeared' };
  }
  return { ok: false, stage: 'eval', msg: 'unknown step' };
})()"""


def resolve_expression(step: str, target_text: str) -> str:
    return P_RESOLVE_JS % (json.dumps(step), json.dumps(target_text))


async def run_delete(target_text: str, browser_id: str, tab_id: str,
                     execute_tool: ToolRunner) -> Dict[str, Any]:
    """The full remove flow: resolve each control in-page, click it with REAL input, verify gone.
    Any unreadable resolve is an honest failure at that stage (never a false 'removed')."""

    async def resolve(step: str) -> Dict[str, Any]:
        res = await execute_tool(
            "BrowserEvaluate", {"expression": resolve_expression(step, target_text)}, browser_id, tab_id)
        return browser_submit_click.parse_eval_value(res) or {"ok": False, "stage": "eval",
                                                              "msg": "the remove flow returned no readable result"}

    for step, settle_s in (("more", 1.0), ("menuitem", 1.0), ("confirm", 1.8)):
        r = await resolve(step)
        if not r.get("ok") and step == "more" and r.get("hoverFirst"):
            # Reveal a hover-only kebab with a real mouse move over the tile, then re-resolve once.
            logger.info("[browser-deletescript] kebab hidden; hovering the tile to reveal it")
            await execute_tool("BrowserClickPoint",
                               {"xPercent": float(r["xPct"]), "yPercent": float(r["yPct"]),
                                "hoverOnly": True}, browser_id, tab_id)
            await asyncio.sleep(0.7)
            r = await resolve(step)
        if not r.get("ok"):
            if step == "confirm" and r.get("optional"):
                break  # some sites delete without a confirm; the verify below is the arbiter
            return {"removed": False, "stage": str(r.get("stage") or step), "msg": str(r.get("msg") or "")}
        logger.info(f"[browser-deletescript] step={step} label={str(r.get('label') or '')[:40]!r} "
                    f"at {float(r['xPct']):.1f},{float(r['yPct']):.1f}")
        await execute_tool("BrowserClickPoint",
                           {"xPercent": float(r["xPct"]), "yPercent": float(r["yPct"])}, browser_id, tab_id)
        await asyncio.sleep(settle_s)
    v = await resolve("verify")
    if not v.get("ok"):
        # Some clients keep the dead tile mounted until a reload (shreddit, measured live: the
        # delete lands server-side while the DOM never flips). Refresh once and re-verify; the
        # verify's substance gate keeps a half-loaded page from reading as gone.
        p_loc = browser_submit_click.parse_eval_value(
            await execute_tool("BrowserEvaluate", {"expression": "({href: location.href})"}, browser_id, tab_id)) or {}
        p_href = str(p_loc.get("href") or "")
        if p_href.startswith("http"):
            logger.info("[browser-deletescript] tile still mounted; refreshing to re-verify")
            await execute_tool("BrowserNavigate", {"url": p_href}, browser_id, tab_id)
            await asyncio.sleep(3.0)
            v = await resolve("verify")
    removed = bool(v.get("ok"))
    return {"removed": removed, "stage": "done",
            "msg": "item removed" if removed else "clicked delete but the item is still on the page"}
