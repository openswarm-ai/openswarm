import { zoneRect, type ZoneRect } from './tiledGeometry';

export function rectsIntersect(a: ZoneRect, b: ZoneRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** True when any tiled card's zone sits over the floating spawn pill (a bottom-left tile put "Ask me anything" on top of the card's own composer, ENG-469). */
export function coveredByTiledZones(zones: string[], pill: ZoneRect, rectFor: (zone: string) => ZoneRect | null = zoneRect): boolean {
  for (const zone of zones) {
    const r = rectFor(zone);
    if (r && rectsIntersect(r, pill)) return true;
  }
  return false;
}

export type HealthToastAnchor = { vertical: 'bottom' | 'top'; horizontal: 'left' | 'center' };
/** The reconnect pill must never hide (a covered composer is row 7, a hidden reconnect is row 5), so when a tile covers its bottom-left spot it moves to the top centre, which no quarter or half tile owns together with the composer. */
export function healthToastAnchor(zones: string[], toastRect: ZoneRect | null, rectFor: (zone: string) => ZoneRect | null = zoneRect): HealthToastAnchor {
  if (toastRect && coveredByTiledZones(zones, toastRect, rectFor)) return { vertical: 'top', horizontal: 'center' };
  return { vertical: 'bottom', horizontal: 'left' };
}

