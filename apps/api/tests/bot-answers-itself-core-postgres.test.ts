import { createHmac, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { CUSTOMER_LEAD_ONLY_INTAKE_JOB, LEAD_ONLY_OPERATOR_SILENT, planCustomerLeadOnlyTurn, runCustomerLeadOnlyIntake,
  sealCustomerLeadOnlyIntake } from "../src/lib/customerLeadOnlyCore.js";
import { customerLeadOnlyIntakeJob } from "../src/jobs/customerLeadOnlyIntake.js";
import { noteLeadOnlyNewPhone } from "../src/lib/leadOnlyHandover.js";
import { LEAD_ONLY_DEFAULTS } from "../src/ai/leadOnlyMode.js";
import { initialOperatorState } from "../src/ai/operator/decide.js";
import { serializeOperatorState } from "../src/ai/operator/state.js";
import { decryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { SELF_ASK_PHONE } from "../src/ai/botSelfAnswerText.js";
import { leadOnlyEscalateLine } from "../src/ai/leadOnlyMode.js";
import { resetMetaSendBlockCache } from "../src/lib/metaSendBlock.js";
import { CUSTOMER_TURN_INTENDED_SILENCE } from "../src/lib/customerIntendedSilence.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * «БОТ ОТВЕЧАЕТ САМ» НА НАСТОЯЩЕМ ПУТИ ЯДРА (PR #283, сведён с оператором #311 19.11.2026). Подписанный вход → билет → ход
 * ядра (lib/customerDmAgentTurn.ts) → план ответа и задание заявки. Обвязка — та же, что у tests/bot-operator-core-postgres
 * (Gemini — синтетический адрес, ни одного внешнего запроса). Сценарии прежнего файла lead-only-mode-core-postgres (#283,
 * удалён в main вместе с шаблонами режима) перенесены сюда и переведены на новую дверь заявки (lib/selfAnswerLead.ts).
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
  return { eventKey, peer, endpoint, io, bodies, accountId: id, setReplies(value: unknown[][]) { replies = value; generated = 0; },
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
    workHoursStart: true, workHoursEnd: true, botCanRequestCallback: true, botCanAskOwner: true, botCanBookShowings: true,
    botAnswersItself: true } });
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

const office = /650 14 14|позвоните нам|занг занед/iu;
const intakeJob = (eventKey: string) => prisma.backgroundJob.findUnique({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${eventKey}` } });

/**
 * Просьба перезвонить (ревью #283): на «позвоните мне завтра» бот отвечал «позвоните нам сами» (телефон офиса, номер
 * WhatsApp известен) и никого не звал — заявка терялась. Известный номер = заявка агенту; без номера — просьба номера.
 */
describe("«бот отвечает сам»: просьба перезвонить — заявка, а не «позвоните нам сами»", () => {
  beforeEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false, botAnswersItself: true } });
  });

  it("WhatsApp: «Позвоните мне завтра после обеда», модель передаёт человеку — заявка на номер отправителя с временем звонка", async () => {
    const f = await coreFixture("Позвоните мне завтра после обеда, пожалуйста", "WHATSAPP");
    f.setReplies([[{ text: JSON.stringify({ kind: "escalate", reason: "needs_staff" }) }]]);
    const text = await plannedText(f.eventKey);
    expect(text).not.toMatch(office);
    expect(text).toBe(leadOnlyEscalateLine("ru", true));
    const id = await conversationOf(f.eventKey);
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${f.eventKey}` } });
    expect(job.payload).toMatchObject({ scenario: "escalate", conversationId: id });
    await prisma.customerOutboxPart.updateMany({ where: { ticketEventKey: f.eventKey }, data: { status: "ACCEPTED", projectionRecordedAt: new Date() } });
    expect(await runCustomerLeadOnlyIntake(job.payload)).toEqual({ status: "accepted" });
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { clientId: true, leadDraft: true } });
    expect(conv.clientId).not.toBeNull();
    clientIds.push(conv.clientId!);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv.clientId! }, select: { phone: true, requirementsNotes: true } });
    expect(client.phone.replace(/\D/g, "")).toBe(f.peer);
    // Время звонка доходит до агента: пометка в карточке, событие или черновик заявки разговора.
    const interactions = await prisma.interaction.findMany({ where: { clientId: conv.clientId! } });
    expect(JSON.stringify([client.requirementsNotes, interactions, conv.leadDraft])).toMatch(/завтра/u);
  });

  it("Instagram без номера: «Перезвоните мне» — просьба номера, а не телефон офиса; заявки без номера нет", async () => {
    const f = await coreFixture("Перезвоните мне, пожалуйста", "INSTAGRAM");
    f.setReplies([[{ text: JSON.stringify({ kind: "escalate", reason: "needs_staff" }) }]]);
    const text = await plannedText(f.eventKey);
    expect(text).not.toMatch(office);
    expect(text).toMatch(/номер/u);
    expect(await intakeJob(f.eventKey)).toBeNull();
    // Номер уже просили, клиент снова просит перезвонить: снова просьба номера, а не «позвоните нам».
    await prisma.customerOutboxPart.updateMany({ where: { ticketEventKey: f.eventKey }, data: { status: "ACCEPTED", projectionRecordedAt: new Date(), acceptedAt: new Date() } });
    const again = await f.receive("Перезвоните мне завтра утром");
    f.setReplies([[{ text: JSON.stringify({ kind: "escalate", reason: "needs_staff" }) }]]);
    const second = await plannedText(again);
    expect(second).not.toMatch(office);
    expect(second).toMatch(/номер/u);
  });

  it("ВЫКЛ (как в main): тот же ход WhatsApp — прежняя строка, задания заявки нет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: false } });
    const f = await coreFixture("Позвоните мне завтра после обеда, пожалуйста", "WHATSAPP");
    f.setReplies([[{ text: JSON.stringify({ kind: "escalate", reason: "needs_staff" }) }]]);
    const text = await plannedText(f.eventKey);
    expect(text).not.toMatch(office);
    expect(await intakeJob(f.eventKey)).toBeNull();
  });
});

/**
 * Ревью #283, блокер 2: обычный ответ ядра «это подскажет агент / он позвонит» (отрисовщик, ai/customerAgentStaffFollowUp.ts)
 * уходил клиенту, а при ВКЛ сигнал гасился — обещание, которое некому выполнить. При ВКЛ без карточки: номер известен —
 * заявка и строка «Передаю ваш вопрос агенту…», номера нет — просьба номера. Вопрос об обмене машины — живой случай (15.11),
 * отрисовщик отвечает на него строкой передачи агенту.
 */
describe("«бот отвечает сам»: ответ ядра звал агента (блокер 2)", () => {
  const TRADE_IN = "Мошин ҳам қабул мекунед?";
  beforeEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false, botAnswersItself: true } });
  });

  it("ВКЛ, WhatsApp без карточки: вместо «агент позвонит» без сигнала — заявка агенту и строка «передаю ваш вопрос агенту»", async () => {
    const f = await coreFixture(TRADE_IN, "WHATSAPP");
    const text = await plannedText(f.eventKey);
    expect(text).toBe(leadOnlyEscalateLine("tg", true));
    const job = await intakeJob(f.eventKey);
    expect(job?.payload).toMatchObject({ scenario: "escalate", conversationId: await conversationOf(f.eventKey) });
  });

  it("ВКЛ, Instagram без номера: вместо «это подскажет агент» — просьба номера, заявки нет", async () => {
    const f = await coreFixture(TRADE_IN, "INSTAGRAM");
    const text = await plannedText(f.eventKey);
    expect(text).toBe(SELF_ASK_PHONE.tg);
    expect(await intakeJob(f.eventKey)).toBeNull();
  });

  it("ВЫКЛ (как в main): строка передачи агенту, задания заявки нет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: false } });
    const f = await coreFixture(TRADE_IN, "WHATSAPP");
    const text = await plannedText(f.eventKey);
    expect(text).toMatch(/агенти мо/u);
    expect(await intakeJob(f.eventKey)).toBeNull();
  });
});

/**
 * БЛОКИРОВКА META (код 368, как у Арвана 17.11) — ВЕТКА НЕ ХУЖЕ MAIN (HANDOFF #283 от 19.11, блокер ревью architect).
 * Прежде ветка выходила из хода ядра ДО модели и оператора с причиной `meta_send_blocked`, записанной в «намеренную
 * тишину»: оператор «только заявки» не запускался (номер из сообщения заявкой не становился), до двери отправки ход не
 * доходил (человек не узнавал), оба сторожа «клиент ждёт» молчание пропускали. В main (#273) ход идёт как обычно, а
 * отправку останавливает дверь Meta (lib/metaSendBlock.ts) и передаёт переписку человеку. Тумблеры на это не влияют.
 */
describe("блокировка Meta: ход ядра идёт как в main — заявка по номеру и сигнал человеку", () => {
  const blocks: string[] = [], handed: string[] = [];
  async function blockDm(accountId: string): Promise<void> {
    const now = new Date();
    const row = await prisma.metaSendBlock.create({ data: { accountKey: `account:${accountId}`, surface: "dm", channel: "INSTAGRAM", accountId,
      label: "Synthetic (Instagram)", since: now, lastFailureAt: now, nextProbeAt: new Date(now.getTime() + 3_600_000), lastCode: 368 } });
    blocks.push(row.id);
    resetMetaSendBlockCache();
  }
  afterEach(async () => {
    const ids = blocks.splice(0);
    for (const id of handed.splice(0)) await prisma.processedMessage.deleteMany({ where: { channel: "meta-send-block-handoff", messageId: { startsWith: `${id}:` } } });
    await prisma.metaSendBlock.deleteMany({ where: { id: { in: ids } } });
    resetMetaSendBlockCache();
  });

  it("«meta_send_blocked» — не намеренная тишина: сторожа «клиент ждёт» такой ход не пропускают", () => {
    expect(CUSTOMER_TURN_INTENDED_SILENCE).not.toContain("meta_send_blocked");
  });

  it.each([false, true])("режим «только заявки», «бот отвечает сам» = %s: номер при блокировке — задание заявки, как в main", async (selfOn) => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: true, botAnswersItself: selfOn } });
    const f = await coreFixture("Хочу продать квартиру", "INSTAGRAM");
    await plannedText(f.eventKey);
    await prisma.customerOutboxPart.updateMany({ where: { ticketEventKey: f.eventKey }, data: { status: "ACCEPTED", projectionRecordedAt: new Date(), acceptedAt: new Date() } });
    await blockDm(f.accountId);
    const second = await f.receive("918 22 33 61");
    const result = await runCustomerDmAgentTurn(second);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "planned" });
    expect((await intakeJob(second))?.payload).toMatchObject({ scenario: "seller", conversationId: await conversationOf(f.eventKey) });
  });

  it.each([false, true])("обычный режим, «бот отвечает сам» = %s: ответ планируется, дверь Meta его не выпускает и зовёт человека", async (selfOn) => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false, botAnswersItself: selfOn } });
    const f = await coreFixture("Сколько стоит двушка в Сино?", "INSTAGRAM");
    await blockDm(f.accountId);
    const result = await runCustomerDmAgentTurn(f.eventKey);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "planned" });
    if (result.status !== "planned") return;
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    expect(await dispatchCustomerOutboxPart(result.partIds[0])).toMatchObject({ status: "suppressed" });
    // В Meta ничего не ушло: ни отправки, ни «печатает…».
    expect(vi.mocked(globalThis.fetch).mock.calls.slice(before).filter(([url]) => !String(url).includes("gemini"))).toEqual([]);
    const conversationId = await conversationOf(f.eventKey);
    handed.push(conversationId);
    const claim = await prisma.processedMessage.findFirst({ where: { channel: "meta-send-block-handoff", messageId: { startsWith: `${conversationId}:` } } });
    expect(claim, "дверь Meta передала переписку человеку").not.toBeNull();
    const chat = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { silenceAlertFor: true } });
    expect(chat.silenceAlertFor).not.toBeNull();
  });
});

/**
 * ЗАКРЕПЛЕНИЕ ДЛЯ ЛИЧНЫХ (HANDOFF #283, 19.11: «тест оба ВЫКЛ = main есть только для комментариев»). Оба тумблера ВЫКЛ —
 * ответ ядра тот же, что в main, заявки «бот отвечает сам» нет, а обещание агента доходит до человека (сигнал «клиент
 * ждёт», как в main). При ВКЛ тот же ход — просьба номера и без сигнала (тест «ВКЛ, Instagram без номера» выше).
 */
describe("ЗАКРЕПЛЕНИЕ: оба тумблера ВЫКЛ — личные (ядро) как в main", () => {
  beforeEach(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false, botAnswersItself: false, botCommentPhoneConversation: false } });
  });
  it("Instagram без карточки: «это подскажет агент» уходит как в main, человек узнаёт, заявки нет", async () => {
    const f = await coreFixture("Мошин ҳам қабул мекунед?", "INSTAGRAM");
    const text = await plannedText(f.eventKey);
    expect(text).toMatch(/агенти мо/u);
    expect(text).not.toBe(SELF_ASK_PHONE.tg);
    expect(await intakeJob(f.eventKey)).toBeNull();
    const id = await conversationOf(f.eventKey);
    await waitFor(async () => (await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { silenceAlertFor: true } })).silenceAlertFor,
      { timeoutMs: 5000, label: "сигнал «клиент ждёт» при ВЫКЛ" });
  });
});
