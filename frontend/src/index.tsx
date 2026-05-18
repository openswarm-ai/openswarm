import React from 'react';
import { createRoot } from 'react-dom/client';
import Main from './app/Main';
import ErrorBoundary from './app/components/ErrorBoundary';
import { ensureAuthToken } from './shared/config';
import { runStartupMigrations } from './shared/migrations';

// Must run before ensureAuthToken reads localStorage; v1.0.31 migration force-clears auth+onboarding so the stale token doesn't survive.
runStartupMigrations();

// 3s timeout so a missing Electron bridge (plain-browser dev) doesn't hang; 401 in that case is intentional.
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
