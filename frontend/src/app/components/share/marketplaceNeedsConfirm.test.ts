import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { marketplaceNeedsConfirm } from './marketplaceNeedsConfirm';
import { importNeedsConfirm } from './importNeedsConfirm';
import type { ImportPreflight } from './shareTypes';

// Measured 2026-09-03 on the real Git Graph listing: verdict "warn" with 95 findings, 94 of them "imports X (outside the safe-data-shaping allowlist)", zero requirements. The App Store shows no sheet for that; we showed a 918px one.
const base = (over: Partial<ImportPreflight> = {}): ImportPreflight => ({
  ok: true, staging_token: 't', conflicts: [], warnings: [],
  summary: { root: { type: 'app', name: 'Git Graph' }, includes: [], requirements: [], counts: {} },
  review: { verdict: 'warn', findings: ['This app runs code on your computer.', ...Array.from({ length: 94 }, (_, i) => `f${i}: Imports os`)], scanned_files: [] },
  ...over,
} as ImportPreflight);

test('an ordinary app with import warnings installs on Get alone', () => {
  assert.equal(marketplaceNeedsConfirm(base()), false);
  assert.equal(importNeedsConfirm(base()), true, 'the dropped-file rule stays stricter');
});

test('a blocked review still stops the install', () => {
  assert.equal(marketplaceNeedsConfirm(base({ review: { verdict: 'block', findings: ['Reads your keychain'], scanned_files: [] } })), true);
});

test('a need the user must supply by hand still gets a sheet', () => {
  const pf = base(); pf.summary.requirements = [{ kind: 'api_key', key: 'k', label: 'OpenAI key' }] as ImportPreflight['summary']['requirements'];
  assert.equal(marketplaceNeedsConfirm(pf), true);
});

test('the review sheet never joins findings into one paragraph', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/components/share/ImportModal.tsx'), 'utf8');
  assert.ok(!src.includes("findings.join("), 'findings joined into a wall of text again');
  assert.ok(src.includes('<ReviewFindings'), 'the findings component is gone');
});
