import { type CardType } from '@/app/pages/Dashboard/_shared/types';

export interface ClipboardCard {
  type: CardType;
  id: string;
  name: string;
  meta: Record<string, unknown>;
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