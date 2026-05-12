import React, { Suspense } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter, useRoutes } from 'react-router-dom';
import routes from '~react-pages';
import { store } from '../shared/state/store';
import ClaudeThemeProvider from '@/shared/styles/ThemeContext';
import AppShell from '@/app/components/Layout/AppShell';

const Pages: React.FC = () => {
  return <Suspense fallback={null}>{useRoutes(routes)}</Suspense>;
};

const Main: React.FC = () => {
  return (
    <Provider store={store}>
      <ClaudeThemeProvider>
        <BrowserRouter>
          <AppShell>
            <Pages />
          </AppShell>
        </BrowserRouter>
      </ClaudeThemeProvider>
    </Provider>
  );
};

export default Main;
