"use client";

import * as React from "react";
import {
  cn,
  Table,
  TableBody,
  TableRow,
  TableCell,
  TableHeader,
  TableHead,
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./_adapter";
import {
  sortData,
  createDataTableRowKeys,
  getDataTableMobileDescriptionId,
} from "./utilities";
import { renderFormattedValue } from "./formatters";
import type {
  DataTableProps,
  DataTableContextValue,
  RowData,
  DataTableRowData,
  ColumnKey,
  Column,
} from "./types";
import type { FormatConfig } from "./formatters";

export const DEFAULT_LOCALE = "en-US" as const;

function isNumericFormat(format?: FormatConfig): boolean {
  const kind = format?.kind;
  return (
    kind === "number" ||
    kind === "currency" ||
    kind === "percent" ||
    kind === "delta"
  );
}

function getAlignmentClass(
  align?: "left" | "right" | "center",
): string | undefined {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return undefined;
}

const DataTableContext = React.createContext<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DataTableContextValue<any> | undefined
>(undefined);

export function useDataTable<T extends object = RowData>() {
  const context = React.useContext(DataTableContext) as
    | DataTableContextValue<T>
    | undefined;
  if (!context) {
    throw new Error("useDataTable must be used within <DataTable.Provider />");
  }
  return context;
}

type DataTableLayout = "auto" | "table" | "cards";

type DataTableBaseProps<T extends object = RowData> = DataTableProps<T> & {
  layout: DataTableLayout;
};

type DataTableProviderProps<T extends object = RowData> = Pick<
  DataTableProps<T>,
  | "columns"
  | "data"
  | "rowIdKey"
  | "defaultSort"
  | "sort"
  | "onSortChange"
  | "id"
  | "locale"
> & {
  children: React.ReactNode;
};

function DataTableProvider<T extends object = RowData>({
  columns,
  data: rawData,
  rowIdKey,
  defaultSort,
  sort: controlledSort,
  id,
  onSortChange,
  locale,
  children,
}: DataTableProviderProps<T>) {
  // Default locale avoids SSR/client formatting mismatches.
  const resolvedLocale = locale ?? DEFAULT_LOCALE;

  const [internalSortBy, setInternalSortBy] = React.useState<
    ColumnKey<T> | undefined
  >(defaultSort?.by);
  const [internalSortDirection, setInternalSortDirection] = React.useState<
    "asc" | "desc" | undefined
  >(defaultSort?.direction);

  const sortBy = controlledSort?.by ?? internalSortBy;
  const sortDirection = controlledSort?.direction ?? internalSortDirection;

  const data = React.useMemo(() => {
    if (!sortBy || !sortDirection) return rawData;
    return sortData(rawData, sortBy, sortDirection, resolvedLocale);
  }, [rawData, sortBy, sortDirection, resolvedLocale]);

  const handleSort = React.useCallback(
    (key: ColumnKey<T>) => {
      let newDirection: "asc" | "desc" | undefined;

      if (sortBy === key) {
        if (sortDirection === "asc") {
          newDirection = "desc";
        } else if (sortDirection === "desc") {
          newDirection = undefined;
        } else {
          newDirection = "asc";
        }
      } else {
        newDirection = "asc";
      }

      const next = {
        by: newDirection ? key : undefined,
        direction: newDirection,
      } as const;

      if (controlledSort) {
        onSortChange?.(next);
      } else {
        setInternalSortBy(next.by);
        setInternalSortDirection(next.direction);
      }
    },
    [sortBy, sortDirection, controlledSort, onSortChange],
  );

  // User-adjustable column order + widths (drag header to reorder, drag the edge strip to resize).
  const [colOrder, setColOrder] = React.useState<string[] | null>(null);
  const [colWidths, setColWidths] = React.useState<Record<string, number>>({});
  const orderedColumns = React.useMemo(() => {
    if (!colOrder) return columns;
    const byKey = new Map(columns.map((c) => [String(c.key), c]));
    const out = colOrder.map((k) => byKey.get(k)).filter(Boolean) as Column<T>[];
    for (const c of columns) if (!colOrder.includes(String(c.key))) out.push(c);
    return out;
  }, [columns, colOrder]);
  const setColWidth = React.useCallback((key: string, px: number) => {
    setColWidths((w) => ({ ...w, [key]: Math.max(64, Math.round(px)) }));
  }, []);
  const moveColumn = React.useCallback((fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setColOrder((prev) => {
      const keys = prev ?? columns.map((c) => String(c.key));
      const next = keys.filter((k) => k !== fromKey);
      const at = next.indexOf(toKey);
      if (at < 0) return keys;
      next.splice(at, 0, fromKey);
      return next;
    });
  }, [columns]);

  const contextValue: DataTableContextValue<T> = {
    columns: orderedColumns,
    data,
    rowIdKey,
    sortBy,
    sortDirection,
    toggleSort: handleSort,
    id,
    locale: resolvedLocale,
    colWidths,
    setColWidth,
    moveColumn,
  };

  return (
    <DataTableContext.Provider value={contextValue}>
      {children}
    </DataTableContext.Provider>
  );
}

interface DataTableLayoutProps {
  layout: DataTableLayout;
  emptyMessage: string;
  maxHeight?: string;
  className?: string;
}

function DataTableLayout({
  layout,
  emptyMessage,
  maxHeight,
  className,
}: DataTableLayoutProps) {
  const { columns, data, rowIdKey, sortBy, sortDirection, id, colWidths } = useDataTable();
  const rowKeys = React.useMemo(
    () =>
      createDataTableRowKeys(
        data as Array<Record<string, unknown>>,
        rowIdKey ? String(rowIdKey) : undefined,
      ),
    [data, rowIdKey],
  );
  const mobileDescriptionId = React.useMemo(
    () => getDataTableMobileDescriptionId(String(id ?? "data-table")),
    [id],
  );

  const sortAnnouncement = React.useMemo(() => {
    const col = columns.find((c) => c.key === sortBy);
    const label = col?.label ?? sortBy;
    return sortBy && sortDirection
      ? `Sorted by ${label}, ${sortDirection === "asc" ? "ascending" : "descending"}`
      : "";
  }, [columns, sortBy, sortDirection]);

  return (
    <div
      className={cn("@container w-full min-w-80", className)}
      data-tool-ui-id={id}
      data-slot="data-table"
      data-layout={layout}
    >
      <div
        className={cn(
          layout === "table"
            ? "block"
            : layout === "cards"
              ? "hidden"
              : "hidden @md:block",
        )}
      >
        <div className="relative">
          <div
            className={cn(
              "bg-card relative w-full overflow-x-auto overflow-y-auto rounded-lg border",
              "touch-pan-x",
              maxHeight && "max-h-[--max-height]",
            )}
            style={
              maxHeight
                ? ({ "--max-height": maxHeight } as React.CSSProperties)
                : undefined
            }
          >
            <Table style={colWidths && Object.keys(colWidths).length ? { tableLayout: "fixed" } : undefined}>
              {columns.length > 0 && (
                <colgroup>
                  {columns.map((col) => {
                    const w = colWidths?.[String(col.key)] ?? col.width;
                    return (
                      <col
                        key={String(col.key)}
                        style={w ? { width: w } : undefined}
                      />
                    );
                  })}
                </colgroup>
              )}
              {data.length === 0 ? (
                <DataTableEmpty message={emptyMessage} />
              ) : (
                <DataTableContent />
              )}
            </Table>
          </div>
        </div>
      </div>

      <div
        className={cn(
          layout === "cards"
            ? ""
            : layout === "table"
              ? "hidden"
              : "@md:hidden",
        )}
        role="list"
        aria-label="Data table (mobile card view)"
        aria-describedby={mobileDescriptionId}
      >
        <div id={mobileDescriptionId} className="sr-only">
          Table data shown as expandable cards. Each card represents one row.
          {columns.length > 0 &&
            ` Columns: ${columns.map((c) => c.label).join(", ")}.`}
        </div>

        {data.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">
            {emptyMessage}
          </div>
        ) : (
          <div className="bg-card flex flex-col overflow-hidden rounded-2xl border shadow-xs">
            {data.map((row, i) => {
              const rowKey = rowKeys[i];
              return (
                <DataTableAccordionCard
                  key={rowKey}
                  row={row as unknown as DataTableRowData}
                  index={i}
                  rowKey={rowKey}
                  isFirst={i === 0}
                />
              );
            })}
          </div>
        )}
      </div>

      {sortAnnouncement && (
        <div className="sr-only" aria-live="polite">
          {sortAnnouncement}
        </div>
      )}
    </div>
  );
}

function DataTableBase<T extends object = RowData>(
  props: DataTableBaseProps<T>,
) {
  const {
    columns,
    data,
    rowIdKey,
    defaultSort,
    sort,
    onSortChange,
    id,
    locale,
    layout,
    emptyMessage = "No data available",
    maxHeight,
    className,
  } = props;

  return (
    <DataTableProvider
      columns={columns}
      data={data}
      rowIdKey={rowIdKey}
      defaultSort={defaultSort}
      sort={sort}
      onSortChange={onSortChange}
      id={id}
      locale={locale}
    >
      <DataTableLayout
        layout={layout}
        emptyMessage={emptyMessage}
        maxHeight={maxHeight}
        className={className}
      />
    </DataTableProvider>
  );
}

function DataTableRoot<T extends object = RowData>(props: DataTableProps<T>) {
  return <DataTableBase {...props} layout="auto" />;
}

function DataTableTable<T extends object = RowData>(props: DataTableProps<T>) {
  return <DataTableBase {...props} layout="table" />;
}

function DataTableCards<T extends object = RowData>(props: DataTableProps<T>) {
  return <DataTableBase {...props} layout="cards" />;
}

type DataTableComponent = {
  <T extends object = RowData>(props: DataTableProps<T>): React.ReactElement;
  Table: typeof DataTableTable;
  Cards: typeof DataTableCards;
  Provider: typeof DataTableProvider;
};

export const DataTable = Object.assign(DataTableRoot, {
  Table: DataTableTable,
  Cards: DataTableCards,
  Provider: DataTableProvider,
}) as DataTableComponent;

function DataTableContent() {
  return (
    <>
      <DataTableHeader />
      <DataTableBody />
    </>
  );
}

function DataTableEmpty({ message }: { message: string }) {
  const { columns } = useDataTable();

  return (
    <TableBody>
      <TableRow className="bg-card h-24 text-center">
        <TableCell colSpan={columns.length} role="status" aria-live="polite">
          {message}
        </TableCell>
      </TableRow>
    </TableBody>
  );
}

function SortIcon({ state }: { state?: "asc" | "desc" }) {
  let char = "⇅";
  let className = "opacity-20";

  if (state === "asc") {
    char = "↑";
    className = "";
  }

  if (state === "desc") {
    char = "↓";
    className = "";
  }

  return (
    <span aria-hidden className={cn("min-w-4 shrink-0 text-center", className)}>
      {char}
    </span>
  );
}

function DataTableHeader() {
  const { columns } = useDataTable();

  return (
    <TooltipProvider delayDuration={300}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((column, columnIndex) => (
            <DataTableHead
              key={column.key}
              column={column}
              columnIndex={columnIndex}
              totalColumns={columns.length}
            />
          ))}
        </TableRow>
      </TableHeader>
    </TooltipProvider>
  );
}

interface DataTableHeadProps {
  column: Column;
  columnIndex?: number;
  totalColumns?: number;
}

const COL_DRAG_MIME = "application/x-osw-col";

function DataTableHead({
  column,
  columnIndex = 0,
  totalColumns = 1,
}: DataTableHeadProps) {
  const { sortBy, sortDirection, toggleSort, colWidths, setColWidth, moveColumn } = useDataTable();
  const isFirstColumn = columnIndex === 0;
  const isLastColumn = columnIndex === totalColumns - 1;

  const startResize = (e: React.PointerEvent) => {
    if (!setColWidth) return;
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest("th");
    if (!th) return;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    const key = String(column.key);
    const onMove = (ev: PointerEvent) => setColWidth(key, startW + (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const isSortable = column.sortable !== false;

  const isSorted = sortBy === column.key;
  const direction = isSorted ? sortDirection : undefined;
  const isDisabled = !isSortable;

  const handleClick = () => {
    if (!isDisabled && toggleSort) {
      toggleSort(column.key);
    }
  };

  const displayText = column.abbr || column.label;
  const shouldShowTooltip = column.abbr || displayText.length > 15;
  const isNumericKind = isNumericFormat(column.format);
  const align =
    column.align ??
    (columnIndex === 0 ? "left" : isNumericKind ? "right" : "left");
  const alignClass = getAlignmentClass(align);
  const buttonAlignClass = cn(
    "min-w-0 gap-1 font-normal",
    align === "right" && "text-right",
    align === "center" && "text-center",
    align === "left" && "text-left",
  );
  const labelAlignClass =
    align === "right"
      ? "text-right"
      : align === "center"
        ? "text-center"
        : "text-left";

  const effectiveWidth = colWidths?.[String(column.key)] ?? column.width;
  return (
    <TableHead
      scope="col"
      className={cn(
        "relative",
        alignClass,
        isFirstColumn && "pl-1",
        isLastColumn && "pr-1",
      )}
      style={effectiveWidth ? { width: effectiveWidth } : undefined}
      draggable={!!moveColumn}
      onDragStart={(e: React.DragEvent) => {
        e.dataTransfer.setData(COL_DRAG_MIME, String(column.key));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e: React.DragEvent) => {
        if (e.dataTransfer.types.includes(COL_DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e: React.DragEvent) => {
        const from = e.dataTransfer.getData(COL_DRAG_MIME);
        if (from && moveColumn) {
          e.preventDefault();
          moveColumn(from, String(column.key));
        }
      }}
      aria-sort={
        isSorted
          ? direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <Button
        type="button"
        size="sm"
        onClick={handleClick}
        onKeyDown={(e) => {
          if (isDisabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        disabled={isDisabled}
        variant="ghost"
        className={cn(
          buttonAlignClass,
          "w-fit min-w-10",
          isFirstColumn && "pl-4",
          isLastColumn && "pr-4",
        )}
        aria-label={
          `Sort by ${column.label}` +
          (isSorted && direction
            ? ` (${direction === "asc" ? "ascending" : "descending"})`
            : "")
        }
        aria-disabled={isDisabled || undefined}
      >
        {shouldShowTooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("truncate", labelAlignClass)}>
                {column.abbr ? (
                  <abbr
                    title={column.label}
                    className={cn(
                      "cursor-help border-b border-dotted border-current no-underline",
                      labelAlignClass,
                    )}
                  >
                    {column.abbr}
                  </abbr>
                ) : (
                  <span className={labelAlignClass}>{column.label}</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{column.label}</p>
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className={cn("truncate", labelAlignClass)}>
            {column.label}
          </span>
        )}
        {isSortable && <SortIcon state={direction} />}
      </Button>
      {setColWidth && (
        <span
          aria-hidden
          draggable={false}
          onDragStart={(e: React.DragEvent) => e.preventDefault()}
          onPointerDown={startResize}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="hover:bg-border absolute inset-y-1 right-0 w-1 cursor-col-resize touch-none rounded select-none"
        />
      )}
    </TableHead>
  );
}

function DataTableBody() {
  const { data, rowIdKey } = useDataTable<DataTableRowData>();
  const rowKeys = React.useMemo(
    () =>
      createDataTableRowKeys(
        data as Array<Record<string, unknown>>,
        rowIdKey ? String(rowIdKey) : undefined,
      ),
    [data, rowIdKey],
  );
  const hasWarnedRowKeyRef = React.useRef(false);

  React.useEffect(() => {
    if (hasWarnedRowKeyRef.current) return;
    // Only nag when the data actually CARRIES an id-like field the caller forgot to point at; model payloads usually have none, and the warning was pure console noise for them.
    const hasIdLikeField = data.length > 0 && ["id", "uuid", "key", "symbol"].some((k) => k in (data[0] as Record<string, unknown>));
    if (process.env.NODE_ENV !== "production" && !rowIdKey && hasIdLikeField) {
      hasWarnedRowKeyRef.current = true;
      console.warn(
        "[DataTable] Missing `rowIdKey` prop. Falling back to inferred/content-derived row keys. " +
          "Strongly recommended: Pass a `rowIdKey` prop that points to a unique identifier in your row data (e.g., 'id', 'uuid', 'symbol').\n" +
          'Example: <DataTable rowIdKey="id" columns={...} data={...} />',
      );
    }
  }, [rowIdKey, data.length]);

  return (
    <TableBody>
      {data.map((row, index) => {
        const rowKey = rowKeys[index];
        return <DataTableRow key={rowKey} row={row} />;
      })}
    </TableBody>
  );
}

interface DataTableRowProps {
  row: DataTableRowData;
  className?: string;
}

function DataTableRow({ row, className }: DataTableRowProps) {
  const { columns } = useDataTable();

  return (
    <TableRow className={className}>
      {columns.map((column, columnIndex) => (
        <DataTableCell
          key={column.key}
          value={row[column.key]}
          column={column}
          row={row}
          columnIndex={columnIndex}
        />
      ))}
    </TableRow>
  );
}

interface DataTableCellProps {
  value:
    | string
    | number
    | boolean
    | null
    | (string | number | boolean | null)[];
  column: Column;
  row: DataTableRowData;
  className?: string;
  columnIndex?: number;
}

function DataTableCell({
  value,
  column,
  row,
  className,
  columnIndex = 0,
}: DataTableCellProps) {
  const { locale } = useDataTable();
  const isNumericKind = isNumericFormat(column.format);
  const isNumericValue = typeof value === "number";
  const displayValue = renderFormattedValue({ value, column, row, locale });
  const align =
    column.align ??
    (columnIndex === 0
      ? "left"
      : isNumericKind || isNumericValue
        ? "right"
        : "left");
  const alignClass = getAlignmentClass(align);

  return (
    <TableCell className={cn("px-5 py-3", alignClass, className)}>
      {displayValue}
    </TableCell>
  );
}

function categorizeColumns(columns: Column[]) {
  const primary: Column[] = [];
  const secondary: Column[] = [];

  let visibleColumnCount = 0;
  columns.forEach((col) => {
    if (col.hideOnMobile) return;

    if (col.priority === "primary") {
      primary.push(col);
    } else if (col.priority === "secondary") {
      secondary.push(col);
    } else if (col.priority === "tertiary") {
      return;
    } else {
      if (visibleColumnCount < 2) {
        primary.push(col);
      } else {
        secondary.push(col);
      }
      visibleColumnCount++;
    }
  });

  return { primary, secondary };
}

interface DataTableAccordionCardProps {
  row: DataTableRowData;
  index: number;
  rowKey: string;
  isFirst?: boolean;
}

function getDataTableRowDomId(rowKey: string): string {
  return encodeURIComponent(rowKey).replace(/%/g, "_");
}

function DataTableAccordionCard({
  row,
  index,
  rowKey,
  isFirst = false,
}: DataTableAccordionCardProps) {
  const { columns, locale } = useDataTable();

  const { primary, secondary } = React.useMemo(
    () => categorizeColumns(columns),
    [columns],
  );

  if (secondary.length === 0) {
    return (
      <SimpleCard
        row={row}
        columns={primary}
        index={index}
        rowKey={rowKey}
        isFirst={isFirst}
      />
    );
  }

  const primaryColumn = primary[0];
  const remainingPrimaryColumns = primary.slice(1);

  const stableRowId = getDataTableRowDomId(rowKey);

  const headingId = `row-${stableRowId}-heading`;
  const detailsId = `row-${stableRowId}-details`;
  const remainingPrimaryDataIds = remainingPrimaryColumns.map(
    (col) => `row-${stableRowId}-${String(col.key)}`,
  );

  const primaryValue = primaryColumn
    ? String(row[primaryColumn.key] ?? "")
    : "";
  const rowLabel = `Row ${index + 1}: ${primaryValue}`;
  const accordionItemId = `row-${stableRowId}`;

  return (
    <Accordion
      type="single"
      collapsible
      className={cn(!isFirst && "border-t")}
      role="listitem"
      aria-label={rowLabel}
    >
      <AccordionItem value={accordionItemId} className="group border-0">
        <AccordionTrigger
          className="group-data-[state=closed]:hover:bg-accent/50 active:bg-accent/50 group-data-[state=open]:bg-muted w-full rounded-none px-4 py-3 hover:no-underline"
          aria-controls={detailsId}
          aria-label={`${rowLabel}. ${secondary.length > 0 ? "Expand for details" : ""}`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {primaryColumn && (
              <div
                id={headingId}
                role="heading"
                aria-level={3}
                className="truncate"
                aria-label={`${primaryColumn.label}: ${row[primaryColumn.key]}`}
              >
                {renderFormattedValue({
                  value: row[primaryColumn.key],
                  column: primaryColumn,
                  row,
                  locale,
                })}
              </div>
            )}

            {remainingPrimaryColumns.length > 0 && (
              <div
                className="text-muted-foreground flex w-full flex-wrap gap-x-4 gap-y-0.5"
                role="group"
                aria-label="Summary information"
              >
                {remainingPrimaryColumns.map((col, idx) => (
                  <span
                    key={col.key}
                    id={remainingPrimaryDataIds[idx]}
                    className="flex min-w-0 gap-1 font-normal"
                    role="cell"
                    aria-label={`${col.label}: ${row[col.key]}`}
                  >
                    <span className="sr-only">{col.label}:</span>
                    <span aria-hidden="true">{col.label}:</span>
                    <span className="truncate">
                      {renderFormattedValue({
                        value: row[col.key],
                        column: col,
                        row,
                        locale,
                      })}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </AccordionTrigger>

        <AccordionContent
          className={"flex flex-col gap-4 px-4 pb-4"}
          id={detailsId}
          role="region"
          aria-labelledby={headingId}
        >
          {secondary.length > 0 && (
            <dl
              className={cn(
                "flex flex-col gap-2 pt-4",
                "motion-safe:group-data-[state=open]:animate-in motion-safe:group-data-[state=open]:fade-in-0",
                "motion-safe:group-data-[state=open]:slide-in-from-top-1",
                "motion-safe:group-data-[state=closed]:animate-out motion-safe:group-data-[state=closed]:fade-out-0",
                "motion-safe:group-data-[state=closed]:slide-out-to-top-1",
                "duration-150",
              )}
              role="list"
              aria-label="Additional data"
            >
              {secondary.map((col) => (
                <div
                  key={col.key}
                  className="flex items-start justify-between gap-4"
                  role="listitem"
                >
                  <dt
                    className="text-muted-foreground shrink-0"
                    id={`row-${stableRowId}-${String(col.key)}-label`}
                  >
                    {col.label}
                  </dt>
                  <dd
                    className={cn(
                      "text-foreground min-w-0 text-pretty wrap-break-word",
                      col.align === "right" && "text-right",
                      col.align === "center" && "text-center",
                    )}
                    role="cell"
                    aria-labelledby={`row-${stableRowId}-${String(col.key)}-label`}
                  >
                    {renderFormattedValue({
                      value: row[col.key],
                      column: col,
                      row,
                      locale,
                    })}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

/**
 * Simple card with no accordion,   for when there are only primary columns
 */
function SimpleCard({
  row,
  columns,
  index,
  rowKey,
  isFirst = false,
}: {
  row: DataTableRowData;
  columns: Column[];
  index: number;
  rowKey: string;
  isFirst?: boolean;
}) {
  const { locale } = useDataTable();
  const primaryColumn = columns[0];
  const otherColumns = columns.slice(1);

  const stableRowId = getDataTableRowDomId(rowKey);

  const primaryValue = primaryColumn
    ? String(row[primaryColumn.key] ?? "")
    : "";
  const rowLabel = `Row ${index + 1}: ${primaryValue}`;

  return (
    <div
      className={cn("flex flex-col gap-2 p-4", !isFirst && "border-t")}
      role="listitem"
      aria-label={rowLabel}
    >
      {primaryColumn && (
        <div
          role="heading"
          aria-level={3}
          aria-label={`${primaryColumn.label}: ${row[primaryColumn.key]}`}
        >
          {renderFormattedValue({
            value: row[primaryColumn.key],
            column: primaryColumn,
            row,
            locale,
          })}
        </div>
      )}

      {otherColumns.map((col) => (
        <div
          key={col.key}
          className="flex items-start justify-between gap-4"
          role="group"
        >
          <span
            className="text-muted-foreground"
            id={`row-${stableRowId}-${String(col.key)}-label`}
          >
            {col.label}:
          </span>
          <span
            className={cn(
              "min-w-0 wrap-break-word",
              col.align === "right" && "text-right",
              col.align === "center" && "text-center",
            )}
            role="cell"
            aria-labelledby={`row-${stableRowId}-${String(col.key)}-label`}
          >
            {renderFormattedValue({
              value: row[col.key],
              column: col,
              row,
              locale,
            })}
          </span>
        </div>
      ))}
    </div>
  );
}
