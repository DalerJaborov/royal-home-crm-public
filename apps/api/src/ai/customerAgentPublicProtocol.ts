import { createHash } from "node:crypto";
import { customerAgentCompanyKnowledgeSchema, customerAgentCompanyPolicyTopicSchema, customerAgentCompanyInformationSchema, customerAgentCompanyInformationObservationSchema, customerAgentSearchObservationSchema,
  customerAgentPropertySearchArgsSchema, customerPropertyFactsSchema,
  type CustomerAgentCompanyKnowledge,
  type CustomerAgentPropertySearchArgs } from "@royal-home/shared";

import type { CustomerAgentCompanyPolicyObservation, CustomerAgentSearchObservation,
  CustomerAgentSearchCard } from "@royal-home/shared";
export type { CustomerAgentCompanyPolicyObservation, CustomerAgentSearchObservation,
  CustomerAgentSearchCard } from "@royal-home/shared";

/** Pure reporting of already read fields; no permission or matching engine.
 * Currency conversion comes from existing money service at the server adapter. */
export function customerAgentSearchFit(query: CustomerAgentPropertySearchArgs, listing: CustomerAgentSearchCard["listing"],
  prices: { cardTjs: number | null; minTjs: number | null; maxTjs: number | null }): CustomerAgentSearchCard["match"] {
  const notes: CustomerAgentSearchCard["match"]["notes"][number][] = [];
  if (query.rooms !== undefined && query.type !== "LAND") {
    if (listing.rooms === null) notes.push("rooms_unknown");
    else if (listing.rooms > query.rooms) notes.push("rooms_more");
    else if (listing.rooms < query.rooms) notes.push("rooms_less");
  }
  if (query.budget) {
    if (prices.cardTjs === null) notes.push("price_unknown");
    else {
      if (prices.maxTjs !== null && prices.cardTjs > prices.maxTjs) notes.push("over_budget");
      if (prices.minTjs !== null && prices.cardTjs < prices.minTjs) notes.push("below_budget");
    }
  }
  return { status: notes.some(note => note === "rooms_unknown" || note === "price_unknown") ? "unknown" : notes.length ? "relaxed" : "exact", notes };
}

/** P03 price/address signature intentionally does not bind rooms/type. This
 * minimal public listing signature extends it before search may assert them. */
export function customerAgentPublicListingSignature(factsSignature: string, listing: Omit<CustomerAgentSearchCard["listing"], "signature">): string {
  return createHash("sha256").update(JSON.stringify({ factsSignature, type: listing.type, rooms: listing.rooms, districtName: listing.districtName })).digest("hex");
}

/** Parsed key order is fixed by the strict schema; no raw prompt/source text.
 * A pinned hash proves content identity, not permission or model truth. */
export function customerAgentCompanyKnowledgeHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(customerAgentCompanyKnowledgeSchema.parse(value))).digest("hex");
}
export function customerAgentCompanyInformationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(customerAgentCompanyInformationSchema.parse(value))).digest("hex");
}
export function isCustomerCompanyInformation(value: unknown): value is import("@royal-home/shared").CustomerAgentCompanyInformationObservation {
  const parsed = customerAgentCompanyInformationObservationSchema.safeParse(value);
  return parsed.success && parsed.data.sourceHash === customerAgentCompanyInformationHash(parsed.data.information);
}
export function isPinnedCompanyPolicy(value: CustomerAgentCompanyPolicyObservation, expectedHash: string | undefined): boolean {
  const parsed = customerAgentCompanyKnowledgeSchema.safeParse(value.knowledge);
  return !!expectedHash && parsed.success && customerAgentCompanyPolicyTopicSchema.safeParse(value.topic).success &&
    value.sourceHash === expectedHash && customerAgentCompanyKnowledgeHash(parsed.data) === expectedHash;
}
export function isPublicPropertySearch(value: CustomerAgentSearchObservation): boolean {
  return customerAgentSearchObservationSchema.safeParse(value).success && customerAgentPropertySearchArgsSchema.safeParse(value.query).success && value.coverage === "bounded_ranked_pool" &&
    /^[a-f0-9]{64}$/.test(value.policyHash) &&
    Number.isSafeInteger(value.poolLimit) && value.poolLimit > 0 && value.poolLimit <= 500 &&
    Array.isArray(value.cards) && value.cards.length <= 3 &&
    new Set(value.cards.map((card: CustomerAgentSearchCard) => card.facts.shortId)).size === value.cards.length &&
    value.cards.every((card: CustomerAgentSearchCard) => customerPropertyFactsSchema.safeParse(card.facts).success &&
      card.facts.availability === "AVAILABLE" && card.facts.addressPolicy === "district_city_only" &&
      ["APARTMENT", "HOUSE", "LAND", "COMMERCIAL"].includes(card.listing.type) &&
      (card.listing.rooms === null || Number.isSafeInteger(card.listing.rooms) && card.listing.rooms >= 0 && card.listing.rooms <= 100) &&
      (card.listing.districtName === null || typeof card.listing.districtName === "string" && card.listing.districtName.length <= 80) &&
      card.listing.signature === customerAgentPublicListingSignature(card.facts.signature, card.listing) &&
      ["exact", "relaxed", "unknown"].includes(card.match.status) && card.match.notes.length <= 6 &&
      new Set(card.match.notes).size === card.match.notes.length &&
      card.match.notes.every(note => ["rooms_more", "rooms_less", "over_budget", "below_budget", "rooms_unknown", "price_unknown"].includes(note)) &&
      (card.match.status === "unknown" ? card.match.notes.some(note => note === "rooms_unknown" || note === "price_unknown")
        : card.match.status === "relaxed" ? card.match.notes.length > 0 && !card.match.notes.some(note => note === "rooms_unknown" || note === "price_unknown")
        : card.match.notes.length === 0));
}

/** Model-visible whitelists: no UUIDs, raw street/owner, signature, internal score or staff assignment. */
export function publicSearchProjection(value: CustomerAgentSearchObservation) {
  return { kind: value.kind, query: structuredClone(value.query), coverage: value.coverage,
    cards: value.cards.map(({ facts: f, listing, match }) => ({ shortId: f.shortId, price: f.price, currency: f.currency,
      availability: f.availability, publicAddress: f.publicAddress,
      type: listing.type, rooms: listing.rooms, match: structuredClone(match) })) };
}
