import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installState } from './installs';
import type { Listing } from './catalog';

// The store's one button: Get until the machine remembers an install, Open while the thing it became still exists.
const listing = { id: 'git-graph', kind: 'app' } as Listing;
const rec = { listing_id: 'git-graph', root_type: 'app', output_id: 'out-1', version: '1.0.0', installed_at: 1 };
const none = { outputs: {}, skills: {}, workflows: {} };

test('no record means Get', () => {
  assert.equal(installState(listing, undefined, none), 'get');
});

test('a recorded app is Open while its output exists, and Get again once it is gone', () => {
  assert.equal(installState(listing, rec, { ...none, outputs: { 'out-1': {} } }), 'open');
  assert.equal(installState(listing, rec, none), 'get');
});

test('skills and workflows open through their own lists; other kinds just read Installed', () => {
  assert.equal(installState(listing, { listing_id: 'x', root_type: 'skill', skill_id: 'sk', version: '', installed_at: 1 }, { ...none, skills: { sk: {} } }), 'open');
  assert.equal(installState(listing, { listing_id: 'x', root_type: 'workflow', workflow_id: 'wf', version: '', installed_at: 1 }, { ...none, workflows: { wf: {} } }), 'open');
  assert.equal(installState(listing, { listing_id: 'x', root_type: 'mode', session_id: 'm', version: '', installed_at: 1 }, none), 'installed');
});
