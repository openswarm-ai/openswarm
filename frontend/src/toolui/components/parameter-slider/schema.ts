import { z } from "zod";
import { type ActionsProp } from "../shared/actions-config";
import type { EmbeddedActionsProps } from "../shared/embedded-actions";
import { defineToolUiContract } from "../shared/contract";
import {
  SerializableActionSchema,
  SerializableActionsConfigSchema,
  ToolUIIdSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

export const SliderConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive().optional(),
    value: z.number().finite(),
    unit: z.string().optional(),
    precision: z.number().int().min(0).optional(),
    disabled: z.boolean().optional(),
    trackClassName: z.string().optional(),
    fillClassName: z.string().optional(),
    handleClassName: z.string().optional(),
  })
  .superRefine((slider, ctx) => {
    if (slider.max <= slider.min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max"],
        message: "max must be greater than min",
      });
    }

    if (slider.value < slider.min || slider.value > slider.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "value must be between min and max",
      });
    }
  });

export type SliderConfig = z.infer<typeof SliderConfigSchema>;

export const SerializableParameterSliderSchema = z
  .object({
    id: ToolUIIdSchema,
    role: ToolUIRoleSchema.optional(),
    sliders: z.array(SliderConfigSchema).min(1),
    actions: z
      .union([
        z.array(SerializableActionSchema),
        SerializableActionsConfigSchema,
      ])
      .optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const seenIds = new Map<string, number>();

    payload.sliders.forEach((slider, index) => {
      const firstSeenAt = seenIds.get(slider.id);
      if (firstSeenAt !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sliders", index, "id"],
          message: `duplicate slider id '${slider.id}' (first seen at index ${firstSeenAt})`,
        });
        return;
      }
      seenIds.set(slider.id, index);
    });
  });

export type SerializableParameterSlider = z.infer<
  typeof SerializableParameterSliderSchema
>;

const SerializableParameterSliderSchemaContract = defineToolUiContract(
  "ParameterSlider",
  SerializableParameterSliderSchema,
);

export const parseSerializableParameterSlider: (
  input: unknown,
) => SerializableParameterSlider =
  SerializableParameterSliderSchemaContract.parse;

export const safeParseSerializableParameterSlider: (
  input: unknown,
) => SerializableParameterSlider | null =
  SerializableParameterSliderSchemaContract.safeParse;

export interface SliderValue {
  id: string;
  value: number;
}

export interface ParameterSliderProps extends Omit<
  SerializableParameterSlider,
  "actions"
> {
  className?: string;
  values?: SliderValue[];
  onChange?: (values: SliderValue[]) => void;
  actions?: ActionsProp;
  onAction?: EmbeddedActionsProps<SliderValue[]>["onAction"];
  onBeforeAction?: EmbeddedActionsProps<SliderValue[]>["onBeforeAction"];
  trackClassName?: string;
  fillClassName?: string;
  handleClassName?: string;
}
