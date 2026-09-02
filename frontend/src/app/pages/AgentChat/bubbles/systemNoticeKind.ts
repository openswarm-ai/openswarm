export type SystemNoticeKind = 'raw_error' | 'notice';

// Unanchored on purpose: the runtime's dump can trail a friendly headline ("...turn failed (x). API Error: 400 {json}"), and the json is what belongs behind the disclosure. No backend-authored notice says these phrases in prose; the test pins the nearest misses.
const RAW_RUNTIME_ERROR_RE = /Command failed with exit code|API Error:|invalid_request_error|"type"\s*:\s*"error"|Check stderr output/i;

/** A system-role message is either a calm note the backend wrote for the user, or a raw runtime dump that needs a card. */
export function classifySystemNotice(text: string): SystemNoticeKind {
  return RAW_RUNTIME_ERROR_RE.test(text) ? 'raw_error' : 'notice';
}
