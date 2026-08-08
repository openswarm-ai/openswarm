"""The CDP half of the 1.7.5 verification: the checks that need a real renderer.

Drives headless Chrome against the dev frontend over raw CDP. Every check here follows two rules
that were learned by getting them wrong first:

  1. Assert the POSITIVE and the NEGATIVE together. "The canvas camera did not move" is not evidence
     a surface works: a surface that cannot scroll at all passes that trivially.
  2. Confirm the hit point with elementFromPoint BEFORE dispatching. Locating a surface by DOM scan
     hands you elements that something else is painting over, which produced three confident wrong
     answers in one afternoon.
"""

import json
import os
import subprocess
import time
from typing import Optional

from scripts.verify175.shared import row

NODE = "node"
# Electron's renderer runs on its own port; plain-Chrome runs default 9223.
CDP_PORT = os.environ.get("OSW_CDP_PORT", "9223")
WS = "/Users/ericzeng/Downloads/openswarm/frontend/node_modules/ws"


def p_cdp(body: str, timeout: int = 180) -> Optional[dict]:
    """Run a snippet in a page context and return whatever JSON it printed."""
    js = (
        "const WebSocket=require(%r);const http=require('http');\n"
        "function tg(){return new Promise((res,rej)=>{http.get('http://127.0.0.1:9223/json/list',r=>{"
        "let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej)})}\n"
        "const sleep=ms=>new Promise(r=>setTimeout(r,ms));\n"
        "(async()=>{const p=(await tg()).find(t=>t.type==='page'&&t.url.includes(':3000'));\n"
        "if(!p){console.log(JSON.stringify({error:'no page'}));return;}\n"
        "const ws=new WebSocket(p.webSocketDebuggerUrl,{perMessageDeflate:false});\n"
        "await new Promise(r=>ws.on('open',r));let id=0;const pend=new Map();\n"
        "ws.on('message',m=>{const g=JSON.parse(m);if(g.id&&pend.has(g.id)){pend.get(g.id)(g);pend.delete(g.id)}});\n"
        "const send=(m,pa={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:pa}))});\n"
        "const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r.result?.result?.value};\n"
        "%s\n"
        "ws.close();})().catch(e=>console.log(JSON.stringify({error:String(e.message)})));\n"
    ) % (WS, body)
    if CDP_PORT != "9223":
        js = js.replace("127.0.0.1:9223", "127.0.0.1:" + CDP_PORT)
    p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=timeout)
    for line in reversed((p.stdout or "").strip().splitlines()):
        try:
            return json.loads(line)
        except Exception:
            continue
    return None


def check_idle_raf() -> None:
    """Counts the APP's rAF scheduling. The old probe used its own rAF loop and therefore always
    reported ~120 ticks, which could never distinguish idle from spinning."""
    out = p_cdp(
        "await ev(\"(function(){if(window.__RC__)return 1;window.__RC__={n:0};var o=window.requestAnimationFrame;"
        "window.requestAnimationFrame=function(cb){window.__RC__.n++;return o.apply(window,arguments)};return 1})()\");\n"
        "await ev('window.__RC__.n=0;1');\n"
        "await sleep(2000);\n"
        "const n=await ev('window.__RC__.n');\n"
        "console.log(JSON.stringify({calls:n}));"
    )
    if out is None or "calls" not in out:
        row("idle renderer (0 rAF in 2s)", "SKIP", f"probe returned {out}")
        return
    row("idle renderer (0 rAF in 2s)", "PASS" if out["calls"] == 0 else "FAIL", f"{out['calls']} app rAF calls")


def check_inp() -> None:
    """Reads real `event` PerformanceObserver entries, which is what INP is computed from."""
    out = p_cdp(
        "await ev(\"(function(){if(window.__IN__)return 1;window.__IN__=[];try{var o=new PerformanceObserver(function(l){"
        "l.getEntries().forEach(function(e){if(e.duration>0)window.__IN__.push(Math.round(e.duration))})});"
        "o.observe({type:'event',buffered:true,durationThreshold:0});}catch(e){}return 1})()\");\n"
        "const pts=await ev(\"(function(){var t=Array.prototype.slice.call(document.querySelectorAll('.osw-dock-tile')).slice(0,8);"
        "return JSON.stringify(t.map(function(x){var r=x.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}))})()\");\n"
        "const list=JSON.parse(pts||'[]');\n"
        "for(let r=0;r<3;r++){for(const q of list){\n"
        "  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:q.x,y:q.y,button:'left',clickCount:1});await sleep(25);\n"
        "  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:q.x,y:q.y,button:'left',clickCount:1});await sleep(110);}}\n"
        "await sleep(1200);\n"
        "const s=await ev(\"(function(){var a=(window.__IN__||[]).slice().sort(function(x,y){return x-y});"
        "if(!a.length)return JSON.stringify({n:0});var p=function(q){return a[Math.min(a.length-1,Math.floor(a.length*q))]};"
        "return JSON.stringify({n:a.length,p50:p(0.5),p95:p(0.95),max:a[a.length-1]})})()\");\n"
        "console.log(s);"
    , timeout=300)
    if not out or not out.get("n"):
        row("INP p95 (<=200ms)", "SKIP", f"no interaction entries ({out})")
        return
    row("INP p95 (<=200ms)", "PASS" if out["p95"] <= 200 else "FAIL",
        f"p95 {out['p95']}ms, p50 {out['p50']}ms, max {out['max']}ms, n={out['n']}")


def check_dictation() -> None:
    """ENG-176. Four scenarios, including the two that were bugs: a target that dies mid-decode must
    drop the words rather than type them into whatever holds focus, and the composer fallback must
    survive that refusal."""
    out = p_cdp(
        "const r=await ev(`(async()=>{\n"
        "  const mk=()=>{document.querySelectorAll('.vprobe').forEach(e=>e.remove());\n"
        "    const A=document.createElement('textarea');A.className='vprobe';document.body.appendChild(A);\n"
        "    const B=document.createElement('textarea');B.className='vprobe';document.body.appendChild(B);return[A,B]};\n"
        "  const snap=()=>window.dispatchEvent(new CustomEvent('osw-test:snapshot'));\n"
        "  const inj=t=>window.dispatchEvent(new CustomEvent('osw-test:inject',{detail:{text:t}}));\n"
        "  const w=ms=>new Promise(r=>setTimeout(r,ms));\n"
        "  let A,B;\n"
        "  [A,B]=mk();A.focus();snap();await w(60);B.focus();await w(60);inj('switch words');await w(160);\n"
        "  const s1={A:A.value,B:B.value};A.remove();B.remove();\n"
        "  [A,B]=mk();A.focus();snap();await w(60);A.remove();B.focus();inj('orphan words');await w(160);\n"
        "  const s2={B:B.value};B.remove();\n"
        "  [A,B]=mk();A.focus();snap();await w(60);inj('normal words');await w(160);\n"
        "  const s3={A:A.value};A.remove();B.remove();\n"
        "  [A,B]=mk();if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();\n"
        "  document.body.focus();const before=[...document.querySelectorAll('textarea,input')].map(e=>e.value).join('|');\n"
        "  snap();await w(60);inj('composer words');await w(260);\n"
        "  const after=[...document.querySelectorAll('textarea,input')].map(e=>e.value).join('|');\n"
        "  A.remove();B.remove();\n"
        "  return JSON.stringify({s1,s2,s3,fallbackRouted:before!==after});\n"
        "})()`);\n"
        "console.log(r);"
    , timeout=200)
    if not out:
        row("ENG-176 dictation (4 scenarios)", "SKIP", "probe returned nothing (test seam is dev-only)")
        return
    s1, s2, s3 = out.get("s1", {}), out.get("s2", {}), out.get("s3", {})
    ok = (s1.get("A") == "switch words" and s1.get("B") == ""
          and s2.get("B") == "" and s3.get("A") == "normal words")
    row("ENG-176 dictation (4 scenarios)", "PASS" if ok else "FAIL",
        f"switch={s1.get('A')!r}/B={s1.get('B')!r}, lost-target B={s2.get('B')!r}, "
        f"normal={s3.get('A')!r}, fallback routed={out.get('fallbackRouted')}")


def check_scroll_both_halves() -> None:
    """Wheel-storm asserting BOTH halves on every surface it can confirm."""
    out = p_cdp(
        "const CAM=\"(function(){var c=document.querySelector('[data-select-type]');if(!c)return 'NC';"
        "var el=c.parentElement;while(el){var t=getComputedStyle(el).transform;"
        "if(t&&t!=='none'&&!/matrix\\\\(1, 0, 0, 1/.test(t))return t;el=el.parentElement}return 'NM'})()\";\n"
        "const FIND=\"(function(){var vw=innerWidth,vh=innerHeight;for(var y=70;y<vh-70;y+=16){for(var x=70;x<vw-70;x+=16){"
        "var el=document.elementFromPoint(x,y);if(!el)continue;var n=el;"
        "for(var i=0;i<10&&n;i++){var s=getComputedStyle(n);"
        "if((s.overflowY==='auto'||s.overflowY==='scroll')&&n.scrollHeight>n.clientHeight+8){window.__S__=n;"
        "return JSON.stringify({x:x,y:y})}n=n.parentElement}}}return 'none'})()\";\n"
        "const f=await ev(FIND);\n"
        "if(f==='none'){console.log(JSON.stringify({found:false}));}else{\n"
        "  const q=JSON.parse(f);const cb=await ev(CAM);const tb=await ev('window.__S__.scrollTop');\n"
        "  for(let i=0;i<10;i++){await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:q.x,y:q.y,deltaX:0,deltaY:120});await sleep(70);}\n"
        "  await sleep(800);\n"
        "  const ta=await ev('window.__S__.scrollTop');const ca=await ev(CAM);\n"
        "  console.log(JSON.stringify({found:true,scrolled:ta>tb,cameraStill:cb===ca,from:tb,to:ta}));}"
    , timeout=200)
    if not out or not out.get("found"):
        row("wheel-storm (both halves)", "SKIP", "no confirmable scrollable surface on screen")
        return
    ok = out["scrolled"] and out["cameraStill"]
    row("wheel-storm (both halves)", "PASS" if ok else "FAIL",
        f"scrollTop {out['from']}->{out['to']} (positive={'ok' if out['scrolled'] else 'FAIL'}), "
        f"camera {'byte-identical' if out['cameraStill'] else 'MOVED'}")


def check_long_tasks_on_mount() -> None:
    """The gate that was missing. TTFT, INP, idle-rAF and 60fps drag all PASSED while opening a
    dashboard blocked the renderer for 4.75s, because every one of them samples a gesture or an idle
    moment and the cost is at MOUNT. This measures the thing users actually call heaviness: total
    main-thread blocking caused by one user action, via the longtask observer that already ships."""
    out = p_cdp(
        "await ev(\"(function(){window.__LTGATE__=[];try{var o=new PerformanceObserver(function(l){"
        "l.getEntries().forEach(function(e){window.__LTGATE__.push(Math.round(e.duration));});});"
        "o.observe({entryTypes:['longtask']});}catch(e){}return 1})()\");\n"
        "await sleep(1500);\n"
        "await ev('window.__LTGATE__=[];1');\n"
        "await sleep(5000);\n"
        "const idle=await ev('JSON.stringify(window.__LTGATE__)');\n"
        "const tile=await ev(\"(function(){var o=null;document.querySelectorAll('.osw-dock-tile').forEach(function(n){"
        "var l=(n.getAttribute('aria-label')||n.getAttribute('title')||n.innerText||'').trim();"
        "if(l==='Browsers'&&!o){var r=n.getBoundingClientRect();o={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}});"
        "return JSON.stringify(o||{none:true})})()\");\n"
        "const t=JSON.parse(tile||'{\"none\":true}');\n"
        "if(t.none){console.log(JSON.stringify({noTile:true,idle:JSON.parse(idle||'[]')}));}else{\n"
        "  await ev('window.__LTGATE__=[];1');\n"
        "  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:t.x,y:t.y,button:'left',clickCount:1});\n"
        "  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:t.x,y:t.y,button:'left',clickCount:1});\n"
        "  await sleep(5000);\n"
        "  const mount=await ev('JSON.stringify(window.__LTGATE__)');\n"
        "  const wv=await ev(\"document.querySelectorAll('webview').length\");\n"
        "  console.log(JSON.stringify({idle:JSON.parse(idle||'[]'),mount:JSON.parse(mount||'[]'),webviews:wv}));}\n",
        timeout=300)
    if not out or "mount" not in out:
        row("long tasks on card mount", "SKIP", f"probe returned {out}")
        return
    def nums(xs):
        return [x if isinstance(x, int) else int(x.get("dur", 0)) for x in (xs or [])]
    idle = nums(out.get("idle"))
    mount = nums(out.get("mount"))
    blocked = sum(mount)
    worst = max(mount) if mount else 0
    # Idle must be clean or the reading is contaminated; a busy box invalidates the mount number.
    if sum(idle) > 0:
        row("long tasks on card mount", "SKIP",
            f"idle control was not clean ({len(idle)} tasks, {sum(idle)}ms) -- rerun on a quiet box")
        return
    ok = worst <= 100 and blocked <= 500
    row("long tasks on card mount (<=100ms worst, <=500ms total)", "PASS" if ok else "FAIL",
        f"{len(mount)} tasks, {blocked}ms blocked, worst {worst}ms, {out.get('webviews')} webviews "
        f"(idle control 0ms) [ENG-193 baseline: 736ms/174ms]")
