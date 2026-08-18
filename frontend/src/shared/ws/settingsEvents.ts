import { store } from '../state/store';
import { fetchSettings } from '../state/settingsSlice';
import type { WSEvent } from './types';
import type { WsEventHandlerResult } from './eventHandlerTypes';

export function handleSettingsEvent(msg: WSEvent): WsEventHandlerResult {
  if (msg.event !== 'settings:changed') return null;
  // An agent wrote settings under us, so refetch instead of waiting for window focus.
  store.dispatch(fetchSettings());
  return true;
}
