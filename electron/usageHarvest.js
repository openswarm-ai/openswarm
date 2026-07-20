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
// plus ChatGPT Memory, THEN pulls the FULL text of the CONVO_N most recent conversations
// (the user's real asks + the exchange, far higher signal than a vague title). Bounded on
// EVERY dimension so no provider's endpoint speed can wedge the read: a wall-clock BUDGET_MS,
// a per-fetch abort, hard page/title caps, and a per-conversation char cap so one marathon
// chat can't dominate. A partial read is a good result; the recent stuff is the strongest signal.
const PREAMBLE = `
  // Prep reads only ~150 titles, so pulling 1000 just burned onboarding runway for signal we throw
  // away. Cap the pull; the count becomes an honest "N+" floor when we stop early. CONVO_N full convos
  // (capped per convo) are the real payload; the budget is raised to fit their detail fetches.
  const BUDGET_MS=20000, PAGE=100, CAP_PAGES=60, CAP_TITLES=200, GAP_MS=120, FETCH_MS=6000, CONVO_N=10, CONVO_CHARS=8000;
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
      if (!sess || !sess.accessToken) return {ok:false, total:0, titles:[], memories:[], convos:[]};
      const H = {headers:{Authorization:'Bearer '+sess.accessToken, accept:'application/json'}};
      const seen = new Set(); const titles = []; const convList = [];
      let offset = 0, page = 0;
      while (page < CAP_PAGES && titles.length < CAP_TITLES && haveTime()) {
        const j = await jget('/backend-api/conversations?offset='+offset+'&limit='+PAGE+'&order=updated', H);
        const items = (j && j.items) || [];
        if (!items.length) break;
        let fresh = 0;
        for (const c of items) { if (c && c.id && !seen.has(c.id)) { seen.add(c.id); if (c.title) titles.push(c.title); convList.push({id:c.id, title:c.title||''}); fresh++; } }
        if (fresh === 0 || items.length < PAGE) break;
        offset += PAGE; page++;
        await new Promise(r=>setTimeout(r, GAP_MS));
      }
      const mem = await jget('/backend-api/memories?include_memory_entries=true', H);
      // The payload: FULL text of the most recent convos, fetched in parallel (bounded by the budget).
      const top = convList.slice(0, CONVO_N);
      const details = await Promise.all(top.map(cv => haveTime() ? jget('/backend-api/conversation/'+cv.id, H) : Promise.resolve(null)));
      const convos = [];
      for (let i=0;i<top.length;i++) {
        const d = details[i]; if (!d || !d.mapping) continue;
        const msgs = Object.keys(d.mapping).map(k=>d.mapping[k] && d.mapping[k].message)
          .filter(m=>m && m.author && (m.author.role==='user'||m.author.role==='assistant') && m.content && m.content.content_type==='text' && m.content.parts && m.content.parts.length)
          .sort((a,b)=>(a.create_time||0)-(b.create_time||0))
          .map(m=>(m.author.role==='user'?'You: ':'AI: ')+String(m.content.parts.join(' ')).trim())
          .filter(s=>s.length>5);
        let text = msgs.join('\\n'); if (text.length > CONVO_CHARS) text = text.slice(0, CONVO_CHARS)+' …';
        if (text) convos.push({title: top[i].title, text});
      }
      return {
        ok: true,
        total: seen.size,
        capped: seen.size >= CAP_TITLES,
        titles: titles.slice(0, CAP_TITLES),
        memories: ((mem && mem.memories) || []).map(m=>m.content).filter(Boolean).slice(0, 40),
        convos,
      };
    } catch (e) { return {ok:false, total:0, titles:[], memories:[], convos:[]}; }
  })()`,
  claude: `(async () => {${PREAMBLE}
    try {
      const orgs = await jget('/api/organizations', {headers:{accept:'application/json'}});
      if (!Array.isArray(orgs) || !orgs.length) return {ok:false, total:0, titles:[], memories:[], convos:[]};
      const org = orgs[0].uuid;
      const seen = new Set(); const titles = []; const convList = [];
      let offset = 0, page = 0;
      while (page < CAP_PAGES && titles.length < CAP_TITLES && haveTime()) {
        const convs = await jget('/api/organizations/'+org+'/chat_conversations?limit='+PAGE+'&offset='+offset, {headers:{accept:'application/json'}});
        const items = Array.isArray(convs) ? convs : [];
        if (!items.length) break;
        let fresh = 0;
        for (const c of items) { const id = c && c.uuid; if (id && !seen.has(id)) { seen.add(id); if (c.name) titles.push(c.name); convList.push({id:id, title:c.name||''}); fresh++; } }
        if (fresh === 0 || items.length < PAGE) break;
        offset += PAGE; page++;
        await new Promise(r=>setTimeout(r, GAP_MS));
      }
      // The payload: FULL text of the most recent convos (both sides), fetched in parallel + capped.
      const top = convList.slice(0, CONVO_N);
      const details = await Promise.all(top.map(cv => haveTime() ? jget('/api/organizations/'+org+'/chat_conversations/'+cv.id+'?tree=True&rendering_mode=raw', {headers:{accept:'application/json'}}) : Promise.resolve(null)));
      const convos = [];
      for (let i=0;i<top.length;i++) {
        const d = details[i]; if (!d) continue;
        const cms = (d && d.chat_messages) || (Array.isArray(d) ? d : []);
        const msgs = cms.filter(m=>m && (m.sender==='human'||m.sender==='assistant'))
          .map(m=>{ let t = m.text || ''; if(!t && Array.isArray(m.content)) t = m.content.map(x=>x&&x.text).filter(Boolean).join(' '); return (m.sender==='human'?'You: ':'AI: ')+String(t).trim(); })
          .filter(s=>s.length>5);
        let text = msgs.join('\\n'); if (text.length > CONVO_CHARS) text = text.slice(0, CONVO_CHARS)+' …';
        if (text) convos.push({title: top[i].title, text});
      }
      return {ok:true, total:seen.size, capped:seen.size >= CAP_TITLES, titles:titles.slice(0, CAP_TITLES), memories:[], convos};
    } catch (e) { return {ok:false, total:0, titles:[], memories:[], convos:[]}; }
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

// Never re-hit a provider we've already read successfully within this window. Rapid repeated
// reads of the SAME session (especially Google's rotating __Secure-1PSIDTS) can trip provider
// anti-abuse and log the user OUT of their real account, so every caller funnels through this
// one cooldown. Failed reads are NOT cached, so a not-yet-logged-in provider stays retryable;
// a cached success also serves an instant re-request with zero extra network.
const HARVEST_COOLDOWN_MS = 15 * 60 * 1000;
const p_okCache = {};

async function harvest(partition, provider) {
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'gemini') return EMPTY;
  const cached = p_okCache[provider];
  if (cached && Date.now() - cached.at < HARVEST_COOLDOWN_MS) return cached.result;
  const result = await Promise.race([
    p_harvestOnce(partition, provider),
    new Promise((resolve) => setTimeout(() => resolve(EMPTY), HARVEST_HARD_CAP_MS)),
  ]);
  if (p_usable(result)) p_okCache[provider] = { at: Date.now(), result };
  return result;
}

module.exports = { harvest, configure };
