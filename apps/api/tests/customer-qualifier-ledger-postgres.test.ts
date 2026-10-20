import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { recoverAndFinalizeCustomerInboxInput } from "../src/lib/customerIngressRecovery.js";
import { loadCustomerStateSnapshot, transitionCustomerState } from "../src/lib/customerState.js";
import { loadCustomerDmCoreQualifierLane, loadCustomerQualifierLane } from "../src/lib/customerQualifierContext.js";
import { appendScopedCustomerReply, recordScopedCustomerInput } from "../src/lib/customerQualifierLedger.js";
import * as append from "../src/messengers/appendMessages.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { runQualifyTurn } from "../src/ai/leadQualifier.js";
import { scheduleSellerFactsRefreshForConversation } from "../src/lib/sellerFacts.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

vi.mock("../src/ai/leadQualifier.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/leadQualifier.js")>()), runQualifyTurn: vi.fn() }));
vi.mock("../src/lib/sellerFacts.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/sellerFacts.js")>()), scheduleSellerFactsRefreshForConversation: vi.fn() }));
// Genuine signed Meta RAW → PENDING → recovery FINAL. The first recorded IN is
// explicit in each test; this fixture never records a message before returning.
const accountIds: string[] = [], nativeIds: string[] = [], eventKeys: string[] = [];
const peerTokens = new Map<string, string>();
const profileReads: string[] = [];
let oldSettings: Awaited<ReturnType<typeof readSettings>>, oldPolicy: Awaited<ReturnType<typeof readPolicy>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } }); }
async function prepareFixture(text = "Сколько стоит квартира?") {
  const id = randomUUID(), externalId = `synthetic-ledger-${randomUUID()}`, peer = `synthetic-peer-${randomUUID()}`;
  const secret = `synthetic-secret-${randomUUID()}`, token = `synthetic-token-${randomUUID()}`;
  peerTokens.set(peer, token);
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId, username: `synthetic_ledger_agency_${id.replaceAll("-", "")}`, title: "Synthetic qualifier ledger", token: encryptSecret(token),
    appSecret: encryptSecret(secret), enabled: true } }); accountIds.push(id);
  const eventId = randomUUID(), rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: eventId, text },
  }] }] }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  // Install this real scope in rollout policy during setup. For paired subjects,
  // both scopes are assigned before either ingress captures a policy revision.
  const endpoint = await rollout.allowDm({ peer, accountId: id, accountExternalId: externalId });
  async function admit() {
    const pending = await persistVerifiedCustomerIngressBatch(request);
    if (pending.status !== "persisted" || pending.tickets.length !== 1) throw new Error(`Actual CORE PENDING intake unavailable: ${JSON.stringify(pending)}`);
    const eventKey = pending.tickets[0].eventKey; eventKeys.push(eventKey);
    // The rollout assignment is already pinned. Seed legacy private sentinels
    // afterward so they cannot turn this subject into a baseline LEGACY lane.
    const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId: id, accountExternalId: externalId }));
    nativeIds.push(native.id);
    await prisma.botConversation.update({ where: { id: native.id }, data: { name: "PRIVATE-OLD-NAME",
      leadDraft: { stage: "awaiting_phone", notes: "PRIVATE-OLD-NOTES" }, messages: [{ role: "user", content: "PRIVATE-OLD-PHONE +992900000019" }] } });
    const finalized = await recoverAndFinalizeCustomerInboxInput(eventKey);
    if (finalized.status !== "finalized") throw new Error(`Actual recovery FINAL unavailable: ${JSON.stringify(finalized)}`);
    const frame = finalized.input, ticket = finalized.ticket;
    const input = { channel: "INSTAGRAM" as const, subscriberId: peer, accountExternalId: externalId, text,
      messageId: eventId, customerPropertyAdmission: { status: "admitted" as const, ticket }, customerAuthenticatedInput: frame };
    return { nativeId: native.id, peer, input, frame, ticket, eventKey };
  }
  return { endpoint, admit };
}
async function fixture(text = "Сколько стоит квартира?") {
  return (await prepareFixture(text)).admit();
}
beforeAll(async () => {
  oldSettings = await readSettings(); oldPolicy = await readPolicy();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  rollout = await createCustomerRolloutFixture();
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: false, callbackWrite: false, newLeadBridge: false } } });
  vi.stubEnv("IG_PROXY_URL", "https://synthetic-ledger-instagram.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubGlobal("fetch", vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    if (url.origin !== "https://synthetic-ledger-instagram.invalid" || !url.pathname.startsWith("/v23.0/synthetic-peer-") ||
        url.searchParams.get("fields") !== "username" || init?.method !== "GET") throw new Error("Unexpected synthetic recovery profile request");
    const peer = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (url.searchParams.get("access_token") !== peerTokens.get(peer)) throw new Error("Unowned synthetic recovery credential");
    profileReads.push(peer);
    return new Response(JSON.stringify({ id: peer, username: "synthetic_ledger_customer" }));
  }));
});
beforeEach(() => {
  vi.mocked(runQualifyTurn).mockReset().mockResolvedValue({ reply: ["Цена 400 000 USD. Какой район нужен?"], ready: false, lead: {} });
  vi.mocked(scheduleSellerFactsRefreshForConversation).mockClear();
});
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: eventKeys.map(key => `customer-inbox-consume:${key}`) } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: eventKeys } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accountIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (oldSettings) await prisma.settings.update({ where: { id: "singleton" }, data: oldSettings });
  if (oldPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: oldPolicy.contractVersion, rolloutMode: oldPolicy.rolloutMode, capabilities: oldPolicy.capabilities!,
  } });
  if (rollout) await rollout.restore();
  expect(profileReads).toHaveLength(eventKeys.length); expect(new Set(profileReads).size).toBe(profileReads.length);
});

describe("scoped qualifier native/ticket ledger boundary", () => {
  it("ordinary Meta lane stays held; genuine CORE projection quarantines old native names/phones/draft", async () => {
    const f = await fixture();
    expect((await loadCustomerQualifierLane(f.input)).mode).toBe("held");
    expect(await recordScopedCustomerInput(f.input, f.frame, f.ticket)).toBe(true);
    const lane = await loadCustomerDmCoreQualifierLane({ authenticatedInput: f.frame, ticket: f.ticket });
    expect(lane.mode).toBe("scoped"); if (lane.mode !== "scoped") throw new Error("Expected actual signed CORE principal");
    expect(lane.context.history).toEqual([{ role: "user", content: f.input.text }]); expect(lane.context.draft).toEqual({ stage: "chatting" });
    expect(lane.context.knownPhoneSource).toBe("none"); expect(JSON.stringify(lane.context)).not.toContain("PRIVATE");
  });
  it("consumes the input ticket atomically and suppresses duplicates after the 40-message trim", async () => {
    const f = await fixture(); expect(await recordScopedCustomerInput(f.input, f.frame, f.ticket)).toBe(true);
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.ticket.eventKey }, select: { inputRecordedAt: true } }))
      .toEqual({ inputRecordedAt: expect.any(Date) });
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId }, select: { lastMessageAt: true } })).lastMessageAt).toBeInstanceOf(Date);
    await append.appendConversationMessages(f.nativeId, Array.from({ length: 40 }, (_, n) => ({ role: "assistant" as const, content: `synthetic-tail-${n}` })));
    expect(await recordScopedCustomerInput(f.input, f.frame, f.ticket)).toBe(true);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId }, select: { messages: true } });
    expect(JSON.stringify(row.messages)).not.toContain(f.input.messageId); expect(row.messages).toHaveLength(40);
    expect(scheduleSellerFactsRefreshForConversation).not.toHaveBeenCalled();
  });
  it("five concurrent duplicate deliveries append one genuine IN", async () => {
    const f = await fixture(); expect(await Promise.all(Array.from({ length: 5 }, () => recordScopedCustomerInput(f.input, f.frame, f.ticket))))
      .toEqual(Array(5).fill(true));
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId }, select: { messages: true } });
    expect((row.messages as Array<{ mid?: string }>).filter(message => message.mid === f.input.messageId)).toHaveLength(1);
  });
  it("a failed append rolls back the consumption marker, and an actual retry can record the input", async () => {
    const f = await fixture(); const fault = vi.spyOn(append, "appendConversationMessagesInTransaction").mockRejectedValueOnce(new Error("synthetic append failure"));
    expect(await recordScopedCustomerInput(f.input, f.frame, f.ticket)).toBe(false); fault.mockRestore();
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.ticket.eventKey } })).inputRecordedAt).toBeNull();
    expect(await recordScopedCustomerInput(f.input, f.frame, f.ticket)).toBe(true);
  });
  it("records genuine IN for a human-owned ledger while the scoped model lane remains held", async () => {
    const f = await fixture(), state = await loadCustomerStateSnapshot({ conversationId: f.nativeId });
    if (!state) throw new Error("Synthetic state missing");
    expect((await prisma.$transaction(tx => transitionCustomerState(tx, state.fence, { type: "owner", mode: "HUMAN", agentId: randomUUID(),
      token: randomUUID(), leaseUntil: null }))).status).toBe("applied");
    expect((await loadCustomerQualifierLane(f.input)).mode).toBe("held");
    expect(await recordScopedCustomerInput(f.input, f.frame, f.ticket)).toBe(true);
    expect((await loadCustomerStateSnapshot({ conversationId: f.nativeId }))?.ownerMode).toBe("HUMAN");
  });
  it("does not adopt a native binding ABA even when the peer string returns", async () => {
    const f = await fixture(); await prisma.botConversation.update({ where: { id: f.nativeId }, data: { subscriberId: `synthetic-other-${randomUUID()}` } });
    await prisma.botConversation.update({ where: { id: f.nativeId }, data: { subscriberId: f.peer } });
    expect(await recordScopedCustomerInput(f.input, f.frame, f.ticket)).toBe(false);
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.ticket.eventKey } })).inputRecordedAt).toBeNull();
  });
  it("Meta legacy dispatch holds CORE-owned input without qualifier or seller effects", async () => {
    const f = await fixture(), before = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId } });
    const result = await processMessengerTurn(f.input);
    expect(result.silenced).toBe("held"); expect(result.shouldReply).toBe(false); expect(result.reply).toBe("");
    expect(runQualifyTurn).not.toHaveBeenCalled();
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId } });
    expect(row.messages).toEqual(before.messages);
    expect(row.name).toBe("PRIVATE-OLD-NAME"); expect(row.leadDraft).toEqual({ stage: "awaiting_phone", notes: "PRIVATE-OLD-NOTES" });
    expect(scheduleSellerFactsRefreshForConversation).not.toHaveBeenCalled();
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } })).inputRecordedAt).toBeNull();
  });
  it("owner change during an awaited CORE principal prevents local assistant OUT", async () => {
    const f = await fixture(); expect(await recordScopedCustomerInput(f.input, f.frame, f.ticket)).toBe(true);
    const lane = await loadCustomerDmCoreQualifierLane({ authenticatedInput: f.frame, ticket: f.ticket });
    if (lane.mode !== "scoped") throw new Error("Expected actual signed CORE principal");
    let release!: () => void;
    const pendingOut = new Promise<void>(resolve => { release = resolve; }).then(() => appendScopedCustomerReply(lane, "Поздний ответ"));
    const state = await loadCustomerStateSnapshot({ conversationId: f.nativeId }); if (!state) throw new Error("Synthetic state missing");
    expect((await prisma.$transaction(tx => transitionCustomerState(tx, state.fence, { type: "owner", mode: "HUMAN",
      agentId: randomUUID(), token: randomUUID(), leaseUntil: null }))).status).toBe("applied");
    release(); expect(await pendingOut).toBe(false);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId }, select: { messages: true } });
    expect(JSON.stringify(row.messages)).not.toContain("Поздний ответ");
  });
  it("cannot append to another ticket/native with a valid principal from inquiry A", async () => {
    const aSetup = await prepareFixture(), bSetup = await prepareFixture();
    const a = await aSetup.admit(), b = await bSetup.admit();
    expect(await recordScopedCustomerInput(a.input, a.frame, a.ticket)).toBe(true);
    const lane = await loadCustomerDmCoreQualifierLane({ authenticatedInput: a.frame, ticket: a.ticket });
    if (lane.mode !== "scoped") throw new Error("Expected actual scoped principal");
    expect(await appendScopedCustomerReply(lane, "Свой ответ A")).toBe(true);
    expect(await appendScopedCustomerReply({ ...lane, ticket: b.ticket }, "Чужой ответ")).toBe(false);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: b.nativeId }, select: { messages: true } });
    expect(JSON.stringify(row.messages)).not.toContain("Чужой ответ");
  });
});
