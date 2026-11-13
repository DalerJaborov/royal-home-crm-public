// «Мы написали первыми — человек ответил» (прод 12.11.2026).
//
// Эхо нашего же исходящего (бот ответил на комментарий в личку, сотрудник
// написал из приложения Instagram) сохранялось с ревизией ядра, хотя аккаунт
// работает на прежнем боте. Первый ответ человека проверка истории считала
// «уже за ядром», ход вставал HELD, вебхук отвечал Meta 503 пятнадцать минут,
// и Meta выбрасывала сообщение. В журнал ошибок не попадало ничего.
//
// Здесь настоящий HTTP с подписью, настоящая маршрутизация, производитель,
// прежний бот и ядро; искусственны только внешние Graph/Gemini и паузы.
import { createHmac, randomInt, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
vi.mock("../src/messengers/humanPacing.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: vi.fn(async () => {}),
}));
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { ensurePublicCommentInstallation } from "../src/lib/customerPublicCommentStore.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { readCustomerDmSubjectExecution } from "../src/lib/customerAgentEnrollment.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { notifyHeldCustomerMessages, recordHeldCustomerMessage } from "../src/lib/customerHeldMessage.js";
import { findStuckConversations, retryStuckConversation } from "../src/lib/stuckConversations.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import { customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import * as legacy from "../src/messengers/conversation.js";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

const tag = `echo-reply-${randomUUID()}`, key = `${tag}-key`;
type Owner = { id: string; channel: "INSTAGRAM" | "WHATSAPP"; externalId: string; token: string; secret: string; peer: string; scopeId: string; publicScopeId: string;
  transport: Awaited<ReturnType<typeof ensureCustomerEndpoint>> };
const owners: Owner[] = [];
const io: Array<{ kind: "core" | "legacy" | "count" | "dm" | "profile"; peer?: string }> = [];
const eventIds: string[] = [], providerMids: string[] = [], extraAgents: string[] = [], extraClients: string[] = [];
let settings: Awaited<ReturnType<typeof readSettings>>, policy: Awaited<ReturnType<typeof readPolicy>>, revisionId = "";
const readSettings = () => prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botCanAnswerComments: true, metaVerifyToken: true,
  geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true, metaAppSecret: true, metaIgAppSecret: true,
  botReplyDelaySec: true, botReplyMaxWaitSec: true,
} });
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });

async function owner(channel: "INSTAGRAM" | "WHATSAPP" = "INSTAGRAM"): Promise<Owner> {
  const id = randomUUID();
  const peer = channel === "WHATSAPP" ? `992918${String(randomInt(100_000, 999_999))}` : `${tag}-peer-${id}`;
  const row = { id, channel, externalId: `${tag}-installation-${id}`, token: `${tag}-token-${id}`, secret: `${tag}-secret-${id}`,
    peer, scopeId: "", publicScopeId: "" } as Owner;
  await prisma.messengerAccount.create({ data: { id, channel, externalId: row.externalId, title: "Synthetic echo gate",
    username: `echo_agency_${id.replaceAll("-", "")}`, enabled: true, token: encryptSecret(row.token), appSecret: encryptSecret(row.secret) } });
  owners.push(row); resetAccountsCache(); resetMetaAccountCredsCache();
  row.transport = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel, subscriberId: row.peer,
    accountId: id, accountExternalId: row.externalId }));
  row.scopeId = row.transport.endpointScopeId;
  if (channel === "INSTAGRAM") {
    const publicScope = await ensurePublicCommentInstallation("INSTAGRAM", row.externalId);
    if (!publicScope) throw new Error("Actual PUBLIC installation missing");
    row.publicScopeId = publicScope.installation.id;
  }
  return row;
}
/** ACTIVE rollout that covers ONLY `allowed` (other accounts stay LEGACY, as royal.home.tj / arvan__estate on 12.11). */
async function config(allowed: Owner[], percent: number) {
  const rollout = { version: 1, cohortId: randomUUID(), candidateRevisionId: revisionId, percentBasisPoints: percent,
    allowed: allowed.flatMap(o => [{ surface: "dm", channel: o.channel, endpointScopeId: o.scopeId },
      ...(o.publicScopeId ? [{ surface: "public_comment", channel: "INSTAGRAM", endpointScopeId: o.publicScopeId }] : [])]) };
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',
    "capabilities"='{"publicRead":true}'::jsonb,"activeAgentRevisionId"=${revisionId},"rolloutConfig"=${JSON.stringify(rollout)}::jsonb WHERE "id"='singleton'`;
}
const DM_TEXT = "Здравствуйте, хотел бы получить консультацию.";
function rawDm(o: Owner, eventId = randomUUID(), peer = o.peer) {
  eventIds.push(eventId);
  if (o.channel === "WHATSAPP") return JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: o.externalId, changes: [{ field: "messages", value: {
    metadata: { phone_number_id: o.externalId, display_phone_number: "+992 918 000 000" }, contacts: [{ wa_id: peer, profile: { name: "Synthetic customer" } }],
    messages: [{ from: peer, id: eventId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: DM_TEXT } }] } }] }] });
  return JSON.stringify({ object: "instagram", entry: [{ id: o.externalId, messaging: [dmFrame(o, eventId, peer)] }] });
}
function dmFrame(o: Owner, eventId: string, peer = o.peer) {
  return { sender: { id: peer }, recipient: { id: o.externalId }, timestamp: Date.now(), message: { mid: eventId, text: DM_TEXT } };
}
/** The person's CRM chat and its lines with this provider MID. */
async function chatWith(o: Owner, mid: string, peer = o.peer) {
  const chat = await prisma.botConversation.findFirst({ where: { endpointScopeId: o.scopeId, subscriberId: peer }, select: { id: true, messages: true } });
  const messages = Array.isArray(chat?.messages) ? chat.messages as Array<{ mid?: string; role?: string; content?: string }> : [];
  return { id: chat?.id ?? null, held: messages.filter(m => m.mid === mid) };
}
const heldNotices = (conversationId: string) => prisma.notification.findMany({ where: { tag: `customer-held-${conversationId}` } });
/** Old row pinned to the core whose label is NOT provider_echo (e.g. its job died before classification). */
async function pinnedHistoryRow(o: Owner, errorCode: string) {
  await prisma.customerPropertyIngressTicket.create({ data: { eventKey: createHmac("sha256", tag).update(`${o.peer}:${errorCode}`).digest("hex"),
    scopeKey: customerPropertyScopeKey(o.channel, o.peer, o.id, o.scopeId), endpointScopeId: o.scopeId, eventKind: "message", payloadVersion: 1,
    payloadCiphertext: "historical-row", payloadHash: createHmac("sha256", tag).update("payload").digest("hex"), processingState: "HELD", errorCode,
    intakeAgentRevisionId: revisionId } });
}
/** Echo of OUR outgoing DM: sender is our account, the person is the recipient. */
function rawEcho(o: Owner, eventId = randomUUID()) {
  eventIds.push(eventId);
  return JSON.stringify({ object: "instagram", entry: [{ id: o.externalId, messaging: [{ sender: { id: o.externalId }, recipient: { id: o.peer },
    timestamp: Date.now(), message: { mid: eventId, text: "Здравствуйте! Ответили вам в комментариях, пишем в личку.", is_echo: true } }] }] });
}
const post = (o: Owner, raw: string) => request(app).post("/api/v1/webhooks/meta")
  .set("Content-Type", "application/json").set("x-hub-signature-256", `sha256=${createHmac("sha256", o.secret).update(raw).digest("hex")}`).send(raw);
async function drain() { await drainBackgroundTasks(15000); await drainBackgroundTasks(15000); }
const tickets = (o: Owner) => prisma.customerPropertyIngressTicket.findMany({ where: { endpointScopeId: o.scopeId }, orderBy: { order: "asc" } });

function wire() {
  vi.stubGlobal("fetch", vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    if (url.origin === "https://echo-model.invalid" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (url.pathname.endsWith(":countTokens")) { io.push({ kind: "count" }); return new Response(JSON.stringify({ totalTokens: 1000 })); }
      const isCore = !!body.tools?.some((t: { functionDeclarations?: Array<{ name: string }> }) => t.functionDeclarations?.some(f => f.name === "get_agency_contact"));
      io.push({ kind: isCore ? "core" : "legacy" });
      const submit = body.tools?.flatMap((tool: { functionDeclarations?: Array<{ name: string; parameters?: unknown; parametersJsonSchema?: unknown }> }) => tool.functionDeclarations ?? [])
        .find((declaration: { name: string }) => declaration.name === "submit_reply");
      const schema = submit?.parametersJsonSchema ?? submit?.parameters ?? body.generationConfig?.responseSchema;
      const value = isCore ? { kind: "reply", refs: [], social: "greet", question: "none" }
        : schema?.properties?.action ? { action: "reply", reply: "Здравствуйте! Напишите, что вас интересует." }
        : { reply: ["Здравствуйте! Чем можем помочь?"], ready: false, confident: true,
          ...(schema?.properties?.topic ? { topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false } : {}) };
      const parts = submit ? [{ functionCall: { name: "submit_reply", args: value } }] : [{ text: JSON.stringify(value) }];
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
    }
    // Any profile/Graph read is counted, whichever host the transport picks.
    if ((init?.method ?? "GET") === "GET") io.push({ kind: "profile", peer: url.pathname });
    if (url.origin !== "https://echo-graph.invalid") throw new Error("Unexpected provider target; no real fetch fallback");
    const o = owners.find(row => url.searchParams.get("access_token") === row.token);
    if (!o) throw new Error("Wrong synthetic credential");
    if (init?.method === "GET" && url.pathname.startsWith("/v23.0/")) return new Response(JSON.stringify({ id: url.pathname.slice(7), username: "echo_customer" }));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === "POST" && url.pathname === "/v23.0/me/messages") {
      expect(String(body.recipient?.id ?? "")).toContain(o.peer); // the account's own people only
      if (!body.message) return new Response("{}"); // read/typing wire, not a reply
      expect(body.message.text.trim()).not.toBe("");
      const mid = `${tag}-mid-${randomUUID()}`; providerMids.push(mid);
      io.push({ kind: "dm" }); return new Response(JSON.stringify({ recipient_id: o.peer, message_id: mid }));
    }
    throw new Error("Unexpected provider method/path/shape");
  }));
}

beforeAll(async () => {
  settings = await readSettings(); policy = await readPolicy();
  vi.stubEnv("IG_PROXY_URL", "https://echo-graph.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubEnv("GEMINI_PROXY_URL", "https://echo-model.invalid"); vi.stubEnv("GEMINI_PROXY_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", key); vi.stubEnv("GEMINI_API_KEY_2", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true,
    botCanAnswerComments: true, botReplyDelaySec: 0, botReplyMaxWaitSec: 1,
    metaVerifyToken: encryptSecret(`${tag}-verify`), geminiApiKey: encryptSecret(key), geminiApiKey2: null, geminiApiKeysExtra: [] } });
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
});
afterEach(async () => { await drain(); vi.restoreAllMocks(); vi.unstubAllGlobals(); io.length = 0; resetAccountsCache(); resetMetaAccountCredsCache(); });
afterAll(async () => {
  try {
    await drain(); const ids = owners.map(o => o.id), scopeIds = owners.flatMap(o => [o.scopeId, o.publicScopeId]).filter(Boolean);
    const rows = await prisma.customerPropertyIngressTicket.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { eventKey: true } });
    const keys = rows.map(t => t.eventKey), parts = await prisma.customerOutboxPart.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { id: true } });
    const native = await prisma.botConversation.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { id: true, contactProfileId: true } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...keys.map(k => `customer-inbox-consume:${k}`),
      ...parts.map(p => `customer-outbox-dispatch:${p.id}`), ...native.map(n => `ai-reply-retry:${n.id}`)] } } });
    await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts.map(p => p.id) } } });
    await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts.map(p => p.id) } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: keys } } });
    await prisma.instagramComment.deleteMany({ where: { accountExternalId: { in: owners.map(o => o.externalId) } } });
    await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: native.map(n => n.id) } } });
    await prisma.customerAgentRolloutAssignment.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: ids } } });
    await prisma.notification.deleteMany({ where: { agentId: { in: extraAgents } } });
    await prisma.client.deleteMany({ where: { id: { in: extraClients } } });
    await prisma.agent.deleteMany({ where: { id: { in: extraAgents } } });
    await prisma.processedMessage.deleteMany({ where: { channel: "INSTAGRAM", messageId: { in: eventIds } } });
    await prisma.processedMessage.deleteMany({ where: { channel: "out:meta", messageId: { in: [...providerMids, ...eventIds] } } });
    await prisma.aiBudgetCounter.deleteMany({ where: { channel: { in: ["INSTAGRAM", "WHATSAPP"] }, peerId: { in: owners.map(o => o.peer) } } });
    await prisma.errorLog.deleteMany({ where: { message: { contains: tag } } });
    await prisma.processedMessage.deleteMany({ where: { channel: "customer-held-notify", messageId: { in: native.map(n => n.id).flatMap(id => [0, 1, 2].map(k => `${id}:${Math.floor(Date.now() / 21_600_000) - k}`)) } } });
    await prisma.botConversation.updateMany({ where: { clientId: { in: extraClients } }, data: { clientId: null } });
    await prisma.notification.deleteMany({ where: { tag: { in: native.map(n => `customer-held-${n.id}`) } } });
    await prisma.processedMessage.deleteMany({ where: { channel: "WHATSAPP", messageId: { in: eventIds } } });
    const identity = { kind: "IG_ID" as const, value: { in: owners.map(o => o.peer) } };
    await prisma.contactProfile.deleteMany({ where: { id: { in: native.flatMap(n => n.contactProfileId ? [n.contactProfileId] : []) }, clientId: null, mergedIntoId: null,
      identities: { some: identity, every: identity }, botConversations: { none: {} }, telegramConversations: { none: {} }, telegramDirectConversations: { none: {} },
      incomingCalls: { none: {} }, jobApplications: { none: {} }, mergedFrom: { none: {} }, linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} },
      mergesIn: { none: {} }, mergesOut: { none: {} } } });
  } finally {
    try { if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings }); }
    finally {
      if (policy) {
        await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: policy.contractVersion,
          rolloutMode: policy.rolloutMode, capabilities: policy.capabilities!, activeAgentRevisionId: policy.activeAgentRevisionId } });
        await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${policy.rolloutConfig === null ? null : JSON.stringify(policy.rolloutConfig)}::jsonb WHERE "id"='singleton'`;
      }
      vi.unstubAllEnvs(); resetAccountsCache(); resetMetaAccountCredsCache();
    }
  }
});

it("LEGACY account: staff wrote first from the app, the person replies -> 200 and the old bot answers", async () => {
  const o = await owner(), coreElsewhere = await owner(); await config([coreElsewhere], 10_000); wire();
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn");
  expect((await post(o, rawEcho(o))).status).toBe(200); await drain();
  // (b) the echo is kept for the record only: no engine, no worker, labelled at once.
  const [echo] = await tickets(o);
  expect(echo).toMatchObject({ intakeAgentRevisionId: null, rolloutAssignmentId: null, processingState: "HELD", errorCode: "provider_echo" });
  expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-inbox-consume:${echo.eventKey}` } })).toBe(0);
  const reply = await post(o, rawDm(o));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  expect(legacySpy).toHaveBeenCalledTimes(1);
  expect(io.filter(i => i.kind === "legacy").length).toBeGreaterThan(0); expect(io.filter(i => i.kind === "dm")).toHaveLength(1);
  expect(io.filter(i => i.kind === "core")).toHaveLength(0);
  const chat = await chatWith(o, eventIds.at(-1)!);
  expect(chat.id).not.toBeNull(); expect(await heldNotices(chat.id!)).toHaveLength(0);
}, 60_000); // Two signed HTTP turns with background drain; the 20 s default is tight on a busy runner.

it("CORE account: our bot wrote first, the person replies -> 200 and the core plans and sends the answer", async () => {
  const o = await owner(); await config([o], 10_000); wire();
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn");
  const echoMid = randomUUID();
  // Bot's own private reply to a comment: the provider MID is known as ours.
  await prisma.processedMessage.create({ data: { channel: "out:meta", messageId: echoMid } });
  expect((await post(o, rawEcho(o, echoMid))).status).toBe(200); await drain();
  const reply = await post(o, rawDm(o));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  expect(legacySpy).not.toHaveBeenCalled();
  const source = (await tickets(o)).find(row => row.errorCode !== "provider_echo");
  expect(source?.intakeAgentRevisionId).toBe(revisionId); expect(source?.rolloutAssignmentId).not.toBeNull();
  expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-inbox-consume:${source!.eventKey}` } })).toBe(1);
  const planned = await consumeCustomerInboxTicket(source!.eventKey);
  expect(planned.status, JSON.stringify(planned)).toBe("planned");
  if (planned.status !== "planned") throw new Error("core did not plan");
  expect(await dispatchCustomerOutboxPart(planned.partIds[0])).toEqual({ status: "accepted" });
  expect(io.filter(i => i.kind === "core")).toHaveLength(1); expect(io.filter(i => i.kind === "dm")).toHaveLength(1);
  expect(io.filter(i => i.kind === "legacy")).toHaveLength(0);
}, 60_000); // Two signed HTTP turns with background drain; the 20 s default is tight on a busy runner.

it("the 12 people trapped on prod (old echo pinned to CORE) are released without SQL", async () => {
  const o = await owner(), coreElsewhere = await owner(); await config([coreElsewhere], 10_000); wire();
  // Exactly the stored shape seen on prod 12.11: echo with the active CORE
  // revision, finished as HELD/provider_echo. The revision column is immutable.
  const scopeKey = customerPropertyScopeKey("INSTAGRAM", o.peer, o.id, o.scopeId);
  await prisma.customerPropertyIngressTicket.create({ data: { eventKey: createHmac("sha256", tag).update(o.peer).digest("hex"),
    scopeKey, endpointScopeId: o.scopeId, eventKind: "message", payloadVersion: 1, payloadCiphertext: "historical-echo",
    payloadHash: createHmac("sha256", tag).update("payload").digest("hex"), processingState: "HELD", errorCode: "provider_echo",
    intakeAgentRevisionId: revisionId } });
  // The old bot's own guard no longer reads our echo as "the core owns this person".
  expect(await readCustomerDmSubjectExecution(prisma, o.transport, o.peer)).toBeNull();
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn");
  const reply = await post(o, rawDm(o));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  expect(legacySpy).toHaveBeenCalledTimes(1); expect(io.filter(i => i.kind === "dm")).toHaveLength(1);
  const assignment = await prisma.customerAgentRolloutAssignment.findFirst({ where: { endpointScopeId: o.scopeId } });
  expect(assignment?.lane).toBe("LEGACY");
}, 60_000); // Two signed HTTP turns with background drain; the 20 s default is tight on a busy runner.

it("core switched off: the CORE person's message is in their CRM chat, no bot answers, the agent is called once", async () => {
  const o = await owner(); await config([o], 10_000); wire();
  expect((await post(o, rawDm(o))).status).toBe(200); await drain(); // the person now belongs to the core
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn"); io.length = 0;
  const before = (await tickets(o)).length;
  const mid = randomUUID(), raw = rawDm(o, mid);
  const reply = await post(o, raw);
  // Before 13.11: 503 for every retry until Meta dropped the message unseen.
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  // Kill switch still means kill: neither bot answers this CORE person, and no
  // Graph profile lookup is spent on a message no bot will process.
  expect(legacySpy).not.toHaveBeenCalled(); expect(io.filter(i => i.kind === "dm" || i.kind === "profile")).toEqual([]);
  expect((await tickets(o)).length).toBe(before);
  const chat = await chatWith(o, mid);
  expect(chat.held).toEqual([expect.objectContaining({ role: "user", content: DM_TEXT })]);
  await waitFor(async () => (await heldNotices(chat.id!)).length > 0, { label: "уведомление сотруднику о непереданном сообщении", timeoutMs: 5000 });
  const notices = await waitForSettled(() => heldNotices(chat.id!));
  expect(notices[0].url).toBe(`/messages?open=${chat.id}`); expect(notices[0].body).toContain(DM_TEXT);
  // Redelivery of the same MID and a second message inside the window: one chat line per MID, no second call.
  expect((await post(o, raw)).status).toBe(200); expect((await post(o, rawDm(o))).status).toBe(200); await drain();
  expect((await chatWith(o, mid)).held).toHaveLength(1);
  // Routing already refuses a MID it finds in the chat; the chat writer itself must
  // still hold under two simultaneous first deliveries of one new MID.
  const racedMid = randomUUID();
  const input = { version: 1 as const, channel: "INSTAGRAM" as const, peer: o.peer, accountExternalId: o.externalId, eventKind: "message" as const,
    eventId: racedMid, inputText: "Одновременная доставка", source: { path: "$.entry[0].messaging[0]", frameHash: createHmac("sha256", tag).update(racedMid).digest("hex") },
    observations: { providerEcho: false, referralOnly: false, classifier: { version: 1 as const, bareTemplateEcho: false } }, media: [], propertyEvidence: [] };
  await Promise.all([1, 2].map(() => recordHeldCustomerMessage({ reason: "owned_subject_stopped", input, transport: o.transport })));
  expect((await chatWith(o, racedMid)).held).toHaveLength(1);
  await waitForSettled(() => heldNotices(chat.id!));
  expect((await heldNotices(chat.id!)).map(row => row.count)).toEqual(notices.map(row => row.count));
  // Five minutes later the "stuck chats" repair must not hand the held line to the old bot.
  await prisma.botConversation.update({ where: { id: chat.id! }, data: { lastMessageAt: new Date(Date.now() - 10 * 60_000) } });
  expect((await findStuckConversations()).map(row => row.id)).not.toContain(chat.id);
  const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id: chat.id! } });
  const lastUser = [...(stored.messages as Array<{ role: string; content: string; mid?: string }>)].reverse().find(m => m.role === "user")!;
  expect(await retryStuckConversation({ id: stored.id, channel: stored.channel, subscriberId: stored.subscriberId, name: stored.name,
    accountId: stored.accountId, lastText: lastUser.content, lastMessageAt: stored.lastMessageAt!, lastMid: lastUser.mid ?? null })).toBe("no-reply");
  expect(legacySpy).not.toHaveBeenCalled(); expect(io.filter(i => i.kind === "dm")).toEqual([]);
}, 90_000);

it("one body with a held CORE person and a LEGACY person: the held one is recorded, the other is answered", async () => {
  const o = await owner(); await config([o], 10_000); wire();
  expect((await post(o, rawDm(o))).status).toBe(200); await drain();
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn");
  const heldMid = randomUUID(), otherMid = randomUUID(), otherPeer = `${o.peer}-second`; eventIds.push(heldMid, otherMid);
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: o.externalId, messaging: [dmFrame(o, heldMid), dmFrame(o, otherMid, otherPeer)] }] });
  const reply = await post(o, raw);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  expect((await chatWith(o, heldMid)).held).toHaveLength(1);
  expect(legacySpy).toHaveBeenCalledTimes(1); expect(legacySpy.mock.calls[0][0]).toMatchObject({ subscriberId: otherPeer });
  expect(io.filter(i => i.kind === "dm")).toHaveLength(1);
}, 90_000);

it("KNOWN: an old CORE-pinned row whose label is not provider_echo still holds the person, but the message is not lost", async () => {
  const o = await owner(), coreElsewhere = await owner(); await config([coreElsewhere], 10_000); wire();
  await pinnedHistoryRow(o, "pending_verifier_or_age_stale");
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn"); io.length = 0;
  const mid = randomUUID(), reply = await post(o, rawDm(o, mid));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  expect(legacySpy).not.toHaveBeenCalled(); // still held: relabelling such rows is a separate, prepared ops step
  expect(io.filter(i => i.kind === "profile")).toEqual([]); // no Graph lookup for a message no bot processes
  const chat = await chatWith(o, mid);
  expect(chat.held).toHaveLength(1);
  await waitFor(async () => (await heldNotices(chat.id!)).length > 0, { label: "уведомление сотруднику", timeoutMs: 5000 });
}, 90_000);

it("WhatsApp: a held message is written into the CRM chat and the agent is called", async () => {
  const o = await owner("WHATSAPP"), coreElsewhere = await owner(); await config([coreElsewhere], 10_000); wire();
  await pinnedHistoryRow(o, "pending_verifier_or_age_stale");
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn");
  const mid = `wamid.${randomUUID()}`, reply = await post(o, rawDm(o, mid));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  expect(legacySpy).not.toHaveBeenCalled();
  const chat = await chatWith(o, mid);
  expect(chat.held).toEqual([expect.objectContaining({ role: "user", content: DM_TEXT })]);
  await waitFor(async () => (await heldNotices(chat.id!)).length > 0, { label: "уведомление сотруднику (WhatsApp)", timeoutMs: 5000 });
}, 90_000);

it("a 503 that Meta will retry is never silent any more", async () => {
  const o = await owner(); await config([o], 10_000); wire();
  // The same MID twice in one signed body: the normalizer refuses an ambiguous frame.
  const mid = randomUUID(); eventIds.push(mid);
  const frame = dmFrame(o, mid);
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: o.externalId, messaging: [frame, frame] }] });
  expect((await post(o, raw)).status).toBe(503);
  // Scoped to this account: only this test's own line can satisfy the check (and afterAll removes it by tag).
  await waitFor(async () => (await prisma.errorLog.count({ where: { source: "meta", dedupKey: { startsWith: "meta-webhook-503:dm:" },
    message: { contains: o.externalId } } })) > 0, { label: "строка в журнале ошибок о 503 для Meta" });
}, 60_000);

it("a chat deleted by staff is not resurrected: no new chat, one journal line naming the person", async () => {
  const o = await owner(), coreElsewhere = await owner(); await config([coreElsewhere], 10_000); wire();
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: o.peer, transport: o.transport }));
  await prisma.botConversation.delete({ where: { id: native.id } }); // the inquiry keeps conversationId = NULL
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn");
  const reply = await post(o, rawDm(o));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  expect(legacySpy).not.toHaveBeenCalled();
  expect(await prisma.botConversation.count({ where: { endpointScopeId: o.scopeId, subscriberId: o.peer } })).toBe(0);
  const line = await waitFor(async () => prisma.errorLog.findFirst({ where: { message: { contains: o.peer } } }), { label: "строка журнала", timeoutMs: 5000 });
  expect(line?.message).toContain("удалён сотрудником");
}, 90_000);

it("an inactive responsible agent is not called; everyone who reads all chats is", async () => {
  const o = await owner(), coreElsewhere = await owner(); await config([coreElsewhere], 10_000); wire();
  await pinnedHistoryRow(o, "pending_verifier_or_age_stale");
  const gone = await prisma.agent.create({ data: { fullName: `Уволенный ${tag}`, phone: `+9929${randomInt(10_000_000, 99_999_999)}`, role: "AGENT",
    passwordHash: "x", isActive: false } });
  extraAgents.push(gone.id);
  const client = await prisma.client.create({ data: { fullName: `Клиент ${tag}`, phone: `+9927${randomInt(10_000_000, 99_999_999)}`, source: "WEBSITE",
    assignedAgentId: gone.id, acceptedAt: new Date() } as never });
  extraClients.push(client.id);
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: o.peer, transport: o.transport }));
  await prisma.botConversation.update({ where: { id: native.id }, data: { clientId: client.id } });
  const reply = await post(o, rawDm(o));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  await waitFor(async () => (await heldNotices(native.id)).length > 0, { label: "уведомление", timeoutMs: 5000 });
  const rows = await waitForSettled(() => heldNotices(native.id));
  expect(rows.map(row => row.agentId)).not.toContain(gone.id);
  expect(rows[0].title).toContain(`Клиент ${tag}`);
}, 90_000);

it("two near-simultaneous batches call each agent once", async () => {
  const o = await owner(), coreElsewhere = await owner(); await config([coreElsewhere], 10_000);
  const mid = randomUUID(); eventIds.push(mid);
  const input = { version: 1 as const, channel: "INSTAGRAM" as const, peer: o.peer, accountExternalId: o.externalId, eventKind: "message" as const,
    eventId: mid, inputText: "Две пачки разом", source: { path: "$.entry[0].messaging[0]", frameHash: createHmac("sha256", tag).update(mid).digest("hex") },
    observations: { providerEcho: false, referralOnly: false, classifier: { version: 1 as const, bareTemplateEcho: false } }, media: [], propertyEvidence: [] };
  const hold = await recordHeldCustomerMessage({ reason: "historical_subject_owned_or_closed", input, transport: o.transport });
  await Promise.all([notifyHeldCustomerMessages([hold]), notifyHeldCustomerMessages([hold])]);
  await waitFor(async () => (await heldNotices(hold.conversationId!)).length > 0, { label: "уведомление", timeoutMs: 5000 });
  const rows = await waitForSettled(() => heldNotices(hold.conversationId!));
  expect(rows.every(row => row.count === 1)).toBe(true);
  expect(new Set(rows.map(row => row.agentId)).size).toBe(rows.length);
}, 60_000);
