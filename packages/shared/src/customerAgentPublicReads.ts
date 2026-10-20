import { z } from "zod";

/** Public projection only. This shape is not evidence of its server source. */
export const customerAgentCompanyKnowledgeSchema = z.object({
  version: z.literal(1), source: z.literal("AGENCY_FACTS"),
  city: z.string().trim().min(1).max(80), otherCities: z.boolean(),
  commission: z.object({ sellerPercent: z.number().finite().min(0).max(100), buyerPercent: z.number().finite().min(0).max(100) }).strict(),
  rent: z.boolean(), installments: z.boolean(), mortgage: z.boolean(),
  botNamesDiscount: z.boolean(), guarantees: z.boolean(),
}).strict();
export type CustomerAgentCompanyKnowledge = z.infer<typeof customerAgentCompanyKnowledgeSchema>;
export const customerAgentCompanyPolicyTopicSchema = z.enum(["commission", "rental", "payment", "negotiation", "legal", "service_scope"]);
export type CustomerAgentCompanyPolicyTopic = z.infer<typeof customerAgentCompanyPolicyTopicSchema>;
export const customerAgentCompanyPolicyCallSchema = z.object({
  name: z.literal("get_company_policy"), args: z.object({ topic: customerAgentCompanyPolicyTopicSchema }).strict(),
}).strict();
export const customerAgentCompanyInformationCallSchema = z.object({
  name: z.literal("get_company_information"), args: z.object({}).strict(),
}).strict();
export const customerAgentCompanyInformationSchema = z.object({
  name: z.string().min(1).max(100), city: z.string().min(1).max(80),
  office: z.string().min(1).max(600), services: z.string().min(1).max(300),
  hours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/),
    daysOff: z.array(z.number().int().min(0).max(6)).max(7) }).strict().nullable(),
}).strict();

const amount = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/).refine(value => Number(value) > 0);
/** No currency inference, raw street/coordinates, staff scope, resource IDs or profile fields.
 * Results are possible ranked alternatives, not proof of a customer's interest. */
export const customerAgentPropertySearchArgsSchema = z.object({
  type: z.enum(["APARTMENT", "HOUSE", "LAND", "COMMERCIAL"]).optional(),
  districtName: z.string().trim().min(1).max(80).optional(),
  rooms: z.number().int().min(1).max(20).optional(),
  budget: z.object({ min: amount.optional(), max: amount.optional(), currency: z.enum(["TJS", "USD"]) }).strict()
    .refine(value => value.min !== undefined || value.max !== undefined)
    .refine(value => value.min === undefined || value.max === undefined || Number(value.min) <= Number(value.max)).optional(),
  sort: z.enum(["best", "cheap"]).optional(),
  nextPage: z.boolean().optional(),
}).strict().refine(value => value.type !== undefined || value.districtName !== undefined,
  "An explicit property type or district is required before a bounded search");
export type CustomerAgentPropertySearchArgs = z.infer<typeof customerAgentPropertySearchArgsSchema>;
export const customerAgentPropertySearchCallSchema = z.object({
  name: z.literal("search_public_properties"), args: customerAgentPropertySearchArgsSchema,
}).strict();
