import { store } from '../state/store';
import { upsertOutput } from '../state/outputsSlice';
import { setCardPosition } from '../state/dashboardLayoutSlice';
import type { WSEvent } from './types';
import type { WsEventHandlerResult } from './eventHandlerTypes';

export function handleOutputEvent(msg: WSEvent): WsEventHandlerResult {
  const { data } = msg;
  switch (msg.event) {
    case 'agent:output_upserted':
      // Emitted when an Output row is created or updated. The reducer merges over existing rows.
      if (data.output && data.output.id) {
        store.dispatch(upsertOutput(data.output));
      }
      return true;

    case 'apps_sdk:tool_grant_request':
      // An app asked to use a connected MCP tool; AppToolGrantHost (global mount) owns the dialog.
      window.dispatchEvent(new CustomEvent('openswarm:app-tool-grant', { detail: data }));
      return true;

    case 'apps_sdk:place_agent_card': {
      // An app asked for its spawned agent at a specific canvas spot; the card is created async by the session lifecycle, so nudge it into place with a short bounded retry.
      const sid = data.session_id as string;
      const px = Number(data.x);
      const py = Number(data.y);
      if (!sid || !Number.isFinite(px) || !Number.isFinite(py)) return true;
      let tries = 0;
      const place = () => {
        const exists = !!store.getState().dashboardLayout.cards[sid];
        if (exists) {
          store.dispatch(setCardPosition({ sessionId: sid, x: px, y: py }));
          return;
        }
        if (++tries < 20) setTimeout(place, 300);
      };
      place();
      return true;
    }

    default:
      return null;
  }
}
