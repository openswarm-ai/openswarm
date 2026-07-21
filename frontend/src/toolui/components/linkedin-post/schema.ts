import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";

export const LinkedInPostAuthorSchema = z.object({
  name: z.string(),
  avatarUrl: z.string(),
  headline: z.string().optional(),
});

export const LinkedInPostMediaSchema = z.object({
  type: z.enum(["image", "video"]),
  url: z.string(),
  alt: z.string(),
});

export const LinkedInPostLinkPreviewSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  domain: z.string().optional(),
});

export const LinkedInPostStatsSchema = z.object({
  likes: z.number().optional(),
  isLiked: z.boolean().optional(),
});

export const SerializableLinkedInPostSchema = z.object({
  id: z.string(),
  author: LinkedInPostAuthorSchema,
  text: z.string().optional(),
  media: LinkedInPostMediaSchema.optional(),
  linkPreview: LinkedInPostLinkPreviewSchema.optional(),
  stats: LinkedInPostStatsSchema.optional(),
  createdAt: z.string().optional(),
});

export type LinkedInPostData = z.infer<typeof SerializableLinkedInPostSchema>;

export type LinkedInPostAuthor = z.infer<typeof LinkedInPostAuthorSchema>;
export type LinkedInPostMedia = z.infer<typeof LinkedInPostMediaSchema>;
export type LinkedInPostLinkPreview = z.infer<
  typeof LinkedInPostLinkPreviewSchema
>;
export type LinkedInPostStats = z.infer<typeof LinkedInPostStatsSchema>;

const SerializableLinkedInPostSchemaContract = defineToolUiContract(
  "LinkedInPost",
  SerializableLinkedInPostSchema,
);

export const parseSerializableLinkedInPost: (
  input: unknown,
) => LinkedInPostData = SerializableLinkedInPostSchemaContract.parse;

export const safeParseSerializableLinkedInPost: (
  input: unknown,
) => LinkedInPostData | null = SerializableLinkedInPostSchemaContract.safeParse;
