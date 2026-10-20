import { createHash } from "node:crypto";
import { z } from "zod";
import { customerAgentCompanyKnowledgeSchema, customerAgentCompanyPolicyCallSchema, customerAgentPropertySearchCallSchema, customerToolCallSchema, customerAgentCompanyInformationCallSchema,
  type CustomerAgentPublicationObservation,
  type CustomerAgentPropertySearchArgs } from "@royal-home/shared";
import { AGENCY_FACTS } from "../ai/agencyFacts.js";
import { customerAgentCompanyKnowledgeHash, isPinnedCompanyPolicy, isPublicPropertySearch,
  customerAgentPublicListingSignature, customerAgentSearchFit,
  type CustomerAgentCompanyPolicyObservation, type CustomerAgentSearchObservation, type CustomerAgentSearchCard } from "../ai/customerAgentPublicProtocol.js";
import { prisma } from "../db.js";
import { isCustomerPrincipal, revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { BOT_OFFER_SELECT, findMatchingProperties, PROPERTY_MATCH_POOL, type PropertyMatchQuery } from "./propertyMatch.js";
import { projectCustomerPropertyFacts, CUSTOMER_PROPERTY_CHARACTERISTICS_SELECT } from "./customerPropertyFacts.js";
import { loadMatchPolicy } from "./matchPolicy.js";
import { loadMoneyContext, toTjs } from "./money.js";
import { readCustomerPublicationObservation, customerPublicationObservationCurrent, type CustomerPublicationSource } from "./customerPublicationCatalog.js";
import { readCustomerCompanyInformation, customerCompanyInformationCurrent } from "./customerCompanyInformation.js";
import type { CustomerAgentCompanyInformationObservation } from "@royal-home/shared";
import { resolveSearchPlace } from "./searchPlace.js";
import { loadCustomerAgentFeaturePolicy } from "./customerAgentFeaturePolicy.js";

/** ONE actual source, no copied commission constants/office/customer data. */
export function readCustomerAgentCompanyKnowledge() {
  const f = AGENCY_FACTS;
  return customerAgentCompanyKnowledgeSchema.parse({ version: 1, source: "AGENCY_FACTS", city: f.city, otherCities: f.otherCities,
    commission: { ...f.commission }, rent: f.rent, installments: f.installments, mortgage: f.mortgage,
    botNamesDiscount: f.botNamesDiscount, guarantees: f.guarantees });
}
export function currentCustomerAgentKnowledgeHash(): string { return customerAgentCompanyKnowledgeHash(readCustomerAgentCompanyKnowledge()); }

const calls = z.union([customerAgentCompanyPolicyCallSchema, customerAgentPropertySearchCallSchema, customerToolCallSchema, customerAgentCompanyInformationCallSchema]);
async function current(principal: CustomerPrincipal): Promise<boolean> {
  return (await revalidateCustomerPrincipal(principal)).status === "current";
}
async function searchPolicy(args: CustomerAgentPropertySearchArgs) {
  const [policy, money, features] = await Promise.all([loadMatchPolicy(), loadMoneyContext(), loadCustomerAgentFeaturePolicy()]);
  const exact = args.districtName ? await prisma.district.findFirst({ where: { name: { equals: args.districtName, mode: "insensitive" } }, select: { name: true } }) : null;
  const place = args.districtName && !exact ? await resolveSearchPlace(args.districtName) : null;
  const requestedDistrict = place?.suburban ? null : place?.districtName ?? place?.placeDistrictName;
  const mapped = requestedDistrict ? await prisma.district.findFirst({ where: { name: { equals: requestedDistrict, mode: "insensitive" } }, select: { name: true } }) : null;
  const districtName = exact?.name ?? mapped?.name ?? null;
  const hash = createHash("sha256").update(JSON.stringify({ query: args, budgetToleranceRatio: policy.budgetToleranceRatio,
    roomsTolerance: policy.roomsTolerance, resolvedDistrictName: districtName, linksAllowed: features.links,
    usdToTjs: args.budget || args.sort === "cheap" ? money.usdToTjs : null })).digest("hex");
  return { hash, money, districtName, linksAllowed: features.links };
}
async function readPublicSearchListing(propertyId: string, channel: string) {
  const row = await prisma.property.findUnique({ where: { id: propertyId }, select: {
    ...BOT_OFFER_SELECT, ...CUSTOMER_PROPERTY_CHARACTERISTICS_SELECT, id: true, shortId: true, price: true, currency: true, updatedAt: true,
    district: { select: { name: true, city: true } },
  } });
  const facts = row ? projectCustomerPropertyFacts(row, channel) : null;
  if (!row || !facts || facts.availability !== "AVAILABLE") return null;
  const data = { type: row.type, rooms: row.rooms, districtName: row.district?.name ?? null };
  return { facts, listing: { ...data, signature: customerAgentPublicListingSignature(facts.signature, data) } };
}
function fit(args: CustomerAgentPropertySearchArgs, value: Pick<CustomerAgentSearchCard, "facts" | "listing">, money: Awaited<ReturnType<typeof loadMoneyContext>>) {
  return customerAgentSearchFit(args, value.listing, {
    cardTjs: value.facts.price ? toTjs(value.facts.price, value.facts.currency, money) : null,
    minTjs: args.budget?.min ? toTjs(args.budget.min, args.budget.currency, money) : null,
    maxTjs: args.budget?.max ? toTjs(args.budget.max, args.budget.currency, money) : null,
  });
}

export interface CustomerAgentPublicDataOptions {
  /** Presentation preference from a server adapter, NOT transport/identity. */
  linkPreference: "site" | "social";
  knowledgeSourceHash: string;
  publication?: CustomerPublicationSource;
  /** Server receipt ledger only; never accepted as model/tool arguments. */
  alreadyShownShortIds?: readonly number[];
}
export type CustomerAgentPublicDataResult =
    { status: "observed"; observation: CustomerAgentCompanyPolicyObservation | CustomerAgentSearchObservation | CustomerAgentPublicationObservation | CustomerAgentCompanyInformationObservation } |
    { status: "denied" | "unavailable"; reason: string };

/** INTERNAL public data service, deliberately no principal/authorization API.
 * DM/website/public-comment/voice adapters must supply their OWN genuine
 * source-specific before/after guards. Never cast a comment/call as a DM.
 * This service is not an HTTP route, model grant, staff tool or channel sender.
 * No liveVoice searchTool: that wrapper writes Profile buyer wishes. */
export async function readCustomerAgentPublicData(rawCall: unknown, options: CustomerAgentPublicDataOptions): Promise<CustomerAgentPublicDataResult> {
  const call = calls.safeParse(rawCall);
  if (!call.success) return { status: "denied", reason: "invalid_public_call" };
  try {
    if (call.data.name === "get_company_information") return { status: "observed", observation: await readCustomerCompanyInformation() };
    if (call.data.name === "get_property_facts") {
      if (!options.publication) return { status: "denied", reason: "publication_source_required" };
      const observation = await readCustomerPublicationObservation(options.publication, call.data.args.kinds);
      return observation ? { status: "observed", observation } : { status: "unavailable", reason: "publication_unresolved" };
    }
    if (call.data.name === "get_company_policy") {
      const knowledge = readCustomerAgentCompanyKnowledge();
      const observation: CustomerAgentCompanyPolicyObservation = { kind: "company_policy", topic: call.data.args.topic,
        knowledge, sourceHash: customerAgentCompanyKnowledgeHash(knowledge) };
      if (!isPinnedCompanyPolicy(observation, options.knowledgeSourceHash)) {
        return { status: "denied", reason: "knowledge_changed" };
      }
      return { status: "observed", observation };
    }
    const args = call.data.args;
    // Existing matcher silently ignores an unknown district. Do not turn an
    // unrecognized area into apparent positive matching across the whole city.
    const before = await searchPolicy(args);
    if (args.districtName && !before.districtName) return { status: "denied", reason: "district_not_resolved" };
    const query: PropertyMatchQuery = { type: args.type, districtName: before.districtName ?? undefined, rooms: args.rooms, sort: args.sort,
      budgetMin: args.budget?.min ? toTjs(args.budget.min, args.budget.currency, before.money) : undefined,
      budgetMax: args.budget?.max ? toTjs(args.budget.max, args.budget.currency, before.money) : undefined };
    const rows = await findMatchingProperties(query, { limit: 3,
      ...(args.nextPage ? { scope: { shortId: { notIn: [...(options.alreadyShownShortIds ?? [])] } } } : {}) });
    const cards: CustomerAgentSearchCard[] = [];
    for (const row of rows) {
      const now = await readPublicSearchListing(row.id, options.linkPreference === "site" ? "WEBSITE" : "INSTAGRAM");
      if (!now || now.facts.updatedAt !== row.updatedAt.toISOString() || now.facts.currency !== row.currency ||
          now.facts.price !== null && now.facts.price !== row.price.toString() ||
          args.type !== undefined && now.listing.type !== args.type || before.districtName !== null && now.listing.districtName !== before.districtName) {
        return { status: "denied", reason: "search_card_changed" };
      }
      cards.push({ ...now, match: fit(args, now, before.money) });
    }
    const observation: CustomerAgentSearchObservation = { kind: "property_search", query: args, coverage: "bounded_ranked_pool",
      poolLimit: PROPERTY_MATCH_POOL, policyHash: before.hash, cards, linksAllowed: before.linksAllowed,
      ...(before.districtName ? { resolvedDistrictName: before.districtName, districtWasNormalized: args.districtName !== before.districtName } : {}) };
    if (!await customerAgentPublicDataCurrent(observation, options)) return { status: "denied", reason: "search_changed" };
    return { status: "observed", observation };
  } catch { return { status: "unavailable", reason: "public_read_unavailable" }; }
}

/** INTERNAL data freshness only. Does not establish an actor, epoch or OUT
 * permission. Persist these exact witnesses in P12, not a model card. */
export async function customerAgentPublicDataCurrent(value: CustomerAgentCompanyPolicyObservation | CustomerAgentSearchObservation | CustomerAgentPublicationObservation | CustomerAgentCompanyInformationObservation,
  options: CustomerAgentPublicDataOptions): Promise<boolean> {
  if (value.kind === "company_information") return customerCompanyInformationCurrent(value);
  if (value.kind === "publication_properties") return customerPublicationObservationCurrent(value);
  if (value.kind === "company_policy") return isPinnedCompanyPolicy(value, options.knowledgeSourceHash) &&
    currentCustomerAgentKnowledgeHash() === options.knowledgeSourceHash;
  const policy = await searchPolicy(value.query);
  if (!isPublicPropertySearch(value) || policy.hash !== value.policyHash) return false;
  if ((value.linksAllowed !== false) !== policy.linksAllowed) return false;
  if (value.query.districtName && (!policy.districtName || value.resolvedDistrictName !== policy.districtName)) return false;
  for (const card of value.cards) {
    const now = await readPublicSearchListing(card.facts.propertyId, options.linkPreference === "site" ? "WEBSITE" : "INSTAGRAM");
    if (!now || now.facts.signature !== card.facts.signature || now.listing.signature !== card.listing.signature ||
        policy.districtName !== null && now.listing.districtName !== policy.districtName ||
        JSON.stringify(fit(value.query, now, policy.money)) !== JSON.stringify(card.match)) return false;
  }
  return (await searchPolicy(value.query)).hash === value.policyHash;
}

/** Genuine DM/website guarded wrapper ONLY. No interest/exposure/shown/lead,
 * SMS/focus writes. Public/voice reuse the service above with their own actual
 * issuer guards; no generic authorized:true or JSON frame is accepted here. */
export async function readCustomerAgentPublicTool(principal: unknown, rawCall: unknown,
  options: { enabled: boolean; knowledgeSourceHash: string }): Promise<CustomerAgentPublicDataResult> {
  if (!options.enabled || !isCustomerPrincipal(principal)) return { status: "denied", reason: "public_read_disabled" };
  try {
    if (!await current(principal)) return { status: "denied", reason: "original_context_changed" };
    const result = await readCustomerAgentPublicData(rawCall, { knowledgeSourceHash: options.knowledgeSourceHash,
      linkPreference: principal.visibility === "website_chat" ? "site" : "social" });
    if (!await current(principal)) return { status: "denied", reason: "original_context_changed" };
    return result;
  } catch { return { status: "unavailable", reason: "public_read_unavailable" }; }
}

/** ORIGINAL genuine DM/website authority before/after data-only freshness.
 * Point checks are not atomic with a physical provider POST; no network lock. */
export async function customerAgentPublicReadCurrent(principal: CustomerPrincipal,
  value: CustomerAgentCompanyPolicyObservation | CustomerAgentSearchObservation | CustomerAgentCompanyInformationObservation, expectedKnowledgeHash: string): Promise<boolean> {
  if (!isCustomerPrincipal(principal) || !await current(principal)) return false;
  if (!await customerAgentPublicDataCurrent(value, { knowledgeSourceHash: expectedKnowledgeHash,
    linkPreference: principal.visibility === "website_chat" ? "site" : "social" })) return false;
  return await current(principal);
}
