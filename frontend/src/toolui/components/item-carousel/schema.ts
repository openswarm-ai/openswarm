import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import {
  ActionSchema,
  SerializableActionSchema,
  ToolUIIdSchema,
} from "../shared/schema";

export const ItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  subtitle: z.string().optional(),
  image: z.url().optional(),
  color: z.string().optional(),
  actions: z.array(ActionSchema).optional(),
});

export const ItemCarouselPropsSchema = z.object({
  id: ToolUIIdSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  items: z.array(ItemSchema),
  className: z.string().optional(),
});

export type Item = z.infer<typeof ItemSchema>;

export type ItemCarouselProps = z.infer<typeof ItemCarouselPropsSchema> & {
  onItemClick?: (itemId: string) => void;
  onItemAction?: (itemId: string, actionId: string) => void;
};

export const SerializableItemSchema = ItemSchema.extend({
  actions: z.array(SerializableActionSchema).optional(),
});

export const SerializableItemCarouselSchema = ItemCarouselPropsSchema.omit({
  className: true,
})
  .extend({
    items: z.array(SerializableItemSchema),
  })
  .superRefine((payload, ctx) => {
    const seenItemIds = new Map<string, number>();

    payload.items.forEach((item, index) => {
      const firstSeenAt = seenItemIds.get(item.id);
      if (firstSeenAt !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "id"],
          message: `duplicate item id '${item.id}' (first seen at index ${firstSeenAt})`,
        });
        return;
      }
      seenItemIds.set(item.id, index);
    });
  });

export type SerializableItem = z.infer<typeof SerializableItemSchema>;
export type SerializableItemCarousel = z.infer<
  typeof SerializableItemCarouselSchema
>;

const SerializableItemCarouselSchemaContract = defineToolUiContract(
  "ItemCarousel",
  SerializableItemCarouselSchema,
);

export const parseSerializableItemCarousel: (
  input: unknown,
) => SerializableItemCarousel = SerializableItemCarouselSchemaContract.parse;

export const safeParseSerializableItemCarousel: (
  input: unknown,
) => SerializableItemCarousel | null =
  SerializableItemCarouselSchemaContract.safeParse;
