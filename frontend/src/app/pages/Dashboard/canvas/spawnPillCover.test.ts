import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { coveredByTiledZones, healthToastAnchor, rectsIntersect } from './spawnPillCover';

// With a chat tiled to the bottom-left quarter, the floating "Ask me anything" pill sat on top of the
// card's own composer, two inputs on one spot (ENG-469). The pill yields to any tile that covers it.
const viewport = { w: 1400, h: 900 };
const fakeZone = (zone: string) => {
  const z: Record<string, { x: number; y: number; w: number; h: number }> = {
    bl: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, tl: { x: 0, y: 0, w: 0.5, h: 0.5 }, right: { x: 0.5, y: 0, w: 0.5, h: 1 },
  };
  const r = z[zone]; return r ? { x: r.x * viewport.w, y: r.y * viewport.h, w: r.w * viewport.w, h: r.h * viewport.h } : null;
};
const pill = { x: 480, y: 830, w: 440, h: 56 };

test('a bottom-left tile covers the pill; a top-left tile does not', () => {
  assert.equal(coveredByTiledZones(['bl'], pill, fakeZone), true);
  assert.equal(coveredByTiledZones(['tl'], pill, fakeZone), false);
});

test('a right-half tile reaches the pill too, an unknown zone is ignored, no tiles means not covered', () => {
  assert.equal(coveredByTiledZones(['right'], pill, fakeZone), true);
  assert.equal(coveredByTiledZones(['nope'], pill, fakeZone), false);
  assert.equal(coveredByTiledZones([], pill, fakeZone), false);
});

test('rectsIntersect is a strict overlap, not a touch', () => {
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 }), true);
});

test('the reconnect pill moves to the top centre only while a tile covers its bottom-left home, and never hides', () => {
  const home = { x: 24, y: 840, w: 420, h: 48 };
  const rects: Record<string, { x: number; y: number; w: number; h: number }> = { bl: { x: 0, y: 450, w: 700, h: 450 }, tr: { x: 700, y: 0, w: 700, h: 450 } };
  const rectFor = (z: string) => rects[z] ?? null;
  assert.deepEqual(healthToastAnchor([], home, rectFor), { vertical: 'bottom', horizontal: 'left' });
  assert.deepEqual(healthToastAnchor(['tr'], home, rectFor), { vertical: 'bottom', horizontal: 'left' });
  assert.deepEqual(healthToastAnchor(['bl'], home, rectFor), { vertical: 'top', horizontal: 'center' });
  assert.deepEqual(healthToastAnchor(['bl'], null, rectFor), { vertical: 'bottom', horizontal: 'left' }, 'unmeasured stays home');
});

test('the toast wires the anchor to the tiled zones, and the capped-table note lives on the widget surface', () => {
  const toast = fs.readFileSync(path.join(process.cwd(), 'src/app/components/overlays/ProviderHealthToast.tsx'), 'utf8');
  assert.ok(toast.includes('anchorOrigin={anchor}') && toast.includes('healthToastAnchor('));
  const view = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/tool-ui/ShowUiWidgetView.tsx'), 'utf8');
  assert.ok(view.includes('className="bg-card text-muted-foreground border border-border border-t-0 rounded-b-xl text-xs"'), 'ENG-474: the note is painted on the tool-ui card surface');
  const chat = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/AgentChat.tsx'), 'utf8');
  assert.equal((chat.match(/<Collapse in appear timeout=\{BROWSER_SLOT_REVEAL_MS\}/g) || []).length, 2, 'ENG-468: both browser-slot mounts grow in');
});
