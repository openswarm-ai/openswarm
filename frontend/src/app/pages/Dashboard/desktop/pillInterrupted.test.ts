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
  assert.ok(chip.includes('Stopped mid-task'), "copy must stay true for user-stop too; 'stopped' has no persisted cause");
});

test('the card derives interrupted from stopped, workflow sidecars excluded', () => {
  assert.ok(card.includes("session.status === 'stopped' && !session.workflow_run_id"), 'run sidecars own pause/resume from the workflow card');
  assert.ok(card.includes('interrupted={pillInterrupted}'), 'wire-check: the flag must reach the pill');
  assert.ok(card.includes('onResumeInterrupted={handleResumeInterrupted}'));
});

test('the resume dispatch is the same hidden continue the in-card button sends', () => {
  const start = card.indexOf('handleResumeInterrupted');
  const h = card.slice(start, card.indexOf('}, [dispatch, session.id', start));
  assert.ok(h.includes('hidden: true'), 'a visible synthetic prompt would litter the transcript');
  assert.ok(h.includes('pick up mid-sentence'), 'keep the proven continue prompt, not a new dialect');
});
