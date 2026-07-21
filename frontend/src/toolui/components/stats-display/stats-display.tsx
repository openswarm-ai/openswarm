"use client";
import {
  cn,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./_adapter";
import type {
  StatsDisplayProps,
  StatItem,
  StatFormat,
  StatDiff,
} from "./schema";
import { Sparkline } from "./sparkline";

interface FormattedValueProps {
  value: string | number;
  format?: StatFormat;
  locale?: string;
}

function FormattedValue({ value, format, locale }: FormattedValueProps) {
  if (typeof value === "string" || !format) {
    return <span className="font-light tabular-nums">{String(value)}</span>;
  }

  switch (format.kind) {
    case "number": {
      const decimals = format.decimals ?? 0;
      if (format.compact) {
        const parts = new Intl.NumberFormat(locale, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
          notation: "compact",
        }).formatToParts(value);
        const fullNumber = new Intl.NumberFormat(locale).format(value);
        return (
          <span className="font-light tabular-nums" aria-label={fullNumber}>
            {parts.map((part, i) =>
              part.type === "compact" ? (
                <span
                  key={i}
                  className="ml-0.5 text-[0.65em] opacity-80"
                  aria-hidden="true"
                >
                  {part.value}
                </span>
              ) : (
                <span key={i}>{part.value}</span>
              ),
            )}
          </span>
        );
      }
      const formatted = new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value);
      return <span className="font-light tabular-nums">{formatted}</span>;
    }
    case "currency": {
      const currency = format.currency;
      const decimals = format.decimals ?? 2;
      const formatted = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value);
      const spokenValue = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        currencyDisplay: "name",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value);
      return (
        <span className="font-light tabular-nums" aria-label={spokenValue}>
          {formatted}
        </span>
      );
    }
    case "percent": {
      const decimals = format.decimals ?? 2;
      const basis = format.basis ?? "fraction";
      const numeric = basis === "fraction" ? value * 100 : value;
      const formatted = numeric.toFixed(decimals);
      return (
        <span
          className="font-light tabular-nums"
          aria-label={`${formatted} percent`}
        >
          {formatted}
          <span className="ml-0.5 text-[0.65em] opacity-80" aria-hidden="true">
            %
          </span>
        </span>
      );
    }
    case "text":
    default:
      return <span className="font-light tabular-nums">{String(value)}</span>;
  }
}

interface DeltaValueProps {
  diff: StatDiff;
}

function DeltaValue({ diff }: DeltaValueProps) {
  const { value, decimals = 1, upIsPositive = true, label } = diff;

  const isPositive = value > 0;
  const isNegative = value < 0;

  const isGood = upIsPositive ? isPositive : isNegative;
  const isBad = upIsPositive ? isNegative : isPositive;

  const colorClass = isGood
    ? "text-green-600 dark:text-green-400"
    : isBad
      ? "text-red-600 dark:text-red-500"
      : "text-muted-foreground";

  const bgClass = isGood
    ? "bg-green-500/10 dark:bg-green-600/15"
    : isBad
      ? "bg-red-500/10 dark:bg-red-500/15"
      : "bg-muted";

  const formatted = Math.abs(value).toFixed(decimals);
  const sign = isNegative ? "−" : "+";
  const display = `${sign}${formatted}%`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs  tabular-nums",
        colorClass,
        bgClass,
      )}
    >
      {!upIsPositive && (
        <span className="text-[0.9em]">{isGood ? "↓" : "↑"}</span>
      )}
      {display}
      {label && (
        <span className="text-muted-foreground font-normal">{label}</span>
      )}
    </span>
  );
}

interface StatCardProps {
  stat: StatItem;
  locale?: string;
  isSingle?: boolean;
  index?: number;
}

function StatCard({
  stat,
  locale,
  isSingle = false,
  index = 0,
}: StatCardProps) {
  const sparklineColor = stat.sparkline?.color ?? "var(--muted-foreground)";
  const hasSparkline = Boolean(stat.sparkline);
  const baseDelay = index * 175;

  return (
    <div
      className={cn(
        "relative flex min-h-28 flex-col gap-1 px-6",
        isSingle ? "justify-center" : "justify-end",
      )}
    >
      {hasSparkline && (
        <Sparkline
          data={stat.sparkline!.data}
          color={sparklineColor}
          showFill
          fillOpacity={0.09}
          className="pointer-events-none absolute inset-x-0 top-2 bottom-2 animate-in fade-in slide-in-from-bottom-12 duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] fill-mode-both"
          style={{ animationDelay: `${baseDelay}ms` }}
        />
      )}
      <span
        className="text-muted-foreground relative text-xs font-normal tracking-wider uppercase opacity-90 animate-in fade-in slide-in-from-bottom-1 duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] fill-mode-both"
        style={{ animationDelay: `${baseDelay + 75}ms` }}
      >
        {stat.label}
      </span>
      <div
        className="relative flex items-baseline gap-2 pb-2 animate-in fade-in slide-in-from-bottom-2 duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] fill-mode-both"
        style={{ animationDelay: `${baseDelay + 150}ms` }}
      >
        <span
          className={cn(
            "font-light tracking-normal",
            isSingle ? "text-5xl" : "text-3xl",
          )}
        >
          <FormattedValue
            value={stat.value}
            format={stat.format}
            locale={locale}
          />
        </span>
        {stat.diff && <DeltaValue diff={stat.diff} />}
      </div>
    </div>
  );
}

export function StatsDisplay({
  id,
  title,
  description,
  stats,
  className,
  locale: localeProp,
}: StatsDisplayProps) {
  const locale =
    localeProp ??
    (typeof navigator !== "undefined" ? navigator.language : undefined);
  const hasHeader = Boolean(title || description);
  const isSingle = stats.length === 1;

  return (
    <article
      data-slot="stats-display"
      data-tool-ui-id={id}
      className={cn(
        "w-full min-w-80 max-w-xl",
        isSingle && "max-w-sm",
        className,
      )}
    >
      <Card className={cn("overflow-clip !pb-0 !pt-2", hasHeader && "!gap-0")}>
        {hasHeader && (
          <CardHeader className="border-b border-border !pt-3 !pb-4">
            {title && <CardTitle className="text-pretty">{title}</CardTitle>}
            {description && (
              <CardDescription className="text-pretty">
                {description}
              </CardDescription>
            )}
          </CardHeader>
        )}
        <CardContent className="@container overflow-hidden p-0">
          <div
            className="grid @[440px]:-ml-px @[440px]:-mt-px"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            }}
          >
            {stats.map((stat, index) => (
              <div
                key={stat.key}
                className={cn(
                  "overflow-clip py-3 first:pt-0 @[440px]:py-3 @[440px]:first:pt-3 @[440px]:border-l @[440px]:border-t @[440px]:border-border",
                  index > 0 && "border-border border-t",
                )}
              >
                <StatCard
                  stat={stat}
                  locale={locale}
                  isSingle={isSingle}
                  index={index}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </article>
  );
}
