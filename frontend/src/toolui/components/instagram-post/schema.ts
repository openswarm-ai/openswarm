import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";

export const InstagramPostAuthorSchema = z.object({
  name: z.string(),
  handle: z.string(),
  avatarUrl: z.string(),
  verified: z.boolean().optional(),
});

export const InstagramPostMediaSchema = z.object({
  type: z.enum(["image", "video"]),
  url: z.string(),
  alt: z.string(),
});

export const InstagramPostStatsSchema = z.object({
  likes: z.number().optional(),
  isLiked: z.boolean().optional(),
});

export interface InstagramPostData {
  id: string;
  author: z.infer<typeof InstagramPostAuthorSchema>;
  text?: string;
  media?: z.infer<typeof InstagramPostMediaSchema>[];
  stats?: z.infer<typeof InstagramPostStatsSchema>;
  createdAt?: string;
}

export const SerializableInstagramPostSchema: z.ZodType<InstagramPostData> =
  z.object({
    id: z.string(),
    author: InstagramPostAuthorSchema,
    text: z.string().optional(),
    media: z.array(InstagramPostMediaSchema).optional(),
    stats: InstagramPostStatsSchema.optional(),
    createdAt: z.string().optional(),
  });

export type InstagramPostAuthor = z.infer<typeof InstagramPostAuthorSchema>;
export type InstagramPostMedia = z.infer<typeof InstagramPostMediaSchema>;
export type InstagramPostStats = z.infer<typeof InstagramPostStatsSchema>;

const SerializableInstagramPostSchemaContract = defineToolUiContract(
  "InstagramPost",
  SerializableInstagramPostSchema,
);

export const parseSerializableInstagramPost: (
  input: unknown,
) => InstagramPostData = SerializableInstagramPostSchemaContract.parse;

export const safeParseSerializableInstagramPost: (
  input: unknown,
) => InstagramPostData | null =
  SerializableInstagramPostSchemaContract.safeParse;
