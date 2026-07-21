import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

export const ChartSeriesSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  color: z.string().optional(),
});

export type ChartSeries = z.infer<typeof ChartSeriesSchema>;

export const ChartPropsSchema = z
  .object({
    id: ToolUIIdSchema,
    role: ToolUIRoleSchema.optional(),
    receipt: ToolUIReceiptSchema.optional(),
    type: z.enum(["bar", "line"]),
    title: z.string().optional(),
    description: z.string().optional(),
    data: z.array(z.record(z.string(), z.unknown())).min(1),
    xKey: z.string().min(1),
    series: z.array(ChartSeriesSchema).min(1),
    /** Color palette applied to series in order. Individual series.color takes precedence. */
    colors: z.array(z.string().min(1)).min(1).optional(),
    showLegend: z.boolean().optional(),
    showGrid: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const seenSeriesKeys = new Set<string>();
    value.series.forEach((series, index) => {
      if (seenSeriesKeys.has(series.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["series", index, "key"],
          message: `Duplicate series key "${series.key}".`,
        });
        return;
      }
      seenSeriesKeys.add(series.key);
    });

    value.data.forEach((row, rowIndex) => {
      if (!(value.xKey in row)) {
        ctx.addIssue({
          code: "custom",
          path: ["data", rowIndex, value.xKey],
          message: `Missing xKey "${value.xKey}" in data row.`,
        });
      } else {
        const xVal = row[value.xKey];
        const isValidX = typeof xVal === "string" || typeof xVal === "number";
        if (!isValidX) {
          ctx.addIssue({
            code: "custom",
            path: ["data", rowIndex, value.xKey],
            message: `Expected "${value.xKey}" to be a string or number.`,
          });
        }
      }

      value.series.forEach((series) => {
        if (!(series.key in row)) {
          ctx.addIssue({
            code: "custom",
            path: ["data", rowIndex, series.key],
            message: `Missing series key "${series.key}" in data row.`,
          });
          return;
        }

        const yVal = row[series.key];
        if (yVal === null) {
          return;
        }
        if (typeof yVal !== "number" || !Number.isFinite(yVal)) {
          ctx.addIssue({
            code: "custom",
            path: ["data", rowIndex, series.key],
            message: `Expected "${series.key}" to be a finite number (or null).`,
          });
        }
      });
    });
  });

export type ChartDataPoint = {
  seriesKey: string;
  seriesLabel: string;
  xValue: unknown;
  yValue: unknown;
  index: number;
  payload: Record<string, unknown>;
};

export type ChartClientProps = {
  className?: string;
  onDataPointClick?: (point: ChartDataPoint) => void;
};

export type ChartProps = z.infer<typeof ChartPropsSchema> & ChartClientProps;

export const SerializableChartSchema = ChartPropsSchema;

export type SerializableChart = z.infer<typeof SerializableChartSchema>;

const SerializableChartSchemaContract = defineToolUiContract(
  "Chart",
  SerializableChartSchema,
);

export const parseSerializableChart: (input: unknown) => SerializableChart =
  SerializableChartSchemaContract.parse;

export const safeParseSerializableChart: (
  input: unknown,
) => SerializableChart | null = SerializableChartSchemaContract.safeParse;
