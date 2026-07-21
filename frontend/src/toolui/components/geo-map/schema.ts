import { z } from "zod";
import type { CSSProperties } from "react";
import { defineToolUiContract } from "../shared/contract";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

const LatitudeSchema = z.number().finite().min(-90).max(90);
const LongitudeSchema = z.number().finite().min(-180).max(180);
const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Expected an http or https URL.",
  });

const GeoMapMarkerIconDotSchema = z.object({
  type: z.literal("dot"),
  color: z.string().optional(),
  borderColor: z.string().optional(),
  radius: z.number().min(3).max(16).optional(),
});

const GeoMapMarkerIconEmojiSchema = z.object({
  type: z.literal("emoji"),
  value: z.string().min(1),
  size: z.number().min(16).max(40).optional(),
  bgColor: z.string().optional(),
  borderColor: z.string().optional(),
});

const GeoMapMarkerIconImageSchema = z.object({
  type: z.literal("image"),
  url: HttpUrlSchema,
  width: z.number().min(16).max(64).optional(),
  height: z.number().min(16).max(64).optional(),
  borderRadius: z.number().min(0).max(999).optional(),
  borderColor: z.string().optional(),
});

export const GeoMapMarkerIconSchema = z.union([
  GeoMapMarkerIconDotSchema,
  GeoMapMarkerIconEmojiSchema,
  GeoMapMarkerIconImageSchema,
]);

export type GeoMapMarkerIcon = z.infer<typeof GeoMapMarkerIconSchema>;

export const GeoMapMarkerSchema = z.object({
  id: z.string().min(1).optional(),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  label: z.string().optional(),
  description: z.string().optional(),
  tooltip: z.enum(["none", "hover", "always"]).optional(),
  icon: GeoMapMarkerIconSchema.optional(),
});

export type GeoMapMarker = z.infer<typeof GeoMapMarkerSchema>;

export const GeoMapRoutePointSchema = z.object({
  lat: LatitudeSchema,
  lng: LongitudeSchema,
});

export const GeoMapRouteSchema = z.object({
  id: z.string().min(1).optional(),
  points: z.array(GeoMapRoutePointSchema).min(2),
  label: z.string().optional(),
  description: z.string().optional(),
  tooltip: z.enum(["none", "hover", "always"]).optional(),
  color: z.string().optional(),
  weight: z.number().min(1).max(12).optional(),
  opacity: z.number().min(0).max(1).optional(),
  dashArray: z.string().optional(),
});

export type GeoMapRoute = z.infer<typeof GeoMapRouteSchema>;

export const GeoMapClusteringSchema = z.object({
  enabled: z.boolean().optional(),
  radius: z.number().min(20).max(120).optional(),
  maxZoom: z.number().min(1).max(22).optional(),
  minPoints: z.number().min(2).max(20).optional(),
});

export type GeoMapClustering = z.infer<typeof GeoMapClusteringSchema>;

export const GeoMapFitTargetSchema = z.enum(["markers", "routes", "all"]);
export type GeoMapFitTarget = z.infer<typeof GeoMapFitTargetSchema>;

const GeoMapFitViewportSchema = z.object({
  mode: z.literal("fit"),
  padding: z.number().nonnegative().optional(),
  maxZoom: z.number().min(1).max(22).optional(),
  target: GeoMapFitTargetSchema.optional(),
});

const GeoMapCenterViewportSchema = z.object({
  mode: z.literal("center"),
  center: z.object({
    lat: LatitudeSchema,
    lng: LongitudeSchema,
  }),
  zoom: z.number().min(1).max(22),
});

export const GeoMapViewportSchema = z.union([
  GeoMapFitViewportSchema,
  GeoMapCenterViewportSchema,
]);

export type GeoMapViewport = z.infer<typeof GeoMapViewportSchema>;

export const GeoMapPropsSchema = z
  .object({
    id: ToolUIIdSchema,
    role: ToolUIRoleSchema.optional(),
    receipt: ToolUIReceiptSchema.optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    markers: z.array(GeoMapMarkerSchema).min(1),
    routes: z.array(GeoMapRouteSchema).optional(),
    clustering: GeoMapClusteringSchema.optional(),
    viewport: GeoMapViewportSchema.optional(),
    showZoomControl: z.boolean().optional(),
    theme: z.enum(["light", "dark"]).optional(),
  })
  .superRefine((value, ctx) => {
    const seenMarkerIds = new Set<string>();

    value.markers.forEach((marker, index) => {
      if (!marker.id) {
        return;
      }

      if (seenMarkerIds.has(marker.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["markers", index, "id"],
          message: `Duplicate marker id "${marker.id}".`,
        });
        return;
      }

      seenMarkerIds.add(marker.id);
    });

    const seenRouteIds = new Set<string>();
    value.routes?.forEach((route, index) => {
      if (!route.id) {
        return;
      }

      if (seenRouteIds.has(route.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["routes", index, "id"],
          message: `Duplicate route id "${route.id}".`,
        });
        return;
      }

      seenRouteIds.add(route.id);
    });
  });

export type GeoMapStyle = CSSProperties &
  Partial<Record<`--${string}`, string | number>>;

export type GeoMapClientProps = {
  className?: string;
  style?: GeoMapStyle;
  tooltipClassName?: string;
  popupClassName?: string;
  onMarkerClick?: (marker: GeoMapMarker) => void;
  onRouteClick?: (route: GeoMapRoute) => void;
};

export type GeoMapProps = z.infer<typeof GeoMapPropsSchema> & GeoMapClientProps;

export const SerializableGeoMapSchema = GeoMapPropsSchema;

export type SerializableGeoMap = z.infer<typeof SerializableGeoMapSchema>;

const SerializableGeoMapSchemaContract = defineToolUiContract(
  "GeoMap",
  SerializableGeoMapSchema,
);

export const parseSerializableGeoMap: (input: unknown) => SerializableGeoMap =
  SerializableGeoMapSchemaContract.parse;

export const safeParseSerializableGeoMap: (
  input: unknown,
) => SerializableGeoMap | null = SerializableGeoMapSchemaContract.safeParse;
