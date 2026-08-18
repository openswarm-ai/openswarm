import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createRuntimeRequestPool } from './createRuntimeRequestPool';

const neverSettles = () => new Promise<Response>(() => {});

test('times out and aborts a request that never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchMock = mock.fn(neverSettles);
  const pool = createRuntimeRequestPool(fetchMock as unknown as typeof fetch);
  const request = pool.fetch('/runtime/status', {}, 5000);
  const signal = (fetchMock.mock.calls[0].arguments[1] as RequestInit | undefined)?.signal as AbortSignal;
  const rejection = assert.rejects(request, /Request timed out/);
  t.mock.timers.tick(5000);
  await rejection;
  assert.equal(signal.aborted, true);
});

test('cancels every pending request', async () => {
  const fetchMock = mock.fn(neverSettles);
  const pool = createRuntimeRequestPool(fetchMock as unknown as typeof fetch);
  const first = pool.fetch('/runtime/start', {}, 10_000);
  const second = pool.fetch('/runtime/status', {}, 10_000);
  const firstSignal = (fetchMock.mock.calls[0].arguments[1] as RequestInit | undefined)?.signal as AbortSignal;
  const secondSignal = (fetchMock.mock.calls[1].arguments[1] as RequestInit | undefined)?.signal as AbortSignal;
  const firstRejection = assert.rejects(first, /Request cancelled/);
  const secondRejection = assert.rejects(second, /Request cancelled/);
  pool.abortAll();
  await Promise.all([firstRejection, secondRejection]);
  assert.equal(firstSignal.aborted, true);
  assert.equal(secondSignal.aborted, true);
});

test('a settled request leaves the pool, so a later abortAll does not touch it', async () => {
  const fetchMock = mock.fn(async () => new Response('{}', { status: 200 }));
  const pool = createRuntimeRequestPool(fetchMock as unknown as typeof fetch);
  const response = await pool.fetch('/runtime/status', {}, 1000);
  assert.equal(response.status, 200);
  pool.abortAll();
  const signal = (fetchMock.mock.calls[0].arguments[1] as RequestInit | undefined)?.signal as AbortSignal;
  assert.equal(signal.aborted, false);
});
