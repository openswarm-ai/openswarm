import React from 'react';

export interface SlashCommand {
  id: string;
  type: 'skill' | 'mode';
  name: string;
  description: string;
  command: string;
}

export interface AtCommand {
  prefix: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  source: string;
  isChild?: boolean;
}

export interface Shortcut {
  key: string;
  description: string;
  category: 'navigation' | 'action';
}

export const SHORTCUTS: Shortcut[] = [
  { key: 'd', description: 'Go to Dashboard', category: 'navigation' },
  { key: '1-9', description: 'Open agent by position', category: 'navigation' },
  { key: 'Shift+A', description: 'Approve all pending', category: 'action' },
  { key: 'Shift+D', description: 'Deny all pending', category: 'action' },
  { key: '?', description: 'Show shortcuts dialog', category: 'navigation' },
];
