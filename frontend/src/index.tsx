import React from 'react';
import { createRoot } from 'react-dom/client';
import Main from './app/Main';

const root = document.getElementById('root')!;
createRoot(root).render(<Main />);
