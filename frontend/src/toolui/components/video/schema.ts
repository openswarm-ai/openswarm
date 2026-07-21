import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

import { AspectRatioSchema, MediaFitSchema } from "../shared/media";

export const SourceSchema = z.object({
  label: z.string(),
  iconUrl: z.url().optional(),
  url: z.url().optional(),
});

export type Source = z.infer<typeof SourceSchema>;

export const SerializableVideoSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  assetId: z.string(),
  src: z.url(),
  poster: z.url().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  href: z.url().optional(),
  domain: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
  ratio: AspectRatioSchema.optional(),
  fit: MediaFitSchema.optional(),
  createdAt: z.string().datetime().optional(),
  locale: z.string().optional(),
  source: SourceSchema.optional(),
});

export type SerializableVideo = z.infer<typeof SerializableVideoSchema>;

const SerializableVideoSchemaContract = defineToolUiContract(
  "Video",
  SerializableVideoSchema,
);

export const parseSerializableVideo: (input: unknown) => SerializableVideo =
  SerializableVideoSchemaContract.parse;

export const safeParseSerializableVideo: (
  input: unknown,
) => SerializableVideo | null = SerializableVideoSchemaContract.safeParse;
