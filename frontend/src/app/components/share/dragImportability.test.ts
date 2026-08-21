import { test } from 'node:test';
import assert from 'node:assert/strict';

import { firstImportable, judgeDrag, looksImportable } from './dragImportability';

test('looksImportable accepts the three bundle extensions and nothing else', () => {
  assert.equal(looksImportable('board.swarm'), true);
  assert.equal(looksImportable('NOTES.MD'), true);
  assert.equal(looksImportable('skills.zip'), true);
  assert.equal(looksImportable('Screenshot 2026-08-20 at 11.40.31 AM.png'), false);
  assert.equal(looksImportable('board.swarm.png'), false);
  assert.equal(looksImportable(''), false);
});

test('judgeDrag rules a screenshot out while it is still in the air', () => {
  assert.equal(judgeDrag(['Files'], ['image/png']), 'unsupported');
  assert.equal(judgeDrag(['Files', 'text/uri-list'], ['application/pdf']), 'unsupported');
  assert.equal(judgeDrag(['Files'], ['image/png', 'video/mp4']), 'unsupported');
});

test('judgeDrag keeps the door open for anything that could be a bundle', () => {
  assert.equal(judgeDrag(['Files'], ['']), 'importable', 'a .swarm has no MIME type');
  assert.equal(judgeDrag(['Files'], ['application/zip']), 'importable');
  assert.equal(judgeDrag(['Files'], ['text/markdown']), 'importable');
  assert.equal(judgeDrag(['Files'], []), 'importable', 'a browser that hides item types must not block the drop');
  assert.equal(judgeDrag(['Files'], ['image/png', '']), 'importable', 'a mixed drag still carries one candidate');
});

test('judgeDrag ignores drags that carry no files at all', () => {
  assert.equal(judgeDrag(['text/plain'], []), 'no-files');
  assert.equal(judgeDrag([], []), 'no-files');
});

test('firstImportable skips past the foreign files to the bundle', () => {
  const png = { name: 'shot.png' } as File;
  const swarm = { name: 'board.swarm' } as File;
  assert.equal(firstImportable([png, swarm]), swarm);
  assert.equal(firstImportable([png]), null);
  assert.equal(firstImportable([]), null);
});
