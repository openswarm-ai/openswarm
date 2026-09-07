import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The runner bundles tests into .test-build, so the sources are read from the mirrored src/ path (the browserSlotSize pin does the same).
const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = here.replace(/([\\/])\.test-build([\\/])/, '$1src$2');
const embedsPath = srcDir + 'InlineSurfaceEmbeds.tsx';
const cardPath = srcDir.replace(/AgentChat[\\/]shell[\\/]$/, 'Dashboard/cards/') + 'DashboardViewCard.tsx';
assert.ok(existsSync(embedsPath), `could not locate InlineSurfaceEmbeds.tsx from ${here}`);
assert.ok(existsSync(cardPath), `could not locate DashboardViewCard.tsx from ${here}`);
const embeds = readFileSync(embedsPath, 'utf8');
const card = readFileSync(cardPath, 'utf8');

// ENG-477: the embed read a thumbnail nothing wrote and said "Preview not captured yet" for the app's whole life.
test('the app embed captures the docked app webview by its registry id and falls back to the stored thumbnail', () => {
  assert.match(embeds, /useBrowserSnapshot\(`app:\$\{outputId\}`, live\)/);
  assert.match(embeds, /const picture = shot \?\? thumbnail;/);
  assert.doesNotMatch(embeds, /app cards never register a webview/, 'the stale premise must not survive in a comment');
});

test('the view card persists a thumbnail when the turn that owns the app ends', () => {
  assert.match(card, /ownerTurnLive/);
  assert.match(card, /dispatch\(updateOutput\(\{ id: output\.id, thumbnail: snap \}\)\)/);
  assert.match(card, /THUMBNAIL_SETTLE_MS = 1500/);
});
