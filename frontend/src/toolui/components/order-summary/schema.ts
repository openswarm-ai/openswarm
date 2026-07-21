import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import { ToolUIIdSchema, ToolUIRoleSchema } from "../shared/schema";

export const OrderItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  quantity: z.number().int().positive().optional(),
  unitPrice: z.number(),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;

const OrderItemsSchema = z
  .array(OrderItemSchema)
  .min(1)
  .superRefine((items, ctx) => {
    const seenIds = new Set<string>();

    for (const [index, item] of items.entries()) {
      if (seenIds.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate item id: "${item.id}"`,
          path: [index, "id"],
        });
      }

      seenIds.add(item.id);
    }
  });

export const PricingSchema = z.object({
  subtotal: z.number(),
  tax: z.number().optional(),
  taxLabel: z.string().optional(),
  shipping: z.number().optional(),
  discount: z.number().nonnegative().optional(),
  discountLabel: z.string().optional(),
  total: z.number(),
  currency: z.string().optional(),
});

export type Pricing = z.infer<typeof PricingSchema>;

export const OrderSummaryVariantSchema = z.enum(["summary", "receipt"]);
export type OrderSummaryVariant = z.infer<typeof OrderSummaryVariantSchema>;

export const OrderDecisionSchema = z.object({
  action: z.literal("confirm"),
  orderId: z.string().optional(),
  confirmedAt: z.string().datetime().optional(),
});

export type OrderDecision = z.infer<typeof OrderDecisionSchema>;

export const SerializableOrderSummarySchema = z
  .object({
    id: ToolUIIdSchema,
    role: ToolUIRoleSchema.optional(),
    title: z.string().optional(),
    variant: OrderSummaryVariantSchema.optional(),
    items: OrderItemsSchema,
    pricing: PricingSchema,
    choice: OrderDecisionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.variant === "receipt" && value.choice === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Receipt variant requires "choice".',
        path: ["choice"],
      });
    }

    if (value.variant === "summary" && value.choice !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Summary variant cannot include "choice".',
        path: ["choice"],
      });
    }
  });

export type SerializableOrderSummary = z.infer<
  typeof SerializableOrderSummarySchema
>;

const SerializableOrderSummarySchemaContract = defineToolUiContract(
  "OrderSummary",
  SerializableOrderSummarySchema,
);

export const parseSerializableOrderSummary: (
  input: unknown,
) => SerializableOrderSummary = SerializableOrderSummarySchemaContract.parse;

export const safeParseSerializableOrderSummary: (
  input: unknown,
) => SerializableOrderSummary | null =
  SerializableOrderSummarySchemaContract.safeParse;

export interface OrderSummaryProps extends SerializableOrderSummary {
  className?: string;
}
