import { z } from "zod";

export const conversationClientLinkSchema = z.object({
  clientId: z.string().uuid(),
  confirmSamePerson: z.literal(true),
});
export type ConversationClientLinkInput = z.infer<typeof conversationClientLinkSchema>;
