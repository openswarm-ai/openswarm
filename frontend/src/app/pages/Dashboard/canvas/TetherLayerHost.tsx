import React, { useEffect, useState } from 'react';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { useTethers, type TetherInputs, type LiveDragInfo } from '../geometry/dashboardTethers';
import { subscribeLiveDrag } from '../hooks/interaction/liveDragChannel';
import TetherLayer from './TetherLayer';

// The ONE component that re-renders per drag frame: it subscribes to the live-drag channel and
// recomputes just the tether SVG, so a 120Hz card drag costs a handful of paths instead of the
// whole dashboard tree (the ENG-88 input delay).
const TetherLayerHost: React.FC<{ inputs: TetherInputs; c: ClaudeTokens }> = ({ inputs, c }) => {
  const [liveDrag, setLiveDrag] = useState<LiveDragInfo | null>(null);
  // Tethers only exist while something glows AND that something is on the canvas; a DOCKED browser's glow draws no tether (geometry skips docked cards), so dragging its chat must not buy per-frame React either.
  const hasTethers =
    Object.keys(inputs.glowingAgentCards).length > 0 ||
    Object.keys(inputs.glowingBrowserCards).some((bid) => !inputs.browserCards[bid]?.docked_to);
  useEffect(() => {
    if (!hasTethers) { setLiveDrag(null); return undefined; }
    return subscribeLiveDrag(setLiveDrag);
  }, [hasTethers]);
  const tethers = useTethers(inputs, liveDrag);
  return <TetherLayer tethers={tethers} c={c} />;
};

export default React.memo(TetherLayerHost);
