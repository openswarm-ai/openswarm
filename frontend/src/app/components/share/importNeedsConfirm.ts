import type { ImportPreflight } from './shareTypes';

// A bundle needs a confirm when it can run code (an app), wants actions connected, failed review, or installs a skill: a skill lands in ~/.claude/skills and rides every future agent turn, so nothing may put one there without the user seeing what it is (ENG-376). Everything else is inert data and imports straight away.
export function importNeedsConfirm(pf: ImportPreflight): boolean {
  const s = pf.summary;
  const hasApp = s.root.type === 'app' || s.includes.some((i) => i.type === 'app');
  const hasSkill = s.root.type === 'skill' || s.includes.some((i) => i.type === 'skill');
  const hasAction = s.requirements.some((r) => r.kind === 'mcp_action');
  const risky = !!pf.review && pf.review.verdict !== 'clean';
  return hasApp || hasSkill || hasAction || risky;
}
