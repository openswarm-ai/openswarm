import { getGmailHeader } from '@/shared/mcpToolMeta';

export function formatTimestamp(ts: string | number | undefined): string {
  if (!ts) return '';
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return String(ts); }
}

export function stripHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

export function extractEmailFields(msg: any) {
  const subject = msg.subject || getGmailHeader(msg, 'Subject') || '(no subject)';
  const from = msg.from || msg.sender || getGmailHeader(msg, 'From') || '';
  const to = msg.to || msg.recipient || getGmailHeader(msg, 'To') || '';
  const rawDate = msg.date || msg.internalDate || msg.receivedAt || getGmailHeader(msg, 'Date') || '';
  const date = formatTimestamp(rawDate);
  const snippet = msg.snippet || '';
  const body = msg.body || msg.text || msg.textBody || '';
  const htmlBody = msg.htmlBody || msg.html || '';
  const bodyPreview = body || (htmlBody ? stripHtml(htmlBody) : '');
  return { subject, from, to, date, snippet, bodyPreview };
}
