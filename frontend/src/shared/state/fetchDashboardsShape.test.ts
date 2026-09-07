import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDashboards } from './dashboardsSlice';

// The list endpoint answered JSON without a `dashboards` key (a sign-in wall's 401 body) and the fulfilled thunk carried
// undefined into the auto-enter page, which threw on `.slice` and took the first screen down. Not ok rejects; ok is a list.
async function run(status: number, body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
  try {
    const dispatch = (a: unknown) => a;
    return await fetchDashboards()(dispatch as never, () => ({}), undefined);
  } finally {
    globalThis.fetch = original;
  }
}

test('a 401 body without a list rejects instead of fulfilling with undefined', async () => {
  const res = await run(401, { detail: 'sign in' });
  assert.ok(fetchDashboards.rejected.match(res));
});

test('an ok body without a list fulfils with an empty list', async () => {
  const res = await run(200, { detail: 'odd but ok' });
  assert.ok(fetchDashboards.fulfilled.match(res));
  assert.deepEqual(res.payload, []);
});

test('an ok list passes through', async () => {
  const res = await run(200, { dashboards: [{ id: 'd1', name: 'One' }] });
  assert.ok(fetchDashboards.fulfilled.match(res));
  assert.equal((res.payload as Array<{ id: string }>)[0].id, 'd1');
});
