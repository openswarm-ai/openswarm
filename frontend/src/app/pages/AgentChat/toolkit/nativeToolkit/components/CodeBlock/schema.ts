import { z } from "zod";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "@/app/pages/AgentChat/toolkit/utils/schema";

export const CodeBlockPropsSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  code: z.string(),
  language: z.string().trim().min(1).default("text"),
  lineNumbers: z.enum(["visible", "hidden"]).default("visible"),
  filename: z.string().optional(),
  highlightLines: z.array(z.number().int().positive()).optional(),
  maxCollapsedLines: z.number().min(1).optional(),
  className: z.string().optional(),
});

export type CodeBlockProps = z.infer<typeof CodeBlockPropsSchema>;
export type CodeBlockLineNumbersMode = CodeBlockProps["lineNumbers"];