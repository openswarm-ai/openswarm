// Silently read the user's OWN provider chat history (chatgpt.com / claude.ai) from
// the browser partition's logged-in session, with no visible card. Onboarding prep
// uses the result to profile what the user actually cares about. The injected script
// is defined HERE (main-owned), so the offscreen exec can never be pointed at a script
// the renderer or a remote page chose. Only reachable when a session already exists in
// the partition; otherwise it fails open to {ok:false} and prep falls back to the scan.
//
// The RAW read never touches disk or redux: it is returned once to the renderer, which
// derives a capped summary for prep and drops the rest. See summarizeUsage (frontend).

const hiddenBrowser = require('./hiddenBrowser');

const ORIGIN = {
  codex: 'https://chatgpt.com/',
  claude: 'https://claude.ai/',
  gemini: 'https://gemini.google.com/app',
};

const DOMAIN = {
  codex: 'chatgpt.com',
  claude: 'claude.ai',
  gemini: 'gemini.google.com',
};

// Main injects a (domain) => Promise<cookieRecords[]> that spawns the Python cookie reader.
// Left null off-Electron / before boot, so harvest silently skips the imported-cookie path.
let p_readCookies = null;
function configure(opts) {
  if (opts && typeof opts.readCookies === 'function') p_readCookies = opts.readCookies;
}

// Runs in the page context. Sweeps recent conversation titles (paginated + deduped)
// plus ChatGPT Memory. Bounded on EVERY dimension so no provider's endpoint speed can
// wedge the read: a wall-clock BUDGET_MS (ChatGPT's /conversations is ~4s/page, so an
// unbounded loop over a many-chat account would run minutes and outlive the offscreen
// window, losing everything), a per-fetch abort, and hard page/title caps. The most
// recent titles are the strongest personalization signal, so a partial is a good result.
const PREAMBLE = `
  const BUDGET_MS=14000, PAGE=100, CAP_PAGES=60, CAP_TITLES=1000, GAP_MS=120, FETCH_MS=6000;
  const startedAt = Date.now();
  const haveTime = () => Date.now() - startedAt < BUDGET_MS;
  const jget = async (url, extra) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), FETCH_MS);
    try { const r = await fetch(url, Object.assign({credentials:'include', signal:ac.signal}, extra||{})); return r.ok ? await r.json() : null; }
    catch (e) { return null; } finally { clearTimeout(t); }
  };`;
const SCRIPT = {
  codex: `(async () => {${PREAMBLE}
    try {
      const sess = await jget('/api/auth/session');
      if (!sess || !sess.accessToken) return {ok:false, total:0, titles:[], memories:[]};
      const H = {headers:{Authorization:'Bearer '+sess.accessToken, accept:'application/json'}};
      const seen = new Set(); const titles = [];
      let offset = 0, page = 0;
      while (page < CAP_PAGES && titles.length < CAP_TITLES && haveTime()) {
        const j = await jget('/backend-api/conversations?offset='+offset+'&limit='+PAGE+'&order=updated', H);
        const items = (j && j.items) || [];
        if (!items.length) break;
        let fresh = 0;
        for (const c of items) { if (c && c.id && !seen.has(c.id)) { seen.add(c.id); if (c.title) titles.push(c.title); fresh++; } }
        if (fresh === 0 || items.length < PAGE) break;
        offset += PAGE; page++;
        await new Promise(r=>setTimeout(r, GAP_MS));
      }
      const mem = await jget('/backend-api/memories?include_memory_entries=true', H);
      return {
        ok: true,
        total: seen.size,
        titles: titles.slice(0, CAP_TITLES),
        memories: ((mem && mem.memories) || []).map(m=>m.content).filter(Boolean).slice(0, 40),
      };
    } catch (e) { return {ok:false, total:0, titles:[], memories:[]}; }
  })()`,
  claude: `(async () => {${PREAMBLE}
    try {
      const orgs = await jget('/api/organizations', {headers:{accept:'application/json'}});
      if (!Array.isArray(orgs) || !orgs.length) return {ok:false, total:0, titles:[], memories:[]};
      const org = orgs[0].uuid;
      const seen = new Set(); const titles = [];
      let offset = 0, page = 0;
      while (page < CAP_PAGES && titles.length < CAP_TITLES && haveTime()) {
        const convs = await jget('/api/organizations/'+org+'/chat_conversations?limit='+PAGE+'&offset='+offset, {headers:{accept:'application/json'}});
        const items = Array.isArray(convs) ? convs : [];
        if (!items.length) break;
        let fresh = 0;
        for (const c of items) { const id = c && c.uuid; if (id && !seen.has(id)) { seen.add(id); if (c.name) titles.push(c.name); fresh++; } }
        if (fresh === 0 || items.length < PAGE) break;
        offset += PAGE; page++;
        await new Promise(r=>setTimeout(r, GAP_MS));
      }
      return {ok:true, total:seen.size, titles:titles.slice(0, CAP_TITLES), memories:[]};
    } catch (e) { return {ok:false, total:0, titles:[], memories:[]}; }
  })()`,
  // Gemini has no clean history JSON (it's the obfuscated batchexecute RPC), so we scrape the
  // rendered rail. Robust by design, one bounded loop that: gates on real TEXT (empty conversation
  // shells persist even when the rail is collapsed, so container count lies); RE-tries the expand
  // every poll (the SPA can mount the toggle after settle, and a one-shot click would miss it),
  // via a stable test-id / icon handle (not an English label) so a non-English UI works, and a
  // no-op once open so an open rail is never toggled shut; reads titles through a fallback
  // selector so a .title-text rename can't zero the harvest; length-caps each; and gives up fast
  // when no text renders (no history / broken DOM) so an empty account can't burn the budget.
  gemini: `(async () => {
    const BUDGET_MS=14000, TEXT_DEADLINE_MS=8000, POLL_MS=500, CAP_TITLES=200, TITLE_MAX=140;
    const startedAt=Date.now();
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const titleNodes=()=>{const n=document.querySelectorAll('[data-test-id="conversation"] .title-text');return n.length?n:document.querySelectorAll('[data-test-id="conversation"] a');};
    const iconIs=(b,name)=>{const i=b.querySelector('mat-icon');return !!i&&(i.getAttribute('data-mat-icon-name')===name||(i.textContent||'').trim()===name);};
    const findExpand=()=>{const bs=Array.from(document.querySelectorAll('button,[role="button"]'));return document.querySelector('button[data-test-id="side-nav-sparkle-button"]')||bs.find(b=>iconIs(b,'side_nav_expand'))||bs.find(b=>/expand|open.*(sidebar|menu|nav)/i.test(b.getAttribute('aria-label')||''));};
    try {
      const seen=new Set(); const titles=[]; let stable=0;
      while (Date.now()-startedAt < BUDGET_MS && titles.length < CAP_TITLES) {
        let fresh=0;
        titleNodes().forEach(e=>{const t=(e.textContent||'').trim().slice(0,TITLE_MAX); if(t&&!seen.has(t)){seen.add(t);titles.push(t);fresh++;}});
        if (titles.length>0) { if (fresh===0){ if(++stable>=2) break; } else stable=0; }
        else { const b=findExpand(); if(b){try{b.click();}catch(_){}} if (Date.now()-startedAt > TEXT_DEADLINE_MS) break; }
        await sleep(POLL_MS);
      }
      return { ok: titles.length>0, total: titles.length, titles: titles.slice(0, CAP_TITLES), memories: [] };
    } catch (e) { return {ok:false, total:0, titles:[], memories:[]}; }
  })()`,
};

const EMPTY = { ok: false, total: 0, titles: [], memories: [] };

function p_usable(res) {
  return res && typeof res === 'object' && res.ok &&
    (res.total > 0 || (res.memories && res.memories.length) || (res.titles && res.titles.length));
}

async function p_harvestOnce(partition, provider) {
  // First run: read the user's own browser session cookies, inject into a throwaway real-Chrome
  // context, and harvest there. This is the only path that beats provider Cloudflare AND works
  // before the user has opened the site in-app.
  if (p_readCookies) {
    try {
      const records = await p_readCookies(DOMAIN[provider]);
      if (records && records.length) {
        const viaCookies = await hiddenBrowser.hiddenEvalWithCookies(ORIGIN[provider], records, SCRIPT[provider]).catch(() => null);
        if (p_usable(viaCookies)) return viaCookies;
      }
    } catch (_) { /* fall through to the opportunistic path */ }
  }
  // Opportunistic: the user already logged into the site in an in-app card, so the browser
  // partition holds the session; read it directly (also a real Chrome context).
  const res = await hiddenBrowser.hiddenEval(partition, ORIGIN[provider], SCRIPT[provider]).catch(() => null);
  return p_usable(res) ? res : EMPTY;
}

// Hard ceiling on the WHOLE harvest (both attempts): a stale-session provider does two full
// offscreen loads, and a hung redirect could otherwise churn a background window toward the
// window-killer. This guarantees harvest() always resolves fast (fail-open); the offscreen
// windows still self-destruct via withWindow. Comfortably above a healthy harvest (~6s).
const HARVEST_HARD_CAP_MS = 30000;

async function harvest(partition, provider) {
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'gemini') return EMPTY;
  return Promise.race([
    p_harvestOnce(partition, provider),
    new Promise((resolve) => setTimeout(() => resolve(EMPTY), HARVEST_HARD_CAP_MS)),
  ]);
}

module.exports = { harvest, configure };
