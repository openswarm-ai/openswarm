import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import { ToolUIIdSchema, ToolUIRoleSchema } from "../shared/schema";

const TextFormatSchema = z.object({
  kind: z.literal("text"),
});

const NumberFormatSchema = z.object({
  kind: z.literal("number"),
  decimals: z.number().int().min(0).optional(),
  compact: z.boolean().optional(),
});

const CurrencyFormatSchema = z.object({
  kind: z.literal("currency"),
  currency: z.string().min(1),
  decimals: z.number().int().min(0).optional(),
});

const PercentFormatSchema = z.object({
  kind: z.literal("percent"),
  decimals: z.number().int().min(0).optional(),
  basis: z.enum(["fraction", "unit"]).optional(),
});

export const StatFormatSchema = z.discriminatedUnion("kind", [
  TextFormatSchema,
  NumberFormatSchema,
  CurrencyFormatSchema,
  PercentFormatSchema,
]);

export type StatFormat = z.infer<typeof StatFormatSchema>;

export const StatDiffSchema = z.object({
  value: z.number(),
  decimals: z.number().int().min(0).optional(),
  upIsPositive: z.boolean().optional(),
  label: z.string().optional(),
});

export type StatDiff = z.infer<typeof StatDiffSchema>;

export const StatSparklineSchema = z.object({
  data: z.array(z.number()).min(2),
  color: z.string().optional(),
});

export type StatSparkline = z.infer<typeof StatSparklineSchema>;

export const StatItemSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  format: StatFormatSchema.optional(),
  diff: StatDiffSchema.optional(),
  sparkline: StatSparklineSchema.optional(),
});

export type StatItem = z.infer<typeof StatItemSchema>;

export const SerializableStatsDisplaySchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  stats: z.array(StatItemSchema).min(1),
});

export type SerializableStatsDisplay = z.infer<
  typeof SerializableStatsDisplaySchema
>;

const SerializableStatsDisplaySchemaContract = defineToolUiContract(
  "StatsDisplay",
  SerializableStatsDisplaySchema,
);

export const parseSerializableStatsDisplay: (
  input: unknown,
) => SerializableStatsDisplay = SerializableStatsDisplaySchemaContract.parse;

export const safeParseSerializableStatsDisplay: (
  input: unknown,
) => SerializableStatsDisplay | null =
  SerializableStatsDisplaySchemaContract.safeParse;
export interface StatsDisplayProps extends SerializableStatsDisplay {
  className?: string;
  locale?: string;
}
