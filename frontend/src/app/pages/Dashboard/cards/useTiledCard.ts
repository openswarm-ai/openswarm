import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { registerTiledCard, subscribeTiledWorkspace, unregisterTiledCard, zoneRect, type Camera } from '../canvas/tiledGeometry';

export interface TiledSize {
  width: number;
  height: number;
}

interface TiledCardArgs {
  cardId: string;
  zone: string | undefined;
  /** False while the card is parked (minimized, docked, kept alive off-screen), where React owns geometry outright. */
  active: boolean;
  /** The card's canvas-space left/top exactly as React renders it, tiled or not. */
  originX: number;
  originY: number;
  getCamera: () => Camera;
}

// Hands back the card's tiled SIZE and nothing else. The camera-dependent half of the rect is
// written by canvas/tiledGeometry alone, so a tile can never be pinned to one camera while the
// canvas paints another.
export function useTiledCard({ cardId, zone, active, originX, originY, getCamera }: TiledCardArgs): TiledSize | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const cameraRef = useRef(getCamera);
  cameraRef.current = getCamera;
  const on = !!zone && active;

  // Becoming ACTIVE while a zone is already set is the from-the-rail path: the card was hidden and
  // is materialising straight into a tile, so the enter glide has no visible start point and must be
  // skipped. Zone set while already active is the normal path and keeps its glide.
  const prevActiveRef = useRef(active);
  const instantRef = useRef(false);
  if (active && !prevActiveRef.current && !!zone) instantRef.current = true;
  prevActiveRef.current = active;

  useEffect(() => (on ? subscribeTiledWorkspace(bump) : undefined), [on]);

  useLayoutEffect(() => {
    if (!on || !zone) return undefined;
    const instant = instantRef.current;
    instantRef.current = false;
    registerTiledCard(cardId, zone, { x: originX, y: originY }, cameraRef.current(), { instant });
    return () => unregisterTiledCard(cardId);
  }, [on, zone, cardId, originX, originY]);

  if (!on || !zone) return null;
  const r = zoneRect(zone);
  return r ? { width: r.w, height: r.h } : null;
}
