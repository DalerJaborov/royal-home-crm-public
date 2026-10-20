import { z } from "zod";
import { customerRevisionSchema } from "./customerState.js";

/** Staff projection only: no stored return target, issuer/authority or private
 * memory. The API separately applies current role and own-conversation ACL. */
export const ownerQuestionViewSchema = z.object({
  id: z.string().uuid(), question: z.string(), askedAt: z.string(),
  clientId: z.string().nullable(), clientShortId: z.number().nullable(), clientName: z.string().nullable(),
  propertyId: z.string().nullable(), propertyShortId: z.number().nullable(), propertyTitle: z.string().nullable(),
  propertyPrice: z.string().nullable(), propertyCurrency: z.string().nullable(), propertyThumbUrl: z.string().nullable(),
  answer: z.string().nullable(), answeredAt: z.string().nullable(), managedRevision: customerRevisionSchema.nullable(),
  deliveryStatus: z.string().nullable(),
}).strict();
export type OwnerQuestionView = z.infer<typeof ownerQuestionViewSchema>;

export const callbackRequestViewSchema = z.object({
  id: z.string().uuid(), requestKind: z.string().nullable(), lifecycleStatus: z.string().nullable(),
  lifecycleRevision: customerRevisionSchema.nullable(), assignedAgentId: z.string().nullable(),
  acceptedAt: z.string().nullable(), closureReason: z.string().nullable(), topic: z.string(), channel: z.string(),
  phone: z.string().nullable(), requestedAt: z.string(), conversationId: z.string().nullable(),
  clientId: z.string().nullable(), clientShortId: z.number().nullable(), clientName: z.string().nullable(),
}).strict();
export type CallbackRequestView = z.infer<typeof callbackRequestViewSchema>;
