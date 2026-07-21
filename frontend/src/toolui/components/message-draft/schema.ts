import { z } from "zod";
import { ToolUIIdSchema, ToolUIRoleSchema } from "../shared/schema";
import { defineToolUiContract } from "../shared/contract";

export const MessageDraftChannelSchema = z.enum(["email", "slack"]);

export type MessageDraftChannel = z.infer<typeof MessageDraftChannelSchema>;

export const MessageDraftOutcomeSchema = z.enum(["sent", "cancelled"]);

export type MessageDraftOutcome = z.infer<typeof MessageDraftOutcomeSchema>;

const SlackTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("channel"),
    name: z.string().min(1),
    memberCount: z.number().optional(),
  }),
  z.object({ type: z.literal("dm"), name: z.string().min(1) }),
]);

export type SlackTarget = z.infer<typeof SlackTargetSchema>;

export const SerializableEmailDraftSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  body: z.string().min(1),
  outcome: MessageDraftOutcomeSchema.optional(),
  channel: z.literal("email"),
  subject: z.string().min(1),
  from: z.string().optional(),
  to: z.array(z.string()).min(1),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
});

export const SerializableSlackDraftSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  body: z.string().min(1),
  outcome: MessageDraftOutcomeSchema.optional(),
  channel: z.literal("slack"),
  target: SlackTargetSchema,
});

export const SerializableMessageDraftSchema = z.discriminatedUnion("channel", [
  SerializableEmailDraftSchema,
  SerializableSlackDraftSchema,
]);

export type SerializableMessageDraft = z.infer<
  typeof SerializableMessageDraftSchema
>;

export type SerializableEmailDraft = z.infer<
  typeof SerializableEmailDraftSchema
>;

export type SerializableSlackDraft = z.infer<
  typeof SerializableSlackDraftSchema
>;

const SerializableMessageDraftSchemaContract = defineToolUiContract(
  "MessageDraft",
  SerializableMessageDraftSchema,
);

export const parseSerializableMessageDraft: (
  input: unknown,
) => SerializableMessageDraft = SerializableMessageDraftSchemaContract.parse;

export const safeParseSerializableMessageDraft: (
  input: unknown,
) => SerializableMessageDraft | null =
  SerializableMessageDraftSchemaContract.safeParse;

export type MessageDraftProps = SerializableMessageDraft & {
  className?: string;
  undoGracePeriod?: number;
  onSend?: () => void | Promise<void>;
  onUndo?: () => void;
  onCancel?: () => void;
};
