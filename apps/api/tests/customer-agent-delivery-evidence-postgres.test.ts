import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { AGENCY_FACTS } from "../src/ai/agencyFacts.js";
import { registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { claimCustomerAgentTurnTx } from "../src/lib/customerAgentClaim.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import { currentCustomerAgentKnowledgeHash } from "../src/lib/customerAgentPublicReads.js";
import { readDmCustomerAgentDataWitness, sealDmCustomerAgentDeliveryEvidence,
  type CustomerAgentDataReadWitness, type CustomerAgentDeliveryRender } from "../src/lib/customerAgentDeliveryEvidence.js";
import { createCustomerOutboxPartsTx, decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "../src/lib/customerOutbox.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { readCustomerPropertyFacts } from "../src/lib/customerPropertyFacts.js";
import { openAuthenticatedCustomerContactIntent } from "../src/lib/customerContactIntent.js";
import { issueCustomerWriteAuthority } from "../src/lib/customerState.js";
import { executeCustomerAction } from "../src/lib/customerActionJournal.js";
import { continueCustomerAgentAfterLocalAuthority } from "../src/lib/customerAgentContinuation.js";
import { revalidateCustomerPrincipal, type CustomerPrincipal } from "../src/lib/customerPrincipal.js";
import type { CustomerAgentDeliveryObservation } from "@royal-home/shared";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

// Actual PG, signed raw Meta request, durable producer/recovery, actual read,
// renderer, principal/claim, P12 transaction and real Meta send adapter. Only
// profile GET / physical provider POST are synthetic. No model/provider costs.
const accounts: string[] = [], events: string[] = [], natives: string[] = [], parts: string[] = [];
const properties: string[] = [], districts: string[] = [], mids: string[] = [];
const h = "6".repeat(64), manifest = { coreHash: h, modelSchemaHash: h, toolSchemaHash: h, rendererHash: h,
  knowledgeSchemaHash: h, knowledgeSourceHash: currentCustomerAgentKnowledgeHash(), providerProfileHash: h,
  providerPolicyHash: h, promptHash: h,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 3000, maxModelOutputTokens: 1024, deadlineMs: 120_000 } };
const revisionId = customerAgentManifestId(manifest);
let settings: Awaited<ReturnType<typeof readSettings>>, policy: Awaited<ReturnType<typeof readPolicy>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, matchBudgetTolerancePct: true,
  matchRoomsTolerance: true, usdToTjsRate: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } }); }
const sentBodies: unknown[] = [];

async function fixture(text = "Какая комиссия?") {
  const accountId = randomUUID(), externalId = `synthetic-data-evidence-${randomUUID()}`;
  const secret = `synthetic-data-key-${randomUUID()}`, token = `synthetic-data-token-${randomUUID()}`, peer = `synthetic-data-peer-${randomUUID()}`;
  await prisma.messengerAccount.create({ data: { id: accountId, externalId, channel: "INSTAGRAM",
    username: `synthetic_data_${accountId.replaceAll("-", "")}`, title: "Synthetic delivery public data",
    token: encryptSecret(token), appSecret: encryptSecret(secret), enabled: true } }); accounts.push(accountId);
  await rollout.allowDm({ peer, accountId, accountExternalId: externalId });
  const mid = randomUUID(), rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId,
    messaging: [{ sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid, text } }] }] }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  const pending = await persistVerifiedCustomerIngressBatch(request);
  expect(pending.status).toBe("persisted"); if (pending.status !== "persisted") throw new Error("Actual pending fixture unavailable");
  events.push(...pending.tickets.map(ticket => ticket.eventKey));
  expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel: "INSTAGRAM", accountId, accountExternalId: externalId })).toBe(true);
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)), authorization = (init?.headers as Record<string, string>)?.Authorization;
    if (u.origin !== "https://graph.instagram.com" || authorization !== `Bearer ${token}`) throw new Error("Unexpected synthetic provider target");
    if (init?.method === "GET" && u.pathname === `/v23.0/${peer}` && u.search === "?fields=username") {
      return new Response(JSON.stringify({ id: peer, username: "synthetic_data_customer" }));
    }
    if (init?.method === "POST" && u.pathname === "/v23.0/me/messages" && u.search === "") {
      const body: unknown = JSON.parse(String(init.body)); posts.push(body); sentBodies.push(body);
      const providerMid = `synthetic-data-mid-${randomUUID()}`; mids.push(providerMid);
      return new Response(JSON.stringify({ recipient_id: peer, message_id: providerMid }));
    }
    throw new Error("Unexpected synthetic provider request");
  }));
  const prepared = await prepareCustomerDmInboxCoreContext(pending.tickets[0].eventKey);
  expect(prepared.status).toBe("prepared"); if (prepared.status !== "prepared") throw new Error(`Actual context unavailable: ${prepared.status}`);
  natives.push(prepared.lane.ticket.conversationId);
  const elected = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, prepared.lane.principal));
  expect(elected.status).toBe("claimed"); if (elected.status !== "claimed") throw new Error("Actual claim unavailable");
  return { ...prepared, claim: elected.claim, posts, peer };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function read(f: Fixture, call: unknown) {
  const result = await readDmCustomerAgentDataWitness({ principal: f.lane.principal, claim: f.claim, call });
  expect(result.status).toBe("observed"); if (result.status !== "observed") throw new Error(`Actual public read unavailable: ${result.status}`);
  return result;
}
async function plan(f: Fixture, observation: CustomerAgentDeliveryObservation, token: CustomerAgentDataReadWitness,
  principal: CustomerPrincipal = f.lane.principal) {
  const render: CustomerAgentDeliveryRender = { decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
    evidence: [{ ref: "e0", value: structuredClone(observation) }], text: "", language: "ru", requestedFacts: [], knownPhoneSource: "none" };
  const text = renderCustomerAgentDecision({ ...render, surface: "dm", maxOutputChars: manifest.limits.maxOutputChars,
    knowledgeSourceHash: manifest.knowledgeSourceHash });
  if (!text) throw new Error("Actual renderer refused fixture"); render.text = text;
  const sealed = await sealDmCustomerAgentDeliveryEvidence({ principal, claim: f.claim, render, serverWitnesses: [token] });
  expect(sealed.status).toBe("sealed"); if (sealed.status !== "sealed" || !sealed.witness) throw new Error("Actual public-data seal unavailable");
  const ids = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal, agentClaim: f.claim,
    parts: [{ payload: { kind: "text", text: sealed.text }, publicDataWitness: sealed.witness }] })); parts.push(...ids);
  expect(ids).toHaveLength(1);
  const row = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: ids[0] } });
  expect(row.agentRevisionId).toBe(revisionId); expect(row.payloadEncrypted).not.toContain("publicData");
  expect(decodeCustomerOutboxPublicData(row)?.observations).toEqual([observation]);
  expect(decodeCustomerOutboxPayload(row)).toEqual({ kind: "text", text });
  return { id: ids[0], text };
}
const policyCall = { name: "get_company_policy", args: { topic: "commission" } };
async function catalog(rooms = 2) {
  const district = await prisma.district.create({ data: { name: `SyntheticData-${randomUUID()}`, city: "Душанбе" } }); districts.push(district.id);
  const property = await prisma.property.create({ data: { title: `Synthetic data property ${randomUUID()}`, type: "APARTMENT",
    areaSqm: 65, price: 500000, currency: "TJS", rooms, districtId: district.id, condition: "GOOD", status: "AVAILABLE",
    address: "PRIVATE DATA EVIDENCE SENTINEL", publishedOnSite: true, instagramUrl: `https://www.instagram.com/p/${randomUUID().replaceAll("-", "")}/` } });
  properties.push(property.id);
  return { property, call: { name: "search_public_properties", args: { type: "APARTMENT", districtName: district.name,
    budget: { max: "600000", currency: "TJS" } } } };
}
beforeAll(async () => {
  settings = await readSettings(); policy = await readPolicy();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  await prisma.customerAgentRevision.upsert({ where: { id: revisionId }, create: { id: revisionId, manifestJson: manifest }, update: {} });
  rollout = await createCustomerRolloutFixture(revisionId);
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true }, activeAgentRevisionId: revisionId } });
  vi.stubEnv("IG_PROXY_URL", ""); vi.stubEnv("GEMINI_PROXY_URL", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
});
beforeEach(() => { sentBodies.length = 0; });
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  try {
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [
      ...events.map(eventKey => `customer-inbox-consume:${eventKey}`), ...parts.map(id => `customer-outbox-dispatch:${id}`),
    ] } } });
    await prisma.processedMessage.deleteMany({ where: { channel: "out:meta", messageId: { in: mids } } });
    await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts } } });
    await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
    await prisma.customerAction.deleteMany({ where: { inquiry: { conversationId: { in: natives } } } });
    await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
    await prisma.outboundShieldState.deleteMany({ where: { endpointScope: { messengerAccountId: { in: accounts } } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
    await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accounts } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
    await prisma.property.deleteMany({ where: { id: { in: properties } } });
    await prisma.district.deleteMany({ where: { id: { in: districts } } });
  } finally {
    if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
    if (policy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
      contractVersion: policy.contractVersion, rolloutMode: policy.rolloutMode, capabilities: policy.capabilities!, activeAgentRevisionId: policy.activeAgentRevisionId,
    } });
    if (rollout) await rollout.restore();
  }
  // Immutable synthetic manifest intentionally retained. No foreign profiles,
  // Clients, shared scopes or global history are removed by this fixture.
});

describe("genuine reads persist exact public data through actual P12 delivery", () => {
  it("company read→seal→encrypted plan→actual send preserves only deterministic text on the wire", async () => {
    const f = await fixture(), data = await read(f, policyCall), planned = await plan(f, data.observation, data.serverWitness);
    expect(await dispatchCustomerOutboxPart(planned.id)).toEqual({ status: "accepted" });
    expect(f.posts).toEqual([{ recipient: { id: f.peer }, message: { text: planned.text } }]);
    expect(JSON.stringify(f.posts)).not.toMatch(/publicData|knowledgeSourceHash|agentRevisionId|observations/);
    expect(await prisma.customerDeliveryAttempt.count({ where: { partId: planned.id, outcome: "ACCEPTED" } })).toBe(1);
  });
  it("company facts changed after planning suppress the physical POST without erasing the plan", async () => {
    const f = await fixture(), data = await read(f, policyCall), planned = await plan(f, data.observation, data.serverWitness);
    const prior = Object.getOwnPropertyDescriptor(AGENCY_FACTS.commission, "sellerPercent")!;
    try {
      Object.defineProperty(AGENCY_FACTS.commission, "sellerPercent", { ...prior, value: Number(prior.value) + 1 });
      expect(await dispatchCustomerOutboxPart(planned.id)).toEqual({ status: "suppressed" });
      expect(f.posts).toHaveLength(0);
      expect(await prisma.customerDeliveryAttempt.count({ where: { partId: planned.id } })).toBe(0);
      expect(decodeCustomerOutboxPublicData(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: planned.id } })))
        .toMatchObject({ knowledgeSourceHash: manifest.knowledgeSourceHash });
    } finally { Object.defineProperty(AGENCY_FACTS.commission, "sellerPercent", prior); }
  });
  it("a genuine public search supports stored zero-room listing facts without leaking private address", async () => {
    const own = await catalog(0), f = await fixture("Подберите квартиру"), data = await read(f, own.call);
    expect(data.observation.kind).toBe("property_search"); if (data.observation.kind !== "property_search") throw new Error("No actual search");
    expect(data.observation.cards.map(card => card.facts.propertyId)).toEqual([own.property.id]);
    expect(data.observation.cards[0].listing.rooms).toBe(0);
    const planned = await plan(f, data.observation, data.serverWitness);
    expect(await dispatchCustomerOutboxPart(planned.id)).toEqual({ status: "accepted" });
    expect(f.posts).toHaveLength(1); expect(JSON.stringify(f.posts)).not.toContain("PRIVATE DATA EVIDENCE SENTINEL");
    expect(JSON.stringify(f.posts)).not.toContain(own.property.id);
  });
  it("room changes invalidate expanded public facts and cannot use the old search witness", async () => {
    const own = await catalog(), f = await fixture("Подберите квартиру"), data = await read(f, own.call);
    const planned = await plan(f, data.observation, data.serverWitness), oldFacts = await readCustomerPropertyFacts(own.property.id, "INSTAGRAM");
    await prisma.property.update({ where: { id: own.property.id }, data: { rooms: 3 } });
    expect((await readCustomerPropertyFacts(own.property.id, "INSTAGRAM"))?.signature).not.toBe(oldFacts?.signature);
    expect(await dispatchCustomerOutboxPart(planned.id)).toEqual({ status: "suppressed" }); expect(f.posts).toHaveLength(0);
    expect(await prisma.customerDeliveryAttempt.count({ where: { partId: planned.id } })).toBe(0);
  });
  it("matching-policy changes revoke a search even when the listed facts themselves stay unchanged", async () => {
    const own = await catalog(), f = await fixture("Подберите квартиру"), data = await read(f, own.call);
    const planned = await plan(f, data.observation, data.serverWitness), before = await readSettings();
    try {
      await prisma.settings.update({ where: { id: "singleton" }, data: { matchRoomsTolerance: before.matchRoomsTolerance + 1 } });
      expect(await dispatchCustomerOutboxPart(planned.id)).toEqual({ status: "suppressed" }); expect(f.posts).toHaveLength(0);
    } finally { await prisma.settings.update({ where: { id: "singleton" }, data: { matchRoomsTolerance: before.matchRoomsTolerance } }); }
  });
  it("relevant FX change revokes the original budget/search policy rather than silently recalculating text", async () => {
    const own = await catalog(), f = await fixture("Подберите квартиру"), data = await read(f, own.call);
    const planned = await plan(f, data.observation, data.serverWitness), before = await readSettings();
    try {
      await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: Number(before.usdToTjsRate) + 1 } });
      expect(await dispatchCustomerOutboxPart(planned.id)).toEqual({ status: "suppressed" }); expect(f.posts).toHaveLength(0);
    } finally { await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: before.usdToTjsRate } }); }
  });
  it("a real read before own contact intent/commit survives only via the genuine same-claim continued principal", async () => {
    const f = await fixture("Мой номер +992 93 344 55 66"), data = await read(f, policyCall);
    const command = { name: "save_contact", args: { phone: "+992 93 344 55 66" } } as const;
    expect(await openAuthenticatedCustomerContactIntent(f.lane.authenticatedInput, f.lane.ticket, command)).toBe("opened");
    const authority = await issueCustomerWriteAuthority(f.lane.authenticatedInput, f.lane.ticket, "contact");
    if (!authority) throw new Error("Actual contact authority missing");
    const continued = await continueCustomerAgentAfterLocalAuthority(f.lane.principal, authority);
    expect(continued.status).toBe("current"); if (continued.status !== "current") throw new Error("Actual intent continuation failed");
    expect((await executeCustomerAction(authority, command)).status).toBe("created");
    const latest = await continueCustomerAgentAfterLocalAuthority(continued.principal, authority);
    expect(latest.status).toBe("current"); if (latest.status !== "current") throw new Error("Actual commit continuation failed");
    expect(await revalidateCustomerPrincipal(f.lane.principal)).toMatchObject({ status: "denied" });
    const planned = await plan(f, data.observation, data.serverWitness, latest.principal);
    expect(await dispatchCustomerOutboxPart(planned.id)).toEqual({ status: "accepted" }); expect(f.posts).toHaveLength(1);
    expect(await prisma.customerAction.count({ where: { inquiryId: latest.principal.authority.fence.inquiryId, kind: "contact", status: "COMMITTED" } })).toBe(1);
  });
  it("a witness from another real account/claim cannot seal identical public facts for the current controller", async () => {
    const first = await fixture(), data = await read(first, policyCall), second = await fixture();
    const render: CustomerAgentDeliveryRender = { decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
      evidence: [{ ref: "e0", value: data.observation }], language: "ru", requestedFacts: [], knownPhoneSource: "none", text: "" };
    render.text = renderCustomerAgentDecision({ ...render, surface: "dm", maxOutputChars: 3000, knowledgeSourceHash: manifest.knowledgeSourceHash })!;
    expect(await sealDmCustomerAgentDeliveryEvidence({ principal: second.lane.principal, claim: second.claim, render,
      serverWitnesses: [data.serverWitness] })).toEqual({ status: "held", reason: "server_read_witness_required" });
    expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: second.claim.eventKey } })).toBe(0);
    expect(second.posts).toHaveLength(0);
  });
});
