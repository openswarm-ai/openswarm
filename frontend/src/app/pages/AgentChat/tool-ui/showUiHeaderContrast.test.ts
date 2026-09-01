// The ShowUI host header (ENG-227) renders an agent-supplied title/description ABOVE a vendored
// card. It set size and weight but no COLOUR, so it inherited whatever the ancestor carried: on a
// light-mode app the inherited text is near-black, and the card underneath is dark, which is a
// title you can only find by selecting it (Eric's screenshot, 2026-08-31).
//
// Same class as ENG-419: a surface that fixes its own background owes its text an explicit token in
// the same place. Inheriting is the bug, not the styling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/app/pages/AgentChat/tool-ui/ShowUiWidgetView.tsx', 'utf8');
// The header block only; the rest of the file legitimately has uncoloured wrappers.
const HEADER = SRC.slice(SRC.indexOf('if (!title && !desc) return widget;'), SRC.indexOf('return widget;', SRC.indexOf('if (!title && !desc)') + 40));

test('the host header title sets its own colour from the theme', () => {
  const title = HEADER.slice(HEADER.indexOf('{title &&'), HEADER.indexOf('{desc &&'));
  assert.match(title, /color:\s*c\.text\.primary/, 'the title must not inherit its colour');
});

test('the description does too, and does not fake contrast with opacity', () => {
  const desc = HEADER.slice(HEADER.indexOf('{desc &&'));
  assert.match(desc, /color:\s*c\.text\.secondary/, 'the description must not inherit its colour');
  assert.doesNotMatch(desc, /opacity:/,
    'opacity over an inherited colour keeps the bug and only dims it; use the secondary token');
});

test('the tokens actually come from the theme hook, not a literal', () => {
  assert.match(SRC, /useClaudeTokens/, 'the component must read live theme tokens');
  assert.doesNotMatch(HEADER, /color:\s*['"#]/, 'no hardcoded colour: it would break the other mode');
});
