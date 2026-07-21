"use client";

import { cn, Button, Card } from "./_adapter";
import type { Item } from "./schema";

interface ItemCardProps {
  item: Item;
  onItemClick?: (itemId: string) => void;
  onItemAction?: (itemId: string, actionId: string) => void;
}

export function ItemCard({ item, onItemClick, onItemAction }: ItemCardProps) {
  const { id, name, subtitle, image, color, actions } = item;
  const isCardInteractive = typeof onItemClick === "function";

  const handleCardClick = () => {
    if (!isCardInteractive) return;
    onItemClick?.(id);
  };

  const handleActionClick = (actionId: string) => {
    onItemAction?.(id, actionId);
  };

  return (
    <Card
      className={cn(
        "group @container/card relative flex w-52 min-w-48 flex-col gap-0 self-stretch overflow-clip rounded-md p-0 @lg:w-56",
        isCardInteractive && "cursor-pointer hover:shadow",
        "touch-manipulation",
      )}
    >
      {isCardInteractive && (
        <button
          type="button"
          aria-label={`View item: ${name}`}
          className={cn(
            "absolute inset-0 z-10 rounded-md",
            "cursor-pointer touch-manipulation",
            "focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
          )}
          onClick={handleCardClick}
        />
      )}

      <div className="bg-muted relative aspect-square w-full overflow-hidden">
        {image ? (
          <img
            src={image}
            alt={name}
            loading="lazy"
            decoding="async"
            draggable={false}
            className={cn(
              "h-full w-full object-cover transition-transform duration-200",
              isCardInteractive && "group-hover:scale-105",
            )}
          />
        ) : (
          <div
            className={cn(
              "h-full w-full transition-transform duration-200",
              isCardInteractive && "group-hover:scale-105",
            )}
            style={color ? { backgroundColor: color } : undefined}
            role="img"
            aria-label={name}
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex flex-col gap-1">
          <h3 className="line-clamp-2 text-sm leading-tight font-medium">
            {name}
          </h3>

          {subtitle && (
            <p className="text-muted-foreground line-clamp-1 text-sm">
              {subtitle}
            </p>
          )}
        </div>

        {actions && actions.length > 0 && (
          <div
            className={cn(
              "relative z-20 mt-auto flex flex-col-reverse gap-2 pt-2 @[176px]/card:flex-row",
            )}
          >
            {actions.map((action) => (
              <Button
                key={action.id}
                type="button"
                variant={action.variant ?? "default"}
                size="sm"
                disabled={action.disabled}
                className="min-h-11 w-full px-3 md:min-h-8 @[176px]/card:h-8 @[176px]/card:w-auto @[176px]/card:flex-1"
                onClick={() => handleActionClick(action.id)}
              >
                {action.icon}
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
