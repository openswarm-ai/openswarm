// Pure ranking + capping for the interactive-element list the browser agent sees from the accessibility tree. No DOM/CDP deps so it stays unit-testable. Why: BrowserListInteractives used to dump EVERY interactive node with no cap. On heavy pages that is 200+ rows, which dilutes the model's attention and burns tokens. We dedupe twins, rank the things a human acts on first, and cap, so the model gets a short, high-signal menu.

export interface RankItem {
  role: string;
  name: string;
  backendNodeId: number;
  // Present when the element lives in a cross-origin (OOPIF) child frame; the CDP session to address it through. Ranking ignores it, just carries it.
  sessionId?: string;
  // Nearby text that disambiguates same-named twins (the card/section this element sits in, e.g. which "Message" button belongs to which person).
  context?: string;
  // Current text of a textbox/searchbox/combobox. Without it a filled compose box still renders by its placeholder name and reads as "typing failed".
  value?: string;
}

// Lower number = higher priority. Inputs the user types into first, then navigation/buttons, then toggles, then the long tail of list/option roles.
const ROLE_PRIORITY: Record<string, number> = {
  textbox: 0, searchbox: 0, combobox: 0,
  button: 1, link: 1, menuitem: 1, tab: 1,
  checkbox: 2, radio: 2, switch: 2, menuitemcheckbox: 2, menuitemradio: 2,
  option: 3, treeitem: 3, listbox: 3, slider: 3, spinbutton: 3,
};

const DEFAULT_PRIORITY = 2;
export const DEFAULT_INTERACTIVE_CAP = 60;

function rolePriority(role: string): number {
  return role in ROLE_PRIORITY ? ROLE_PRIORITY[role] : DEFAULT_PRIORITY;
}

// Drop back-to-back duplicates with the same role+name. The AX tree often emits an icon node and its label as twins, and sticky headers repeat the same control. Consecutive-only so a genuine list (5 distinct "Add to cart" buttons interleaved with product text) is never collapsed. The sessionId is part of the key so a same-named element in a cross-origin child frame is never mistaken for a twin of the root frame's last element at the seam. Context too: five "Message" buttons in five people-cards are NOT twins, only same-card icon+label pairs (identical context) collapse.
function dedupeConsecutive(items: RankItem[]): RankItem[] {
  const out: RankItem[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev && prev.role === it.role && prev.name === it.name
        && prev.sessionId === it.sessionId && (prev.context || '') === (it.context || '')) continue;
    out.push(it);
  }
  return out;
}

export interface RankResult {
  shown: RankItem[];
  truncated: number;
}

export interface RankOptions {
  cap?: number;
  // The agent's current goal; elements whose name matches it float to the top so the thing the model is actually looking for survives the cap.
  goal?: string;
}

// Words too generic to be useful signal, including the browser-action verbs and UI nouns that would otherwise match half the page ("click the button").
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'click', 'type', 'into', 'button', 'link',
  'press', 'select', 'open', 'goto', 'navigate', 'find', 'tap', 'this',
  'that', 'your', 'from', 'page', 'then', 'enter', 'input', 'field', 'box',
  'icon', 'menu', 'option', 'item', 'element',
]);

export function goalKeywords(goal: string): string[] {
  const words = goal.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set(kept)).slice(0, 8);
}

function matchesGoal(name: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = name.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

export function rankAndCapInteractives(
  items: RankItem[],
  opts: RankOptions = {},
): RankResult {
  const cap = opts.cap ?? DEFAULT_INTERACTIVE_CAP;
  const keywords = opts.goal ? goalKeywords(opts.goal) : [];
  const deduped = dedupeConsecutive(items);
  const scored = deduped.map((it, i) => ({ it, i, m: matchesGoal(it.name, keywords) ? 0 : 1 }));
  // Rank picks WHICH items survive the cap (goal-matched first, then role priority),
  // so the thing the model wants is never truncated away.
  const ranked = [...scored].sort((a, b) => {
    if (a.m !== b.m) return a.m - b.m;
    const pa = rolePriority(a.it.role);
    const pb = rolePriority(b.it.role);
    if (pa !== pb) return pa - pb;
    return a.i - b.i;
  });
  const selected = cap > 0 ? ranked.slice(0, cap) : ranked;
  // But the DISPLAY order is document order (by original index), so the numbered
  // list reads top-to-bottom the way the page looks. A rank-sorted list scrambled
  // ordinals ("the 4th story" landed at [48], out of order), forcing the model to
  // burn a turn reading page text just to recover position; document order lets it
  // count directly. The high-signal-subset win (from the cap) is untouched.
  const shown = selected.sort((a, b) => a.i - b.i).map((x) => x.it);
  return { shown, truncated: Math.max(0, ranked.length - shown.length) };
}
