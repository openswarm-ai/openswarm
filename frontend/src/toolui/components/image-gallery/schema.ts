import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

export const ImageGallerySourceSchema = z.object({
  label: z.string(),
  url: z.string().url().optional(),
});

export type ImageGallerySource = z.infer<typeof ImageGallerySourceSchema>;

export const ImageGalleryItemSchema = z.object({
  id: z.string().min(1),
  src: z.string().url(),
  alt: z.string().min(1, "Images require alt text for accessibility"),
  width: z.number().positive(),
  height: z.number().positive(),
  title: z.string().optional(),
  caption: z.string().optional(),
  source: ImageGallerySourceSchema.optional(),
});

export type ImageGalleryItem = z.infer<typeof ImageGalleryItemSchema>;

export const SerializableImageGallerySchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  images: z.array(ImageGalleryItemSchema).min(1),
  title: z.string().optional(),
  description: z.string().optional(),
});

export type SerializableImageGallery = z.infer<
  typeof SerializableImageGallerySchema
>;

export interface ImageGalleryProps extends SerializableImageGallery {
  className?: string;
  onImageClick?: (imageId: string, image: ImageGalleryItem) => void;
}

const SerializableImageGallerySchemaContract = defineToolUiContract(
  "ImageGallery",
  SerializableImageGallerySchema,
);

export const parseSerializableImageGallery: (
  input: unknown,
) => SerializableImageGallery = SerializableImageGallerySchemaContract.parse;

export const safeParseSerializableImageGallery: (
  input: unknown,
) => SerializableImageGallery | null =
  SerializableImageGallerySchemaContract.safeParse;
