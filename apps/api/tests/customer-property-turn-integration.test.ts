import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmissionResult, CustomerPropertyEvidence } from "@royal-home/shared";
import { submitReplySchema } from "@royal-home/shared";

// Real conversation orchestration and PostgreSQL. Only the paid model/network
// boundary is replaced; admission, focus, history and output fences are real.
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: callAi,
}));
vi.mock("../src/loadEnv.js", () => ({}));
import { prisma } from "../src/db.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";

const prefix = `p03-turn-${randomUUID()}`;
const peers: string[] = [];
const propertyIds: string[] = [];
const accountIds: string[] = [];
let externalId: string;
let a: { id: string; shortId: number };
let b: { id: string; shortId: number };
const settingsSelect = { botEnabled: true, botInstagramEnabled: true, botReplyDelaySec: true, botReplyMaxWaitSec: true } as const;
let settingsBefore: { botEnabled: boolean; botInstagramEnabled: boolean; botReplyDelaySec: number; botReplyMaxWaitSec: number };
const peer = () => { const value = `${prefix}-${peers.length}`; peers.push(value); return value; };
const reference = (property: { shortId: number }): CustomerPropertyEvidence[] => [
  { kind: "public_selector", origin: "message", reference: `short:${property.shortId}` },
];
async function admit(subscriberId: string, mid: string, evidence: CustomerPropertyEvidence[] = []): Promise<CustomerPropertyAdmissionResult> {
  const result = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: subscriberId, accountExternalId: externalId,
    eventKind: "message", eventId: mid, evidence });
  expect(result.status).toBe("admitted");
  return result;
}
function turn(subscriberId: string, mid: string, admission: CustomerPropertyAdmissionResult, text = "Сколько стоит?", batch?: CustomerPropertyAdmissionResult[]) {
  return processMessengerTurn({ channel: "INSTAGRAM", subscriberId, accountExternalId: externalId, messageId: mid,
    customerPropertyEventKind: "message", customerPropertyAdmission: admission, customerPropertyBatch: batch, text });
}
const row = (subscriberId: string) => prisma.botConversation.findUniqueOrThrow({ where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } } });

beforeAll(async () => {
  settingsBefore = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {}, select: settingsSelect });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botInstagramEnabled: true, botReplyDelaySec: 0, botReplyMaxWaitSec: 0 } });
  externalId = `${prefix}-account`;
  const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId, title: prefix, token: "fictional-never-used" } });
  accountIds.push(account.id); resetAccountsCache();
  for (const price of [320000, 460000]) {
    const property = await prisma.property.create({ data: { title: `${prefix}-${price}`, type: "APARTMENT", areaSqm: 60,
      windowCount: 3, price, currency: "TJS", address: "PRIVATE MUST NOT BE SENT", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true } });
    propertyIds.push(property.id);
    if (!a) a = property; else b = property;
  }
});
beforeEach(() => {
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "1"); vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  callAi.mockReset();
  const modelReply = { reply: ["Подскажите удобное время для звонка."], ready: false, confident: true,
    topic: "price", openQuestion: "", clientAnsweredOpenQuestion: false };
  expect(submitReplySchema({ showings: true, askOwner: true, vacancies: true, promptEconomy: true,
    canSendPhotos: true, canSendGuide: true, topicLock: true }).safeParse(modelReply).success).toBe(true);
  callAi.mockResolvedValue(modelReply);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external network in P03 turn integration"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { channel: "INSTAGRAM", subscriberId: { in: peers } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  resetAccountsCache();
});

describe("P03 actual conversation turn", () => {
  it("unknown endpoint is held without creating a native or calling model/network", async () => {
    const target = peer();
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: target,
      accountExternalId: `${prefix}-not-installed`, text: "Сколько стоит?" });
    expect(result).toMatchObject({ reply: "", ready: false, accepted: false, shouldReply: false, silenced: "held" });
    expect(await prisma.botConversation.count({ where: { subscriberId: target } })).toBe(0);
    expect(callAi).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("answers card price before the model without losing known phone or changing stage", async () => {
    const target = peer(); const admission = await admit(target, "known-phone", reference(a));
    const before = await row(target);
    await prisma.botConversation.update({ where: { id: before.id }, data: { leadDraft: { stage: "chatting", phone: "+992900000001", intent: "buy" } } });
    const result = await turn(target, "known-phone", admission);
    expect(result.reply).toContain("320 000 сомони");
    expect(result.reply).not.toContain("PRIVATE");
    expect(result.customerPropertyReply?.delivery).toMatchObject({ status: "pending", propertyId: a.id });
    expect((await row(target)).leadDraft).toMatchObject({ stage: "chatting", phone: "+992900000001" });
    expect((await row(target)).clientId).toBeNull();
    expect(callAi).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("a later explicit object replaces A and a following plain price question retains B", async () => {
    const target = peer();
    expect((await turn(target, "A", await admit(target, "A", reference(a)))).reply).toContain("320 000");
    expect((await turn(target, "B", await admit(target, "B", reference(b)))).reply).toContain("460 000");
    const result = await turn(target, "Q", await admit(target, "Q"));
    expect(result.reply).toContain("460 000"); expect(result.reply).not.toContain("320 000");
    expect(callAi).not.toHaveBeenCalled();
  });
  it("large canonical price survives the real known-phone path in Tajik", async () => {
    const target = peer(); const admission = await admit(target, "large-price", reference(a));
    const before = await row(target);
    await prisma.botConversation.update({ where: { id: before.id }, data: { leadDraft: { stage: "chatting", phone: "+992900000001", intent: "buy" } } });
    await prisma.property.update({ where: { id: a.id }, data: { price: 100_000_000 } });
    try {
      const answer = await turn(target, "large-price", admission, "Нархш чансумай?");
      expect(answer.reply).toContain("100 000 000 сомонӣ");
      expect(answer.reply).not.toMatch(/рақам(?:атон|ро)|оставьте|номер телефона/i);
      expect((await row(target)).leadDraft).toMatchObject({ stage: "chatting", phone: "+992900000001" });
      expect(callAi).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { await prisma.property.update({ where: { id: a.id }, data: { price: 320_000 } }); }
  });
  it("two explicit objects in one captured batch ask for clarification and fence both inputs", async () => {
    const target = peer(); const first = await admit(target, "A", reference(a)); const second = await admit(target, "B", reference(b));
    const result = await turn(target, "B", second, "Сколько стоит?", [first, second]);
    expect(result.reply).toContain("Какой объект");
    expect(result.reply).not.toMatch(/320 000|460 000/);
    expect((await row(target)).customerPropertyFocus).toMatchObject({ status: "ambiguous", propertyId: null });
    const tickets = await prisma.customerPropertyIngressTicket.findMany({ where: { conversationId: (await row(target)).id } });
    expect(tickets).toHaveLength(2); expect(tickets.every((ticket) => ticket.managedOutputRecordedAt !== null)).toBe(true);
    expect(callAi).not.toHaveBeenCalled();
  });
  it("two real concurrent turns share the debounce batch without choosing the last object's price", async () => {
    const target = peer(); const first = await admit(target, "A", reference(a));
    await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3 } });
    const running = [turn(target, "A", first)];
    try {
      let captured = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const pending = (await row(target)).pendingMessages;
        if (Array.isArray(pending) && pending.length > 0) { captured = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(captured).toBe(true);
      running.push(turn(target, "B", await admit(target, "B", reference(b))));
      const responses = (await Promise.all(running)).filter((result) => result.shouldReply !== false && result.reply);
      expect(responses).toHaveLength(1);
      expect(responses[0].reply).toContain("Какой объект");
      expect(responses[0].reply).not.toMatch(/320 000|460 000/);
      expect((await row(target)).customerPropertyFocus).toMatchObject({ status: "ambiguous", propertyId: null });
      expect(callAi).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled(running);
      await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 0 } });
    }
  });
  it("missing event identity cannot silently reuse the old object's price", async () => {
    const target = peer(); await turn(target, "A", await admit(target, "A", reference(a)));
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: target, accountExternalId: externalId,
      text: "Сколько стоит?", customerPropertyAdmission: { status: "denied", reason: "missing_identity" } });
    expect(result.reply).not.toContain("320 000");
    expect(result.reply).toContain("определить объект"); expect(callAi).not.toHaveBeenCalled();
  });
  it("retry restores the captured conflicting batch instead of adopting only its final object", async () => {
    const target = peer(); const first = await admit(target, "A", reference(a)); const second = await admit(target, "B", reference(b));
    if (second.status !== "admitted") throw new Error("fixture admission failed");
    await prisma.botConversation.update({ where: { id: second.ticket.conversationId }, data: { messages: [{ role: "user", content: "Сколько стоит?",
      at: new Date().toISOString(), customerPropertyAdmission: second.ticket, customerPropertyBatch: [first, second] }] } });
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: target, accountExternalId: externalId, text: "Сколько стоит?", skipSaveIncoming: true });
    expect(result.reply).toContain("Какой объект"); expect(result.reply).not.toMatch(/320 000|460 000/);
    expect(callAi).not.toHaveBeenCalled();
  });
  it("flag OFF still blocks a previously managed MID after history is trimmed", async () => {
    const target = peer(); await turn(target, "A", await admit(target, "A", reference(a)));
    const before = await row(target);
    await prisma.botConversation.update({ where: { id: before.id }, data: { messages: [] } });
    vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
    const countBefore = await prisma.customerPropertyIngressTicket.count({ where: { conversationId: before.id } });
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: target, accountExternalId: externalId,
      messageId: "A", customerPropertyEventKind: "message", text: "Сколько стоит?" });
    expect(result.shouldReply).toBe(false); expect(result.reply).toBe("");
    expect((await row(target)).messages).toEqual([]);
    expect(await prisma.customerPropertyIngressTicket.count({ where: { conversationId: before.id } })).toBe(countBefore);
    expect(callAi).not.toHaveBeenCalled();
  });
  it("stale retry from account A cannot rebind a conversation moved to B", async () => {
    const target = peer(); const admission = await admit(target, "A", reference(a));
    if (admission.status !== "admitted") throw new Error("fixture admission failed");
    const other = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `${prefix}-other`, title: prefix, token: "fictional-never-used" } });
    accountIds.push(other.id); resetAccountsCache();
    await prisma.botConversation.update({ where: { id: admission.ticket.conversationId }, data: { accountId: other.id,
      messages: [{ role: "user", content: "Сколько стоит?", customerPropertyAdmission: admission.ticket, at: new Date().toISOString() }] } });
    const before = await row(target);
    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: target, accountExternalId: externalId, text: "Сколько стоит?", skipSaveIncoming: true });
    expect(result.shouldReply).toBe(false); expect(result.reply).toBe("");
    expect((await row(target)).accountId).toBe(other.id);
    expect(await row(target)).toEqual(before);
    expect(callAi).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("price plus a callback request stays in the existing model path", async () => {
    const target = peer(); const admission = await admit(target, "mixed", reference(a));
    const result = await turn(target, "mixed", admission, "Сколько стоит? Позвоните мне завтра.");
    expect(result.customerPropertyReply).toBeUndefined();
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.reply).toContain("время");
    expect(callAi).toHaveBeenCalledTimes(1);
    expect(await prisma.customerPropertyIngressTicket.count({ where: { conversationId: (await row(target)).id, managedOutputRecordedAt: { not: null } } })).toBe(0);
  });
});
