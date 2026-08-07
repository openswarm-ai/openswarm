// The last N dictations, local-only (localStorage): a transcript that landed somewhere wrong or got
// overwritten is recoverable without re-speaking it. Never synced, never sent anywhere.

export interface DictationHistoryEntry {
  text: string;
  at: number;
  target: string;
}

const KEY = 'osw-dictation-history';
const CAP = 20;

export function readDictationHistory(): DictationHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is DictationHistoryEntry =>
      !!e && typeof e === 'object' && typeof (e as DictationHistoryEntry).text === 'string' && typeof (e as DictationHistoryEntry).at === 'number');
  } catch {
    return [];
  }
}

export function pushDictation(text: string, target: string): void {
  try {
    const next = [{ text, at: Date.now(), target }, ...readDictationHistory()].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* quota or private mode; history is a convenience, never a blocker */ }
}

export function clearDictationHistory(): void {
  try { localStorage.removeItem(KEY); } catch { /* same */ }
}
