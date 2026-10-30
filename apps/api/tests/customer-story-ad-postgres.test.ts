import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmission, CustomerPropertyEvidence } from "@royal-home/shared";
// Explicit DATABASE_URL supplied by the stand runner; do not load local keys.
vi.mock("../src/loadEnv.js", () => ({}));
import { prisma } from "../src/db.js";
import { parseIncoming } from "../src/messengers/meta.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { customerPropertyEvidenceFromMeta } from "../src/lib/customerPropertyEvidence.js";
import { resolveCustomerPropertyTurnContext } from "../src/lib/customerPropertyTurnContext.js";
import { customerPropertyUnresolvedReason } from "../src/lib/customerPropertyUnresolvedReason.js";
import { resetMetaPeerMemory } from "../src/messengers/metaPeerMemory.js";

const tag = `p1-${randomUUID()}`;
const peers: string[] = [];
const accountIds: string[] = [];
const ticketKeys = new Set<string>();
const propertyIds: string[] = [];
const adExternalIds: string[] = [];
let externalId: string;
const CDN = "https://scontent-fra5-1.cdninstagram.com/v/t51.12442-15/synthetic_story.jpg?token=synthetic";
const peer = () => { const value = `${tag}-${peers.length}`; peers.push(value); return value; };
async function admit(target: string, id: string, refs: CustomerPropertyEvidence[]): Promise<CustomerPropertyAdmission> {
  const result = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: target, accountExternalId: externalId, eventKind: "message", eventId: id, evidence: refs });
  if (result.status !== "admitted") throw new Error(`Admission denied: ${result.reason}`);
  ticketKeys.add(result.ticket.eventKey);
  return result.ticket;
}
const turn = (ticket: CustomerPropertyAdmission) => resolveCustomerPropertyTurnContext({ status: "admitted", ticket }, [ticket]);
const storyReply = (storyId: string, text: string) => parseIncoming({ object: "instagram", entry: [{ id: externalId, messaging: [{
  sender: { id: "synthetic-peer" }, recipient: { id: externalId }, timestamp: 1,
  message: { mid: `mid-${storyId}`, text, reply_to: { story: { id: storyId, url: CDN } } } }] }] }, undefined, false, { captureCustomerReferences: true })[0];
async function property(title: string): Promise<string> {
  const row = await prisma.property.create({ data: { title: `${tag}-${title}`, type: "APARTMENT", areaSqm: 60, price: 960000, currency: "TJS",
    condition: "GOOD", status: "AVAILABLE", publishedOnSite: true, address: "Synthetic private address" } });
  propertyIds.push(row.id); return row.id;
}

beforeAll(async () => {
  externalId = `${tag}-account`;
  const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId, title: tag, token: "fictional-token-never-used" } });
  accountIds.push(account.id);
});
beforeEach(() => resetMetaPeerMemory());
afterAll(async () => {
  const scopes = await prisma.customerEndpointScope.findMany({ where: { messengerAccountId: { in: accountIds } }, select: { id: true } });
  const scopeIds = scopes.map(scope => scope.id);
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { OR: [{ eventKey: { in: [...ticketKeys] } }, { endpointScopeId: { in: scopeIds } }] } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { in: peers }, channel: "INSTAGRAM" } });
  await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.ad.deleteMany({ where: { externalId: { in: adExternalIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } }); // stories cascade
  await prisma.$disconnect();
});

describe("P1 a reply to our own story finds the object through PropertyStoryPost", () => {
  it("«салом адрес» under the story card of an object resolves to that object", async () => {
    const id = await property("story-card");
    const mediaId = `1811${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await prisma.propertyStoryPost.create({ data: { propertyId: id, channel: "INSTAGRAM", mediaId, kind: "CARD" } });
    const evidence = customerPropertyEvidenceFromMeta(storyReply(mediaId, "салом адрес"));
    const context = await turn(await admit(peer(), "A", evidence));
    expect(context?.snapshot.focus).toMatchObject({ status: "resolved", propertyId: id });
  });
  it("a price offer under a story («850 хазор накт») resolves the same way", async () => {
    const id = await property("story-video");
    const mediaId = `1812${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await prisma.propertyStoryPost.create({ data: { propertyId: id, channel: "INSTAGRAM", mediaId, kind: "VIDEO" } });
    const context = await turn(await admit(peer(), "A", customerPropertyEvidenceFromMeta(storyReply(mediaId, "850хазор те Ман мегирам накт"))));
    expect(context?.snapshot.focus).toMatchObject({ status: "resolved", propertyId: id });
  });
  it("an unknown story id is «not found», never an untrusted-origin accusation", async () => {
    const context = await turn(await admit(peer(), "A", customerPropertyEvidenceFromMeta(storyReply("18199999999999999", "салом адрес"))));
    expect(context?.snapshot.focus.status).toBe("missing");
    expect(customerPropertyUnresolvedReason(context!.snapshot.focus.evidence, "missing", context!.snapshot.focus.lookupAttempts)).toBe("not_found");
  });
});

describe("P1 an ad referral resolves, or says the ad is not tied to an object", () => {
  it("the ad of an object resolves to it", async () => {
    const id = await property("ad-bound"); const adId = `${tag}-ad-1`; adExternalIds.push(adId);
    await prisma.ad.create({ data: { platform: "META", externalId: adId, name: tag, propertyId: id } });
    const context = await turn(await admit(peer(), "A", [{ kind: "ad", origin: "remembered_referral", reference: adId }]));
    expect(context?.snapshot.focus).toMatchObject({ status: "resolved", propertyId: id });
  });
  it("an ad without an object is ad_unmapped, not «by this link or number»", async () => {
    const adId = `${tag}-ad-2`; adExternalIds.push(adId);
    await prisma.ad.create({ data: { platform: "META", externalId: adId, name: tag } });
    const context = await turn(await admit(peer(), "A", [{ kind: "ad", origin: "remembered_referral", reference: adId }]));
    expect(context?.snapshot.focus.status).toBe("missing");
    expect(customerPropertyUnresolvedReason(context!.snapshot.focus.evidence, "missing", context!.snapshot.focus.lookupAttempts)).toBe("ad_unmapped");
  });
});
