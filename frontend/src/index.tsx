import React from 'react';
import { createRoot } from 'react-dom/client';
import Main from './app/Main';
import ErrorBoundary from './app/components/ErrorBoundary';
import { ensureAuthToken } from './shared/config';

// Resolve the per-install auth token from Electron BEFORE first render
// so the very first fetch/WS carries the Authorization header. The
// token IPC is fast (synchronous file read in main process). We bound
// the wait at 3s so a missing Electron bridge (e.g. running the React
// app in a plain browser) doesn't hang forever — in that case
// `getAuthToken()` returns '' and backend calls will 401, which is
// the desired behavior (plain browsers can't be allowed to impersonate
// the user).
async function bootstrap() {
  try {
    await Promise.race([
      ensureAuthToken(),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  } catch {}
  const root = document.getElementById('root')!;
  createRoot(root).render(
    <ErrorBoundary scope="root">
      <Main />
    </ErrorBoundary>
  );
}
bootstrap();
