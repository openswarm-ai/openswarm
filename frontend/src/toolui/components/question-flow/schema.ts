import { z } from "zod";
import type { ReactNode } from "react";
import { defineToolUiContract } from "../shared/contract";
import { ToolUIIdSchema, ToolUIRoleSchema } from "../shared/schema";

export const QuestionFlowOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.custom<ReactNode>().optional(),
  disabled: z.boolean().optional(),
});

export type QuestionFlowOption = z.infer<typeof QuestionFlowOptionSchema>;

export const QuestionFlowStepDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  options: z.array(QuestionFlowOptionSchema.omit({ icon: true })).min(1),
  selectionMode: z.enum(["single", "multi"]).optional(),
});

export type QuestionFlowStepDefinition = z.infer<
  typeof QuestionFlowStepDefinitionSchema
>;

export const QuestionFlowSummaryItemSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});

export type QuestionFlowSummaryItem = z.infer<
  typeof QuestionFlowSummaryItemSchema
>;

export const QuestionFlowChoiceSchema = z.object({
  title: z.string().min(1),
  summary: z.array(QuestionFlowSummaryItemSchema).min(1),
});

export type QuestionFlowChoice = z.infer<typeof QuestionFlowChoiceSchema>;

const BaseSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
});

export const SerializableProgressiveModeSchema = BaseSchema.extend({
  step: z.number().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  options: z.array(QuestionFlowOptionSchema.omit({ icon: true })).min(1),
  selectionMode: z.enum(["single", "multi"]).optional(),
});

export type SerializableProgressiveMode = z.infer<
  typeof SerializableProgressiveModeSchema
>;

export const SerializableUpfrontModeSchema = BaseSchema.extend({
  steps: z.array(QuestionFlowStepDefinitionSchema).min(1),
});

export type SerializableUpfrontMode = z.infer<
  typeof SerializableUpfrontModeSchema
>;

export const SerializableReceiptModeSchema = BaseSchema.extend({
  choice: QuestionFlowChoiceSchema,
});

export type SerializableReceiptMode = z.infer<
  typeof SerializableReceiptModeSchema
>;

export const SerializableQuestionFlowSchema = z.union([
  SerializableProgressiveModeSchema,
  SerializableUpfrontModeSchema,
  SerializableReceiptModeSchema,
]);

export type SerializableQuestionFlow = z.infer<
  typeof SerializableQuestionFlowSchema
>;

const SerializableQuestionFlowSchemaContract = defineToolUiContract(
  "QuestionFlow",
  SerializableQuestionFlowSchema,
);

export const parseSerializableQuestionFlow: (
  input: unknown,
) => SerializableQuestionFlow = SerializableQuestionFlowSchemaContract.parse;

export const safeParseSerializableQuestionFlow: (
  input: unknown,
) => SerializableQuestionFlow | null =
  SerializableQuestionFlowSchemaContract.safeParse;
interface BaseRuntimeProps {
  className?: string;
}

export interface QuestionFlowProgressiveProps
  extends BaseRuntimeProps, Omit<SerializableProgressiveMode, "options"> {
  options: QuestionFlowOption[];
  defaultValue?: string[];
  onSelect?: (optionIds: string[]) => void | Promise<void>;
  onBack?: () => void;
  steps?: never;
  choice?: never;
}

export interface QuestionFlowUpfrontProps
  extends BaseRuntimeProps, SerializableUpfrontMode {
  onStepChange?: (stepId: string) => void;
  onComplete?: (answers: Record<string, string[]>) => void | Promise<void>;
  step?: never;
  choice?: never;
}

export interface QuestionFlowReceiptProps
  extends BaseRuntimeProps, SerializableReceiptMode {
  step?: never;
  steps?: never;
}

export type QuestionFlowProps =
  | QuestionFlowProgressiveProps
  | QuestionFlowUpfrontProps
  | QuestionFlowReceiptProps;
