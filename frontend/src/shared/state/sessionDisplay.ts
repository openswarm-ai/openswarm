import type { AgentSession } from './agentsSlice';

export const SESSION_NAME_PLACEHOLDER = 'New chat';

const LEGACY_AUTO_NAME = /^Agent-[a-f0-9]{4,8}$/i;

export function isLegacyAutoName(name: string | null | undefined): boolean {
  return !!name && LEGACY_AUTO_NAME.test(name);
}

export function displaySessionName(name: string | null | undefined): string {
  if (!name || isLegacyAutoName(name)) return SESSION_NAME_PLACEHOLDER;
  return name;
}

export function normalizeSessionName(name: string | null | undefined): string {
  if (!name || isLegacyAutoName(name)) return '';
  return name;
}

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

export function displayChatTitle(session: AgentSession | null | undefined): string {
  if (!session) return SESSION_NAME_PLACEHOLDER;
  if (session.name && !isLegacyAutoName(session.name)) {
    return session.name;
  }
  const firstUserMsg = session.messages?.find((m) => m.role === 'user');
  if (firstUserMsg && typeof firstUserMsg.content === 'string') {
    const truncated = truncateForTitle(firstUserMsg.content);
    if (truncated) return truncated;
  }
  return session.mode === 'view-builder' ? 'Untitled App' : SESSION_NAME_PLACEHOLDER;
}
