import { z } from "zod";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";
import { defineToolUiContract } from "../shared/contract";

export const PlanTodoStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

export const PlanTodoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: PlanTodoStatusSchema,
  description: z.string().optional(),
});

export type PlanTodoStatus = z.infer<typeof PlanTodoStatusSchema>;
export type PlanTodo = z.infer<typeof PlanTodoSchema>;

export const PlanPropsSchema = z
  .object({
    id: ToolUIIdSchema,
    role: ToolUIRoleSchema.optional(),
    receipt: ToolUIReceiptSchema.optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    todos: z.array(PlanTodoSchema).min(1),
    maxVisibleTodos: z.number().finite().int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const seenTodoIds = new Set<string>();
    value.todos.forEach((todo, index) => {
      if (seenTodoIds.has(todo.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["todos", index, "id"],
          message: `Duplicate todo id "${todo.id}".`,
        });
        return;
      }
      seenTodoIds.add(todo.id);
    });
  });

export type PlanProps = z.infer<typeof PlanPropsSchema> & {
  className?: string;
};

export const SerializablePlanSchema = PlanPropsSchema;

export type SerializablePlan = z.infer<typeof SerializablePlanSchema>;

const SerializablePlanSchemaContract = defineToolUiContract(
  "Plan",
  SerializablePlanSchema,
);

export const parseSerializablePlan: (input: unknown) => SerializablePlan =
  SerializablePlanSchemaContract.parse;

export const safeParseSerializablePlan: (
  input: unknown,
) => SerializablePlan | null = SerializablePlanSchemaContract.safeParse;
