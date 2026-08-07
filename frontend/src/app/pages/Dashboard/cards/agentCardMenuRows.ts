import { clearSessionMessages, deleteSession, duplicateSession, expandSession, collapseSession, stopAgent, fetchSession, type AgentSession } from '@/shared/state/agentsSlice';
import { placeCard, bringToFront } from '@/shared/state/dashboardLayoutSlice';
import { setClipboardCards } from '@/shared/dashboardClipboard';
import { copySessionResponse } from '@/shared/copySessionResponse';
import { requestShare } from '@/app/components/share/ShareRequestHost';
import { displaySessionName } from '@/shared/state/sessionDisplay';
import { handleSlashCommand } from '@/app/pages/AgentChat/ChatInput/hooks/slashCommands';
import type { AppDispatch } from '@/shared/state/store';
import type { CardMenuRow } from '../desktop/openCardContextMenu';
import { chord } from '../desktop/chord';
import { tileMenuRows } from './tileMenuRows';

interface AgentMenuArgs {
  session: AgentSession;
  dispatch: AppDispatch;
  expanded: boolean;
  tileZone?: string;
  expandedSessionIds: string[];
  card: { x: number; y: number; width: number; height: number };
  onTile: (zone: string) => void;
  onClose: () => void;
}

export function agentCardMenuRows({ session, dispatch, expanded, tileZone, expandedSessionIds, card, onTile, onClose }: AgentMenuArgs): CardMenuRow[] {
  const running = session.status === 'running';
  return [
    { label: expanded ? 'Collapse' : 'Open', shortcut: chord('enter'), onClick: () => dispatch(expanded ? collapseSession(session.id) : expandSession(session.id)) },
    { label: tileZone === 'fullscreen' ? 'Exit Full Screen' : 'Full Screen', onClick: () => onTile(tileZone === 'fullscreen' ? 'restore' : 'fullscreen') },
    { label: 'Tile to zone', submenu: tileMenuRows(onTile, tileZone) },
    { label: 'Bring to front', onClick: () => dispatch(bringToFront({ id: session.id, type: 'agent' })) },
    { kind: 'separator' },
    {
      label: 'Duplicate',
      onClick: () => {
        void dispatch(duplicateSession({ sessionId: session.id, dashboardId: session.dashboard_id })).then((action) => {
          if (duplicateSession.fulfilled.match(action)) {
            dispatch(placeCard({ sessionId: action.payload.id, x: card.x + 40, y: card.y - 40, width: card.width, height: card.height, expandedSessionIds }));
            if (expanded) dispatch(expandSession(action.payload.id));
          }
        });
      },
    },
    {
      label: 'Copy',
      shortcut: chord('mod', 'C'),
      onClick: () => setClipboardCards([{
        type: 'agent', id: session.id, name: session.name || session.id,
        meta: { name: session.name, status: session.status, model: session.model, mode: session.mode },
        x: card.x, y: card.y, width: card.width, height: card.height, expanded,
      }]),
    },
    { label: 'Copy response', onClick: () => { copySessionResponse(session.id); } },
    { label: 'Share as .swarm…', onClick: () => requestShare({ kind: 'session', id: session.id, name: displaySessionName(session.name) }) },
    { kind: 'separator' },
    { kind: 'header', label: 'Session' },
    { label: 'Stop turn', disabled: !running, onClick: () => { void dispatch(stopAgent({ sessionId: session.id })); } },
    // Clear the server transcript first, then the local one: the reducer alone would leave the backend holding history.
    { label: 'Clear messages', disabled: running, onClick: () => { void handleSlashCommand('/clear', session.id).then(() => dispatch(clearSessionMessages(session.id))); } },
    { label: 'Compact context', disabled: running, onClick: () => { void handleSlashCommand('/compact', session.id).then(() => dispatch(fetchSession(session.id))); } },
    { kind: 'separator' },
    { label: 'Close', onClick: onClose },
    { label: 'Delete chat', shortcut: chord('del'), danger: true, onClick: () => { void dispatch(deleteSession({ sessionId: session.id })); } },
  ];
}
