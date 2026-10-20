import { z } from "zod";
import { PROPERTY_TYPES } from "@royal-home/shared";

/** Internal server policy context, never a customer/model tool argument.
 * Phones/names/peer are read from the owned resource and exact native binding. */
export const customerIntakeContextSchema = z.object({
  version: z.literal(1), kind: z.enum(["BUYER", "SELLER", "OTHER"]).optional(),
  budgetMin: z.number().finite().nonnegative().optional(), budgetMax: z.number().finite().nonnegative().optional(),
  desiredDistrictId: z.string().uuid().optional(), desiredRooms: z.number().int().min(0).max(50).optional(),
  desiredType: z.enum(PROPERTY_TYPES).optional(), propertyId: z.string().uuid().optional(),
  requestedAgentId: z.string().uuid().optional(),
  deferAssignment: z.boolean().default(false),
}).strict();
export type CustomerIntakeContext = z.infer<typeof customerIntakeContextSchema>;
export const customerIntakeProgressSchema = z.object({
  intakeContext: customerIntakeContextSchema,
  intakeOutcome: z.object({ mode: z.enum(["assigned", "other", "duplicate_hold", "staff_owned", "night_pending", "unassigned"]),
    agentId: z.string().uuid().optional() }).strict().optional(),
  policyCommittedAt: z.string().optional(),
}).strict();
