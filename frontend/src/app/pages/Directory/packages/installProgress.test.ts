import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ringFor, fractionOf, RING_FLOOR_PERCENT } from './installRing';
import { stagePackageInstall, POLL_MS } from './installPackage';

// The App Store's ring: while a package downloads the pill becomes a circle that fills with the
// bytes the backend has received. The size comes from Content-Length; without it the ring spins.

test('a fraction fills the ring, an unknown total spins it, and a fresh start shows a sliver', () => {
  assert.deepEqual(ringFor(0.5), { variant: 'determinate', value: 50 });
  assert.deepEqual(ringFor(0), { variant: 'determinate', value: RING_FLOOR_PERCENT });
  assert.deepEqual(ringFor(1.7), { variant: 'determinate', value: 100 });
  assert.deepEqual(ringFor(null), { variant: 'indeterminate', value: 0 });
  assert.equal(fractionOf({ received: 250, total: 1000 }), 0.25);
  assert.equal(fractionOf({ received: 9, total: 0 }), null);
  assert.equal(fractionOf(null), null);
});

function fakeFetch(statuses: Array<Record<string, unknown>>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/install/start')) return new Response(JSON.stringify({ job_id: 'job-1' }), { status: 200 });
    const next = statuses.shift() ?? statuses[statuses.length - 1];
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

test('the install polls the job, reports bytes as they land, and resolves with the review', async () => {
  const preflight = { ok: true, summary: {}, staging_token: 'tok', conflicts: [], warnings: [] };
  const { fetch: f, calls } = fakeFetch([
    { job_id: 'job-1', phase: 'downloading', received: 300, total: 1000 },
    { job_id: 'job-1', phase: 'downloading', received: 1000, total: 1000 },
    { job_id: 'job-1', phase: 'staging', received: 1000, total: 1000 },
    { job_id: 'job-1', phase: 'ready', received: 1000, total: 1000, preflight },
  ]);
  const seen: Array<{ received: number; total: number }> = [];
  const t0 = Date.now();
  const res = await stagePackageInstall('git-graph', (p) => seen.push(p), f);
  assert.equal(res.staging_token, 'tok');
  assert.deepEqual(seen, [{ received: 300, total: 1000 }, { received: 1000, total: 1000 }, { received: 1000, total: 1000 }]);
  assert.equal(calls[0].endsWith('/marketplace/install/start'), true);
  assert.equal(calls.filter((u) => u.endsWith('/install/job-1')).length, 4);
  assert.ok(Date.now() - t0 >= POLL_MS * 3 - 5, 'the poll waits between reads');
});

test('a failed job rejects with the backend\'s reason', async () => {
  const { fetch: f } = fakeFetch([{ job_id: 'job-1', phase: 'failed', received: 0, total: 0, error: 'the download returned 404' }]);
  await assert.rejects(stagePackageInstall('x', undefined, f), /the download returned 404/);
});

test('the pill draws the ring in the installing state and every surface passes progress', () => {
  const pill = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Directory/packages/InstallPill.tsx'), 'utf8');
  assert.match(pill, /state === 'installing'/);
  assert.match(pill, /role="progressbar"/);
  assert.match(pill, /data-install-ring=\{ring\.variant\}/);
  for (const file of ['src/app/pages/Directory/packages/PackageCard.tsx', 'src/app/pages/Directory/packages/detail/PackageDialog.tsx', 'src/app/pages/Directory/packages/detail/PackageBundleDialog.tsx']) {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    assert.match(src, /progress=\{/, file);
  }
});
