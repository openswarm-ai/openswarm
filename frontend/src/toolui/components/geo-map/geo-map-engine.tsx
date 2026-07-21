"use client";

import type { Map as LeafletMap } from "leaflet";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Supercluster from "supercluster";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  ZoomControl,
  useMap,
  useMapEvents,
} from "./_adapter";
import { createClusterIcon, resolveMarkerIcon } from "./geo-map-icons";
import { GeoMapOverlays } from "./geo-map-overlays";
import type {
  GeoMapClustering,
  GeoMapFitTarget,
  GeoMapMarker,
  GeoMapRoute,
  GeoMapViewport,
} from "./schema";

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
const ROUTE_DEFAULT_COLOR = "var(--primary)";
const ROUTE_DEFAULT_WEIGHT = 3;
const ROUTE_DEFAULT_OPACITY = 0.85;
const EMPTY_ROUTES: GeoMapRoute[] = [];

const CLUSTER_RADIUS_DEFAULT = 60;
const CLUSTER_MAX_ZOOM_DEFAULT = 16;
const CLUSTER_MIN_POINTS_DEFAULT = 2;

const DEFAULT_CENTER: [number, number] = [20, 0];
export const DEFAULT_VIEW_ZOOM = 2;
const SINGLE_LOCATION_ZOOM = 13;
const DEFAULT_VIEWPORT_PADDING = 32;

type LeafletRuntime = Pick<
  typeof import("leaflet"),
  "divIcon" | "latLngBounds"
>;

export type GeoMapBbox = [
  west: number,
  south: number,
  east: number,
  north: number,
];
export type GeoMapLatLng = [lat: number, lng: number];

export type GeoMapClusterProperties = {
  cluster?: boolean;
  cluster_id?: number;
  point_count?: number;
  markerId?: string;
};

export type GeoMapClusterFeature = GeoJSON.Feature<
  GeoJSON.Point,
  GeoMapClusterProperties
>;

type MarkerClusterPointProperties = GeoMapClusterProperties & {
  markerId?: string;
  marker?: GeoMapMarker;
};

type MapViewportState = {
  bbox: GeoMapBbox;
  zoom: number;
};

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeViewportState(state: MapViewportState): MapViewportState {
  return {
    bbox: [
      roundCoordinate(state.bbox[0]),
      roundCoordinate(state.bbox[1]),
      roundCoordinate(state.bbox[2]),
      roundCoordinate(state.bbox[3]),
    ],
    zoom: state.zoom,
  };
}

function areViewportStatesEqual(
  a: MapViewportState | null,
  b: MapViewportState,
): boolean {
  if (!a) {
    return false;
  }

  return (
    a.zoom === b.zoom &&
    a.bbox[0] === b.bbox[0] &&
    a.bbox[1] === b.bbox[1] &&
    a.bbox[2] === b.bbox[2] &&
    a.bbox[3] === b.bbox[3]
  );
}

function serializeFitPoints(points: [number, number][]): string {
  return points
    .map(([lat, lng]) => `${roundCoordinate(lat)},${roundCoordinate(lng)}`)
    .join("|");
}

function readViewportState(map: LeafletMap): MapViewportState {
  const bounds = map.getBounds();
  return normalizeViewportState({
    bbox: [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ],
    zoom: Math.round(map.getZoom()),
  });
}

export function collectFitPoints(
  markers: GeoMapMarker[],
  routes: GeoMapRoute[],
  target: GeoMapFitTarget,
): GeoMapLatLng[] {
  const markerPoints =
    target === "markers" || target === "all"
      ? markers.map((marker) => [marker.lat, marker.lng] as GeoMapLatLng)
      : [];

  const routePoints =
    target === "routes" || target === "all"
      ? routes.flatMap((route) =>
          route.points.map((point) => [point.lat, point.lng] as GeoMapLatLng),
        )
      : [];

  return [...markerPoints, ...routePoints];
}

export function resolveFitPointsWithFallback(
  markers: GeoMapMarker[],
  routes: GeoMapRoute[],
  target: GeoMapFitTarget,
): GeoMapLatLng[] {
  const selected = collectFitPoints(markers, routes, target);
  if (selected.length > 0) {
    return selected;
  }

  if (target !== "markers") {
    return collectFitPoints(markers, routes, "markers");
  }

  return [];
}

export function splitDatelineBbox(bbox: GeoMapBbox): GeoMapBbox[] {
  const [west, south, east, north] = bbox;

  if (west <= east) {
    return [bbox];
  }

  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ];
}

function getClusterFeatureKey(feature: GeoMapClusterFeature): string {
  const properties = feature.properties ?? {};

  if (properties.cluster && typeof properties.cluster_id === "number") {
    return `cluster:${properties.cluster_id}`;
  }

  if (
    typeof properties.markerId === "string" &&
    properties.markerId.length > 0
  ) {
    return `marker:${properties.markerId}`;
  }

  if (feature.id !== undefined && feature.id !== null) {
    return `id:${String(feature.id)}`;
  }

  const [lng, lat] = feature.geometry.coordinates;
  return `point:${lat}:${lng}`;
}

function dedupeClusterFeatures(
  features: GeoMapClusterFeature[],
): GeoMapClusterFeature[] {
  const seen = new Set<string>();
  const deduped: GeoMapClusterFeature[] = [];

  features.forEach((feature) => {
    const key = getClusterFeatureKey(feature);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    deduped.push(feature);
  });

  return deduped;
}

export function getClustersForDatelineAwareBbox(
  bbox: GeoMapBbox,
  zoom: number,
  getClustersForBbox: (
    candidateBbox: GeoMapBbox,
    zoom: number,
  ) => GeoMapClusterFeature[],
): GeoMapClusterFeature[] {
  const queried = splitDatelineBbox(bbox).flatMap((candidateBbox) =>
    getClustersForBbox(candidateBbox, zoom),
  );

  return dedupeClusterFeatures(queried);
}

export function toSafeExpansionZoom(
  zoom: number,
  options?: { minZoom?: number; maxZoom?: number; fallback?: number },
): number {
  const minZoom = options?.minZoom ?? 1;
  const maxZoom = options?.maxZoom ?? 22;
  const fallback = options?.fallback ?? 2;

  if (!Number.isFinite(zoom)) {
    return fallback;
  }

  return Math.min(maxZoom, Math.max(minZoom, Math.round(zoom)));
}

function resolveInitialView(
  markers: GeoMapMarker[],
  routes: GeoMapRoute[],
  viewport: GeoMapViewport | undefined,
): { center: [number, number]; zoom: number } {
  if (viewport?.mode === "center") {
    return {
      center: [viewport.center.lat, viewport.center.lng],
      zoom: viewport.zoom,
    };
  }

  const fitTarget = viewport?.target ?? "all";
  const fitPoints = resolveFitPointsWithFallback(markers, routes, fitTarget);

  if (fitPoints.length === 1) {
    return {
      center: [fitPoints[0][0], fitPoints[0][1]],
      zoom: viewport?.maxZoom
        ? Math.min(SINGLE_LOCATION_ZOOM, viewport.maxZoom)
        : SINGLE_LOCATION_ZOOM,
    };
  }

  return { center: DEFAULT_CENTER, zoom: DEFAULT_VIEW_ZOOM };
}

function ViewportController({
  markers,
  routes,
  viewport,
  leafletRuntime,
}: {
  markers: GeoMapMarker[];
  routes: GeoMapRoute[];
  viewport: GeoMapViewport | undefined;
  leafletRuntime: LeafletRuntime;
}) {
  const map = useMap();
  const lastAppliedViewportRef = useRef<string | null>(null);

  useEffect(() => {
    lastAppliedViewportRef.current = null;
  }, [map]);

  useEffect(() => {
    if (viewport?.mode === "center") {
      const viewportKey = `center:${roundCoordinate(viewport.center.lat)}:${roundCoordinate(viewport.center.lng)}:${viewport.zoom}`;
      if (lastAppliedViewportRef.current === viewportKey) {
        return;
      }

      lastAppliedViewportRef.current = viewportKey;
      map.setView([viewport.center.lat, viewport.center.lng], viewport.zoom);
      return;
    }

    const fitTarget = viewport?.target ?? "all";
    const fitPoints = resolveFitPointsWithFallback(markers, routes, fitTarget);
    if (fitPoints.length === 0) {
      return;
    }

    const maxZoom = viewport?.maxZoom;
    if (fitPoints.length === 1) {
      const [lat, lng] = fitPoints[0];
      const zoom = maxZoom
        ? Math.min(SINGLE_LOCATION_ZOOM, maxZoom)
        : SINGLE_LOCATION_ZOOM;
      const viewportKey = `fit-single:${roundCoordinate(lat)}:${roundCoordinate(lng)}:${zoom}`;
      if (lastAppliedViewportRef.current === viewportKey) {
        return;
      }

      lastAppliedViewportRef.current = viewportKey;
      map.setView([lat, lng], zoom);
      return;
    }

    const padding = viewport?.padding ?? DEFAULT_VIEWPORT_PADDING;
    const viewportKey = `fit:${fitTarget}:${padding}:${maxZoom ?? "none"}:${serializeFitPoints(fitPoints)}`;
    if (lastAppliedViewportRef.current === viewportKey) {
      return;
    }

    lastAppliedViewportRef.current = viewportKey;
    const bounds = leafletRuntime.latLngBounds(fitPoints);
    map.fitBounds(bounds, {
      maxZoom,
      padding: [padding, padding],
    });
  }, [leafletRuntime, map, markers, routes, viewport]);

  return null;
}

function MapObserver({
  onViewportChange,
  onMapReady,
}: {
  onViewportChange: (state: MapViewportState) => void;
  onMapReady: (map: LeafletMap) => void;
}) {
  const map = useMapEvents({
    moveend: () => {
      onViewportChange(readViewportState(map));
    },
    zoomend: () => {
      onViewportChange(readViewportState(map));
    },
  });

  useEffect(() => {
    onMapReady(map);
    onViewportChange(readViewportState(map));
  }, [map, onMapReady, onViewportChange]);

  return null;
}

function resolveMarkerAriaLabel(marker: GeoMapMarker): string {
  if (marker.label && marker.description) {
    return `${marker.label}. ${marker.description}`;
  }

  return (
    marker.label ??
    marker.description ??
    `Marker at ${marker.lat.toFixed(4)}, ${marker.lng.toFixed(4)}`
  );
}

export const GeoMapEngine = memo(function GeoMapEngine({
  id,
  markers,
  routes,
  clustering,
  viewport,
  showZoomControl,
  tileUrl,
  mapAriaLabel,
  tooltipClassName,
  popupClassName,
  onMarkerClick,
  onRouteClick,
  onReadyChange,
}: {
  id: string;
  markers: GeoMapMarker[];
  routes?: GeoMapRoute[];
  clustering?: GeoMapClustering;
  viewport?: GeoMapViewport;
  showZoomControl: boolean;
  tileUrl: string;
  mapAriaLabel: string;
  tooltipClassName?: string;
  popupClassName?: string;
  onMarkerClick?: (marker: GeoMapMarker) => void;
  onRouteClick?: (route: GeoMapRoute) => void;
  onReadyChange?: (isReady: boolean) => void;
}) {
  const resolvedRoutes = routes ?? EMPTY_ROUTES;
  const [leafletRuntime, setLeafletRuntime] = useState<LeafletRuntime | null>(
    null,
  );
  const [mapInstance, setMapInstance] = useState<LeafletMap | null>(null);
  const [viewportState, setViewportState] = useState<MapViewportState | null>(
    null,
  );

  const handleViewportChange = useCallback((nextState: MapViewportState) => {
    const normalized = normalizeViewportState(nextState);
    setViewportState((previousState) =>
      areViewportStatesEqual(previousState, normalized)
        ? previousState
        : normalized,
    );
  }, []);

  useEffect(() => {
    let isActive = true;

    void import("leaflet").then((module) => {
      if (!isActive) {
        return;
      }

      setLeafletRuntime({
        divIcon: module.divIcon,
        latLngBounds: module.latLngBounds,
      });
    });

    return () => {
      isActive = false;
    };
  }, []);

  const isReady = leafletRuntime !== null;

  useEffect(() => {
    onReadyChange?.(isReady);
  }, [isReady, onReadyChange]);

  useEffect(() => {
    if (!mapInstance) {
      return;
    }

    const container = mapInstance.getContainer();
    container.setAttribute("role", "region");
    container.setAttribute("aria-label", mapAriaLabel);
  }, [mapAriaLabel, mapInstance]);

  useEffect(() => {
    if (!mapInstance) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        mapInstance.closePopup();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [mapInstance]);

  const initialView = useMemo(
    () => resolveInitialView(markers, resolvedRoutes, viewport),
    [markers, resolvedRoutes, viewport],
  );

  const markerById = useMemo(() => {
    const map = new Map<string, GeoMapMarker>();
    markers.forEach((marker, index) => {
      map.set(marker.id ?? `marker-${index}`, marker);
    });
    return map;
  }, [markers]);

  const clusterConfig = useMemo(
    () => ({
      enabled: clustering?.enabled === true,
      radius: clustering?.radius ?? CLUSTER_RADIUS_DEFAULT,
      maxZoom: clustering?.maxZoom ?? CLUSTER_MAX_ZOOM_DEFAULT,
      minPoints: clustering?.minPoints ?? CLUSTER_MIN_POINTS_DEFAULT,
    }),
    [clustering],
  );

  const clusterIndex = useMemo(() => {
    if (!clusterConfig.enabled) {
      return null;
    }

    const index = new Supercluster<MarkerClusterPointProperties>({
      radius: clusterConfig.radius,
      maxZoom: clusterConfig.maxZoom,
      minPoints: clusterConfig.minPoints,
    });

    const points = markers.map((marker, index) => {
      const markerId = marker.id ?? `marker-${index}`;
      return {
        type: "Feature" as const,
        id: markerId,
        geometry: {
          type: "Point" as const,
          coordinates: [marker.lng, marker.lat] as [number, number],
        },
        properties: {
          markerId,
          marker,
        },
      };
    });

    index.load(points);
    return index;
  }, [
    clusterConfig.enabled,
    clusterConfig.maxZoom,
    clusterConfig.minPoints,
    clusterConfig.radius,
    markers,
  ]);

  const clusteredFeatures = useMemo(() => {
    if (!clusterConfig.enabled || !clusterIndex || !viewportState) {
      return [] as GeoMapClusterFeature[];
    }

    return getClustersForDatelineAwareBbox(
      viewportState.bbox,
      viewportState.zoom,
      (bbox, zoom) =>
        clusterIndex.getClusters(bbox, zoom) as GeoMapClusterFeature[],
    );
  }, [clusterConfig.enabled, clusterIndex, viewportState]);

  const renderMarker = useCallback(
    (
      marker: GeoMapMarker,
      markerKey: string,
      markerPositionOverride?: [number, number],
    ) => {
      const markerPosition: [number, number] = markerPositionOverride ?? [
        marker.lat,
        marker.lng,
      ];
      const tooltipMode = marker.tooltip ?? "hover";
      const tooltipContent = marker.label ?? marker.description;
      const icon = marker.icon;
      const markerAriaLabel = resolveMarkerAriaLabel(marker);

      if (!leafletRuntime) {
        return null;
      }

      const leafletIcon = resolveMarkerIcon(icon, leafletRuntime);
      if (leafletIcon) {
        return (
          <Marker
            key={markerKey}
            position={markerPosition}
            icon={leafletIcon}
            title={markerAriaLabel}
            alt={markerAriaLabel}
            eventHandlers={{
              click: () => onMarkerClick?.(marker),
            }}
          >
            <GeoMapOverlays
              tooltipMode={tooltipMode}
              tooltipContent={tooltipContent}
              label={marker.label}
              description={marker.description}
              tooltipClassName={tooltipClassName}
              popupClassName={popupClassName}
            />
          </Marker>
        );
      }

      const markerStroke =
        icon?.type === "dot"
          ? (icon.borderColor ?? "var(--border)")
          : "var(--border)";
      const markerFill =
        icon?.type === "dot"
          ? (icon.color ?? "var(--primary)")
          : "var(--primary)";
      const markerRadius = icon?.type === "dot" ? (icon.radius ?? 7) : 7;

      return (
        <CircleMarker
          key={markerKey}
          center={markerPosition}
          radius={markerRadius}
          pathOptions={{
            color: markerStroke,
            fillColor: markerFill,
            fillOpacity: 0.95,
            weight: 2,
          }}
          eventHandlers={{
            click: () => onMarkerClick?.(marker),
          }}
        >
          <GeoMapOverlays
            tooltipMode={tooltipMode}
            tooltipContent={tooltipContent}
            label={marker.label}
            description={marker.description}
            tooltipClassName={tooltipClassName}
            popupClassName={popupClassName}
          />
        </CircleMarker>
      );
    },
    [leafletRuntime, onMarkerClick, popupClassName, tooltipClassName],
  );

  if (!leafletRuntime) {
    return null;
  }

  return (
    <MapContainer
      center={initialView.center}
      zoom={initialView.zoom}
      zoomControl={false}
      className="h-full w-full"
      scrollWheelZoom
    >
      <TileLayer attribution={TILE_ATTRIBUTION} url={tileUrl} />
      {showZoomControl && <ZoomControl position="topright" />}
      <MapObserver
        onMapReady={setMapInstance}
        onViewportChange={handleViewportChange}
      />
      <ViewportController
        leafletRuntime={leafletRuntime}
        markers={markers}
        routes={resolvedRoutes}
        viewport={viewport}
      />

      {resolvedRoutes.map((route, routeIndex) => {
        const routeKey = route.id ?? `${id}-route-${routeIndex}`;
        const positions = route.points.map((point) => [
          point.lat,
          point.lng,
        ]) as [number, number][];
        const tooltipMode = route.tooltip ?? "hover";
        const tooltipContent = route.label ?? route.description;

        return (
          <Polyline
            key={routeKey}
            positions={positions}
            pathOptions={{
              color: route.color ?? ROUTE_DEFAULT_COLOR,
              weight: route.weight ?? ROUTE_DEFAULT_WEIGHT,
              opacity: route.opacity ?? ROUTE_DEFAULT_OPACITY,
              dashArray: route.dashArray,
            }}
            eventHandlers={{
              click: () => onRouteClick?.(route),
            }}
          >
            <GeoMapOverlays
              tooltipMode={tooltipMode}
              tooltipContent={tooltipContent}
              label={route.label}
              description={route.description}
              tooltipClassName={tooltipClassName}
              popupClassName={popupClassName}
            />
          </Polyline>
        );
      })}

      {clusterConfig.enabled && clusterIndex && viewportState
        ? clusteredFeatures.map((feature, index) => {
            const [lng, lat] = feature.geometry.coordinates;
            const properties = (feature.properties ??
              {}) as MarkerClusterPointProperties;

            if (
              properties.cluster &&
              typeof properties.cluster_id === "number"
            ) {
              const pointCount = properties.point_count ?? 0;
              const clusterId = properties.cluster_id;
              const clusterIcon = createClusterIcon(pointCount, leafletRuntime);
              const clusterAriaLabel = `Cluster containing ${pointCount} locations`;

              return (
                <Marker
                  key={`cluster-${clusterId}`}
                  position={[lat, lng]}
                  icon={clusterIcon}
                  title={clusterAriaLabel}
                  alt={clusterAriaLabel}
                  eventHandlers={{
                    click: () => {
                      if (!mapInstance) {
                        return;
                      }

                      const expansionZoom = toSafeExpansionZoom(
                        clusterIndex.getClusterExpansionZoom(clusterId),
                        {
                          maxZoom: 22,
                          fallback:
                            (viewportState.zoom ?? DEFAULT_VIEW_ZOOM) + 2,
                        },
                      );
                      mapInstance.flyTo([lat, lng], expansionZoom);
                    },
                  }}
                />
              );
            }

            const marker =
              properties.marker ??
              markerById.get(properties.markerId ?? `marker-${index}`);
            if (!marker) {
              return null;
            }

            const markerKey =
              marker.id ?? properties.markerId ?? `${id}-cluster-leaf-${index}`;
            return renderMarker(marker, markerKey, [lat, lng]);
          })
        : markers.map((marker, index) =>
            renderMarker(marker, marker.id ?? `${id}-marker-${index}`),
          )}
    </MapContainer>
  );
});
