import { z } from "zod";
import type { ReactNode } from "react";

export const ActionSchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    /**
     * Canonical narration the assistant can use after this action is taken.
     *
     * Example: "I exported the table as CSV." / "I opened the link in a new tab."
     */
    sentence: z.string().optional(),
    confirmLabel: z.string().optional(),
    variant: z
      .enum(["default", "destructive", "secondary", "ghost", "outline"])
      .optional(),
    icon: z.custom<ReactNode>().optional(),
    loading: z.boolean().optional(),
    disabled: z.boolean().optional(),
    shortcut: z.string().optional(),
});

export type Action = z.infer<typeof ActionSchema>;

const SerializableActionSchema = ActionSchema.omit({ icon: true });

export interface ActionsConfig {
    items: Action[];
    align?: "left" | "center" | "right";
    confirmTimeout?: number;
}

export const SerializableActionsConfigSchema = z.object({
    items: z.array(SerializableActionSchema).min(1),
    align: z.enum(["left", "center", "right"]).optional(),
    confirmTimeout: z.number().positive().optional(),
});