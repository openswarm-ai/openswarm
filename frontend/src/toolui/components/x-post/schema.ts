import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";

export const XPostAuthorSchema = z.object({
  name: z.string(),
  handle: z.string(),
  avatarUrl: z.url(),
  verified: z.boolean().optional(),
});

export const XPostMediaSchema = z.object({
  type: z.enum(["image", "video"]),
  url: z.url(),
  alt: z.string(),
  aspectRatio: z.enum(["1:1", "4:3", "16:9", "9:16"]).optional(),
});

export const XPostLinkPreviewSchema = z.object({
  url: z.url(),
  title: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.url().optional(),
  domain: z.string().optional(),
});

export const XPostStatsSchema = z.object({
  likes: z.number().optional(),
  isLiked: z.boolean().optional(),
  isReposted: z.boolean().optional(),
  isBookmarked: z.boolean().optional(),
});

export interface XPostData {
  id: string;
  author: z.infer<typeof XPostAuthorSchema>;
  text?: string;
  media?: z.infer<typeof XPostMediaSchema>;
  linkPreview?: z.infer<typeof XPostLinkPreviewSchema>;
  quotedPost?: XPostData;
  stats?: z.infer<typeof XPostStatsSchema>;
  createdAt?: string;
}

export const SerializableXPostSchema: z.ZodType<XPostData> = z.object({
  id: z.string(),
  author: XPostAuthorSchema,
  text: z.string().optional(),
  media: XPostMediaSchema.optional(),
  linkPreview: XPostLinkPreviewSchema.optional(),
  quotedPost: z.lazy(() => SerializableXPostSchema).optional(),
  stats: XPostStatsSchema.optional(),
  createdAt: z.string().optional(),
});
export type XPostAuthor = z.infer<typeof XPostAuthorSchema>;
export type XPostMedia = z.infer<typeof XPostMediaSchema>;
export type XPostLinkPreview = z.infer<typeof XPostLinkPreviewSchema>;
export type XPostStats = z.infer<typeof XPostStatsSchema>;

const SerializableXPostSchemaContract = defineToolUiContract(
  "XPost",
  SerializableXPostSchema,
);

export const parseSerializableXPost: (input: unknown) => XPostData =
  SerializableXPostSchemaContract.parse;

export const safeParseSerializableXPost: (input: unknown) => XPostData | null =
  SerializableXPostSchemaContract.safeParse;
