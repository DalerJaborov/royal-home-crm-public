import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

// Действия CRM на входящее (lib/inboundSideEffects.ts, 31.10.2026): клиент,
// которого ведёт ЯДРО, пишет — агент получает тот же пуш, что и при старом боте;
// потерянный клиент возвращается по тем же правилам; повторная доставка того же
// сообщения второго пуша не даёт. Модель и сеть в тесте не участвуют.
const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));
vi.mock("../src/lib/clientAvatar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientAvatar.js")>()),
  fetchAndStoreClientAvatarIfMissing: vi.fn(async () => null),
}));
// Автопилот и детектор неактивности зовут модель — здесь важен только факт вызова.
const runClientAutopilotInBackground = vi.fn();
vi.mock("../src/lib/clientAutopilot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientAutopilot.js")>()),
  runClientAutopilotInBackground,
}));
const checkClientInactiveSignal = vi.fn(async () => {});
vi.mock("../src/lib/clientInactiveTextDetector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientInactiveTextDetector.js")>()),
  checkClientInactiveSignal,
}));

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { ensureScopedBotConversation } = await import("../src/lib/customerConversationScope.js");
const { registerAuthenticatedMetaCustomerRequest } = await import("../src/lib/customerIngressAuthority.js");
const { persistVerifiedCustomerIngressBatch } = await import("../src/lib/customerIngressProducer.js");
const { recoverAndFinalizeCustomerInboxInput } = await import("../src/lib/customerIngressRecovery.js");
const { recordScopedCustomerInput } = await import("../src/lib/customerQualifierLedger.js");
const { applyInboundSideEffects, INBOUND_SIDE_EFFECTS_LOCK } = await import("../src/lib/inboundSideEffects.js");
const { resetClientMessageThrottle } = await import("../src/lib/clientMessageAlert.js");
const { createCustomerRolloutFixture } = await import("./helpers/customerRolloutFixture.js");

const runId = `${Date.now()}`.slice(-6);
const accountIds: string[] = [], nativeIds: string[] = [], eventKeys: string[] = [], clientIds: string[] = [], lockKeys: string[] = [];
const peerTokens = new Map<string, string>();
let agentId: string;
let oldSettings: { botEnabled: boolean; metaEnabled: boolean; botInstagramEnabled: boolean };
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
let phoneSeq = 0;
const phone = () => `+9929${runId}${String(++phoneSeq).padStart(2, "0")}`;

/** Настоящее подписанное входящее Meta в полосе CORE, переписка уже связана с карточкой. */
async function coreInput(clientId: string, text: string) {
  const id = randomUUID(), externalId = `synthetic-effects-${randomUUID()}`, peer = `synthetic-peer-${randomUUID()}`;
  const secret = `synthetic-secret-${randomUUID()}`, token = `synthetic-token-${randomUUID()}`;
  peerTokens.set(peer, token);
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId, username: `synthetic_effects_${id.replaceAll("-", "")}`,
    title: "Synthetic inbound effects", token: encryptSecret(token), appSecret: encryptSecret(secret), enabled: true } });
  accountIds.push(id);
  const eventId = randomUUID(), rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: eventId, text },
  }] }] }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  await rollout.allowDm({ peer, accountId: id, accountExternalId: externalId });
  const pending = await persistVerifiedCustomerIngressBatch(request);
  if (pending.status !== "persisted" || pending.tickets.length !== 1) throw new Error(`CORE intake unavailable: ${JSON.stringify(pending)}`);
  const eventKey = pending.tickets[0].eventKey; eventKeys.push(eventKey);
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId: id, accountExternalId: externalId }));
  nativeIds.push(native.id);
  // Связь с карточкой — ДО того, как ядро зафиксирует свою границу (bindingRevision).
  await prisma.botConversation.update({ where: { id: native.id }, data: { clientId } });
  const finalized = await recoverAndFinalizeCustomerInboxInput(eventKey);
  if (finalized.status !== "finalized") throw new Error(`Recovery FINAL unavailable: ${JSON.stringify(finalized)}`);
  lockKeys.push(`INSTAGRAM:${eventId}`);
  const input = { channel: "INSTAGRAM" as const, subscriberId: peer, skipSaveIncoming: false };
  return { nativeId: native.id, peer, eventId, record: () => recordScopedCustomerInput(input, finalized.input, finalized.ticket) };
}

async function client(data: { status?: "NEW" | "LOST"; assigned?: boolean; lastAgent?: boolean } = {}) {
  const row = await prisma.client.create({ data: { fullName: `Клиент эффектов ${runId}-${phoneSeq}`, phone: phone(), source: "INSTAGRAM", kind: "BUYER",
    status: data.status ?? "NEW", assignedAgentId: data.assigned ? agentId : null, lastAgentId: data.lastAgent ? agentId : null } });
  clientIds.push(row.id);
  return row;
}

const pushesFor = (id: string) => sendPushToAgent.mock.calls.filter((call) => (call as unknown[])[0] === id && JSON.stringify((call as unknown[])[1]).includes("/clients/"));

beforeAll(async () => {
  oldSettings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  rollout = await createCustomerRolloutFixture();
  agentId = (await prisma.agent.create({ data: { fullName: "Агент эффектов", phone: phone(), role: "AGENT", passwordHash: "x" } })).id;
  vi.stubEnv("IG_PROXY_URL", "https://synthetic-effects-instagram.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubGlobal("fetch", vi.fn(async (target: string | URL | Request) => {
    const url = new URL(String(target));
    if (url.origin !== "https://synthetic-effects-instagram.invalid" || !url.pathname.startsWith("/v23.0/synthetic-peer-")) {
      throw new Error("Unexpected synthetic request");
    }
    const peer = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (url.searchParams.get("access_token") !== peerTokens.get(peer)) throw new Error("Unowned synthetic credential");
    return new Response(JSON.stringify({ id: peer, username: "synthetic_effects_customer" }));
  }));
});
beforeEach(() => {
  sendPushToAgent.mockClear(); runClientAutopilotInBackground.mockClear(); checkClientInactiveSignal.mockClear();
  resetClientMessageThrottle();
});
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  // Фоновые действия последнего теста могли ещё дописывать — дать им осесть.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await prisma.processedMessage.deleteMany({ where: { channel: INBOUND_SIDE_EFFECTS_LOCK, messageId: { in: lockKeys } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: eventKeys.map(key => `customer-inbox-consume:${key}`) } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: eventKeys } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accountIds } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } }).catch(() => {});
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
  await prisma.settings.update({ where: { id: "singleton" }, data: oldSettings });
  await rollout.restore();
});

describe("действия CRM на входящее в полосе CORE", () => {
  it("клиент ядра пишет — агенту уходит пуш «клиент написал», автопилот и детектор неактивности зовутся", async () => {
    const card = await client({ assigned: true });
    const f = await coreInput(card.id, "Здравствуйте, квартира ещё продаётся?");
    expect(await f.record()).toBe(true);
    await waitFor(() => pushesFor(agentId).length === 1, { label: "пуш агенту о сообщении клиента ядра" });
    expect(pushesFor(agentId)[0][1]).toMatchObject({ url: `/clients/${card.shortId}` });
    await waitFor(() => runClientAutopilotInBackground.mock.calls.some(call => call[0] === card.id && call[1] === "client_message"), { label: "автопилот" });
    expect(checkClientInactiveSignal).toHaveBeenCalledWith(card.id, "Здравствуйте, квартира ещё продаётся?");
  });

  it("повторная доставка того же сообщения второго пуша не шлёт", async () => {
    const card = await client({ assigned: true });
    const f = await coreInput(card.id, "Можно посмотреть завтра?");
    expect(await f.record()).toBe(true);
    await waitFor(() => pushesFor(agentId).length === 1, { label: "первый пуш" });
    // Антиспам пачки снят: если второй пуш не придёт, то только из-за замка события.
    resetClientMessageThrottle();
    expect(await f.record()).toBe(true);
    expect(await applyInboundSideEffects({ source: "core", channel: "INSTAGRAM", peer: f.peer, conversationId: f.nativeId,
      text: "Можно посмотреть завтра?", eventId: f.eventId })).toEqual({ status: "duplicate" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pushesFor(agentId)).toHaveLength(1);
    expect(runClientAutopilotInBackground.mock.calls.filter(call => call[0] === card.id)).toHaveLength(1);
  });

  it("потерянный клиент ядра, написав сам, выходит из LOST", async () => {
    const card = await client({ status: "LOST", lastAgent: true });
    const f = await coreInput(card.id, "Я снова ищу квартиру в Сино");
    expect(await f.record()).toBe(true);
    const back = await waitFor(async () => {
      const row = await prisma.client.findUniqueOrThrow({ where: { id: card.id }, select: { status: true } });
      return row.status !== "LOST" ? row : null;
    }, { label: "возврат из LOST", timeoutMs: 5000 });
    expect(back.status).not.toBe("LOST");
  });
});

describe("действия CRM на входящее в старом ходе", () => {
  it("тот же замок события: повтор с тем же идентификатором — без второго пуша; без идентификатора — как раньше", async () => {
    const card = await client({ assigned: true });
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `legacy-effects-${randomUUID()}`, clientId: card.id, messages: [] } });
    nativeIds.push(conv.id);
    const eventId = randomUUID(); lockKeys.push(`INSTAGRAM:${eventId}`);
    const event = { source: "legacy" as const, channel: "INSTAGRAM", peer: conv.subscriberId, conversationId: conv.id, text: "Добрый день", eventId };
    expect(await applyInboundSideEffects(event)).toEqual({ status: "applied", clientId: card.id, dealReview: null });
    await waitFor(() => pushesFor(agentId).length === 1, { label: "пуш старого хода" });
    resetClientMessageThrottle();
    expect(await applyInboundSideEffects(event)).toEqual({ status: "duplicate" });
    // Старый ход сам решает про автопилот после склейки — здесь он не зовётся.
    expect(runClientAutopilotInBackground).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pushesFor(agentId)).toHaveLength(1);
  });

  it("карточка в Корзине — ни пуша, ни карточки в результате", async () => {
    const card = await client({ assigned: true });
    await prisma.client.update({ where: { id: card.id }, data: { deletedAt: new Date() } });
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `legacy-deleted-${randomUUID()}`, clientId: card.id, messages: [] } });
    nativeIds.push(conv.id);
    expect(await applyInboundSideEffects({ source: "legacy", channel: "INSTAGRAM", peer: conv.subscriberId, conversationId: conv.id, text: "Алло" }))
      .toEqual({ status: "applied", clientId: null, dealReview: null });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pushesFor(agentId)).toHaveLength(0);
  });
});
