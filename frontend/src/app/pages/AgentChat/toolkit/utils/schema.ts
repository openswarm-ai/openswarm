import { z } from "zod";

/**
 * Tool UI conventions:
 * - Serializable schemas are JSON-safe (no callbacks/ReactNode/`className`).
 * - Schema: `SerializableXSchema`
 * - Parser: `parseSerializableX(input: unknown)` (throws on invalid)
 * - Safe parser: `safeParseSerializableX(input: unknown)` (returns `null` on invalid)
 * - Actions: `LocalActions` for non-receipt actions and `DecisionActions` for consequential actions
 * - Root attrs: `data-tool-ui-id` + `data-slot`
 */

/**
 * Schema for tool UI identity.
 *
 * Every tool UI should have a unique identifier that:
 * - Is stable across re-renders
 * - Is meaningful (not auto-generated)
 * - Is unique within the conversation
 *
 * Format recommendation: `{component-type}-{semantic-identifier}`
 * Examples: "data-table-expenses-q3", "option-list-deploy-target"
 */
export const ToolUIIdSchema = z.string().min(1);

/**
 * Primary role of a Tool UI surface in a chat context.
 */
export const ToolUIRoleSchema = z.enum([
  "information",
  "decision",
  "control",
  "state",
  "composite",
]);

const ToolUIReceiptOutcomeSchema = z.enum([
  "success",
  "partial",
  "failed",
  "cancelled",
]);

/**
 * Optional receipt metadata: a durable summary of an outcome.
 */
export const ToolUIReceiptSchema = z.object({
  outcome: ToolUIReceiptOutcomeSchema,
  summary: z.string().min(1),
  identifiers: z.record(z.string(), z.string()).optional(),
  at: z.string().datetime(),
});
