export interface McpToolInfo {
  isMcp: boolean;
  serverSlug: string;
  action: string;
  service: string;
  displayName: string;
}

export function parseMcpToolName(rawName: string): McpToolInfo {
  const m = rawName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (!m) return { isMcp: false, serverSlug: '', action: '', service: '', displayName: rawName };
  const serverSlug = m[1];
  const action = m[2];
  const spaced = action.replace(/_/g, ' ').toLowerCase();
  const display = spaced.charAt(0).toUpperCase() + spaced.slice(1);

  const lower = action.toLowerCase();
  let service = '';
  if (lower.includes('gmail') || lower.includes('email') || lower.includes('mail')) service = 'gmail';
  else if (lower.includes('calendar') || lower.includes('event') || lower.includes('freebusy')) service = 'calendar';
  else if (lower.includes('drive') || lower.includes('file')) service = 'drive';
  else if (lower.includes('sheet') || lower.includes('spreadsheet')) service = 'sheets';
  else if (lower.includes('doc') || lower.includes('paragraph')) service = 'docs';
  else if (lower.includes('contact')) service = 'contacts';

  return { isMcp: true, serverSlug, action, service, displayName: display };
}

export function getMcpInputSummary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  if (keys.length === 1) {
    const v = input[keys[0]];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }
  return keys.slice(0, 3).map((k) => {
    const v = input[k];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${s.length > 30 ? s.slice(0, 30) + '…' : s}`;
  }).join('  ');
}

export function getMcpShortAction(mcpInfo: McpToolInfo): string {
  const { action, service } = mcpInfo;
  let short = action;
  if (service && action.toLowerCase().startsWith(service.toLowerCase() + '_')) {
    short = action.slice(service.length + 1);
  }
  const lower = short.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function getGmailHeader(msg: any, name: string): string {
  if (msg.payload?.headers && Array.isArray(msg.payload.headers)) {
    const h = msg.payload.headers.find(
      (hdr: any) => (hdr.name || '').toLowerCase() === name.toLowerCase()
    );
    if (h) return h.value || '';
  }
  if (msg.headers && typeof msg.headers === 'object' && !Array.isArray(msg.headers)) {
    return msg.headers[name] || msg.headers[name.toLowerCase()] || '';
  }
  return '';
}
