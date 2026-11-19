import { createHmac, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Понимание оператора — настоящее (ai/operator/understand.ts), подменена только его модель: тест решает, что она ответит
// (по умолчанию null — запасные правила). Подмена через importOriginal: остальной модуль живой (audit:mocks).
const { understandModel } = vi.hoisted(() => ({ understandModel: vi.fn() }));
vi.mock("../src/ai/operator/understand.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/operator/understand.js")>();
  return { ...actual, understandTurn: (input: Parameters<typeof actual.understandTurn>[0], state: Parameters<typeof actual.understandTurn>[1],
    ctx: Parameters<typeof actual.understandTurn>[2]) => actual.understandTurn(input, state, ctx, understandModel, 2000) };
});
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { runCustomerDmAgentTurn } from "../src/lib/customerDmAgentTurn.js";
import { decodeCustomerOutboxPayload } from "../src/lib/customerOutbox.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { CUSTOMER_LEAD_ONLY_INTAKE_JOB, LEAD_ONLY_OPERATOR_SILENT, runCustomerLeadOnlyIntake } from "../src/lib/customerLeadOnlyCore.js";
import { decryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * ОПЕРАТОР ПРИЁМА ЗАЯВОК НА НАСТОЯЩЕМ ПУТИ ЯДРА (этап 1.2): подписанный вход → билет → ход ядра (lib/customerDmAgentTurn.ts)
 * → оператор (lib/customerLeadOnlyCore.ts → ai/operator) → план ответа в P12 и задание заявки. Цепочки случаев SPEC 3, 4, 6, 10,
 * 15 с памятью между ходами. Внешний HTTP подменён (Gemini — синтетический адрес): ход модели ядра в режиме не должен
 * начаться ни разу. Сценарии прежних шаблонов режима (lead-only-mode-core-postgres) удалены вместе с шаблонами.
 */
const EMPTY_ANSWER = { role: "none", roleQuote: "", question: "none", aboutThisProperty: false, rooms: "", district: "", budget: "", area: "",
  floor: "", renovation: "", price: "", units: "", callbackWhen: "", callbackQuote: "", textOnly: false, noCall: false, language: "none",
  bargain: false, rude: false, botQuestion: false, offTopic: false, complaint: false, jobPosition: "", outsidePlace: "" };
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
  // Пятое ревью: действие посреди хода (например, режим включили, пока модель думала) — перед ответом модели номер N.
  let beforeGenerate: ((round: number) => Promise<void>) | null = null;
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
      if (beforeGenerate) await beforeGenerate(generated);
      const parts = replies[generated++];
      if (!parts) throw new Error("Unexpected extra model round");
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
    }
    throw new Error("Unqualified synthetic endpoint");
  }));
  return { eventKey, peer, endpoint, io, bodies, setReplies(value: unknown[][]) { replies = value; generated = 0; },
    onGenerate(hook: (round: number) => Promise<void>) { beforeGenerate = hook; },
    /** Следующее подписанное сообщение того же собеседника (Instagram или WhatsApp). */
    async receive(nextText: string): Promise<string> {
      const nextBody = channel === "INSTAGRAM" ? { object: "instagram", entry: [{ id: externalId, messaging: [{ sender: { id: peer }, recipient: { id: externalId },
        timestamp: Date.now(), message: { mid: randomUUID(), text: nextText } }] }] }
        : { object: "whatsapp_business_account", entry: [{ id: externalId, changes: [{ field: "messages", value: {
          metadata: { phone_number_id: externalId, display_phone_number: "+992 918 999 999" }, contacts: [{ wa_id: peer, profile: { name: "Synthetic customer" } }],
          messages: [{ from: peer, id: randomUUID(), timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: nextText } }] } }] }] };
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
    workHoursStart: true, workHoursEnd: true, botCanRequestCallback: true, botCanAskOwner: true, botCanBookShowings: true } });
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
      ...events.map(key => `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${key}`), ...events.map(key => `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${key}:note`),
      ...parts.map(row => `customer-outbox-dispatch:${row.id}`)] } } });
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

async function conversationOf(eventKey: string): Promise<string> {
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey }, select: { conversationId: true } });
  if (!ticket.conversationId) throw new Error("ticket without conversation");
  return ticket.conversationId;
}
/** Ответ хода «ушёл» (как после отправки): следующий ход видит его в памяти, задание заявки может работать. */
async function settle(eventKey: string): Promise<void> {
  await prisma.customerOutboxPart.updateMany({ where: { ticketEventKey: eventKey }, data: { status: "ACCEPTED", projectionRecordedAt: new Date(), acceptedAt: new Date() } });
}
async function silent(eventKey: string): Promise<void> {
  expect(await runCustomerDmAgentTurn(eventKey)).toEqual({ status: "held", reason: LEAD_ONLY_OPERATOR_SILENT });
}
const intakeJob = (eventKey: string, note = false) =>
  prisma.backgroundJob.findUnique({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${eventKey}${note ? ":note" : ""}` } });
/** Модель ответа ядра в режиме не звалась ни разу: её ход всегда начинается с подсчёта токенов и идёт с serverSurface. */
function coreModelUntouched(f: { io: string[] }): void {
  expect(f.io.filter(entry => entry === "count" || entry === "generate")).toEqual([]);
}
async function operatorStateOf(conversationId: string): Promise<Record<string, unknown>> {
  const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { leadOnlyPending: true } });
  return (row.leadOnlyPending ?? {}) as Record<string, unknown>;
}

describe("оператор приёма заявок на настоящем пути ядра (этап 1.2)", () => {
  beforeEach(() => { understandModel.mockReset(); understandModel.mockResolvedValue(null); });

  it("случай 3, WhatsApp: заявка в этот же ход и вопрос о деталях; ответ — заметка; модель ядра не звалась; память v2 переживает приём", async () => {
    const f = await coreFixture("Хочу продать квартиру", "WHATSAPP");
    expect(await plannedText(f.eventKey)).toBe("Поможем продать, комиссия агентства 2%. Агент позвонит вам на этот номер в ближайшее время, " +
      "а пока опишите одним сообщением: район, комнаты, площадь, этаж, ремонт и цену.");
    const lead = await intakeJob(f.eventKey);
    expect(lead?.payload).toMatchObject({ scenario: "seller", propertyId: null });
    const sealed = JSON.parse(decryptSecret((lead!.payload as { sealed: string }).sealed)) as { phone: string; note: string };
    expect(sealed.phone).toContain(f.peer.slice(-9));
    expect(sealed.note).toContain("Хочет продать");
    await settle(f.eventKey);
    expect(await runCustomerLeadOnlyIntake(lead!.payload)).toEqual({ status: "accepted" });
    const conversationId = await conversationOf(f.eventKey);
    // П6: приём заявки стирает только прежнюю память (версия 1), память оператора остаётся с «заявка принята».
    expect(await operatorStateOf(conversationId)).toMatchObject({ version: 2, role: "seller", leadAccepted: true, step: "done" });
    const second = await f.receive("Сино, 3 комнаты, 5 этаж, 80 кв, ремонт есть, 90 000$");
    expect(await plannedText(second)).toBe("Передал агенту.");
    const note = await intakeJob(second, true);
    expect(note?.payload).toMatchObject({ scenario: "note" });
    await settle(second);
    expect(await runCustomerLeadOnlyIntake(note!.payload)).toEqual({ status: "noted" });
    const third = await f.receive("ок");
    await silent(third);
    coreModelUntouched(f);
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { clientId: true } });
    clientIds.push(conv.clientId!);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: conv.clientId! } })).kind).toBe("SELLER");
  });

  it("случай 4, WhatsApp: «С 11 до 2.30 удобно» после заявки — время повторяем и пишем агенту заметкой", async () => {
    const f = await coreFixture("Продать недвижимость", "WHATSAPP");
    expect(await plannedText(f.eventKey)).toContain("а пока опишите одним сообщением");
    await settle(f.eventKey);
    const second = await f.receive("С 11 до 2.30 удобно");
    expect(await plannedText(second)).toBe("Передам агенту: звонить с 11:00 до 14:30.");
    expect((await intakeJob(second, true))?.payload).toMatchObject({ scenario: "note" });
    coreModelUntouched(f);
  });

  it("случай 6, WhatsApp по-таджикски: покупатель — заявка сразу, ответ «2 хонага…» — «Ба агент расондам.», без списка", async () => {
    understandModel.mockImplementation(async (request: { user: string }) => {
      const current = (JSON.parse(request.user) as { currentClientMessage: string }).currentClientMessage;
      return current.startsWith("Хона") ? { ...EMPTY_ANSWER, role: "buyer", roleQuote: "Хона мехарам", language: "tg" } : null;
    });
    const f = await coreFixture("Хона мехарам", "WHATSAPP");
    const first = await plannedText(f.eventKey);
    expect(first).toContain("ба ҳамин рақам занг мезанад");
    expect(first).toContain("чанд ҳуҷра, кадом ноҳия ва то чанд пул");
    expect((await intakeJob(f.eventKey))?.payload).toMatchObject({ scenario: "buyer", propertyId: null });
    await settle(f.eventKey);
    const second = await f.receive("2 хонага, ремонт, 700 ҳазор");
    const text = await plannedText(second);
    expect(text).toBe("Ба агент расондам.");
    expect(text).not.toMatch(/№|https?:/u);
    coreModelUntouched(f);
  });

  it("случай 10, Instagram, реклама объекта: объект и цена из базы + номер; номер — заявка агенту-хозяину объекта", async () => {
    const f = await coreFixture("Сколько стоят ваши услуги?", "INSTAGRAM");
    // Объект рекламы — запасной фокус оператора (BotConversation.adPropertyId), которого прежде у ядра не было. Диалог
    // заводим заранее той же дверью, что ядро (метку рекламы пишет вход вебхука первым касанием).
    const { subscriberId: _peer, ...transport } = f.endpoint;
    const conversationId = (await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: f.peer, transport }))).id;
    nativeExtra.push(conversationId);
    await prisma.botConversation.update({ where: { id: conversationId }, data: { adPropertyId: propertyId, adTopic: "property" } });
    expect(await plannedText(f.eventKey)).toBe(`Это объект №${propertyShortId}, цена 520 000 сомони. ` +
      "Напишите, пожалуйста, ваш номер телефона, агент перезвонит.");
    await settle(f.eventKey);
    const second = await f.receive("918 22 33 47");
    expect(await plannedText(second)).toBe("Спасибо, номер получил, агент позвонит в ближайшее время.");
    const lead = await intakeJob(second);
    expect(lead?.payload).toMatchObject({ scenario: "property", propertyId });
    await settle(second);
    expect(await runCustomerLeadOnlyIntake(lead!.payload)).toEqual({ status: "accepted" });
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { clientId: true } });
    clientIds.push(conv.clientId!);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv.clientId! } });
    expect(client.assignedAgentId).toBe(ownerId);
    coreModelUntouched(f);
  });

  it("случай 15, WhatsApp: «Мефурушам» → продавец; «Я хочу продоват свою квартиру» — роль не теряется, вопроса покупателю нет", async () => {
    const f = await coreFixture("Мефурушам", "WHATSAPP");
    const first = await plannedText(f.eventKey);
    expect(first).toContain("комиссияи агентӣ 2%");
    await settle(f.eventKey);
    const second = await f.receive("Я хочу продоват свою квартиру");
    await silent(second);
    expect(await operatorStateOf(await conversationOf(f.eventKey))).toMatchObject({ version: 2, role: "seller", leadAccepted: true });
    coreModelUntouched(f);
  });

  it("сбой понимания (модель бросает): запасные правила оператора, свободная модель ядра не вызывается", async () => {
    understandModel.mockRejectedValue(new Error("model down"));
    const f = await coreFixture("Салом", "INSTAGRAM");
    expect(await plannedText(f.eventKey)).toBe("Ассалому алайкум! Шумо хона мехаред ё мефурӯшед?");
    coreModelUntouched(f);
  });
});
