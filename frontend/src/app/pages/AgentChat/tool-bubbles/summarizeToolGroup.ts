const PHRASES: Record<string, (n: number) => string> = {
  Read: (n) => `read ${n} file${n === 1 ? '' : 's'}`,
  Write: (n) => `wrote ${n} file${n === 1 ? '' : 's'}`,
  Edit: (n) => `edited ${n} file${n === 1 ? '' : 's'}`,
  Bash: (n) => `ran ${n} command${n === 1 ? '' : 's'}`,
  Grep: (n) => `searched the code${n === 1 ? '' : ` ${n} times`}`,
  Glob: (n) => `scanned the files${n === 1 ? '' : ` ${n} times`}`,
  WebSearch: (n) => `searched the web${n === 1 ? '' : ` ${n} times`}`,
  WebFetch: (n) => `read ${n} page${n === 1 ? '' : 's'}`,
  TodoWrite: () => `updated the plan`,
  Task: (n) => `delegated ${n} task${n === 1 ? '' : 's'}`,
};

/** Done-state group header in outcome language ("Read 3 files · ran 2 commands") instead of a raw call count; null when no tool name is recognized. */
export function summarizeToolGroup(toolNames: string[]): string | null {
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const name of toolNames) {
    const key = name === 'MultiEdit' ? 'Edit' : name;
    if (PHRASES[key]) counts.set(key, (counts.get(key) ?? 0) + 1);
    else unknown += 1;
  }
  if (counts.size === 0) return null;
  const parts = Array.from(counts.entries()).slice(0, 3).map(([key, n]) => PHRASES[key](n));
  if (unknown > 0) parts.push(`${unknown} more step${unknown === 1 ? '' : 's'}`);
  const joined = parts.join(' · ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
