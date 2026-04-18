import { z } from "zod";
import { ToolUIIdSchema, ToolUIRoleSchema } from "../shared/schema";

const MetadataItemSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

export const ApprovalDecisionSchema = z.enum(["approved", "denied"]);

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const SerializableApprovalCardSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),

  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  metadata: z.array(MetadataItemSchema).optional(),

  variant: z.enum(["default", "destructive"]).optional(),

  confirmLabel: z.string().optional(),
  cancelLabel: z.string().optional(),

  choice: ApprovalDecisionSchema.optional(),
});

export type SerializableApprovalCard = z.infer<
  typeof SerializableApprovalCardSchema
>;

export interface ApprovalCardProps extends SerializableApprovalCard {
  className?: string;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}
