import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

export const SourceSchema = z.object({
  label: z.string(),
  iconUrl: z.url().optional(),
  url: z.url().optional(),
});

export type Source = z.infer<typeof SourceSchema>;

export const SerializableAudioSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  assetId: z.string(),
  src: z.url(),
  title: z.string().optional(),
  description: z.string().optional(),
  artwork: z.url().optional(),
  durationMs: z.number().int().positive().optional(),
  fileSizeBytes: z.number().int().positive().optional(),
  createdAt: z.string().datetime().optional(),
  locale: z.string().optional(),
  source: SourceSchema.optional(),
});

export type SerializableAudio = z.infer<typeof SerializableAudioSchema>;

const SerializableAudioSchemaContract = defineToolUiContract(
  "Audio",
  SerializableAudioSchema,
);

export const parseSerializableAudio: (input: unknown) => SerializableAudio =
  SerializableAudioSchemaContract.parse;

export const safeParseSerializableAudio: (
  input: unknown,
) => SerializableAudio | null = SerializableAudioSchemaContract.safeParse;
export type AudioVariant = "full" | "compact";
