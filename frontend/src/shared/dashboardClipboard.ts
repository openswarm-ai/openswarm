import type { CardType } from '@/app/pages/Dashboard/useDashboardSelection';

export interface ClipboardCard {
  type: CardType;
  id: string;
  name: string;
  meta: Record<string, any>;
  x: number;
  y: number;
  width: number;
  height: number;
  expanded?: boolean;
}

let clipboardCards: ClipboardCard[] = [];

export function setClipboardCards(cards: ClipboardCard[]): void {
  clipboardCards = cards;
}

export function getClipboardCards(): ClipboardCard[] {
  return clipboardCards;
}

export function clearClipboard(): void {
  clipboardCards = [];
}
