import type { ImportPreflight } from './shareTypes';

// A Get on a named, labelled listing is already the user's decision, the way the App Store treats
// a tap on GET; a second sheet that everyone clicks through protects nobody. The only things worth
// a stop are a review that BLOCKS (not the import-allowlist warnings every real app trips) and a
// need the user must supply by hand (a key, a connector). A dropped file keeps importNeedsConfirm.
export function marketplaceNeedsConfirm(pf: ImportPreflight): boolean {
  const blocked = !!pf.review && pf.review.verdict === 'block';
  const needsHand = pf.summary.requirements.some((r) => r.kind === 'api_key' || r.kind === 'mcp_action');
  return blocked || needsHand;
}
