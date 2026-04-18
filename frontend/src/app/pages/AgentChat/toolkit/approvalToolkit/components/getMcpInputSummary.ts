export function getMcpInputSummary(actionName: string, toolInput: Record<string, any>): string {
    const lower = actionName.toLowerCase();
  
    if (lower.includes('gmail') || lower.includes('email') || lower.includes('mail')) {
      const query = toolInput.query || toolInput.search_query || toolInput.q || '';
      const to = toolInput.to || toolInput.recipient || '';
      const subject = toolInput.subject || '';
      if (query) return `Search: "${query}"`;
      if (to && subject) return `To ${to} — ${subject}`;
      if (to) return `To ${to}`;
      if (subject) return `Subject: ${subject}`;
    }
  
    if (lower.includes('calendar') || lower.includes('event') || lower.includes('freebusy')) {
      const summary = toolInput.summary || toolInput.title || toolInput.event_name || '';
      const start = toolInput.start || toolInput.start_time || toolInput.date || '';
      if (summary && start) return `${summary} — ${start}`;
      if (summary) return summary;
      if (start) return `Date: ${start}`;
    }
  
    if (lower.includes('drive') || lower.includes('doc') || lower.includes('sheet') || lower.includes('slide')) {
      const name = toolInput.name || toolInput.title || toolInput.filename || toolInput.file_name || '';
      const query = toolInput.query || toolInput.q || '';
      if (name) return name;
      if (query) return `Search: "${query}"`;
    }
  
    if (lower.includes('tweet') || lower.includes('post') || lower.includes('send') || lower.includes('reply')) {
      const text = toolInput.text || toolInput.content || toolInput.body || toolInput.message || '';
      if (text) return text.length > 80 ? text.slice(0, 77) + '...' : text;
    }
  
    if (lower.includes('search') || lower.includes('find') || lower.includes('query') || lower.includes('list')) {
      const query = toolInput.query || toolInput.q || toolInput.search_query || toolInput.keyword || toolInput.term || '';
      if (query) return `"${query}"`;
    }
  
    const stringVals: string[] = [];
    for (const [key, val] of Object.entries(toolInput)) {
      if (key.startsWith('_')) continue;
      if (typeof val === 'string' && val.trim()) {
        stringVals.push(val.trim());
      }
      if (stringVals.length >= 2) break;
    }
    if (stringVals.length > 0) {
      const joined = stringVals.join(' — ');
      return joined.length > 100 ? joined.slice(0, 97) + '...' : joined;
    }
  
    return '';
  }