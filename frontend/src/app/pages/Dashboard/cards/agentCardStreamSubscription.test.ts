import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The collapsed card paints a 120-character preview, but it used to subscribe to the whole streaming
// entry, so every token of a long answer re-rendered all 1,464 lines of AgentCard, for every
// streaming card at once. AgentChat had already fixed the same problem one layer down by taking the
// message id and letting a leaf own the text (AgentChat.tsx, "never to the content"); this card
// never got the treatment, which is why a board of streaming agents felt sluggish.
//
// Found by asking an agent the vague question "the canvas feels sluggish when cards are streaming",
// then verifying its answer against the source, 2026-08-30.
const here = path.join(process.cwd(), 'src/app/pages/Dashboard/cards');
const src = fs.readFileSync(path.join(here, 'AgentCard.tsx'), 'utf8');

test('the card never subscribes to the whole streaming entry', () => {
  assert.doesNotMatch(src, /useStreamingMessage\(/,
    'useStreamingMessage returns the entry INCLUDING content, so every delta re-renders the card');
  assert.doesNotMatch(src, /from '@\/shared\/state\/streamingSlice'/,
    'the whole-entry hook should no longer be imported here');
});

test('it projects to what is painted, and compares shallowly', () => {
  assert.match(src, /const stream = useAppSelector\(/, 'a projected selector must replace it');
  assert.match(src, /shallowEqual\)/, 'the projection needs shallowEqual or it re-renders on every tick anyway');
  assert.match(src, /import \{ shallowEqual \} from 'react-redux';/);
  // The projection must slice INSIDE the selector. Slicing after the fact still hands the component
  // a new full string every token, which is the bug wearing a hat.
  const sel = src.slice(src.indexOf('const stream = useAppSelector('), src.indexOf('const isStreaming = stream.on;'));
  assert.match(sel, /slice\(0, PREVIEW_CHARS\)/, 'the slice belongs inside the selector');
  assert.doesNotMatch(sel, /m\.content(?!\s*\|\|)/, 'the raw body must not escape the selector');
});

test('the preview length has ONE definition', () => {
  assert.match(src, /const PREVIEW_CHARS = 120;/);
  // Two copies of a boundary is how the subscription and the paint drift apart.
  assert.equal((src.match(/slice\(0, 120\)/g) || []).length, 0,
    'no bare 120 literals should remain; they must all read PREVIEW_CHARS');
});
