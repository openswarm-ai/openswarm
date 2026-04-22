import { API_BASE } from './config';

let _lastAction = '';
let _lastPage = '';
let _appStartTime = Date.now();

export function trackEvent(eventType: string, properties?: Record<string, any>, useBeacon = false) {
  _lastAction = eventType;
  _lastPage = window.location.hash || window.location.pathname;

  const body = JSON.stringify({ event_type: eventType, properties });
  if (useBeacon && navigator.sendBeacon) {
    // sendBeacon is guaranteed to complete even during page unload
    navigator.sendBeacon(`${API_BASE}/analytics/event`, new Blob([body], { type: 'application/json' }));
  } else {
    fetch(`${API_BASE}/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {});
  }
}

export function getLastAction() { return _lastAction; }
export function getLastPage() { return _lastPage; }
export function getTimeSpent() { return Math.round((Date.now() - _appStartTime) / 1000); }
