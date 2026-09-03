// Drill seam for interleaved A/B runs on one live board: `localStorage.setItem('osw.perf.baseline', '1')`
// restores the pre-2026-09-02 gesture behaviour (measure transcript heights on every commit, flush every
// held stream in the same tick). Read once per page load, so flipping an arm is a reload, never a rebuild.
let p_cached: boolean | null = null;

export function perfBaseline(): boolean {
  if (p_cached === null) {
    try {
      p_cached = localStorage.getItem('osw.perf.baseline') === '1';
    } catch {
      p_cached = false;
    }
  }
  return p_cached;
}
