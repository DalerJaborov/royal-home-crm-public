import { z } from "zod";
import { PROPERTY_TYPES } from "./enums.js";
import { customerAgentCompanyKnowledgeSchema, customerAgentCompanyPolicyTopicSchema,
  customerAgentPropertySearchArgsSchema, customerAgentCompanyInformationSchema } from "./customerAgentPublicReads.js";
import { customerPropertyFactsSchema, customerPropertyFactKindSchema } from "./customerPropertyContext.js";
import { customerAgentVacanciesObservationSchema, type CustomerAgentVacanciesObservation } from "./recruitment.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const customerAgentCompanyInformationObservationSchema = z.object({
  kind: z.literal("company_information"), sourceHash: digest, information: customerAgentCompanyInformationSchema,
}).strict();
export const customerAgentCompanyPolicyObservationSchema = z.object({
  kind: z.literal("company_policy"), topic: customerAgentCompanyPolicyTopicSchema,
  sourceHash: digest, knowledge: customerAgentCompanyKnowledgeSchema,
}).strict();
export const customerAgentSearchCardSchema = z.object({
  facts: customerPropertyFactsSchema.refine(value => value.availability === "AVAILABLE"),
  listing: z.object({ type: z.enum(PROPERTY_TYPES),
    rooms: z.number().int().min(0).max(100).nullable(), districtName: z.string().max(80).nullable(), signature: digest }).strict(),
  match: z.object({ status: z.enum(["exact", "relaxed", "unknown"]),
    notes: z.array(z.enum(["rooms_more", "rooms_less", "over_budget", "below_budget", "rooms_unknown", "price_unknown"])).max(6)
      .refine(values => new Set(values).size === values.length) }).strict(),
}).strict();
export const customerAgentSearchObservationSchema = z.object({
  kind: z.literal("property_search"), query: customerAgentPropertySearchArgsSchema,
  coverage: z.literal("bounded_ranked_pool"), poolLimit: z.number().int().min(1).max(500),
  policyHash: digest, cards: z.array(customerAgentSearchCardSchema).max(3),
  resolvedDistrictName: z.string().min(1).max(80).optional(),
  /** District mapping is not a promise of proximity to a named landmark. */
  districtWasNormalized: z.boolean().optional(),
  linksAllowed: z.boolean().optional(),
}).strict().refine(value => new Set(value.cards.map(card => card.facts.shortId)).size === value.cards.length &&
  new Set(value.cards.map(card => card.facts.propertyId)).size === value.cards.length, "Duplicate search card");
/** Exact publisher catalog membership, not a ranked search or model-selected IDs. */
export const customerAgentPublicationObservationSchema = z.object({
  kind: z.literal("publication_properties"),
  source: z.object({ channel: z.enum(["INSTAGRAM", "FACEBOOK"]), resourceId: z.string().min(1).max(512), publicationId: z.string().min(1).max(512),
    permalink: z.string().regex(/^https:\/\/www\.instagram\.com\/p\/[A-Za-z0-9_-]{1,128}\/$/).optional() }).strict()
    .refine(value => value.permalink === undefined || value.channel === "INSTAGRAM"),
  mappingSignature: digest,
  linksAllowed: z.boolean().optional(),
  kinds: z.array(customerPropertyFactKindSchema).min(1).max(customerPropertyFactKindSchema.options.length)
    .refine(values => new Set(values).size === values.length),
  cards: z.array(customerPropertyFactsSchema).min(1).max(5)
    .refine(values => new Set(values.map(value => value.propertyId)).size === values.length),
}).strict();
export type CustomerAgentPublicationObservation = z.infer<typeof customerAgentPublicationObservationSchema>;
export const customerAgentDeliveryObservationSchema = z.discriminatedUnion("kind", [
  customerAgentCompanyPolicyObservationSchema, customerAgentSearchObservationSchema, customerAgentPublicationObservationSchema, customerAgentCompanyInformationObservationSchema, customerAgentVacanciesObservationSchema,
]);
export type CustomerAgentCompanyPolicyObservation = z.infer<typeof customerAgentCompanyPolicyObservationSchema>;
export type CustomerAgentCompanyInformationObservation = z.infer<typeof customerAgentCompanyInformationObservationSchema>;
export type CustomerAgentSearchObservation = Omit<z.infer<typeof customerAgentSearchObservationSchema>, "cards"> & { cards: readonly CustomerAgentSearchCard[] };
export type CustomerAgentSearchCard = Omit<z.infer<typeof customerAgentSearchCardSchema>, "match"> & { match: Omit<z.infer<typeof customerAgentSearchCardSchema>["match"], "notes"> & { notes: readonly z.infer<typeof customerAgentSearchCardSchema>["match"]["notes"][number][] } };
export type CustomerAgentDeliveryObservation = CustomerAgentCompanyPolicyObservation | CustomerAgentSearchObservation | CustomerAgentPublicationObservation | CustomerAgentCompanyInformationObservation | CustomerAgentVacanciesObservation;

/** Encrypted P12 sideband, never a model/customer authority. Original revision
 * and presentation preference are retained; restart must not adopt current defaults. */
export const customerAgentDeliveryEvidenceSchema = z.object({
  version: z.literal(1), agentRevisionId: digest, knowledgeSourceHash: digest,
  linkPreference: z.enum(["site", "social"]),
  observations: z.array(customerAgentDeliveryObservationSchema).max(8),
  callbackQuestion: z.object({ version: z.literal(1), kind: z.literal("callback_consent"), language: z.enum(["ru", "tg"]) }).strict().optional(),
  nameQuestion: z.object({ version: z.literal(1), kind: z.literal("name"), language: z.enum(["ru", "tg"]) }).strict().optional(),
  guideFollow: z.object({ version: z.literal(1), kind: z.literal("buyer_guide_follow"), language: z.enum(["ru", "tg"]) }).strict().optional(),
}).strict().refine(value => value.observations.length > 0 || !!value.callbackQuestion || !!value.nameQuestion || !!value.guideFollow, "Empty delivery evidence");
export type CustomerAgentDeliveryEvidence = z.infer<typeof customerAgentDeliveryEvidenceSchema>;
export const customerAgentStoredTextPayloadSchema = z.object({
  kind: z.literal("text"), text: z.string().trim().min(1).max(12000),
  publicData: customerAgentDeliveryEvidenceSchema.optional(),
}).strict();
