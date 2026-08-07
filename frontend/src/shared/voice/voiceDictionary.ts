// The glossary that rides every whisper decode: the user's manual list merged with proper nouns
// LEARNED from their own dictations (a capitalized word that keeps showing up is a name worth
// biasing toward). All local; main receives one merged comma list via voiceSetDictionary.

// v2: the v1 store learned junk from garbled transcripts and fed it BACK into decoding (a
// degradation loop); new key orphans it, and the merge bar is higher.
const LEARNED_KEY = 'osw-dictation-learned-v2';
const LEARNED_CAP = 40;
const MERGE_TOP = 12;

// Words that start sentences get capitalized for free; only mid-sentence capitals count as names.
const NOUN_RE = /(?<![.!?]\s)(?<!^)\b([A-Z][a-zA-Z]{2,}(?:'s)?)\b/g;
const COMMON = new Set(['The', 'This', 'That', 'What', 'When', 'Where', 'Which', 'And', 'But', 'For', 'Not', 'You', 'Your', 'They', 'Their', 'There', 'Then', 'Also', 'Okay', 'Yes', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

let manual = '';

function readLearned(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LEARNED_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function pushMerged(): void {
  const counts = readLearned();
  const learned = Object.entries(counts)
    .filter(([w, n]) => n >= 3 && w.length >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MERGE_TOP)
    .map(([w]) => w);
  const manualWords = manual.split(',').map((w) => w.trim()).filter(Boolean);
  const merged = [...new Set([...manualWords, ...learned])].join(', ');
  lastPushedMerged = merged;
  const bridge = window as unknown as { openswarm?: { voiceSetDictionary?: (words: string) => void } };
  bridge.openswarm?.voiceSetDictionary?.(merged);
}

export function setManualDictionary(words: string): void {
  manual = words || '';
  pushMerged();
}

let lastPushedMerged = '';

// OpenWhispr's echo test: the model sometimes reads the glossary prompt back as the "transcript".
// Mostly-dictionary words (90%) covering most of the dictionary (70%) = the prompt leaked.
export function isDictionaryEcho(text: string): boolean {
  const dictWords = new Set(lastPushedMerged.toLowerCase().split(/[,\s]+/).filter(Boolean));
  if (dictWords.size === 0) return false;
  const words = text.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z']/g, '')).filter(Boolean);
  if (words.length === 0) return false;
  const unique = [...new Set(words)];
  const fromDict = unique.filter((w) => dictWords.has(w)).length;
  const coverage = [...dictWords].filter((w) => words.includes(w)).length / dictWords.size;
  return fromDict / unique.length >= 0.9 && coverage >= 0.7;
}

export function learnFromTranscript(text: string): void {
  try {
    const counts = readLearned();
    for (const m of text.matchAll(NOUN_RE)) {
      const w = m[1].replace(/'s$/, '');
      if (COMMON.has(w)) continue;
      counts[w] = (counts[w] || 0) + 1;
    }
    const trimmed = Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, LEARNED_CAP),
    );
    localStorage.setItem(LEARNED_KEY, JSON.stringify(trimmed));
    pushMerged();
  } catch { /* learning is a bonus, never a blocker */ }
}
