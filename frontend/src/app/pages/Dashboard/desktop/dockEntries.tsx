import React from 'react';
import LanguageIcon from '@mui/icons-material/Language';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import { MessageCircle } from 'lucide-react';
import { pickIcon } from '../canvas/DashboardGlyph';
import { displayChatTitle } from '@/shared/state/sessionDisplay';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type {
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition,
  WorkflowCardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';

export interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DockEntryKind = 'agent' | 'browser' | 'view' | 'workflow';

export interface DockEntry {
  id: string;
  kind: DockEntryKind;
  label: string;
  rect: CardRect;
  tileBg: string;
  icon: React.ReactNode;
  faviconUrl?: string;
  thumbnail?: string | null;
  browserId?: string;
  snippet?: string;
}

export interface DockSlices {
  sessions: Record<string, AgentSession>;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  outputs: Record<string, Output>;
}

// Frames show a colorful per-card dock, not uniform tiles; hues rotate by name so two agents rarely match.
const AGENT_TILE_HUES = [
  'linear-gradient(135deg, #4a7dd6, #2b4fa8)',
  'linear-gradient(135deg, #8a5bd6, #5b34a8)',
  'linear-gradient(135deg, #3aa88f, #1f7a64)',
  'linear-gradient(135deg, #d6754a, #a8492b)',
  'linear-gradient(135deg, #c94a7d, #96305c)',
];

function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AGENT_TILE_HUES[Math.abs(h) % AGENT_TILE_HUES.length];
}

export function buildDockEntries({ sessions, cards, viewCards, browserCards, workflowCards, outputs }: DockSlices): DockEntry[] {
  const list: DockEntry[] = [];
  for (const card of Object.values(cards)) {
    const session = sessions[card.session_id];
    if (!session) continue;
    const title = displayChatTitle(session);
    const ChatIcon = pickIcon(title) || MessageCircle;
    list.push({
      id: card.session_id,
      kind: 'agent',
      label: title,
      rect: card,
      tileBg: hueFor(title),
      icon: <ChatIcon size={16} strokeWidth={1.75} color="#fff" />,
      snippet: session.turn_label?.label || undefined,
    });
  }
  for (const bc of Object.values(browserCards)) {
    // A browser living inside a chat is represented by that chat's tile; its own tile read as a phantom window ("invisible openai browser"). Pulling it out brings the tile back.
    if (bc.docked_to && cards[bc.docked_to]) continue;
    const activeTab = bc.tabs.find((t) => t.id === bc.activeTabId) || bc.tabs[0];
    list.push({
      id: bc.browser_id,
      kind: 'browser',
      label: activeTab?.title || 'Browser',
      rect: bc,
      tileBg: 'linear-gradient(135deg, #4f9fe8, #2f6ed4)',
      icon: <LanguageIcon sx={{ fontSize: 17, color: '#fff' }} />,
      faviconUrl: activeTab?.favicon,
      browserId: bc.browser_id,
    });
  }
  for (const [cardKey, vc] of Object.entries(viewCards)) {
    const output = outputs[vc.output_id];
    const appName = output?.name || 'App';
    list.push({
      id: cardKey,
      kind: 'view',
      label: appName,
      rect: vc,
      tileBg: 'linear-gradient(135deg, #ef9552, #d96a2b)',
      // Never letters in the dock: a real symbol reads as an app, a glyph initial reads as a bug.
      icon: <GridViewRoundedIcon sx={{ fontSize: 16, color: '#fff' }} />,
      thumbnail: output?.thumbnail,
    });
  }
  for (const [cardKey, wf] of Object.entries(workflowCards)) {
    list.push({
      id: cardKey,
      kind: 'workflow',
      label: 'Workflow',
      rect: wf,
      tileBg: 'linear-gradient(135deg, #ef7a70, #d94f45)',
      icon: <CalendarMonthIcon sx={{ fontSize: 16, color: '#fff' }} />,
    });
  }
  return list;
}
