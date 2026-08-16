// ENG-318: autofocus framed the STORED rect while an expanded chat renders >= EXPANDED_CARD_MIN_H
// tall plus a 64px title bubble above, so the camera landed with the card's bottom off-screen and
// the title beheaded. The correction existed as scattered Math.max copies; these pin the one shared
// helper and that the camera paths read the full framing envelope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXPANDED_CARD_MIN_H,
  EXPANDED_HEADER_H,
  renderedAgentCardHeight,
} from '@/shared/state/dashboardLayoutSlice';

test('an expanded chat is never shorter than the overlay minimum', () => {
  assert.equal(renderedAgentCardHeight(280, true), EXPANDED_CARD_MIN_H);
  assert.equal(renderedAgentCardHeight(900, true), 900);
});

test('a collapsed chat keeps its stored height untouched', () => {
  assert.equal(renderedAgentCardHeight(280, false), 280);
  assert.equal(renderedAgentCardHeight(56, false), 56);
});

const here = path.join(process.cwd(), 'src/app/pages/Dashboard/geometry');
const read = (rel: string): string => fs.readFileSync(path.join(here, rel), 'utf8');

test('getCardRect frames the rendered envelope, header included', () => {
  const src = read('./getCardRect.ts');
  assert.ok(src.includes('renderedAgentCardHeight(card.height, true)'), 'expanded height must be the rendered one');
  assert.ok(src.includes('card.y - EXPANDED_HEADER_H'), 'the title bubble above the card must be inside the frame');
});

test('the reveal paths frame through getCardRect, not raw store rects', () => {
  // These two sites shipped the bug: history-resume and sidebar-focus flew to a 280px lie.
  const actions = read('../hooks/lifecycle/useDashboardCardActions.ts');
  const resume = actions.slice(actions.indexOf('handleHistoryResume'), actions.indexOf('handleFitToView'));
  assert.ok(resume.includes("getCardRect(sessionId, 'agent')"), 'history-resume must frame the envelope');
  assert.ok(!resume.includes('height: card.height'), 'the raw store rect is the bug');

  const lifecycle = read('../hooks/lifecycle/useDashboardLifecycle.ts');
  const focusStart = lifecycle.indexOf('pendingFocusAgentId || !layoutInitialized');
  const focus = lifecycle.slice(focusStart, lifecycle.indexOf('pendingFocusBrowserId', focusStart));
  assert.ok(focus.includes("getCardRect(agentId, 'agent')"), 'sidebar-focus must frame the envelope');
  assert.ok(!focus.includes('height: card.height'), 'the raw store rect is the bug');
});

test('the header constant has exactly one home', () => {
  const actions = read('../hooks/lifecycle/useDashboardCardActions.ts');
  assert.ok(!actions.includes('EXPANDED_HEADER_H = 64'), 'local copies drift');
  assert.equal(EXPANDED_HEADER_H, 64);
});
