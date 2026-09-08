export interface HealModel { value: string; label: string; billing_kind?: string }

/** Where a chat pinned to a retired model is moved, or null when nothing of the user's own is reachable
 * this tick. On 1.7.9 a dead Claude login left only the funded Haiku row in the list and every chat was
 * rewritten onto it (install 59a37510, 2026-09-03: three chats, then "No credentials for provider: claude"
 * on a model nobody picked). A free row is a face for the picker, never a home for someone's chat. */
export function healTarget(
  reachable: HealModel[],
  defaultModel: string,
  fallback: { value: string; label: string } | null,
): { value: string; label: string } | null {
  if (!reachable.some((m) => m.billing_kind !== 'free')) return null;
  const current = reachable.find((m) => m.value === defaultModel);
  if (current) return { value: current.value, label: current.label };
  return fallback;
}
