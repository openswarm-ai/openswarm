// The grab strips at a card's edges, shared by every card that can be resized (ENG-290).
//
// This table used to live in four files byte-for-byte, each with its own copy of the direction
// union and the cursor map. One home means the invariant below can be stated once and tested.
//
// THE INVARIANT: no offset may be negative. Every card root paints with `overflow: hidden`, so
// anything hanging outside the card is clipped away and cannot be clicked. The handles used to be
// centred on the border (`-EDGE / 2`), which looked like a 6px grab band and was really a 3px one,
// and at a zoomed-out canvas that is about two screen pixels. Measured live on 1.7.8-exp.4: the
// bottom and right handles were not hittable at their own centre at all (6/8), and anchoring them
// fully inside took it to 8/8 with the bottom edge going from partly clipped to 4px of 4px.
//
// Losing the outside half costs nothing, because the outside half was never there.
import React from 'react';

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGE = 6;
const CORNER = 14;

export const RESIZE_CURSOR: Record<ResizeDir, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
};

export interface ResizeHandleDef {
  dir: ResizeDir;
  css: React.CSSProperties;
}

export const RESIZE_HANDLE_DEFS: ResizeHandleDef[] = [
  { dir: 'n', css: { top: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: 's', css: { bottom: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: 'w', css: { left: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: 'e', css: { right: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: 'nw', css: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { dir: 'ne', css: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { dir: 'sw', css: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
  { dir: 'se', css: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
];
