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
