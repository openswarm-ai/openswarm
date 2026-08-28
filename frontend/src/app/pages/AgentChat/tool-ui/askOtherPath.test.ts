// ENG-419, two defects on the AskUI "Other..." path, both reported from production 1.7.9.
//
// 1. INVISIBLE TEXT. `DarkTokensScope` swapped OUR ThemeContext for a subtree (agent cards paint
//    dark even in light mode) but left the MUI ThemeProvider at the app's mode. Measured in real
//    Chromium: text rgb(26,26,24) on card rgb(31,30,27) -- contrast 4 of 255. With the MUI palette
//    swapped alongside: 219. ENG-281 had fixed the same class for the app theme; this subtree
//    escaped it because two providers were expected to agree by convention.
//
// 2. THE BOX APPEARED ONLY AFTER ENTER. The free-text input was gated on `flowAnswers`, which is
//    set from `onComplete` -- i.e. after the whole flow is committed. Picking "Other..." reported
//    nothing outward, so the field the user was told to type into did not exist yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const themeCtx = fs.readFileSync(path.join(root, 'src/shared/styles/ThemeContext.tsx'), 'utf8');
const card = fs.readFileSync(path.join(root, 'src/app/pages/AgentChat/tool-ui/AskQuestionCard.tsx'), 'utf8');
const flow = fs.readFileSync(path.join(root, 'src/toolui/components/question-flow/question-flow.tsx'), 'utf8');

test('a dark-tokens subtree swaps the MUI palette too', () => {
  const i = themeCtx.indexOf('export const DarkTokensScope');
  const body = themeCtx.slice(i, i + 1200);
  assert.ok(body.includes('buildMuiTheme('), 'our tokens and MUI must move together');
  assert.ok(body.includes('<MuiThemeProvider'), 'the subtree needs its own MUI provider');
  assert.ok(body.includes("'dark'"), 'and it must be built dark, matching the tokens');
});

test('the theme builder is shared, not duplicated', () => {
  // A second copy would drift, and the drift IS this bug.
  const main = fs.readFileSync(path.join(root, 'src/app/Main.tsx'), 'utf8');
  assert.ok(main.includes("from '@/shared/styles/muiTheme'"));
  assert.ok(!/function buildMuiTheme/.test(main), 'Main.tsx must not keep its own copy');
});

test('picking an option reports outward before the flow is committed', () => {
  // TWO handleToggles exist. AskQuestionCard passes `steps`, so QuestionFlow dispatches to the
  // UPFRONT variant, whose toggle is the LAST one in the file. Anchoring on the first found the
  // progressive variant's, which this path never renders -- a green test over dead code.
  const i = flow.lastIndexOf('const handleToggle');
  const body = flow.slice(i, i + 900);
  assert.ok(body.includes('onSelectionChange?.('), 'the live toggle must be observable');
  assert.ok(flow.includes('<QuestionFlowUpfront'), 'and that is the variant `steps` selects');
});

test('the callback is additive: onComplete still drives submission', () => {
  assert.ok(flow.includes('onComplete?.(answers)'), 'the existing contract is untouched');
  assert.ok(card.includes('onComplete: (answers: Record<string, string[]>)'));
});

test('the free-text box appears on selection, not on completion', () => {
  assert.ok(card.includes('{pendingOther.length > 0 && ('), 'gated on live selection');
  assert.ok(card.includes('const otherSteps = flowAnswers ?? liveAnswers;'));
});

test('it does not steal focus while the flow is still on screen', () => {
  // autoFocus fires on every render of the field; mid-flow that yanks focus off the option list.
  assert.ok(card.includes('autoFocus={flowAnswers !== null}'), 'focus only once the flow is gone');
});

test('Submit and Back only exist once the flow is committed', () => {
  // Mid-flow a Submit could truncate a multi-step flow, and Back (which clears flowAnswers) would
  // be a no-op button sitting under a live flow.
  const i = card.indexOf('{pendingOther.length > 0 && (');
  const block = card.slice(i, card.indexOf('{!flowAnswers && (', i));
  assert.ok(block.includes('{flowAnswers !== null && ('), 'the buttons are gated');
  const iBtn = block.indexOf('{flowAnswers !== null && (');
  assert.ok(block.indexOf('Submit') > iBtn, 'Submit sits inside that gate');
  assert.ok(block.includes('submit(flowAnswers)'), 'and submits the committed answers');
});
