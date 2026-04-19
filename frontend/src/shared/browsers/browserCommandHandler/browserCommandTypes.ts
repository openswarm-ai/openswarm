export type BrowserAction = 'screenshot' | 'get_text' | 'navigate' | 'click' | 'type' | 'evaluate' | 'get_elements' | 'scroll' | 'wait';

export interface BrowserActivity {
  action: BrowserAction;
  detail?: string;
  coords?: { xPercent: number; yPercent: number };
}

type ActivityListener = (browserId: string, activity: BrowserActivity | null) => void;

const activityMap = new Map<string, BrowserActivity>();
const listeners = new Set<ActivityListener>();

export function setActivity(browserId: string, activity: BrowserActivity | null) {
  if (activity) {
    activityMap.set(browserId, activity);
  } else {
    activityMap.delete(browserId);
  }
  listeners.forEach((fn) => fn(browserId, activity));
}

export function getActivity(browserId: string): BrowserActivity | null {
  return activityMap.get(browserId) ?? null;
}

export function subscribeActivity(fn: ActivityListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const ACTION_LABELS: Record<string, string> = {
  screenshot: 'Capturing...',
  get_text: 'Reading...',
  navigate: 'Navigating...',
  click: 'Clicking...',
  type: 'Typing...',
  evaluate: 'Evaluating...',
  get_elements: 'Inspecting...',
  scroll: 'Scrolling...',
  wait: 'Waiting...',
};

export function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? 'Working...';
}
