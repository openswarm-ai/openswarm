"""The JS that drives x.com's DOM inside the user's own logged-in card.

X signs every API request with a browser-JS header we can't forge, so instead of calling
the API we drive the real card: navigate + run these snippets via the perform_action bridge.
This is the one brittle layer, X's data-testid attributes are the isolated assumption; if X
reshuffles them, only this file changes. Selectors are the stable data-testid ones the web
app itself uses (tweet, tweetText, like, reply, tweetButton, ...).
"""

import json
from typing import List

CAP_DEFAULT = 20


def scrape_tweets_js(cap: int = CAP_DEFAULT) -> str:
    """Poll for rendered tweets, then return a compact array of {id,author,text,likes,replies,url}."""
    n = json.dumps(cap)
    return (
        "(async()=>{const cap=" + n + ";const sleep=ms=>new Promise(r=>setTimeout(r,ms));"
        "const dl=Date.now()+7000;let arts=[];"
        "while(Date.now()<dl){arts=[...document.querySelectorAll('article[data-testid=\"tweet\"]')];"
        "if(arts.length)break;await sleep(400);}"
        "const num=s=>{if(!s)return null;const m=(s+'').replace(/,/g,'').match(/(\\d+(?:\\.\\d+)?)([KM]?)/);"
        "if(!m)return null;let v=parseFloat(m[1]);if(m[2]==='K')v*=1e3;if(m[2]==='M')v*=1e6;return Math.round(v);};"
        "const out=[];const seen=new Set();"
        "for(const a of arts){if(out.length>=cap)break;"
        "const t=a.querySelector('[data-testid=\"tweetText\"]');const text=t?t.innerText:'';"
        "let handle='';for(const l of a.querySelectorAll('a[href^=\"/\"]')){const m=(l.getAttribute('href')||'').match(/^\\/([A-Za-z0-9_]{1,15})$/);if(m){handle=m[1];break;}}"
        "let url='',id='';const sl=a.querySelector('a[href*=\"/status/\"]');"
        "if(sl){url='https://x.com'+sl.getAttribute('href').split('/photo')[0];const m=url.match(/status\\/(\\d+)/);if(m)id=m[1];}"
        "if(id&&seen.has(id))continue;if(id)seen.add(id);"
        "const lk=a.querySelector('[data-testid=\"like\"],[data-testid=\"unlike\"]');"
        "const rp=a.querySelector('[data-testid=\"reply\"]');"
        "out.push({id,author:handle,text:(text||'').slice(0,500),"
        "likes:lk?num(lk.getAttribute('aria-label')):null,"
        "replies:rp?num(rp.getAttribute('aria-label')):null,url});}"
        "return out;})()"
    )


def whoami_js() -> str:
    return (
        "(()=>{const a=document.querySelector('[data-testid=\"AppTabBar_Profile_Link\"]');"
        "const h=a?(a.getAttribute('href')||'').replace('/',''):'';"
        "return{handle:h,logged_in:!!h};})()"
    )


def click_action_js(testids: List[str], done_testid: str, label: str) -> str:
    """Click the first matching action button (like/retweet/follow); done_testid = the toggled state that means success/already."""
    ids = json.dumps(testids)
    done = json.dumps(done_testid)
    lbl = json.dumps(label)
    return (
        "(async()=>{const ids=" + ids + ";const done=" + done + ";const label=" + lbl + ";"
        "const sleep=ms=>new Promise(r=>setTimeout(r,ms));const dl=Date.now()+6000;"
        "const find=()=>{for(const t of ids){const e=document.querySelector('[data-testid=\"'+t+'\"]');if(e)return e;}return null;};"
        "let el=find();while(!el&&Date.now()<dl){await sleep(300);el=find();}"
        "if(!el){if(document.querySelector('[data-testid=\"'+done+'\"]'))return{ok:true,already:true,action:label};"
        "return{ok:false,error:label+' control not found'};}"
        "el.scrollIntoView({block:'center'});el.click();await sleep(600);"
        "return{ok:true,action:label};})()"
    )


def post_text_js(text: str, submit_testid: str = "tweetButton") -> str:
    """Type into the focused/opened composer (Draft.js) and click submit. Used for compose + reply."""
    t = json.dumps(text)
    sub = json.dumps(submit_testid)
    return (
        "(async()=>{const text=" + t + ";const sub=" + sub + ";const sleep=ms=>new Promise(r=>setTimeout(r,ms));"
        "const dl=Date.now()+7000;let box=null;"
        "while(Date.now()<dl){box=document.querySelector('[data-testid=\"tweetTextarea_0\"]');if(box)break;await sleep(300);}"
        "if(!box)return{ok:false,error:'composer not found'};"
        "box.focus();document.execCommand('insertText',false,text);"
        "box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));"
        "await sleep(700);"
        "let btn=document.querySelector('[data-testid=\"'+sub+'\"]');"
        "if(!btn)return{ok:false,error:'submit button not found'};"
        "if(btn.getAttribute('aria-disabled')==='true')return{ok:false,error:'submit disabled (empty/too long?)'};"
        "btn.click();await sleep(1200);return{ok:true,posted:true};})()"
    )


def open_reply_js() -> str:
    """On a tweet detail page, make sure the reply composer is open (click reply if the inline box isn't there)."""
    return (
        "(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));"
        "if(document.querySelector('[data-testid=\"tweetTextarea_0\"]'))return{ok:true,open:true};"
        "const r=document.querySelector('[data-testid=\"reply\"]');"
        "if(!r)return{ok:false,error:'reply button not found'};r.click();await sleep(1000);"
        "return{ok:!!document.querySelector('[data-testid=\"tweetTextarea_0\"]'),open:true};})()"
    )


def profile_js() -> str:
    return (
        "(()=>{const nm=document.querySelector('[data-testid=\"UserName\"]');"
        "const bio=document.querySelector('[data-testid=\"UserDescription\"]');"
        "const grab=s=>{const a=document.querySelector('a[href$=\"/'+s+'\"]');return a?a.innerText.replace(/\\n/g,' '):null;};"
        "const raw=nm?nm.innerText:'';const hm=raw.match(/@(\\w+)/);"
        "return{name:raw.split('\\n')[0],handle:hm?hm[1]:'',bio:bio?bio.innerText:'',"
        "following:grab('following'),followers:grab('verified_followers')||grab('followers')};})()"
    )


def retweet_js(undo: bool) -> str:
    """Retweet is two clicks: the retweet button opens a menu, then confirm. Undo mirrors it."""
    first = "unretweet" if undo else "retweet"
    confirm = "unretweetConfirm" if undo else "retweetConfirm"
    f = json.dumps(first)
    c = json.dumps(confirm)
    return (
        "(async()=>{const first=" + f + ";const confirm=" + c + ";const sleep=ms=>new Promise(r=>setTimeout(r,ms));"
        "const b=document.querySelector('[data-testid=\"'+first+'\"]');"
        "if(!b)return{ok:false,error:first+' button not found (already done?)'};"
        "b.scrollIntoView({block:'center'});b.click();await sleep(700);"
        "const cf=document.querySelector('[data-testid=\"'+confirm+'\"]');"
        "if(!cf)return{ok:false,error:'confirm menu item not found'};cf.click();await sleep(600);"
        "return{ok:true,retweeted:!" + ("true" if undo else "false") + "};})()"
    )


def follow_js(unfollow: bool) -> str:
    """The follow button's data-testid is '<userid>-follow' / '-unfollow'; match by suffix, fall back to button text."""
    suffix = "-unfollow" if unfollow else "-follow"
    label = "following" if unfollow else "follow"
    s = json.dumps(suffix)
    lbl = json.dumps(label)
    return (
        "(async()=>{const suf=" + s + ";const label=" + lbl + ";const sleep=ms=>new Promise(r=>setTimeout(r,ms));"
        "const dl=Date.now()+6000;const find=()=>{let e=document.querySelector('[data-testid$=\"'+suf+'\"]');"
        "if(e)return e;for(const b of document.querySelectorAll('[role=\"button\"]')){"
        "if((b.textContent||'').trim().toLowerCase()===label)return b;}return null;};"
        "let el=find();while(!el&&Date.now()<dl){await sleep(300);el=find();}"
        "if(!el)return{ok:false,error:label+' button not found'};"
        "el.scrollIntoView({block:'center'});el.click();await sleep(600);"
        "if('" + ("true" if unfollow else "false") + "'==='true'){const c=document.querySelector('[data-testid=\"confirmationSheetConfirm\"]');if(c){c.click();await sleep(400);}}"
        "return{ok:true,following:!" + ("true" if unfollow else "false") + "};})()"
    )
