import { CheckCircle, Package } from "lucide-react";
import type { ReactElement } from "react";
import { cn, Separator } from "./_adapter";
import type {
  OrderSummaryProps,
  OrderItem,
  Pricing,
  OrderDecision,
  OrderSummaryVariant,
} from "./schema";

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatQuantity(quantity: number): string {
  return quantity === 1 ? "" : `Qty: ${quantity}`;
}

function ItemImage({ src, alt }: { src?: string; alt: string }) {
  if (!src) {
    return (
      <div className="bg-muted flex h-12 w-12 shrink-0 items-center justify-center rounded-md">
        <Package
          aria-hidden="true"
          focusable="false"
          className="text-muted-foreground h-5 w-5"
        />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      width={48}
      height={48}
      className="h-12 w-12 shrink-0 rounded-md object-cover"
    />
  );
}

function OrderItemRow({
  item,
  currency,
}: {
  item: OrderItem;
  currency: string;
}) {
  const quantity = item.quantity ?? 1;
  const quantityText = formatQuantity(quantity);
  const hasDescription = item.description || quantityText;
  const lineTotal = item.unitPrice * quantity;

  return (
    <div className="flex gap-3">
      <ItemImage src={item.imageUrl} alt={item.name} />
      <div className="flex min-w-0 flex-1 items-center justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center justify-between">
            <span className="truncate text-sm font-medium">{item.name}</span>
            <span className="truncate text-sm tabular-nums">
              {formatCurrency(lineTotal, currency)}
            </span>
          </div>
          {hasDescription && (
            <div className="text-muted-foreground truncate text-sm">
              {[item.description, quantityText].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PricingBreakdown({
  pricing,
  className,
}: {
  pricing: Pricing;
  className?: string;
}) {
  const currency = pricing.currency ?? "USD";

  return (
    <dl className={cn("flex flex-col gap-2 text-sm", className)}>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Subtotal</dt>
        <dd className="tabular-nums">
          {formatCurrency(pricing.subtotal, currency)}
        </dd>
      </div>

      {pricing.discount !== undefined && pricing.discount > 0 && (
        <div className="flex justify-between gap-4 text-green-600 dark:text-green-500">
          <dt>{pricing.discountLabel || "Discount"}</dt>
          <dd className="tabular-nums">
            -{formatCurrency(pricing.discount, currency)}
          </dd>
        </div>
      )}

      {pricing.shipping !== undefined && (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Shipping</dt>
          <dd className="tabular-nums">
            {pricing.shipping === 0
              ? "Free"
              : formatCurrency(pricing.shipping, currency)}
          </dd>
        </div>
      )}

      {pricing.tax !== undefined && (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{pricing.taxLabel || "Tax"}</dt>
          <dd className="tabular-nums">
            {formatCurrency(pricing.tax, currency)}
          </dd>
        </div>
      )}

      <div className="flex justify-between gap-4">
        <dt className="font-medium">Total</dt>
        <dd className="font-semibold tabular-nums">
          {formatCurrency(pricing.total, currency)}
        </dd>
      </div>
    </dl>
  );
}

function formatDate(isoString: string): string | undefined {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return undefined;
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return undefined;
  }
}

function ReceiptBadge({
  orderId,
  confirmedAt,
}: {
  orderId?: string;
  confirmedAt?: string;
}) {
  const formattedDate = confirmedAt ? formatDate(confirmedAt) : undefined;

  const parts = [orderId && `#${orderId}`, formattedDate].filter(Boolean);
  if (parts.length === 0) return null;

  return (
    <p className="text-muted-foreground mt-1 text-sm">{parts.join(" · ")}</p>
  );
}

function OrderSummaryRoot({
  id,
  title = "Order Summary",
  variant,
  items,
  pricing,
  choice,
  className,
}: OrderSummaryProps) {
  const titleId = `${id}-title`;
  const resolvedVariant: OrderSummaryVariant =
    variant ?? (choice === undefined ? "summary" : "receipt");
  const isReceipt = resolvedVariant === "receipt";
  const isMalformedPayload =
    !Array.isArray(items) ||
    items.length === 0 ||
    pricing == null ||
    (isReceipt && choice === undefined);

  if (isMalformedPayload) {
    return (
      <article
        data-slot="order-summary"
        data-tool-ui-id={id}
        aria-labelledby={titleId}
        className={cn("flex max-w-md min-w-80 flex-col gap-3", className)}
      >
        <div className="text-card-foreground rounded-lg border bg-card p-4 shadow-sm">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <p className="text-muted-foreground mt-2 text-sm">
            Unable to render order summary
          </p>
        </div>
      </article>
    );
  }

  return (
    <article
      data-slot="order-summary"
      data-tool-ui-id={id}
      aria-labelledby={titleId}
      className={cn("flex max-w-md min-w-80 flex-col gap-3", className)}
    >
      <div
        className={cn(
          "text-card-foreground rounded-lg border shadow-sm",
          isReceipt ? "bg-card/60" : "bg-card",
        )}
      >
        <div className={cn("space-y-4 p-4", isReceipt && "opacity-95")}>
          <div>
            <h2
              id={titleId}
              className="flex items-center gap-2 text-base font-semibold"
            >
              {isReceipt && (
                <CheckCircle
                  aria-hidden="true"
                  focusable="false"
                  className="h-5 w-5 text-green-600 dark:text-green-500"
                />
              )}
              {title}
            </h2>
            {isReceipt && choice && (
              <ReceiptBadge
                orderId={choice.orderId}
                confirmedAt={choice.confirmedAt}
              />
            )}
          </div>

          <div className="space-y-3">
            {items.map((item) => (
              <OrderItemRow
                key={item.id}
                item={item}
                currency={pricing.currency ?? "USD"}
              />
            ))}
          </div>

          <Separator />

          <PricingBreakdown pricing={pricing} />
        </div>
      </div>
    </article>
  );
}

export type OrderSummaryDisplayProps = OrderSummaryProps;

function OrderSummaryDisplay(props: OrderSummaryDisplayProps) {
  return <OrderSummaryRoot {...props} variant="summary" />;
}

export interface OrderSummaryReceiptProps extends Omit<
  OrderSummaryProps,
  "choice"
> {
  choice: OrderDecision;
}

function OrderSummaryReceipt(props: OrderSummaryReceiptProps) {
  return <OrderSummaryRoot {...props} variant="receipt" />;
}

export interface OrderSummaryCompoundComponent {
  (props: OrderSummaryProps): ReactElement;
  Display: (props: OrderSummaryDisplayProps) => ReactElement;
  Receipt: (props: OrderSummaryReceiptProps) => ReactElement;
}

export const OrderSummary: OrderSummaryCompoundComponent = Object.assign(
  OrderSummaryRoot,
  {
    Display: OrderSummaryDisplay,
    Receipt: OrderSummaryReceipt,
  },
);
