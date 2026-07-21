import { z } from "zod";
import {
  ToolUISurfaceSchema,
  ToolUIReceiptSchema,
  type ToolUIReceipt,
} from "../shared/schema";
import { defineToolUiContract } from "../shared/contract";

/**
 * Receipt state for ProgressTracker showing the outcome of a workflow.
 */
export type ProgressTrackerChoice = ToolUIReceipt;

export const ProgressStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["pending", "in-progress", "completed", "failed"]),
});

export type ProgressStep = z.infer<typeof ProgressStepSchema>;

const ProgressStepsSchema = z
  .array(ProgressStepSchema)
  .min(1)
  .superRefine((steps, ctx) => {
    const seenIds = new Set<string>();

    for (const [index, step] of steps.entries()) {
      if (seenIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate step id: "${step.id}"`,
          path: [index, "id"],
        });
      }

      seenIds.add(step.id);
    }
  });

export const SerializableProgressTrackerSchema = ToolUISurfaceSchema.omit({
  receipt: true,
})
  .extend({
    steps: ProgressStepsSchema,
    elapsedTime: z.number().finite().nonnegative().optional(),
    /**
     * When set, renders the component in receipt state showing the workflow outcome.
     */
    choice: ToolUIReceiptSchema.optional(),
  })
  .strict();

export type SerializableProgressTracker = z.infer<
  typeof SerializableProgressTrackerSchema
>;

const SerializableProgressTrackerSchemaContract = defineToolUiContract(
  "ProgressTracker",
  SerializableProgressTrackerSchema,
);

export const parseSerializableProgressTracker: (
  input: unknown,
) => SerializableProgressTracker =
  SerializableProgressTrackerSchemaContract.parse;

export const safeParseSerializableProgressTracker: (
  input: unknown,
) => SerializableProgressTracker | null =
  SerializableProgressTrackerSchemaContract.safeParse;

export interface ProgressTrackerProps extends SerializableProgressTracker {
  className?: string;
}
