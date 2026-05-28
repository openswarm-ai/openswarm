interface PreviewSortable {
  preview_updated_at?: string | null;
  created_at: string;
}

/**
 * Newest screenshot first. Apps/dashboards never screenshotted yet fall back to
 * their creation time, so they hold a stable spot until their first shot instead
 * of jumping around on every incidental save.
 */
export function byPreviewRecency(a: PreviewSortable, b: PreviewSortable): number {
  const ka = a.preview_updated_at || a.created_at;
  const kb = b.preview_updated_at || b.created_at;
  return new Date(kb).getTime() - new Date(ka).getTime();
}
