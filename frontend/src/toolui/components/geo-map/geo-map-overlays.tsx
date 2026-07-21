"use client";

import { useMemo, useState } from "react";

import { Popup, Tooltip, cn } from "./_adapter";

function GeoMapPopupContent({
  label,
  description,
}: {
  label?: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {label && (
        <p className="block text-sm leading-tight font-semibold tracking-tight text-foreground">
          {label}
        </p>
      )}
      {description && (
        <p className="block text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

function GeoMapTooltipContent({ text }: { text: string }) {
  return <span className="block">{text}</span>;
}

export function GeoMapOverlays({
  tooltipMode,
  tooltipContent,
  label,
  description,
  tooltipClassName,
  popupClassName,
}: {
  tooltipMode: "none" | "hover" | "always";
  tooltipContent?: string;
  label?: string;
  description?: string;
  tooltipClassName?: string;
  popupClassName?: string;
}) {
  const hasPopup = Boolean(label || description);
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const shouldRenderTooltip =
    tooltipMode !== "none" && tooltipContent && (!hasPopup || !isPopupOpen);
  const popupEventHandlers = useMemo(
    () => ({
      add: () => setIsPopupOpen(true),
      remove: () => setIsPopupOpen(false),
    }),
    [],
  );

  return (
    <>
      {shouldRenderTooltip && (
        <Tooltip
          direction="top"
          permanent={tooltipMode === "always"}
          className={cn("geo-map-tooltip", tooltipClassName)}
        >
          <GeoMapTooltipContent text={tooltipContent} />
        </Tooltip>
      )}
      {hasPopup && (
        <Popup
          className={cn("geo-map-popup", popupClassName)}
          closeButton
          closeOnEscapeKey
          minWidth={0}
          maxWidth={288}
          eventHandlers={popupEventHandlers}
        >
          <GeoMapPopupContent label={label} description={description} />
        </Popup>
      )}
    </>
  );
}
