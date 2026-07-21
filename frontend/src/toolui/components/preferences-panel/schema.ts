import { z } from "zod";
import { type ActionsProp } from "../shared/actions-config";
import type { EmbeddedActionsProps } from "../shared/embedded-actions";
import { defineToolUiContract } from "../shared/contract";
import {
  SerializableActionSchema,
  SerializableActionsConfigSchema,
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

const PreferenceItemBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

const PreferenceSwitchSchema = PreferenceItemBaseSchema.extend({
  type: z.literal("switch"),
  defaultChecked: z.boolean().optional(),
});

const PreferenceToggleSchema = PreferenceItemBaseSchema.extend({
  type: z.literal("toggle"),
  options: z
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(2),
  defaultValue: z.string().optional(),
});

const PreferenceSelectSchema = PreferenceItemBaseSchema.extend({
  type: z.literal("select"),
  selectOptions: z
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(5),
  defaultSelected: z.string().optional(),
});

const PreferenceItemSchema = z.discriminatedUnion("type", [
  PreferenceSwitchSchema,
  PreferenceToggleSchema,
  PreferenceSelectSchema,
]);

const PreferenceSectionSchema = z.object({
  heading: z.string().min(1).optional(),
  items: z.array(PreferenceItemSchema).min(1),
});

const PreferencesPanelBaseSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  title: z.string().min(1).optional(),
  sections: z.array(PreferenceSectionSchema).min(1),
});

export const SerializablePreferencesPanelSchema =
  PreferencesPanelBaseSchema.extend({
    actions: z
      .union([
        z.array(SerializableActionSchema),
        SerializableActionsConfigSchema,
      ])
      .optional(),
  }).strict();

export const SerializablePreferencesPanelReceiptSchema =
  PreferencesPanelBaseSchema.extend({
    choice: z.record(z.string(), z.union([z.string(), z.boolean()])),
    error: z.record(z.string(), z.string()).optional(),
  }).strict();

export type SerializablePreferencesPanel = z.infer<
  typeof SerializablePreferencesPanelSchema
>;

export type SerializablePreferencesPanelReceipt = z.infer<
  typeof SerializablePreferencesPanelReceiptSchema
>;

const SerializablePreferencesPanelSchemaContract = defineToolUiContract(
  "PreferencesPanel",
  SerializablePreferencesPanelSchema,
);

const SerializablePreferencesPanelReceiptSchemaContract = defineToolUiContract(
  "PreferencesPanelReceipt",
  SerializablePreferencesPanelReceiptSchema,
);

export const parseSerializablePreferencesPanel: (
  input: unknown,
) => SerializablePreferencesPanel =
  SerializablePreferencesPanelSchemaContract.parse;

export const safeParseSerializablePreferencesPanel: (
  input: unknown,
) => SerializablePreferencesPanel | null =
  SerializablePreferencesPanelSchemaContract.safeParse;

export const parseSerializablePreferencesPanelReceipt: (
  input: unknown,
) => SerializablePreferencesPanelReceipt =
  SerializablePreferencesPanelReceiptSchemaContract.parse;

export const safeParseSerializablePreferencesPanelReceipt: (
  input: unknown,
) => SerializablePreferencesPanelReceipt | null =
  SerializablePreferencesPanelReceiptSchemaContract.safeParse;

export interface PreferencesValue {
  [itemId: string]: string | boolean;
}

export interface PreferencesPanelProps extends Omit<
  SerializablePreferencesPanel,
  "actions"
> {
  className?: string;
  value?: PreferencesValue;
  onChange?: (value: PreferencesValue) => void;
  actions?: ActionsProp;
  onAction?: EmbeddedActionsProps<PreferencesValue>["onAction"];
  onBeforeAction?: EmbeddedActionsProps<PreferencesValue>["onBeforeAction"];
}

export interface PreferencesPanelReceiptProps extends SerializablePreferencesPanelReceipt {
  className?: string;
}

export type PreferenceItem = z.infer<typeof PreferenceItemSchema>;
export type PreferenceSection = z.infer<typeof PreferenceSectionSchema>;
