// Run: node --test frontend/src/shared/getCachePolicy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bypassesGetCache, mutationClearsGetCache } from './getCachePolicy.ts';

test('no-store and reload bypass the dedupe cache; the defaults do not', () => {
  assert.equal(bypassesGetCache('no-store'), true);
  assert.equal(bypassesGetCache('reload'), true);
  assert.equal(bypassesGetCache('default'), false);
  assert.equal(bypassesGetCache('force-cache'), false);
  assert.equal(bypassesGetCache(undefined), false);
});

test('every mutation clears the GET cache; reads never do', () => {
  for (const m of ['POST', 'post', 'PATCH', 'PUT', 'DELETE']) assert.equal(mutationClearsGetCache(m), true, m);
  for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) assert.equal(mutationClearsGetCache(m), false, m);
});
