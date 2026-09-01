// Clicking a widget link from a FULLSCREEN chat used to look like a broken click: the chat dropped
// fullscreen for a frame ("glitches"), the browser card landed on the canvas behind it, and the page
// only appeared later when the user left fullscreen by hand. ENG-234 fixed the card being invisible;
// it did not fix WHERE the card goes.
//
// The rule this codebase already applies for apps (AppShell.navigateToApp): while something is
// fullscreen, opening a new thing SWAPS the fullscreen to it, because otherwise the new card lands
// invisibly behind. The reducer evicts any other fullscreen in the same write, so the swap is atomic
// and there is no un-tiled frame for anything to race with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import reducer, { addBrowserCard, setTiledCard } from '../../../../shared/state/dashboardLayoutSlice';

const SRC = readFileSync('src/app/pages/AgentChat/tool-ui/useOpenUrlInBrowserCard.ts', 'utf8');

test('the hook swaps fullscreen instead of dropping it', () => {
  assert.match(SRC, /setTiledCard\(\{ cardId: openedId, zone: 'fullscreen' \}\)/,
    'a link opened from fullscreen must put the BROWSER in the fullscreen slot');
  assert.doesNotMatch(SRC, /clearTiledCard/,
    'dropping fullscreen is what left the page hidden behind the chat');
});

test('it only swaps when something WAS fullscreen (a normal click must not tile)', () => {
  const gate = SRC.indexOf('if (!wasFullscreen) return;');
  const swap = SRC.indexOf('setTiledCard(');
  assert.ok(gate > 0 && gate < swap, 'the non-fullscreen path must return before tiling anything');
});

test('a browser card is a tileable owner, so the swap is not a silent no-op', () => {
  // setTiledCard refuses ids it does not recognise (tileOwnerExists). If browserCards were not in
  // that list the fix would dispatch, change nothing, and look exactly like the bug it replaced.
  let s = reducer(undefined, { type: '@@init' });
  s = reducer(s, addBrowserCard({ url: 'https://example.com' }));
  const id = s.pendingFocusBrowserId as string;
  s = reducer(s, setTiledCard({ cardId: id, zone: 'fullscreen' }));
  assert.equal(s.tiledCards[id], 'fullscreen', 'the browser card must actually take the slot');
});

test('the swap evicts the previous fullscreen in one write (what makes it atomic)', () => {
  let s = reducer(undefined, { type: '@@init' });
  s = reducer(s, addBrowserCard({ url: 'https://first.example' }));
  const first = s.pendingFocusBrowserId as string;
  s = reducer(s, setTiledCard({ cardId: first, zone: 'fullscreen' }));
  assert.equal(s.tiledCards[first], 'fullscreen');
  s = reducer(s, addBrowserCard({ url: 'https://second.example' }));
  const second = s.pendingFocusBrowserId as string;
  s = reducer(s, setTiledCard({ cardId: second, zone: 'fullscreen' }));
  assert.equal(s.tiledCards[second], 'fullscreen');
  assert.equal(s.tiledCards[first], undefined,
    'two fullscreen cards at once would be the invisible-card bug all over again');
});

test('addBrowserCard hands the new id back through pendingFocusBrowserId', () => {
  let s = reducer(undefined, { type: '@@init' });
  s = reducer(s, addBrowserCard({ url: 'https://example.com' }));
  const id = s.pendingFocusBrowserId;
  assert.ok(id && s.browserCards[id], 'the hook has no other handle on the card it just created');
});
