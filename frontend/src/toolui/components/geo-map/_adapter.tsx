/**
 * Adapter: UI and utility re-exports for copy-standalone portability.
 *
 * When copying this component to another project, update these imports
 * to match your project's paths:
 *
 *   cn      → Your Tailwind merge utility (e.g., "@toolui/lib/utils", "~/lib/cn")
 *   Leaflet → map primitives from react-leaflet
 */

export { cn } from "@toolui/lib/utils";
export {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";
