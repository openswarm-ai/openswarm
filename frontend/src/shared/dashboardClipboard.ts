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
let clipboardTimestamp = 0;

export function setClipboardCards(cards: ClipboardCard[]): void {
  clipboardCards = cards;
  clipboardTimestamp = Date.now();
}

export function getClipboardCards(): ClipboardCard[] {
  return clipboardCards;
}

export function getClipboardTimestamp(): number {
  return clipboardTimestamp;
}

export function clearClipboard(): void {
  clipboardCards = [];
  clipboardTimestamp = 0;
}
