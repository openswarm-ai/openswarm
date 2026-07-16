// Run: node --test frontend/src/shared/providerUsage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, type ProviderUsage } from './providerUsage.ts';

test('failed or null read yields empty summary', () => {
  assert.equal(summarizeUsage(null), '');
  assert.equal(summarizeUsage({ ok: false, total: 0, titles: [], memories: [] }), '');
});

test('summary leads with memory, names scale, and lists recent topics', () => {
  const u: ProviderUsage = {
    ok: true,
    total: 812,
    titles: ['Swift concurrency', 'Deadlift form check', 'Tax on RSUs'],
    memories: ['Has an Akita', 'Squats 495'],
  };
  const s = summarizeUsage(u);
  assert.match(s, /812 past AI conversations/);
  assert.match(s, /Has an Akita; Squats 495/);
  assert.match(s, /Swift concurrency; Deadlift form check; Tax on RSUs/);
});

test('summary is hard-capped so a heavy user never ships a wall of PII', () => {
  const titles = Array.from({ length: 1000 }, (_, i) => `conversation number ${i} about a very specific topic`);
  const s = summarizeUsage({ ok: true, total: 1000, titles, memories: [] });
  assert.ok(s.length <= 4000, `summary length ${s.length} exceeded 4000`);
});
