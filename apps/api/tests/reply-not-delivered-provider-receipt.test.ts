import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessengerTurnInput, MessengerTurnResult } from "../src/messengers/turnTypes.js";

// Signed ingress, installed Settings routing, admission and dedupe are real.
// Generation/provider I/O/notification sinks and the injected stamp failure are
// declared seams; no customer principal or private/action grant is mocked.
const { processTurn, sendMessage, showTyping, push, releaseCalled, stampFailure, logError } = vi.hoisted(() => ({
  processTurn: vi.fn<(input: MessengerTurnInput) => Promise<MessengerTurnResult>>(),
  sendMessage: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  showTyping: vi.fn(async (..._args: unknown[]) => undefined),
  push: vi.fn(async (..._args: unknown[]) => 1),
  releaseCalled: vi.fn(), stampFailure: { enabled: false }, logError: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()), processMessengerTurn: processTurn,
}));
vi.mock("../src/messengers/conversationStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/conversationStore.js")>();
  return { ...actual,
    stampOutgoingMid: (...args: Parameters<typeof actual.stampOutgoingMid>) => {
      if (stampFailure.enabled) throw new Error("synthetic stamp persistence failure after MID");
      return actual.stampOutgoingMid(...args);
    } };
});
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage, showReadAndTyping: showTyping,
}));
vi.mock("../src/lib/webhookDedupe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/webhookDedupe.js")>();
  return { ...actual, releaseProcessedMessage: (...args: Parameters<typeof actual.releaseProcessedMessage>) => {
    releaseCalled(...args); return actual.releaseProcessedMessage(...args);
  } };
});
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: push,
}));
vi.mock("../src/lib/recipients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/recipients.js")>()), findAgentsWithPermission: vi.fn(async () => []),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: logError,
}));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: async () => undefined,
}));

import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { app } from "../src/app.js";
import { notifyBotReplyNotDelivered } from "../src/routes/webhooks.js";
import { ensureCustomerEndpoint, ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { managedCustomerPropertyReply, persistManagedCustomerPropertyReply } from "../src/lib/customerPropertyDelivery.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { waitFor } from "./helpers/waitFor.js";

const tag = `receipt-alert-${randomUUID()}`;
const resourceA = `${tag}-wa-A`, resourceB = `${tag}-wa-B`;
const secret = `${tag}-signing-key`;
const ciphertextToken = encryptSecret(`${tag}-synthetic-provider-token`);
const scopeIds = new Set<string>();
let restoreSettings: () => Promise<unknown> = async () => undefined;
let restorePolicy: () => Promise<unknown> = async () => undefined;
const configA = { metaEnabled: true, botEnabled: true, botWhatsappEnabled: true,
  metaWaPhoneId: resourceA, metaWaToken: ciphertextToken,
  metaAppSecret: encryptSecret(secret), metaVerifyToken: encryptSecret(`${tag}-verification`),
  workHoursStart: "00:00", workHoursEnd: "24:00" };
const reply = "Уточните, какой район вас интересует?";

beforeAll(async () => {
  const beforePolicy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: { contractVersion: true, rolloutMode: true } });
  restorePolicy = () => prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: beforePolicy });
  const before = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
    metaEnabled: true, botEnabled: true, botWhatsappEnabled: true, metaWaPhoneId: true,
    metaWaToken: true, metaAppSecret: true, metaVerifyToken: true, workHoursStart: true, workHoursEnd: true,
  } });
  restoreSettings = () => prisma.settings.update({ where: { id: "singleton" }, data: before });
  await prisma.settings.update({ where: { id: "singleton" }, data: configA });
  expect(await prisma.messengerAccount.count({ where: { channel: "WHATSAPP", externalId: { in: [resourceA, resourceB] } } })).toBe(0);
  resetAccountsCache();
});
beforeEach(async () => {
  // This file verifies legacy immediate-OUT receipt handling. Its processor is
  // a declared fixture seam, not the P11 FINAL/managed planner/ledger consumer.
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "compat", rolloutMode: "OFF" } });
  await prisma.settings.update({ where: { id: "singleton" }, data: configA });
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0"); vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external request in receipt alert test"); }));
  processTurn.mockReset(); sendMessage.mockReset(); showTyping.mockReset();
  push.mockClear(); releaseCalled.mockClear(); logError.mockClear(); stampFailure.enabled = false;
  showTyping.mockResolvedValue(undefined);
  processTurn.mockResolvedValue({ reply, ready: false, accepted: false, shouldReply: true });
  sendMessage.mockResolvedValue(`${tag}-accepted-mid`);
});
afterEach(async () => {
  await drainBackgroundTasks(5000);
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
afterAll(async () => {
  try {
  const rows = await prisma.customerEndpointScope.findMany({ where: { channel: "WHATSAPP",
    transportKey: { in: [`settings:WHATSAPP:${resourceA}`, `settings:WHATSAPP:${resourceB}`] } }, select: { id: true } });
  rows.forEach(row => scopeIds.add(row.id));
  const ids = [...scopeIds];
  const native = await prisma.botConversation.findMany({ where: { endpointScopeId: { in: ids } }, select: { id: true } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { originalConversationId: { in: native.map(row => row.id) } } });
  await prisma.botConversation.deleteMany({ where: { endpointScopeId: { in: ids } } });
  await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: { in: ids }, actions: { none: {} } } });
  await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: { in: ids } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: ids } } });
  await prisma.processedMessage.deleteMany({ where: { channel: "WHATSAPP", messageId: { startsWith: tag } } });
  } finally {
    try { await restoreSettings(); }
    finally { try { await restorePolicy(); } finally { resetAccountsCache(); } }
  }
});

async function captureRoute(peer: string, resource = resourceA) {
  const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx,
    { channel: "WHATSAPP", subscriberId: peer, accountExternalId: resource }));
  scopeIds.add(endpoint.endpointScopeId);
  return endpoint;
}
function body(peer: string, id: string) {
  return { object: "whatsapp_business_account", entry: [{ changes: [{ value: {
    metadata: { phone_number_id: resourceA }, contacts: [{ wa_id: peer, profile: { name: "Synthetic visitor" } }],
    messages: [{ from: peer, id, type: "text", text: { body: "Хочу купить двухкомнатную квартиру" } }],
  } }] }] };
}
async function deliver(payload: unknown) {
  const raw = JSON.stringify(payload), signature = createHmac("sha256", secret).update(raw).digest("hex");
  expect((await request(app).post("/api/v1/webhooks/meta").set("Content-Type", "application/json")
    .set("x-hub-signature-256", `sha256=${signature}`).send(raw)).status).toBe(200);
  await drainBackgroundTasks(5000);
}
async function completed(id: string) {
  await waitFor(() => prisma.processedMessage.findFirst({ where: { channel: "WHATSAPP", messageId: id, completedAt: { not: null } } }));
}
async function ordinaryReply(input: MessengerTurnInput, reply2?: string): Promise<MessengerTurnResult> {
  const admission = input.customerPropertyAdmission;
  if (admission?.status !== "admitted") throw new Error("Missing actual ordinary-reply admission");
  // The real qualifier persists both bubbles in one assistant history element;
  // the provider stamps mid/mid2 onto that element after sending each bubble.
  await prisma.botConversation.update({ where: { id: admission.ticket.conversationId }, data: { messages: [
    { role: "user", content: input.text },
    { role: "assistant", content: [reply, reply2].filter(Boolean).join("\n"), by: { kind: "bot" } },
  ] } });
  return { reply, reply2, ready: false, accepted: false, shouldReply: true };
}
async function ordinaryHistory() {
  const admission = processTurn.mock.calls[0]?.[0].customerPropertyAdmission;
  if (admission?.status !== "admitted") throw new Error("Missing ordinary history witness");
  return (await prisma.botConversation.findUniqueOrThrow({ where: { id: admission.ticket.conversationId }, select: { messages: true } })).messages;
}
function assertAlert() {
  expect(push).toHaveBeenCalledTimes(1);
  expect(push.mock.calls[0]?.[1]).toMatchObject({ title: "🤖 Доставка ответа требует проверки" });
  expect(JSON.stringify(push.mock.calls[0]?.[1])).not.toContain("клиент нашего ответа не получил");
}

describe("Settings-only namespace and observed provider receipt", () => {
  it("NULL-account captured WA route resolves the exact inbox URL", async () => {
    const peer = `${tag}-helper`;
    const transport = await captureRoute(peer);
    const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "WHATSAPP", subscriberId: peer, transport }));
    expect(transport.accountId).toBeNull();
    await notifyBotReplyNotDelivered("WHATSAPP", peer, transport);
    assertAlert();
    expect(push.mock.calls[0]?.[1]).toMatchObject({ url: `/messages?open=${native.id}` });
  });
  it("resource rotation rejects A's old hint; same peer on B never adopts A's inbox", async () => {
    const peer = `${tag}-rotation`;
    const old = await captureRoute(peer);
    const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "WHATSAPP", subscriberId: peer, transport: old }));
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaWaPhoneId: resourceB } });
    await notifyBotReplyNotDelivered("WHATSAPP", peer, old);
    expect(push).not.toHaveBeenCalled();
    const current = await captureRoute(peer, resourceB);
    await notifyBotReplyNotDelivered("WHATSAPP", peer, current);
    assertAlert();
    expect(push.mock.calls[0]?.[1]).toMatchObject({ url: "/messages" });
    expect(JSON.stringify(push.mock.calls)).not.toContain(native.id);
    expect(await prisma.botConversation.count({ where: { subscriberId: peer } })).toBe(1);
  });
  it("accepted MID before a failed history stamp preserves dedupe and sends no lost-reply push", async () => {
    const id = `${tag}-stamp`, payload = body(`${tag}-stamp-peer`, id);
    processTurn.mockImplementation(input => ordinaryReply(input));
    stampFailure.enabled = true;
    await deliver(payload); await completed(id);
    expect(sendMessage).toHaveBeenCalledTimes(1); expect(processTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[4]).toMatchObject({ transport: {
      accountId: null, accountExternalId: resourceA,
      endpointScopeId: processTurn.mock.calls[0]?.[0].customerTransport?.endpointScopeId,
    } });
    expect(releaseCalled).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
    const history = await ordinaryHistory();
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: reply })]));
    expect(history).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", deliveryStatus: "failed" })]));
    expect(history).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", mid: expect.anything() })]));
    await deliver(payload);
    expect(sendMessage).toHaveBeenCalledTimes(1); expect(processTurn).toHaveBeenCalledTimes(1);
  });
  it("accepted first bubble followed by second-bubble failure does not falsely notify or replay", async () => {
    const id = `${tag}-second`, payload = body(`${tag}-second-peer`, id);
    processTurn.mockImplementation(input => ordinaryReply(input, "Можем обсудить варианты."));
    sendMessage.mockResolvedValueOnce(`${tag}-first-mid`).mockRejectedValueOnce(new Error("synthetic second POST failure"));
    await deliver(payload); await completed(id);
    expect(sendMessage).toHaveBeenCalledTimes(2); expect(releaseCalled).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
    const history = await ordinaryHistory();
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: `${reply}\nМожем обсудить варианты.`, mid: `${tag}-first-mid` })]));
    expect(history).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", deliveryStatus: "failed" })]));
    expect(history).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", mid2: expect.anything() })]));
    await deliver(payload);
    expect(processTurn).toHaveBeenCalledTimes(1); expect(sendMessage).toHaveBeenCalledTimes(2);
  });
  it("initial POST failure notifies once, releases the failed turn, and allows an accepted retry", async () => {
    const id = `${tag}-initial`, payload = body(`${tag}-initial-peer`, id);
    processTurn.mockImplementation(input => ordinaryReply(input));
    sendMessage.mockRejectedValueOnce(new Error("synthetic initial POST failure"));
    await deliver(payload);
    await waitFor(() => push.mock.calls.length === 1);
    await waitFor(async () => (await prisma.processedMessage.count({ where: { channel: "WHATSAPP", messageId: id } })) === 0);
    expect(releaseCalled).toHaveBeenCalledTimes(1); expect(releaseCalled).toHaveBeenCalledWith("WHATSAPP", id); assertAlert();
    expect(await ordinaryHistory()).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: reply, deliveryStatus: "failed" })]));
    await deliver(payload); await completed(id);
    expect(processTurn).toHaveBeenCalledTimes(2); expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledTimes(1); expect(releaseCalled).toHaveBeenCalledTimes(1);
  });
  it("persisted managed pending alone is not a provider receipt when typing fails", async () => {
    const id = `${tag}-pending`, payload = body(`${tag}-pending-peer`, id);
    processTurn.mockImplementation(async input => {
      const admission = input.customerPropertyAdmission;
      if (admission?.status !== "admitted" || !input.customerTransport) throw new Error("Missing actual admission fixture");
      const part = managedCustomerPropertyReply({ id: admission.ticket.conversationId, channel: "WHATSAPP", subscriberId: input.subscriberId,
        accountId: null, endpointScopeId: input.customerTransport.endpointScopeId, accountExternalId: resourceA }, null, reply, admission);
      expect(await persistManagedCustomerPropertyReply(part, [admission])).toBe(true);
      return { reply, ready: false, accepted: false, shouldReply: true, customerPropertyReply: part };
    });
    // The earlier cosmetic read-only indicator runs in parallel. Fail only the
    // awaited final typing call, after the managed pending part was persisted.
    showTyping.mockImplementation(async (...args) => {
      if (args[3] === true) throw new Error("synthetic typing failure before POST");
      return undefined;
    });
    await deliver(payload); await completed(id); await waitFor(() => push.mock.calls.length === 1);
    expect(processTurn).toHaveBeenCalledTimes(1);
    const admission = processTurn.mock.calls[0]?.[0].customerPropertyAdmission;
    expect(admission?.status).toBe("admitted");
    if (admission?.status !== "admitted") throw new Error("Missing persisted admission witness");
    const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: admission.ticket.eventKey } });
    expect(ticket.managedOutputRecordedAt).not.toBeNull();
    const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: admission.ticket.conversationId }, select: { messages: true } });
    expect(native.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: reply,
      customerPropertyDelivery: expect.objectContaining({ inputEventKey: admission.ticket.eventKey, status: "pending" }) })]));
    expect(sendMessage).not.toHaveBeenCalled(); expect(releaseCalled).not.toHaveBeenCalled(); assertAlert();
    await deliver(payload);
    expect(processTurn).toHaveBeenCalledTimes(1); expect(push).toHaveBeenCalledTimes(1);
  });
});
