// The retry planner behind useRuntimePreviewUrl: a start whose HTTP answer never came may or may not have reached the backend (attach() increments before startup completes), so a retry restarts rather than stacking a second start, and only a restart that reports "not running" on a new-mode workspace earns one fresh start.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeUrlBuilder } from './runtimePreviewLease';
import { pickPreviewUrl } from './pickPreviewUrl';
import { planRuntimeRequest, shouldStartAfterAmbiguousRestart } from './runtimePreviewRetry';

test('the first attempt starts; a retry after any possible or confirmed attachment restarts', () => {
  assert.deepEqual(planRuntimeRequest(false, 'none'), { action: 'start', retryingPossibleAttachment: false });
  assert.deepEqual(planRuntimeRequest(false, 'confirmed'), { action: 'start', retryingPossibleAttachment: false });
  assert.deepEqual(planRuntimeRequest(true, 'none'), { action: 'start', retryingPossibleAttachment: false });
  assert.deepEqual(planRuntimeRequest(true, 'possible'), { action: 'restart', retryingPossibleAttachment: true });
  assert.deepEqual(planRuntimeRequest(true, 'confirmed'), { action: 'restart', retryingPossibleAttachment: false });
});

test('only an ambiguous restart that finds nothing running on a new-mode workspace is followed by one fresh start', () => {
  const ambiguous = planRuntimeRequest(true, 'possible');
  assert.equal(shouldStartAfterAmbiguousRestart(ambiguous, { running: false, is_new_mode: true }), true);
  assert.equal(shouldStartAfterAmbiguousRestart(ambiguous, { running: true, is_new_mode: true }), false);
  assert.equal(shouldStartAfterAmbiguousRestart(ambiguous, { running: false, is_new_mode: false }), false);
  assert.equal(shouldStartAfterAmbiguousRestart(ambiguous, {}), false);
  const confirmed = planRuntimeRequest(true, 'confirmed');
  assert.equal(shouldStartAfterAmbiguousRestart(confirmed, { running: false, is_new_mode: true }), false);
  const first = planRuntimeRequest(false, 'none');
  assert.equal(shouldStartAfterAmbiguousRestart(first, { running: false, is_new_mode: true }), false);
});

test('start and stop carry the attachment id; status and restart do not', () => {
  const url = createRuntimeUrlBuilder('http://localhost:8324/api', 'ws-1', 2, 'att-1');
  assert.equal(url('start'), 'http://localhost:8324/api/outputs/workspace/ws-1/runtime/start?instance=2&attachment_id=att-1');
  assert.equal(url('stop'), 'http://localhost:8324/api/outputs/workspace/ws-1/runtime/stop?instance=2&attachment_id=att-1');
  assert.equal(url('status'), 'http://localhost:8324/api/outputs/workspace/ws-1/runtime/status?instance=2');
  assert.equal(url('restart'), 'http://localhost:8324/api/outputs/workspace/ws-1/runtime/restart?instance=2');
});

test('pickPreviewUrl: legacy URL without a workspace, placeholder while a new-mode runtime has no URL yet, runtime URL once bound', () => {
  assert.deepEqual(pickPreviewUrl({ workspaceId: null, legacyUrl: '/serve/index.html', frontendUrl: null, isNewMode: false }), { url: '/serve/index.html', isBooting: false });
  assert.deepEqual(pickPreviewUrl({ workspaceId: 'ws', legacyUrl: '/serve/index.html', frontendUrl: null, isNewMode: true }), { url: undefined, isBooting: true });
  assert.deepEqual(pickPreviewUrl({ workspaceId: 'ws', legacyUrl: '/serve/index.html', frontendUrl: 'http://localhost:5173', isNewMode: true }), { url: 'http://localhost:5173', isBooting: false });
  assert.deepEqual(pickPreviewUrl({ workspaceId: 'ws', legacyUrl: '/serve/index.html', frontendUrl: null, isNewMode: false }), { url: '/serve/index.html', isBooting: false });
});
