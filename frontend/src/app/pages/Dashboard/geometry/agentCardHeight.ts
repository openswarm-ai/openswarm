import { renderedAgentCardHeight } from '@/shared/state/dashboardLayoutSlice';

/**
 * A chat card's real on-screen height: what the DOM measured, else the stored envelope.
 *
 * The tether layer and the sibling restack each grew their own version of this and disagreed on the
 * expanded case (the restack ignored the measured value), so the arrow anchored where the card was
 * not and the stack cursor left siblings overlapping. One formula, so they cannot drift (ENG-412).
 */
export function agentCardHeight(
  id: string,
  storedHeight: number,
  expanded: boolean,
  measured: Record<string, number> | null,
): number {
  const m = measured?.[id];
  // A zero reading is a card mid-mount, not a flat card.
  return m && m > 0 ? m : renderedAgentCardHeight(storedHeight, expanded);
}
