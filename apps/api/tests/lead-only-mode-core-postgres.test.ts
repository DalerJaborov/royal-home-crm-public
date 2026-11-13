import { createHmac, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { runCustomerDmAgentTurn } from "../src/lib/customerDmAgentTurn.js";
import { decodeCustomerOutboxPayload } from "../src/lib/customerOutbox.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { CUSTOMER_LEAD_ONLY_INTAKE_JOB, runCustomerLeadOnlyIntake, sealCustomerLeadOnlyIntake } from "../src/lib/customerLeadOnlyCore.js";
import { customerLeadOnlyIntakeJob } from "../src/jobs/customerLeadOnlyIntake.js";
import { decryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — ЯДРО БОТА (lib/customerDmAgentTurn.ts → lib/customerLeadOnlyCore.ts).
 * Настоящий путь: подписанный вход → билет → ход ядра → план ответа в P12. Внешний
 * HTTP подменён (Gemini — синтетический адрес), модель должна молчать в сценариях
 * заявки и не видеть инструмента подборки в остальных.
 */
const accounts: string[] = [], events: string[] = [], clientIds: string[] = [], nativeExtra: string[] = [];
const cohortId = randomUUID(), apiKey = "synthetic-lead-only-core-key";
const allowed: Array<{ surface: "dm"; channel: "INSTAGRAM" | "WHATSAPP"; endpointScopeId: string }> = [];
let revisionId: string, dnsLookup: ReturnType<typeof vi.spyOn>;
let waPeerCounter = Math.floor(Math.random() * 900000);
let settingsBefore: Record<string, unknown>, policyBefore: Awaited<ReturnType<typeof prisma.customerRuntimePolicy.findUniqueOrThrow>>;
let savedRollout: unknown;
let ownerId: string, propertyId: string, propertyShortId: number;
// Ядро держит ровно один номер WhatsApp компании: все сценарии WhatsApp идут через один аккаунт.
let waAccount: { id: string; externalId: string; secret: string; token: string } | null = null;

async function coreFixture(text: string, channel: "INSTAGRAM" | "WHATSAPP") {
  let id = randomUUID(), externalId = `synthetic-lead-only-${id}`, secret = `synthetic-lead-only-secret-${id}`, token = `synthetic-lead-only-token-${id}`;
  if (channel === "WHATSAPP" && waAccount) ({ id, externalId, secret, token } = waAccount);
  else {
    await prisma.messengerAccount.create({ data: { id, channel, externalId, username: `synthetic_lead_only_${id.replaceAll("-", "")}`,
      title: "Synthetic lead-only core", enabled: true, token: encryptSecret(token), appSecret: encryptSecret(secret) } });
    accounts.push(id);
    if (channel === "WHATSAPP") waAccount = { id, externalId, secret, token };
  }
  const peer = channel === "WHATSAPP" ? `992917${String(++waPeerCounter).padStart(6, "0")}` : `synthetic-lead-only-peer-${id}`;
  const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel, subscriberId: peer, accountId: id, accountExternalId: externalId }));
  if (!allowed.some(value => value.endpointScopeId === endpoint.endpointScopeId)) allowed.push({ surface: "dm", channel, endpointScopeId: endpoint.endpointScopeId });
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({ version: 1, cohortId,
    candidateRevisionId: revisionId, percentBasisPoints: 10_000, allowed })}::jsonb WHERE "id"='singleton'`;
  const eventId = randomUUID();
  const body = channel === "INSTAGRAM" ? { object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: eventId, text } }] }] }
    : { object: "whatsapp_business_account", entry: [{ id: externalId, changes: [{ field: "messages", value: {
      metadata: { phone_number_id: externalId, display_phone_number: "+992 918 999 999" }, contacts: [{ wa_id: peer, profile: { name: "Synthetic customer" } }],
      messages: [{ from: peer, id: eventId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  const stored = await persistVerifiedCustomerIngressBatch(request);
  if (stored.status !== "persisted") throw new Error(`not persisted: ${JSON.stringify(stored)}`);
  expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel, accountId: id, accountExternalId: externalId })).toBe(true);
  const eventKey = stored.tickets[0].eventKey; events.push(eventKey);
  const io: string[] = [], bodies: Array<{ tools?: Array<{ functionDeclarations?: Array<{ name: string }> }> }> = [];
  let replies: unknown[][] = [[{ text: JSON.stringify({ kind: "reply", refs: [], social: "greet", question: "budget" }) }]], generated = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    // Ядро читает ник отправителя Instagram (защита от собственного аккаунта).
    if (u.origin === "https://synthetic-lead-only-instagram.invalid" && u.pathname === `/v23.0/${peer}` && (init?.method ?? "GET") === "GET") {
      io.push("profile"); return new Response(JSON.stringify({ id: peer, username: "synthetic_lead_only_customer" }));
    }
    if (u.origin !== "https://synthetic-lead-only-gemini.invalid" || init?.method !== "POST") throw new Error(`Unexpected HTTP ${u.origin}${u.pathname}`);
    if (u.pathname.endsWith(":countTokens")) { io.push("count"); return new Response(JSON.stringify({ totalTokens: 1000 })); }
    if (u.pathname.endsWith(":generateContent")) {
      // Фоновые разборы карточки после заявки прошлого сценария тоже ходят сюда: им пустой ответ, ходу ядра — заданный.
      if (!String(init.body).includes("serverSurface")) {
        io.push("background");
        return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "{}" }] }, finishReason: "STOP" }] }));
      }
      io.push("generate"); bodies.push(JSON.parse(String(init.body)));
      const parts = replies[generated++];
      if (!parts) throw new Error("Unexpected extra model round");
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
    }
    throw new Error("Unqualified synthetic endpoint");
  }));
  return { eventKey, peer, endpoint, io, bodies, setReplies(value: unknown[][]) { replies = value; generated = 0; },
    /** Следующее подписанное сообщение того же собеседника (только Instagram). */
    async receive(nextText: string): Promise<string> {
      const nextBody = { object: "instagram", entry: [{ id: externalId, messaging: [{ sender: { id: peer }, recipient: { id: externalId },
        timestamp: Date.now(), message: { mid: randomUUID(), text: nextText } }] }] };
      const raw = Buffer.from(JSON.stringify(nextBody));
      const next = { rawBody: raw, get: () => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` };
      registerAuthenticatedMetaCustomerRequest(next);
      const saved = await persistVerifiedCustomerIngressBatch(next);
      if (saved.status !== "persisted") throw new Error("next input not persisted");
      expect(await verifyAndRegisterMetaCustomerIssuer(next, { channel, accountId: id, accountExternalId: externalId })).toBe(true);
      events.push(saved.tickets[0].eventKey); return saved.tickets[0].eventKey;
    } };
}
async function plannedText(eventKey: string): Promise<string> {
  const result = await runCustomerDmAgentTurn(eventKey);
  expect(result.status, JSON.stringify(result)).toBe("planned");
  if (result.status !== "planned") throw new Error(JSON.stringify(result));
  const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
  await prisma.backgroundJob.updateMany({ where: { dedupeKey: `customer-outbox-dispatch:${part.id}` }, data: { runAt: new Date("2099-01-01") } });
  const payload = decodeCustomerOutboxPayload(part);
  return payload.kind === "text" ? payload.text : "";
}

beforeAll(async () => {
  dnsLookup = vi.spyOn(dns, "lookup").mockImplementation((async () => { throw Error("Unexpected external DNS"); }) as typeof dns.lookup);
  settingsBefore = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true,
    botInstagramEnabled: true, botWhatsappEnabled: true, geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true,
    botLeadOnlyMode: true, botUseWhatsappNumber: true, botMaxPhoneAsks: true, botHotIntentHandover: true,
    workHoursStart: true, workHoursEnd: true } });
  policyBefore = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
  const [row] = await prisma.$queryRaw<Array<{ rolloutConfig: unknown }>>`SELECT "rolloutConfig" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  savedRollout = row.rolloutConfig;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true,
    botWhatsappEnabled: true, geminiApiKey: encryptSecret(apiKey), geminiApiKey2: null, geminiApiKeysExtra: [],
    workHoursStart: "00:00", workHoursEnd: "24:00" } });
  vi.stubEnv("IG_PROXY_URL", "https://synthetic-lead-only-instagram.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubEnv("GEMINI_PROXY_URL", "https://synthetic-lead-only-gemini.invalid"); vi.stubEnv("GEMINI_PROXY_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", apiKey); vi.stubEnv("GEMINI_API_KEY_2", "");
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0"); vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "OFF");
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: "scoped", rolloutMode: "ACTIVE", activeAgentRevisionId: revisionId, capabilities: { publicRead: true } } });
  ownerId = (await prisma.agent.create({ data: { fullName: `Хозяин ядра ${cohortId.slice(0, 8)}`, phone: `+992908${Date.now().toString().slice(-6)}`,
    role: "AGENT", passwordHash: "x" } })).id;
  const property = await prisma.property.create({ data: { title: "Lead-only core property", type: "APARTMENT", status: "AVAILABLE",
    publishedOnSite: true, price: 520000, currency: "TJS", rooms: 2, areaSqm: 60, condition: "GOOD", assignedAgentId: ownerId } });
  propertyId = property.id; propertyShortId = property.shortId;
});
beforeEach(async () => {
  // Фоновые разборы карточки после заявки прошлого сценария (card-fill и т. п.) не должны попасть в подмену этого.
  await drainBackgroundTasks(5000);
  await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: true, botUseWhatsappNumber: true, botMaxPhoneAsks: 2,
    botHotIntentHandover: true } });
});
afterAll(async () => {
  dnsLookup?.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await drainBackgroundTasks(2000);
  try {
    const parts = await prisma.customerOutboxPart.findMany({ where: { ticketEventKey: { in: events } }, select: { id: true } });
    const natives = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: events } }, select: { conversationId: true } });
    const nativeIds = [...natives.flatMap(row => row.conversationId ? [row.conversationId] : []), ...nativeExtra];
    const linked = await prisma.botConversation.findMany({ where: { id: { in: nativeIds } }, select: { clientId: true } });
    clientIds.push(...linked.flatMap(row => row.clientId ? [row.clientId] : []));
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...events.map(key => `customer-inbox-consume:${key}`),
      ...events.map(key => `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${key}`), ...parts.map(row => `customer-outbox-dispatch:${row.id}`)] } } });
    await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts.map(row => row.id) } } });
    await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts.map(row => row.id) } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
    await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
    await prisma.outboundShieldState.deleteMany({ where: { endpointScope: { messengerAccountId: { in: accounts } } } });
    await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accounts } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.property.deleteMany({ where: { id: propertyId } });
    await prisma.agent.deleteMany({ where: { id: ownerId } });
  } finally {
    await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: policyBefore.contractVersion,
      rolloutMode: policyBefore.rolloutMode, capabilities: policyBefore.capabilities!, activeAgentRevisionId: policyBefore.activeAgentRevisionId } });
    if (savedRollout === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
    else await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(savedRollout)}::jsonb WHERE "id"='singleton'`;
  }
});

describe("режим «только заявки», ядро", () => {
  it("ревью №1: Instagram — вторая просьба другая, третьим ходом номер офиса (счёт по отправленному)", async () => {
    const f = await coreFixture("Нужна двухкомнатная квартира", "INSTAGRAM");
    expect(await plannedText(f.eventKey)).toContain("Оставьте, пожалуйста, номер телефона");
    await prisma.customerOutboxPart.updateMany({ where: { ticketEventKey: f.eventKey }, data: { status: "ACCEPTED", projectionRecordedAt: new Date(), acceptedAt: new Date() } });
    const second = await f.receive("Хочу купить квартиру");
    expect(await plannedText(second)).toContain("Если удобно, напишите номер");
    await prisma.customerOutboxPart.updateMany({ where: { ticketEventKey: second }, data: { status: "ACCEPTED", projectionRecordedAt: new Date(), acceptedAt: new Date() } });
    const third = await f.receive("Ищу квартиру");
    expect(await plannedText(third)).toContain("777 070 100");
    expect(f.io).not.toContain("count");
  });

  it("ревью №9: ответ так и не ушёл (площадка лежит) — последняя попытка всё равно заводит заявку", async () => {
    const f = await coreFixture("Хочу продать квартиру", "WHATSAPP");
    await plannedText(f.eventKey);
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${f.eventKey}` } });
    expect(await runCustomerLeadOnlyIntake(job.payload)).toEqual({ status: "wait", reason: "turn_not_settled" });
    await customerLeadOnlyIntakeJob.onGiveUp(customerLeadOnlyIntakeJob.schema.parse(job.payload));
    const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey }, select: { conversationId: true } });
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! }, select: { clientId: true } });
    expect(conv.clientId).not.toBeNull();
  });

  it("WhatsApp, продавец: короткий ответ без модели, номер не спрашиваем, заявка после хода на номер отправителя", async () => {
    const f = await coreFixture("Здравствуйте, хочу продать свою квартиру", "WHATSAPP");
    const text = await plannedText(f.eventKey);
    expect(text).toContain("на этот номер");
    expect(text).not.toMatch(/номер телефона|оставьте/i);
    // Ход модели ядра всегда начинается с подсчёта токенов: его нет — модель не звалась.
    expect(f.io).not.toContain("count");
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${f.eventKey}` } });
    expect(job.payload).toMatchObject({ scenario: "seller", propertyId: null });
    // Номер — только в зашифрованной части задания (ревью 13.11, №8).
    expect(JSON.stringify(job.payload)).not.toContain(f.peer.slice(-9));
    expect(JSON.parse(decryptSecret((job.payload as { sealed: string }).sealed)).phone).toContain(f.peer.slice(-9));
    // Ответ хода ещё не отправлен — заявку не трогаем (привязка карточки отменила бы ответ).
    expect(await runCustomerLeadOnlyIntake(job.payload)).toEqual({ status: "wait", reason: "turn_not_settled" });
    await prisma.customerOutboxPart.updateMany({ where: { ticketEventKey: f.eventKey }, data: { status: "ACCEPTED", projectionRecordedAt: new Date() } });
    expect(await runCustomerLeadOnlyIntake(job.payload)).toEqual({ status: "accepted" });
    const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey }, select: { conversationId: true } });
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! }, select: { clientId: true } });
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv.clientId! } });
    expect(client.phone.replace(/\D/g, "")).toBe(f.peer);
    expect(client.kind).toBe("SELLER");
    // Повтор задания безопасен: карточка уже есть — второй карточки и второго уведомления нет.
    expect(await runCustomerLeadOnlyIntake(job.payload)).toEqual({ status: "accepted", reason: "card_exists" });
  });

  it("Instagram, «нужна квартира»: без модели и подборки, номер просим, заявки без номера нет", async () => {
    const f = await coreFixture("Нужна двухкомнатная квартира", "INSTAGRAM");
    const text = await plannedText(f.eventKey);
    expect(text).toContain("Оставьте, пожалуйста, номер телефона");
    expect(text).not.toMatch(/https?:|№/);
    // Ход модели ядра всегда начинается с подсчёта токенов: его нет — модель не звалась.
    expect(f.io).not.toContain("count");
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${f.eventKey}` } })).toBe(0);
  });

  it("Instagram: номер в ответ на просьбу — короткое «номер получил» и заявка по теме прежних слов", async () => {
    const f = await coreFixture("Нужна двухкомнатная квартира", "INSTAGRAM");
    expect(await plannedText(f.eventKey)).toContain("Оставьте, пожалуйста, номер телефона");
    await prisma.customerOutboxPart.updateMany({ where: { ticketEventKey: f.eventKey }, data: { status: "ACCEPTED", projectionRecordedAt: new Date() } });
    const next = await f.receive("918 22 33 45");
    const text = await plannedText(next);
    expect(text).toBe("Спасибо, номер получил. Агент скоро позвонит.");
    expect(f.io).not.toContain("count");
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${next}` } });
    expect(job.payload).toMatchObject({ scenario: "buyer" });
    expect(JSON.parse(decryptSecret((job.payload as { sealed: string }).sealed)).phone).toContain("918223345");
  });

  it("прочий вопрос идёт модели без инструмента подборки; «передать сотруднику» — ответ, а не молчание", async () => {
    const f = await coreFixture("У меня вопрос по документам на собственность", "INSTAGRAM");
    f.setReplies([[{ text: JSON.stringify({ kind: "escalate", reason: "needs_staff" }) }]]);
    const text = await plannedText(f.eventKey);
    // Без номера звонок не обещаем; человек зовётся заданием (ревью 13.11, №3).
    expect(text).toBe("Передаю ваш вопрос агенту, он ответит вам здесь.");
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${f.eventKey}` } })).toBe(1);
    expect(f.io).toContain("generate");
    const names = f.bodies.flatMap(body => body.tools?.flatMap(tool => tool.functionDeclarations?.map(d => d.name) ?? []) ?? []);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("search_public_properties");
  });

  it("режим выключен — прежнее поведение: отвечает модель, заявки на номер WhatsApp нет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false } });
    const f = await coreFixture("Здравствуйте, хочу продать свою квартиру", "WHATSAPP");
    await runCustomerDmAgentTurn(f.eventKey);
    expect(f.io).toContain("generate");
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${f.eventKey}` } })).toBe(0);
  });

  it("сценарий 2: заявка с объектом из ядра уходит агенту объекта, даже ночью", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "23:58", workHoursEnd: "23:59" } });
    try {
      const peer = `992916${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
      const seed = await coreFixture("Салом", "WHATSAPP");
      const { subscriberId: _peer, ...transport } = seed.endpoint;
      const conversation = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "WHATSAPP", subscriberId: peer, transport }));
      nativeExtra.push(conversation.id);
      const result = await runCustomerLeadOnlyIntake(sealCustomerLeadOnlyIntake({ eventKey: "f".repeat(64), conversationId: conversation.id,
        scenario: "property", propertyId }, { phone: `+${peer}`, whatsappPhone: `+${peer}`, clientText: `Интересует объект №${propertyShortId}`,
        promised: "call", lead: true }));
      expect(result).toEqual({ status: "accepted" });
      const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { clientId: true } });
      clientIds.push(conv.clientId!);
      const client = await prisma.client.findUniqueOrThrow({ where: { id: conv.clientId! } });
      expect(client.assignedAgentId).toBe(ownerId);
      expect(client.assignReason).toBe("own_property_explicit");
      expect(client.requirementsNotes ?? "").toContain("Интересует конкретный объект");
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
    }
  });
});
