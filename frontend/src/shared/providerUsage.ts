// Reads what the user actually uses their AI for, from a logged-in provider website (chatgpt.com / claude.ai) using that site's own session. Sweeps the FULL conversation history (all titles, paginated) plus ChatGPT Memory, so prep can profile what the user keeps coming back to. Same-origin fetch from the page context (the proven technique); the RAW result never leaves the renderer, only the derived summary goes to prep, and even that is dropped after.

export type UsageProvider = 'codex' | 'claude';

export interface ProviderUsage {
  ok: boolean;
  total: number;
  titles: string[];
  memories: string[];
}

// Runs in the WEBVIEW/offscreen page context (chatgpt.com / claude.ai), so it inherits the live session. Kept as a string because it is injected via executeJavaScript. Hard caps (pages, titles, memory) bound the work + the PII footprint even for a user with thousands of chats; every fetch fails open to empty.
export const USAGE_READ_JS: Record<UsageProvider, string> = {
  codex: `(async () => {
    const PAGE=100, CAP_PAGES=60, CAP_TITLES=1000, GAP_MS=90;
    try {
      const sess = await fetch('/api/auth/session', {credentials:'include'}).then(r=>r.json());
      if (!sess || !sess.accessToken) return {ok:false, total:0, titles:[], memories:[]};
      const H = {headers:{Authorization:'Bearer '+sess.accessToken, accept:'application/json'}, credentials:'include'};
      const seen = new Set(); const titles = [];
      let offset = 0, page = 0;
      while (page < CAP_PAGES && titles.length < CAP_TITLES) {
        const j = await fetch('/backend-api/conversations?offset='+offset+'&limit='+PAGE+'&order=updated', H).then(r=>r.ok?r.json():null).catch(()=>null);
        const items = (j && j.items) || [];
        if (!items.length) break;
        let fresh = 0;
        for (const c of items) { if (c && c.id && !seen.has(c.id)) { seen.add(c.id); if (c.title) titles.push(c.title); fresh++; } }
        if (fresh === 0) break;
        if (items.length < PAGE) break;
        offset += PAGE; page++;
        await new Promise(r=>setTimeout(r, GAP_MS));
      }
      const mem = await fetch('/backend-api/memories?include_memory_entries=true', H).then(r=>r.ok?r.json():null).catch(()=>null);
      return {
        ok: true,
        total: seen.size,
        titles: titles.slice(0, CAP_TITLES),
        memories: ((mem && mem.memories) || []).map(m=>m.content).filter(Boolean).slice(0, 40),
      };
    } catch (e) { return {ok:false, total:0, titles:[], memories:[]}; }
  })()`,
  claude: `(async () => {
    const PAGE=100, CAP_PAGES=60, CAP_TITLES=1000, GAP_MS=90;
    try {
      const orgs = await fetch('/api/organizations', {credentials:'include', headers:{accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null);
      if (!Array.isArray(orgs) || !orgs.length) return {ok:false, total:0, titles:[], memories:[]};
      const org = orgs[0].uuid;
      const seen = new Set(); const titles = [];
      let offset = 0, page = 0;
      while (page < CAP_PAGES && titles.length < CAP_TITLES) {
        const convs = await fetch('/api/organizations/'+org+'/chat_conversations?limit='+PAGE+'&offset='+offset, {credentials:'include', headers:{accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null);
        const items = Array.isArray(convs) ? convs : [];
        if (!items.length) break;
        let fresh = 0;
        for (const c of items) { const id = c && c.uuid; if (id && !seen.has(id)) { seen.add(id); if (c.name) titles.push(c.name); fresh++; } }
        if (fresh === 0) break;
        if (items.length < PAGE) break;
        offset += PAGE; page++;
        await new Promise(r=>setTimeout(r, GAP_MS));
      }
      return {ok:true, total:seen.size, titles:titles.slice(0, CAP_TITLES), memories:[]};
    } catch (e) { return {ok:false, total:0, titles:[], memories:[]}; }
  })()`,
};

export const USAGE_ORIGIN: Record<UsageProvider, string> = {
  codex: 'https://chatgpt.com/',
  claude: 'https://claude.ai/',
};

// Turn the raw read into a compact profile block for the prep prompt: the memory facts (strongest), the scale, and the most-recent topics. Capped hard so we never ship a wall of PII even for a heavy user; the aux model turns this into the profile.
export function summarizeUsage(u: ProviderUsage | null): string {
  if (!u || !u.ok) return '';
  const parts: string[] = [];
  if (u.total > 0) parts.push(`They have ${u.total} past AI conversations.`);
  if (u.memories.length > 0) parts.push('Facts their AI remembers about them: ' + u.memories.join('; '));
  if (u.titles.length > 0) parts.push('Topics they keep coming back to (recent first): ' + u.titles.slice(0, 150).join('; '));
  return parts.join('\n').slice(0, 4000);
}
