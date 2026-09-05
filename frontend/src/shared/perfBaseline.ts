// Drill seam for interleaved A/B runs on one live board. `localStorage.setItem('osw.perf.baseline', '1')`
// restores every pre-fix behaviour; a comma list names the fixes to switch off, so one arm can isolate one
// change ('gesture': the 2026-09-02 transcript measure + stream flush; 'ambient': the pill artifact cap +
// the ShowUI memo boundaries). Read once per page load, so flipping an arm is a reload, never a rebuild.
export type PerfFix = 'gesture' | 'ambient';
let p_cached: Set<string> | null = null;
function p_flags(): Set<string> {
  if (p_cached === null) {
    try {
      const raw = (localStorage.getItem('osw.perf.baseline') || '').trim();
      p_cached = new Set(raw === '1' ? ['gesture', 'ambient'] : raw ? raw.split(',').map((s) => s.trim()) : []);
    } catch {
      p_cached = new Set();
    }
  }
  return p_cached;
}
export function perfBaselineFor(fix: PerfFix): boolean {
  return p_flags().has(fix);
}
export function perfBaseline(): boolean {
  return perfBaselineFor('gesture');
}
