// The dashboard the user is currently on, mirrored to a window global so low-level non-React code (the addBrowserCard reducer) can tag a new browser card with its home dashboard at birth, instead of the card leaking onto every dashboard until the first layout save.
const WINDOW_KEY = '__openswarm_last_dashboard_id';

export function setLastDashboardId(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) (window as any)[WINDOW_KEY] = id;
  else delete (window as any)[WINDOW_KEY];
}

export function getLastDashboardId(): string | null {
  if (typeof window === 'undefined') return null;
  return ((window as any)[WINDOW_KEY] as string) || null;
}
