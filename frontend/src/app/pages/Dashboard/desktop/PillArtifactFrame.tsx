import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';

/** Widest and narrowest a collapsed artifact may get dragged to. */
const MIN_W = 240;
const MAX_W = 900;
/** Anything with no family rule: the old fixed pill width, so nothing narrows unexpectedly. */
const DEFAULT_W = 320;

// A table at 320px wraps every column into unreadable slivers, while a weather card at 520px is
// mostly empty. So the resting width follows what the widget IS, matched against the component
// name the payload already carries. Ordered, first match wins.
const FAMILY_WIDTHS: Array<[RegExp, number]> = [
  [/table|chart|gallery|carousel|terminal|code|diff/i, 560],
  [/map|image|video|post/i, 460],
  [/stats|plan|links|order|preferences/i, 380],
];

export function defaultWidthFor(name: string): number {
  for (const [re, w] of FAMILY_WIDTHS) if (re.test(name)) return w;
  return DEFAULT_W;
}

// Keyed by COMPONENT, not by session: having sized a table once, you want every table that way,
// and a per-session key would make the drag feel like it never stuck.
const storageKey = (name: string): string => `osw.artifactWidth.${name}`;

function storedWidth(name: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey(name));
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? Math.min(Math.max(n, MIN_W), MAX_W) : null;
  } catch { return null; }   // private mode / quota: fall back to the family default
}

interface Props {
  /** Component name off the payload; picks the resting width and the persistence key. */
  name: string;
  children: React.ReactNode;
}

/**
 * The collapsed card's artifact holder: sizes itself to the widget family, lets the user drag that
 * width, and keeps the widget INTERACTIVE.
 *
 * The interactivity is the subtle half. The pill host owns pointerdown (to drag the card) and the
 * card owns click/dblclick (select, expand), so every click that landed on a sort button inside a
 * table also expanded the card, which is the opposite of what a control is for. Stopping those
 * three here means the widget behaves like a widget; the card still drags by its pill and its
 * chrome, which is what a user actually aims at to move it.
 */
function PillArtifactFrame({ name, children }: Props): React.ReactElement {
  const [width, setWidth] = useState<number>(() => storedWidth(name) ?? defaultWidthFor(name));
  // A different widget arriving in the same card is a different thing to size.
  useEffect(() => { setWidth(storedWidth(name) ?? defaultWidthFor(name)); }, [name]);

  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onHandleDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startW: width };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
  }, [width]);

  const onHandleMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    setWidth(Math.min(Math.max(d.startW + (e.clientX - d.startX), MIN_W), MAX_W));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.stopPropagation();
    try { window.localStorage.setItem(storageKey(name), String(width)); } catch { /* nothing to do if storage is full */ }
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }, [name, width]);

  return (
    <Box
      // The "dark" class scopes the vendored tool-ui theme: pill artifacts always sit on the dark glass surface, so a light widget card here read as a white slab.
      className="osw-artifact dark"
      onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      onDoubleClick={(e: React.MouseEvent) => e.stopPropagation()}
      sx={{ position: 'relative', width, maxWidth: '90vw', '&:hover .osw-artifact-grip': { opacity: 1 } }}
    >
      {children}
      <Box
        className="osw-artifact-grip"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        sx={{
          position: 'absolute',
          top: 0,
          right: -3,
          width: 10,
          height: '100%',
          cursor: 'ew-resize',
          opacity: 0,
          transition: 'opacity 140ms ease',
          touchAction: 'none',
          // The visible grip is a thin bar centred in a wider hit area: easy to grab, quiet to look at.
          '&::after': {
            content: '""',
            position: 'absolute',
            top: '50%',
            left: 3,
            width: 3,
            height: 34,
            marginTop: '-17px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.45)',
          },
        }}
      />
    </Box>
  );
}

export default PillArtifactFrame;
