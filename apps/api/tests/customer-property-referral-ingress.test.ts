import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessengerTurnInput } from "../src/messengers/conversation.js";

// The actual signed Express ingress, dedupe, admission and registry are real.
// Only downstream conversation generation and external Meta I/O are replaced.
const { processTurn } = vi.hoisted(() => ({ processTurn: vi.fn() }));
vi.mock("../src/loadEnv.js", () => ({}));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()), processMessengerTurn: processTurn,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  fetchInstagramProfile: vi.fn(async () => ({ name: "Fictional test visitor" })),
  showReadAndTyping: vi.fn(async () => undefined),
}));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: async () => undefined,
}));
import { prisma } from "../src/db.js";
import { app } from "../src/app.js";
import * as admissionModule from "../src/lib/customerPropertyAdmission.js";
import { resolveCustomerPropertyTurnContext } from "../src/lib/customerPropertyTurnContext.js";
import { managedCustomerPropertyReply, persistManagedCustomerPropertyReply } from "../src/lib/customerPropertyDelivery.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { peekAdReferral, resetMetaPeerMemory } from "../src/messengers/metaPeerMemory.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { encryptSecret } from "../src/crypto.js";

const tag = `p03-ingress-${randomUUID()}`;
const secret = "fictional-p03-signed-webhook-secret";
const peers: string[] = []; const accounts: { id: string; externalId: string }[] = [];
const properties: string[] = []; const adIds: string[] = [];
let settingsBefore: { metaEnabled: boolean; metaAppSecret: string | null; metaVerifyToken: string | null; botInstagramEnabled: boolean };
const peer = () => { const value = `${tag}-${peers.length}`; peers.push(value); return value; };
const mid = (value: string) => `${tag}-${value}`;
const referral = (adId: string) => ({ referral: { source: "ADS", ad_id: adId } });
const message = (id: string, adId?: string) => ({ message: { mid: id, text: "Сколько стоит?" }, ...(adId ? referral(adId) : {}) });
function body(target: string, events: Record<string, unknown>[], account = accounts[0]) {
  return { object: "instagram", entry: [{ id: account.externalId,
    messaging: events.map((event) => ({ sender: { id: target }, recipient: { id: account.externalId }, ...event })) }] };
}
async function post(payload: unknown, valid = true, signingKey = secret) {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", valid ? signingKey : "wrong-fictional-secret").update(raw).digest("hex");
  return request(app).post("/api/v1/webhooks/meta").set("Content-Type", "application/json").set("x-hub-signature-256", `sha256=${signature}`).send(raw);
}
async function deliver(payload: unknown) { expect((await post(payload)).status).toBe(200); await drainBackgroundTasks(5000); }
const conversation = (target: string) => prisma.botConversation.findUniqueOrThrow({ where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: target } } });
function inputFor(id: string): MessengerTurnInput {
  const found = processTurn.mock.calls.map((call) => call[0] as MessengerTurnInput).find((input) => input.messageId === id);
  expect(found).toBeDefined(); return found!;
}
async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Expected ingress event was not observed");
}
beforeAll(async () => {
  settingsBefore = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {},
    select: { metaEnabled: true, metaAppSecret: true, metaVerifyToken: true, botInstagramEnabled: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaEnabled: true, metaAppSecret: encryptSecret(secret),
    metaVerifyToken: encryptSecret("fictional-verification-token"), botInstagramEnabled: false } });
  for (let index = 0; index < 2; index++) {
    accounts.push(await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `${tag}-account-${index}`, title: tag, token: encryptSecret("fictional-token-never-sent") }, select: { id: true, externalId: true } }));
    const property = await prisma.property.create({ data: { title: `${tag}-${index}`, type: "APARTMENT", areaSqm: 60, price: 320000 + index * 140000,
      currency: "TJS", address: "Private test address", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true } });
    properties.push(property.id); adIds.push(`${tag}-ad-${index}`);
    await prisma.ad.create({ data: { platform: "META", externalId: adIds[index], name: tag, propertyId: property.id } });
  }
  resetAccountsCache();
});
beforeEach(() => {
  resetMetaPeerMemory(); processTurn.mockReset(); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "1"); vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external request in signed ingress test"); }));
  processTurn.mockImplementation(async (input: MessengerTurnInput) => {
    const admission = input.customerPropertyAdmission;
    if (admission?.status === "admitted") await resolveCustomerPropertyTurnContext(admission, [admission.ticket]);
    return { reply: "", ready: false, accepted: false, shouldReply: false };
  });
});
afterEach(async () => { await drainBackgroundTasks(5000); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { channel: "INSTAGRAM", subscriberId: { in: peers } } });
  await prisma.processedMessage.deleteMany({ where: { channel: "INSTAGRAM", messageId: { startsWith: tag } } });
  await prisma.ad.deleteMany({ where: { externalId: { in: adIds } } });
  await prisma.property.deleteMany({ where: { id: { in: properties } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts.map((account) => account.id) } } });
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  resetAccountsCache(); resetMetaPeerMemory();
});

describe("signed referral-only ingress lifecycle", () => {
  it("rejects an invalid signature before touching referral memory", async () => {
    const target = peer(); expect((await post(body(target, [referral(adIds[0])]), false)).status).toBe(403);
    expect(peekAdReferral("INSTAGRAM", target, accounts[0].externalId)).toBeNull();
    expect(processTurn).not.toHaveBeenCalled();
  });
  it("a configured referral alone remembers a hint without a namespace, native or ticket", async () => {
    const target = peer();
    const namespaceCount = await prisma.customerEndpointScope.count({ where: { messengerAccountId: accounts[0].id } });
    const ticketCount = await prisma.customerPropertyIngressTicket.count();
    await deliver(body(target, [referral(adIds[0])]));
    expect(peekAdReferral("INSTAGRAM", target, accounts[0].externalId)?.ref.adId).toBe(adIds[0]);
    expect(await prisma.customerEndpointScope.count({ where: { messengerAccountId: accounts[0].id } })).toBe(namespaceCount);
    expect(await prisma.botConversation.count({ where: { subscriberId: target } })).toBe(0);
    expect(await prisma.customerPropertyIngressTicket.count()).toBe(ticketCount);
    expect(processTurn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("a signed referral to an uninstalled target is not remembered or admitted", async () => {
    const target = peer(); const unknown = { id: `${tag}-unknown`, externalId: `${tag}-uninstalled` };
    await deliver(body(target, [referral(adIds[0])], unknown));
    expect(peekAdReferral("INSTAGRAM", target, unknown.externalId)).toBeNull();
    expect(await prisma.botConversation.count({ where: { subscriberId: target } })).toBe(0);
    expect(processTurn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("another app's valid signature cannot poison a target with its own key", async () => {
    const target = peer(); const ownKey = `${tag}-target-own-key`;
    await prisma.messengerAccount.update({ where: { id: accounts[0].id }, data: { appSecret: encryptSecret(ownKey) } });
    resetAccountsCache();
    try {
      // Legacy ANY-key ACK is allowed, but A's global key is not B's evidence.
      expect((await post(body(target, [referral(adIds[1])]))).status).toBe(200);
      await drainBackgroundTasks(5000);
      expect(peekAdReferral("INSTAGRAM", target, accounts[0].externalId)).toBeNull();
      expect(await prisma.botConversation.count({ where: { subscriberId: target } })).toBe(0);
      expect(processTurn).not.toHaveBeenCalled();
      // The target's own key still binds its first real MID to the correct ad.
      const id = mid("target-key-positive");
      expect((await post(body(target, [referral(adIds[0]), message(id)]), true, ownKey)).status).toBe(200);
      await drainBackgroundTasks(5000);
      expect(inputFor(id).customerPropertyAdmission).toMatchObject({ status: "admitted", ticket: { evidence: [{ reference: adIds[0] }] } });
      expect((await conversation(target)).customerPropertyFocus).toMatchObject({ propertyId: properties[0] });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await prisma.messengerAccount.update({ where: { id: accounts[0].id }, data: { appSecret: null } });
      resetAccountsCache();
    }
  });
  it("binds an unnumbered referral to the next real MID once, including the same envelope", async () => {
    const target = peer(); const id = mid("same-envelope");
    await deliver(body(target, [referral(adIds[0]), message(id)]));
    expect(inputFor(id).customerPropertyAdmission).toMatchObject({ status: "admitted", ticket: { evidence: [{ kind: "ad", origin: "remembered_referral", reference: adIds[0] }] } });
    expect((await conversation(target)).customerPropertyFocus).toMatchObject({ status: "resolved", propertyId: properties[0] });
    expect(peekAdReferral("INSTAGRAM", target, accounts[0].externalId)).toBeNull();
    await deliver(body(target, [message(mid("next-plain"))]));
    expect(inputFor(mid("next-plain")).customerPropertyAdmission).toMatchObject({ status: "admitted", ticket: { evidence: [] } });
    expect((await conversation(target)).customerPropertyFocus).toMatchObject({ propertyId: properties[0] });
  });
  it.each([false, true])("a duplicate old MID cannot consume the next referral (managed fence=%s)", async (fenced) => {
    const target = peer(); const old = mid(`old-${fenced}`); await deliver(body(target, [message(old)]));
    const admission = inputFor(old).customerPropertyAdmission;
    if (admission?.status !== "admitted") throw new Error("Missing real admission");
    if (fenced) {
      const part = managedCustomerPropertyReply({ id: admission.ticket.conversationId, channel: "INSTAGRAM", subscriberId: target, accountId: accounts[0].id }, null, "Уточните объект.", admission);
      expect(await persistManagedCustomerPropertyReply(part, [admission])).toBe(true);
    }
    const before = (await conversation(target)).customerPropertyFocus;
    await deliver(body(target, [referral(adIds[0])]));
    await deliver(body(target, [message(old)]));
    expect(peekAdReferral("INSTAGRAM", target, accounts[0].externalId)?.ref.adId).toBe(adIds[0]);
    expect((await conversation(target)).customerPropertyFocus).toEqual(before);
    const fresh = mid(`new-${fenced}`); await deliver(body(target, [message(fresh)]));
    expect(inputFor(fresh).customerPropertyAdmission).toMatchObject({ status: "admitted", ticket: { evidence: [{ reference: adIds[0] }] } });
    expect((await conversation(target)).customerPropertyFocus).toMatchObject({ propertyId: properties[0] });
  });
  it("a fresh explicit ad supersedes a pending old referral instead of reverting on the next question", async () => {
    const target = peer();
    await deliver(body(target, [referral(adIds[0]), message(mid("explicit-C"), adIds[1]), message(mid("plain-after-C"))]));
    expect(inputFor(mid("plain-after-C")).customerPropertyAdmission).toMatchObject({ status: "admitted", ticket: { evidence: [] } });
    expect((await conversation(target)).customerPropertyFocus).toMatchObject({ propertyId: properties[1] });
    expect(peekAdReferral("INSTAGRAM", target, accounts[0].externalId)).toBeNull();
  });
  it("a newer referral arriving while admission is awaited survives conditional consumption", async () => {
    const target = peer(); await deliver(body(target, [referral(adIds[0])]));
    let unblock!: () => void; let observed!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; }); const entered = new Promise<void>((resolve) => { observed = resolve; });
    const original = admissionModule.admitCustomerPropertyInput;
    const waitingMid = mid("waiting");
    const spy = vi.spyOn(admissionModule, "admitCustomerPropertyInput").mockImplementation(async (input) => {
      const result = await original(input);
      if (input.eventId === waitingMid) { observed(); await gate; }
      return result;
    });
    try {
      expect((await post(body(target, [message(waitingMid)]))).status).toBe(200); await entered;
      expect((await post(body(target, [referral(adIds[1])]))).status).toBe(200);
      await waitUntil(() => peekAdReferral("INSTAGRAM", target, accounts[0].externalId)?.ref.adId === adIds[1]);
      unblock(); await drainBackgroundTasks(5000);
      expect(peekAdReferral("INSTAGRAM", target, accounts[0].externalId)?.ref.adId).toBe(adIds[1]);
    } finally { unblock(); await drainBackgroundTasks(5000); spy.mockRestore(); }
    await deliver(body(target, [message(mid("after-wait"))]));
    expect((await conversation(target)).customerPropertyFocus).toMatchObject({ propertyId: properties[1] });
  });
  it("referral memory is isolated between two accounts for the same peer", async () => {
    const target = peer(); await deliver(body(target, [referral(adIds[0])]));
    const id = mid("other-account"); await deliver(body(target, [message(id)], accounts[1]));
    expect(inputFor(id).customerPropertyAdmission).toMatchObject({ status: "admitted", ticket: { accountId: accounts[1].id, evidence: [] } });
    expect((await conversation(target)).customerPropertyFocus).toMatchObject({ status: "missing", propertyId: null });
    expect(peekAdReferral("INSTAGRAM", target, accounts[0].externalId)?.ref.adId).toBe(adIds[0]);
  });
});
