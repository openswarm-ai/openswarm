// A chat cut off mid-turn was invisible from the board: the only recovery affordance was a Resume
// pill inside the opened card, so Eric read a restored board as "agents aren't even running"
// (ENG-321). These pin the board-level signal and its one-click resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const here = path.join(process.cwd(), 'src/app/pages/Dashboard/desktop');
const pill = fs.readFileSync(path.join(here, 'AgentNarratorPill.tsx'), 'utf8');
const card = fs.readFileSync(path.join(here, '../cards/AgentCard.tsx'), 'utf8');

test('interrupted wins the artifact ladder so nothing hides it', () => {
  const key = pill.slice(pill.indexOf('const artifactKey'), pill.indexOf(';', pill.indexOf('const artifactKey')));
  assert.ok(key.includes("interrupted ? 'interrupted'"), 'a browser shot or old answer must not out-rank the owed-response signal');
  assert.ok(pill.includes('{interrupted ? ('), 'the chip must render at the ladder top');
});

test('the chip resumes with one click and does not select the card', () => {
  const chip = pill.slice(pill.indexOf('{interrupted ? ('), pill.indexOf(') : liveAsk ? ('));
  assert.ok(chip.includes('onResumeInterrupted?.()'), 'a signal without the action is half the fix');
  assert.ok(chip.includes('stopPropagation'), 'the click must not fall through to card-select');
  assert.ok(chip.includes('Interrupted'), 'the compact chip names the state in one word (Eric: the wrapping box read ugly)');
  assert.ok(chip.includes('whiteSpace'), 'one line, never a wrapping paragraph');
});

test('the card derives interrupted from stopped AND an unanswered user message', () => {
  const cond = card.slice(card.indexOf('const pillInterrupted'), card.indexOf('const handleResumeInterrupted'));
  assert.ok(cond.includes("session.status !== 'stopped' || session.workflow_run_id"), 'run sidecars own pause/resume from the workflow card');
  // The 2026-08-17 board: bare status==stopped lit the chip on EVERY old/deliberately-stopped
  // session at once; only a chat whose last visible word is the USER'S owes a resume.
  assert.ok(cond.includes("last.role === 'user'"), 'a chat the assistant finished answering owes nothing');
  assert.ok(cond.includes('!m.hidden'), 'hidden harness nudges must not make a finished chat look owed');
  assert.ok(card.includes('interrupted={pillInterrupted}'), 'wire-check: the flag must reach the pill');
  assert.ok(card.includes('onResumeInterrupted={handleResumeInterrupted}'));
});

test('the resume dispatch is the same hidden continue the in-card button sends', () => {
  const start = card.indexOf('handleResumeInterrupted');
  const h = card.slice(start, card.indexOf('}, [dispatch, session.id', start));
  assert.ok(h.includes('hidden: true'), 'a visible synthetic prompt would litter the transcript');
  assert.ok(h.includes('pick up mid-sentence'), 'keep the proven continue prompt, not a new dialect');
});
