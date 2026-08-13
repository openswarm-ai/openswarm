// Run: npm test (frontend/scripts/run-tests.mjs)
//
// ENG-231. Cmd+A inside a chat used to select every card on the canvas, so the next Backspace
// deleted the board instead of copying a conversation. Eric's rule: the whole page is right when
// you are on the canvas, but when you are clicked into a chat it should take that chat's contents,
// tool outputs and images included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAllTarget } from './selectAllTarget.ts';

// Minimal element stand-ins: closest() is the only DOM behaviour the decision depends on.
function el(tag: string, opts: { editable?: boolean; inTranscript?: HTMLElement | null } = {}): Element {
  const transcript = opts.inTranscript ?? null;
  return {
    tagName: tag,
    isContentEditable: opts.editable === true,
    closest: (sel: string) => (sel.includes('data-chat-transcript') ? transcript : null),
  } as unknown as Element;
}

const TRANSCRIPT = { tagName: 'DIV' } as unknown as HTMLElement;

test('a text field keeps native select-all, so typing is never hijacked', () => {
  for (const tag of ['INPUT', 'TEXTAREA']) {
    assert.equal(selectAllTarget(el(tag)).scope, 'native', `${tag} must keep native behaviour`);
  }
  assert.equal(selectAllTarget(el('DIV', { editable: true })).scope, 'native', 'contenteditable too');
});

test('focus inside a chat scopes the selection to that chat', () => {
  const d = selectAllTarget(el('DIV', { inTranscript: TRANSCRIPT }));
  assert.equal(d.scope, 'transcript');
  assert.equal(d.transcript, TRANSCRIPT, 'must hand back the transcript it found, not just a flag');
});

test('a text field INSIDE a chat still wins: you are typing, not reading', () => {
  const d = selectAllTarget(el('TEXTAREA', { inTranscript: TRANSCRIPT }));
  assert.equal(d.scope, 'native', 'the composer sits inside the chat; Cmd+A there is text selection');
});

test('the canvas keeps the original select-every-card behaviour', () => {
  const d = selectAllTarget(el('DIV'));
  assert.equal(d.scope, 'cards');
  assert.equal(d.transcript, null);
});

test('a missing or exotic target degrades to the canvas rather than throwing', () => {
  assert.equal(selectAllTarget(null).scope, 'cards');
  // An element with no closest() (some SVG/shadow hosts) must not crash the shortcut.
  const odd = { tagName: 'DIV' } as unknown as Element;
  assert.equal(selectAllTarget(odd).scope, 'cards');
});

test('every scope is reachable, so the decision is not secretly one-armed', () => {
  const seen = new Set([
    selectAllTarget(el('INPUT')).scope,
    selectAllTarget(el('DIV', { inTranscript: TRANSCRIPT })).scope,
    selectAllTarget(el('DIV')).scope,
  ]);
  assert.equal(seen.size, 3, `only reached ${[...seen].join(', ')}`);
});

// --- Eric, 2026-08-13: "Cmd+A in a fullscreen chat seems to do nothing." ---
//
// The first cut sent every text field to native select-all. A fullscreen chat AUTOFOCUSES its
// composer and the composer sits OUTSIDE [data-chat-transcript], so focus was in an empty text box,
// native select-all selected nothing, and the shortcut looked dead. That is the common path, not a
// corner: the user has to click into the transcript first to get the documented behaviour.

/** A composer: a text field beside its transcript, both under one [data-chat-root]. */
function composer(value: string, transcript: HTMLElement | null): Element {
  const root = {
    querySelector: (sel: string) => (sel.includes('data-chat-transcript') ? transcript : null),
  };
  return {
    tagName: 'TEXTAREA',
    isContentEditable: false,
    value,
    closest: (sel: string) => (sel.includes('data-chat-root') ? root : null),
  } as unknown as Element;
}

test('an EMPTY composer scopes Cmd+A to its own chat instead of doing nothing', () => {
  const d = selectAllTarget(composer('', TRANSCRIPT));
  assert.equal(d.scope, 'transcript', 'an empty composer left the shortcut dead in a fullscreen chat');
  assert.equal(d.transcript, TRANSCRIPT, 'selected the wrong chat, or none');
});

test('a composer WITH a draft keeps native select-all, so typing is never hijacked', () => {
  const d = selectAllTarget(composer('half a message', TRANSCRIPT));
  assert.equal(d.scope, 'native', 'stole Cmd+A from a user who was mid-sentence');
  assert.equal(d.transcript, null);
});

test('an empty text field with no chat around it stays native', () => {
  const d = selectAllTarget(composer('', null));
  assert.equal(d.scope, 'native', 'a search box outside any chat must not select a transcript');
});
