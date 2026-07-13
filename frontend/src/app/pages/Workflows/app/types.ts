import type { PointerEvent } from 'react';

export type AppMode = 'home' | 'calendar' | 'detail' | 'new' | 'trash';
export type CalView = 'week' | 'month';

// The card owns drag geometry but the title bar renders inside the content (it needs nav state to know which workflow to share), so the card hands its drag handlers down.
export interface CardHeader {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  dragging: boolean;
}

// Navigation + ephemeral UI state for the Workflows app window. Data lives in Redux; this is only "where am I looking right now".
export interface AppNav {
  mode: AppMode;
  selectedId: string | null;
  calView: CalView;
  refDate: Date;
  goHome: () => void;
  goCalendar: () => void;
  goNew: () => void;
  goTrash: () => void;
  selectWorkflow: (id: string) => void;
  setCalView: (v: CalView) => void;
  setRefDate: (d: Date) => void;
}
