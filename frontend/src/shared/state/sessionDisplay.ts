import type { AgentSession } from './agentsSlice';

// Placeholder shown for surfaces that only have a name string (search palette,
// dynamic island, notifications, history). Smarter surfaces use displayChatTitle.
export const SESSION_NAME_PLACEHOLDER = 'New chat';

// Old backend default was `Agent-<6-hex>`. Catch any session loaded from a
// pre-fix on-disk record so the hex id never reaches the UI.
const LEGACY_AUTO_NAME = /^Agent-[a-f0-9]{4,8}$/i;

export function isLegacyAutoName(name: string | null | undefined): boolean {
  return !!name && LEGACY_AUTO_NAME.test(name);
}

export function displaySessionName(name: string | null | undefined): string {
  if (!name || isLegacyAutoName(name)) return SESSION_NAME_PLACEHOLDER;
  return name;
}

// Used by reducers to normalize the legacy auto-name out at intake.
export function normalizeSessionName(name: string | null | undefined): string {
  if (!name || isLegacyAutoName(name)) return '';
  return name;
}

// First 4 words OR 30 chars, whichever shorter; ellipsis if cut. Tight enough to fit
// every render surface (sidebar columns, dashboard cards) without CSS overflow.
// Applied to both Phase 2 (first-message fallback) and Phase 3 (aux-LLM title), so even
// a misbehaving aux-LLM response can't blow the cap.
const MAX_TITLE_CHARS = 30;
const MAX_TITLE_WORDS = 4;

export function truncateForTitle(text: string | null | undefined): string {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const words = trimmed.split(' ').slice(0, MAX_TITLE_WORDS).join(' ');
  if (words.length > MAX_TITLE_CHARS) return words.slice(0, MAX_TITLE_CHARS).trimEnd() + '…';
  if (words.length < trimmed.length) return words + '…';
  return words;
}

// Phase-aware chat title:
//   Phase 3: aux-LLM title (session.name) when present.
//   Phase 2: first user message (truncated) when sent but no aux title yet.
//   Phase 1: context placeholder (App Builder -> "Untitled App", else "New chat").
export function displayChatTitle(session: AgentSession | null | undefined): string {
  if (!session) return SESSION_NAME_PLACEHOLDER;
  if (session.name && !isLegacyAutoName(session.name)) {
    return truncateForTitle(session.name) || session.name;
  }
  const firstUserMsg = session.messages?.find((m) => m.role === 'user');
  if (firstUserMsg && typeof firstUserMsg.content === 'string') {
    const truncated = truncateForTitle(firstUserMsg.content);
    if (truncated) return truncated;
  }
  return session.mode === 'view-builder' ? 'Untitled App' : SESSION_NAME_PLACEHOLDER;
}
