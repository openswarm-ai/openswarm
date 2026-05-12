import React from 'react';
import { createRoot } from 'react-dom/client';
import Main from './app/Main';

console.log('[App] Bootstrapping React app');
const rootEl = document.getElementById('root');
if (!rootEl) {
  console.error('[App] FATAL: #root element not found in DOM');
} else {
  createRoot(rootEl).render(<Main />);
  console.log('[App] React root mounted');
}
