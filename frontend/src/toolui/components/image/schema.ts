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

export const SerializableImageSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  assetId: z.string(),
  src: z.url(),
  alt: z.string().min(1, "Images require alt text for accessibility"),
  title: z.string().optional(),
  description: z.string().optional(),
  href: z.url().optional(),
  domain: z.string().optional(),
  ratio: AspectRatioSchema.optional(),
  fit: MediaFitSchema.optional(),
  fileSizeBytes: z.number().int().positive().optional(),
  createdAt: z.string().datetime().optional(),
  locale: z.string().optional(),
  source: SourceSchema.optional(),
});

export type SerializableImage = z.infer<typeof SerializableImageSchema>;

const SerializableImageSchemaContract = defineToolUiContract(
  "Image",
  SerializableImageSchema,
);

export const parseSerializableImage: (input: unknown) => SerializableImage =
  SerializableImageSchemaContract.parse;

export const safeParseSerializableImage: (
  input: unknown,
) => SerializableImage | null = SerializableImageSchemaContract.safeParse;
