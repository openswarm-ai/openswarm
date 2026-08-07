// Run: node --test frontend/src/app/pages/AgentChat/tool-bubbles/domainBrand.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandIconForDomain, monogramHue } from './domainBrand.ts';

test('a known brand domain resolves to a bundled icon', () => {
  assert.ok(brandIconForDomain('github.com'));
});

test('a subdomain walks up to its registered brand', () => {
  assert.equal(brandIconForDomain('docs.github.com'), brandIconForDomain('github.com'));
  assert.equal(brandIconForDomain('en.wikipedia.org'), brandIconForDomain('wikipedia.org'));
});

test('www and case are ignored', () => {
  assert.equal(brandIconForDomain('www.GitHub.com'), brandIconForDomain('github.com'));
});

test('an unknown domain has no brand icon', () => {
  assert.equal(brandIconForDomain('example.org'), null);
});

test('lookalike hosts never match across a label boundary', () => {
  assert.equal(brandIconForDomain('evilgithub.com'), null);
});

test('monogram hue is deterministic and a valid hue', () => {
  assert.equal(monogramHue('example.org'), monogramHue('example.org'));
  for (const d of ['a', 'example.org', 'sub.long-domain-name.co.uk']) {
    const h = monogramHue(d);
    assert.ok(h >= 0 && h < 360, `${d} hue out of range: ${h}`);
  }
});

test('no favicon beacon: nothing in tool-bubbles builds a remote favicon URL', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(dir).filter((n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.includes('.test.'));
  for (const f of sources) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!src.includes('s2/favicons'), `${f} references a favicon service`);
    assert.ok(!src.includes('favicons?domain='), `${f} builds a favicon beacon URL`);
    assert.ok(!src.includes('faviconUrlForDomain'), `${f} still references the deleted beacon helper`);
  }
});
