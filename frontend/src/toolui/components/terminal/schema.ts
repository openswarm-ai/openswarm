import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

export const TerminalPropsSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  command: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().min(0),
  durationMs: z.number().optional(),
  cwd: z.string().optional(),
  truncated: z.boolean().optional(),
  maxCollapsedLines: z.number().min(1).optional(),
  className: z.string().optional(),
});

export type TerminalProps = z.infer<typeof TerminalPropsSchema>;

export const SerializableTerminalSchema = TerminalPropsSchema.omit({
  className: true,
});

export type SerializableTerminal = z.infer<typeof SerializableTerminalSchema>;

const SerializableTerminalSchemaContract = defineToolUiContract(
  "Terminal",
  SerializableTerminalSchema,
);

export const parseSerializableTerminal: (
  input: unknown,
) => SerializableTerminal = SerializableTerminalSchemaContract.parse;

export const safeParseSerializableTerminal: (
  input: unknown,
) => SerializableTerminal | null = SerializableTerminalSchemaContract.safeParse;
