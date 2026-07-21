import { z } from "zod";
import type { ReactNode } from "react";
import type { ActionsProp } from "../shared/actions-config";
import type { EmbeddedActionsProps } from "../shared/embedded-actions";
import {
  ActionSchema,
  SerializableActionSchema,
  SerializableActionsConfigSchema,
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";
import { defineToolUiContract } from "../shared/contract";

export const OptionListOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.custom<ReactNode>().optional(),
  disabled: z.boolean().optional(),
});

export type OptionListSelection = string[] | string | null;

const OptionListSelectionSchema = z
  .union([z.array(z.string()), z.string(), z.null()])
  .optional();

type OptionListSchemaInvariantInput = {
  options: Array<{ id: string }>;
  minSelections?: number;
  maxSelections?: number;
  value?: OptionListSelection;
  defaultValue?: OptionListSelection;
  choice?: OptionListSelection;
};

function selectionToIds(selection: OptionListSelection | undefined): string[] {
  if (selection == null) return [];
  if (typeof selection === "string") return [selection];
  return Array.isArray(selection) ? selection : [];
}

function validateOptionListInvariants(
  data: OptionListSchemaInvariantInput,
  ctx: z.RefinementCtx,
) {
  if (
    data.minSelections !== undefined &&
    data.maxSelections !== undefined &&
    data.minSelections > data.maxSelections
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minSelections"],
      message: "`minSelections` cannot be greater than `maxSelections`.",
    });
  }

  const optionIds = new Set<string>();
  for (let index = 0; index < data.options.length; index++) {
    const optionId = data.options[index]?.id;
    if (!optionId) continue;

    if (optionIds.has(optionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", index, "id"],
        message: `Duplicate option id "${optionId}" is not allowed.`,
      });
    } else {
      optionIds.add(optionId);
    }
  }

  const selectionFields: Array<
    ["value" | "defaultValue" | "choice", OptionListSelection | undefined]
  > = [
    ["value", data.value],
    ["defaultValue", data.defaultValue],
    ["choice", data.choice],
  ];

  for (const [fieldName, selection] of selectionFields) {
    if (selection == null) continue;

    const ids = selectionToIds(selection);
    ids.forEach((selectionId, index) => {
      if (!optionIds.has(selectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path:
            typeof selection === "string" ? [fieldName] : [fieldName, index],
          message: `Selection id "${selectionId}" must exist in options.`,
        });
      }
    });
  }
}

const OptionListPropsSchemaBase = z.object({
  /**
   * Unique identifier for this tool UI instance in the conversation.
   *
   * Used for:
   * - Assistant referencing ("the options above")
   * - Receipt generation (linking selections to their source)
   * - Narration context
   *
   * Should be stable across re-renders, meaningful, and unique within the conversation.
   *
   * @example "option-list-deploy-target", "format-selection"
   */
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  options: z.array(OptionListOptionSchema).min(1),
  selectionMode: z.enum(["multi", "single"]).optional(),
  /**
   * Controlled selection value (advanced / runtime only).
   *
   * For Tool UI tool payloads, prefer `defaultValue` (initial selection) and
   * `choice` (receipt state). Controlled `value` is intentionally excluded
   * from `SerializableOptionListSchema` to avoid accidental "controlled but
   * non-interactive" states when an LLM includes `value` in args.
   */
  value: OptionListSelectionSchema,
  defaultValue: OptionListSelectionSchema,
  /**
   * When set, renders the component in receipt state showing the user's choice.
   *
   * In receipt state:
   * - Only the chosen option(s) are shown
   * - Actions are hidden
   * - The component is read-only
   *
   * Use this with assistant-ui's `addResult` to show the outcome of a decision.
   *
   * @example
   * ```tsx
   * // In a toolkit render function:
   * if (result) {
   *   return <OptionList {...args} choice={result} />;
   * }
   * ```
   */
  choice: OptionListSelectionSchema,
  actions: z
    .union([z.array(ActionSchema), SerializableActionsConfigSchema])
    .optional(),
  minSelections: z.number().min(0).optional(),
  maxSelections: z.number().min(1).optional(),
});

export const OptionListPropsSchema = OptionListPropsSchemaBase.superRefine(
  validateOptionListInvariants,
);

export type OptionListOption = z.infer<typeof OptionListOptionSchema>;

export type OptionListProps = Omit<
  z.infer<typeof OptionListPropsSchema>,
  "value" | "defaultValue" | "choice" | "actions"
> & {
  /** @see OptionListPropsSchema.id */
  id: string;
  value?: OptionListSelection;
  defaultValue?: OptionListSelection;
  /** @see OptionListPropsSchema.choice */
  choice?: OptionListSelection;
  onChange?: (value: OptionListSelection) => void;
  actions?: ActionsProp;
  onAction?: EmbeddedActionsProps<OptionListSelection>["onAction"];
  onBeforeAction?: EmbeddedActionsProps<OptionListSelection>["onBeforeAction"];
  className?: string;
};

export const SerializableOptionListSchema = OptionListPropsSchemaBase.omit({
  // Exclude controlled selection from tool/LLM payloads.
  value: true,
})
  .extend({
    options: z.array(OptionListOptionSchema.omit({ icon: true })),
    actions: z
      .union([
        z.array(SerializableActionSchema),
        SerializableActionsConfigSchema,
      ])
      .optional(),
  })
  .strict()
  .superRefine(validateOptionListInvariants);

export type SerializableOptionList = z.infer<
  typeof SerializableOptionListSchema
>;

const SerializableOptionListSchemaContract = defineToolUiContract(
  "OptionList",
  SerializableOptionListSchema,
);

export const parseSerializableOptionList: (
  input: unknown,
) => SerializableOptionList = SerializableOptionListSchemaContract.parse;

export const safeParseSerializableOptionList: (
  input: unknown,
) => SerializableOptionList | null =
  SerializableOptionListSchemaContract.safeParse;
