import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

const CodeDiffPropsSchemaBase = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  oldCode: z.string().optional(),
  newCode: z.string().optional(),
  patch: z.string().optional(),
  language: z.string().trim().min(1).default("text"),
  filename: z.string().optional(),
  lineNumbers: z.enum(["visible", "hidden"]).default("visible"),
  diffStyle: z.enum(["unified", "split"]).default("unified"),
  maxCollapsedLines: z.number().min(1).optional(),
  className: z.string().optional(),
});

function validateCodeDiffInputMode(
  data: { patch?: string; oldCode?: string; newCode?: string },
  ctx: z.RefinementCtx,
) {
  const hasPatch = !!data.patch;
  const hasFiles = !!data.oldCode || !!data.newCode;

  if (!hasPatch && !hasFiles) {
    ctx.addIssue({
      code: "custom",
      message:
        "Provide either a patch string or at least one of oldCode/newCode",
    });
  }

  if (hasPatch && hasFiles) {
    ctx.addIssue({
      code: "custom",
      message:
        "Cannot mix patch mode with oldCode/newCode — use one or the other",
    });
  }
}

export const CodeDiffPropsSchema = CodeDiffPropsSchemaBase.superRefine(
  validateCodeDiffInputMode,
);

export type CodeDiffProps = z.infer<typeof CodeDiffPropsSchema>;

export const SerializableCodeDiffSchema = CodeDiffPropsSchemaBase.omit({
  className: true,
}).superRefine(validateCodeDiffInputMode);

export type SerializableCodeDiff = z.infer<typeof SerializableCodeDiffSchema>;

const SerializableCodeDiffSchemaContract = defineToolUiContract(
  "CodeDiff",
  SerializableCodeDiffSchema,
);

export const parseSerializableCodeDiff: (
  input: unknown,
) => SerializableCodeDiff = SerializableCodeDiffSchemaContract.parse;

export const safeParseSerializableCodeDiff: (
  input: unknown,
) => SerializableCodeDiff | null = SerializableCodeDiffSchemaContract.safeParse;
