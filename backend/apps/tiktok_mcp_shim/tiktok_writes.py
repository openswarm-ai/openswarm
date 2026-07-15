"""Write operations for TikTok, delegated to the user's own live browser card.

TikTok signs every request, so pure-HTTP writes get bot-flagged. Instead each write drives
the user's already-open, logged-in tiktok.com card via the backend action bridge: navigate to
the target, then run a small click/type script keyed on TikTok's data-e2e test-ids (with a
button-text fallback). The card is a real signed-in browser, so this is free, undetectable, and
does what a human does. Selector drift is the isolated soft spot: if a control moves, the script
returns an actionable error and the agent can fall back to driving the card by hand.
"""

import json
from typing import Any, Dict, List

from backend.apps.social_shims.browser_action import last_json, perform

DOMAIN = "tiktok.com"
UPLOAD_URL = "https://www.tiktok.com/upload"


def p_click_script(candidates: List[str], label: str) -> str:
    """JS that polls up to ~6s for the first matching control (by selector, then button text) and clicks it."""
    cands = json.dumps(candidates)
    lbl = json.dumps(label)
    return (
        "(async()=>{const cands=" + cands + ";const label=" + lbl + ";"
        "const find=()=>{for(const c of cands){const el=document.querySelector(c);if(el)return el;}"
        "for(const b of document.querySelectorAll('button,[role=button],[data-e2e]')){"
        "if((b.textContent||'').trim().toLowerCase()===label.toLowerCase())return b;}return null;};"
        "const deadline=Date.now()+6000;let el=find();"
        "while(!el&&Date.now()<deadline){await new Promise(r=>setTimeout(r,300));el=find();}"
        "if(!el)return{ok:false,error:'control not found: '+label};"
        "el.scrollIntoView({block:'center'});el.click();return{ok:true,clicked:label};})()"
    )


def p_comment_script(text: str) -> str:
    t = json.dumps(text)
    return (
        "(async()=>{const q=s=>document.querySelector(s);const deadline=Date.now()+6000;"
        "let box=q('[data-e2e=\"comment-input\"]')||q('div[contenteditable=\"true\"]');"
        "while(!box&&Date.now()<deadline){await new Promise(r=>setTimeout(r,300));"
        "box=q('[data-e2e=\"comment-input\"]')||q('div[contenteditable=\"true\"]');}"
        "if(!box)return{ok:false,error:'comment box not found'};"
        "box.focus();document.execCommand('selectAll',false);document.execCommand('insertText',false," + t + ");"
        "box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:" + t + "}));"
        "await new Promise(r=>setTimeout(r,400));"
        "const post=q('[data-e2e=\"comment-post\"]')||q('[data-e2e=\"comment-post-button\"]');"
        "if(!post)return{ok:false,error:'post button not found'};"
        "if(post.getAttribute('aria-disabled')==='true')return{ok:false,error:'post button disabled (comment empty?)'};"
        "post.click();return{ok:true,posted:true};})()"
    )


def p_do(url: str, script: str) -> Dict[str, Any]:
    steps = [{"op": "navigate", "url": url}, {"op": "wait", "ms": 1500}, {"op": "evaluate", "expression": script}]
    return last_json(perform(DOMAIN, steps))


def like(video_url: str, unlike: bool) -> Dict[str, Any]:
    out = p_do(video_url, p_click_script(['[data-e2e="like-icon"]', '[data-e2e="browse-like-icon"]'], "like"))
    return {"video": video_url, "liked": bool(out.get("ok")) and not unlike, "detail": out}


def favorite(video_url: str, remove: bool) -> Dict[str, Any]:
    out = p_do(video_url, p_click_script(['[data-e2e="favorite-icon"]', '[data-e2e="browse-favorite-icon"]'], "favorite"))
    return {"video": video_url, "favorited": bool(out.get("ok")) and not remove, "detail": out}


def follow(username: str, unfollow: bool) -> Dict[str, Any]:
    handle = username.lstrip("@")
    label = "following" if unfollow else "follow"
    out = p_do(f"https://www.tiktok.com/@{handle}", p_click_script(['[data-e2e="follow-button"]', '[data-e2e="follow-icon"]'], label))
    return {"username": handle, "following": bool(out.get("ok")) and not unfollow, "detail": out}


def comment(video_url: str, text: str) -> Dict[str, Any]:
    out = p_do(video_url, p_comment_script(text))
    return {"video": video_url, "posted": bool(out.get("ok")), "detail": out}


def upload(caption: str, video_path: str) -> Dict[str, Any]:
    # Open the real upload page; the OS file picker can't be driven from page JS (browser security), so the human/agent finishes the file choice.
    perform(DOMAIN, [{"op": "navigate", "url": UPLOAD_URL}])
    return {
        "opened": UPLOAD_URL,
        "note": (
            f"Opened the TikTok upload page in your browser card. Choose the file ({video_path!r}) in the "
            f"picker and paste the caption ({caption!r}); browser security blocks scripts from selecting the "
            "file for you, so this last step is yours (or drive the card with the browser agent)."
        ),
    }
