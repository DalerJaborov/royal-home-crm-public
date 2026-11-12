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
import { createHmac, randomUUID } from "node:crypto";
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
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import { customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import * as legacy from "../src/messengers/conversation.js";
import { waitFor } from "./helpers/waitFor.js";

const tag = `echo-reply-${randomUUID()}`, key = `${tag}-key`;
type Owner = { id: string; externalId: string; token: string; secret: string; peer: string; scopeId: string; publicScopeId: string;
  transport: Awaited<ReturnType<typeof ensureCustomerEndpoint>> };
const owners: Owner[] = [];
const io: Array<{ kind: "core" | "legacy" | "count" | "dm" }> = [];
const eventIds: string[] = [], providerMids: string[] = [];
let settings: Awaited<ReturnType<typeof readSettings>>, policy: Awaited<ReturnType<typeof readPolicy>>, revisionId = "";
const readSettings = () => prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botCanAnswerComments: true, metaVerifyToken: true,
  geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true, metaAppSecret: true, metaIgAppSecret: true,
  botReplyDelaySec: true, botReplyMaxWaitSec: true,
} });
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });

async function owner(): Promise<Owner> {
  const id = randomUUID();
  const row = { id, externalId: `${tag}-installation-${id}`, token: `${tag}-token-${id}`, secret: `${tag}-secret-${id}`,
    peer: `${tag}-peer-${id}`, scopeId: "", publicScopeId: "" } as Owner;
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId: row.externalId, title: "Synthetic echo gate",
    username: `echo_agency_${id.replaceAll("-", "")}`, enabled: true, token: encryptSecret(row.token), appSecret: encryptSecret(row.secret) } });
  owners.push(row); resetAccountsCache(); resetMetaAccountCredsCache();
  row.transport = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: row.peer,
    accountId: id, accountExternalId: row.externalId }));
  row.scopeId = row.transport.endpointScopeId;
  const publicScope = await ensurePublicCommentInstallation("INSTAGRAM", row.externalId);
  if (!publicScope) throw new Error("Actual PUBLIC installation missing");
  row.publicScopeId = publicScope.installation.id;
  return row;
}
/** ACTIVE rollout that covers ONLY `allowed` (other accounts stay LEGACY, as royal.home.tj / arvan__estate on 12.11). */
async function config(allowed: Owner[], percent: number) {
  const rollout = { version: 1, cohortId: randomUUID(), candidateRevisionId: revisionId, percentBasisPoints: percent,
    allowed: allowed.flatMap(o => [{ surface: "dm", channel: "INSTAGRAM", endpointScopeId: o.scopeId },
      { surface: "public_comment", channel: "INSTAGRAM", endpointScopeId: o.publicScopeId }]) };
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',
    "capabilities"='{"publicRead":true}'::jsonb,"activeAgentRevisionId"=${revisionId},"rolloutConfig"=${JSON.stringify(rollout)}::jsonb WHERE "id"='singleton'`;
}
function rawDm(o: Owner, eventId = randomUUID()) {
  eventIds.push(eventId);
  return JSON.stringify({ object: "instagram", entry: [{ id: o.externalId, messaging: [{ sender: { id: o.peer }, recipient: { id: o.externalId },
    timestamp: Date.now(), message: { mid: eventId, text: "Здравствуйте, хотел бы получить консультацию." } }] }] });
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
const errorLogs = (needle: string) => prisma.errorLog.findMany({ where: { source: "meta", message: { contains: needle } } });

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
    if (url.origin !== "https://echo-graph.invalid") throw new Error("Unexpected provider target; no real fetch fallback");
    const o = owners.find(row => url.searchParams.get("access_token") === row.token);
    if (!o) throw new Error("Wrong synthetic credential");
    if (init?.method === "GET" && url.pathname === `/v23.0/${o.peer}`) return new Response(JSON.stringify({ id: o.peer, username: "echo_customer" }));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === "POST" && url.pathname === "/v23.0/me/messages") {
      expect(body.recipient).toEqual({ id: o.peer });
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
    await drain(); const ids = owners.map(o => o.id), scopeIds = owners.flatMap(o => [o.scopeId, o.publicScopeId]);
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
    await prisma.processedMessage.deleteMany({ where: { channel: "INSTAGRAM", messageId: { in: eventIds } } });
    await prisma.processedMessage.deleteMany({ where: { channel: "out:meta", messageId: { in: [...providerMids, ...eventIds] } } });
    await prisma.aiBudgetCounter.deleteMany({ where: { channel: "INSTAGRAM", peerId: { in: owners.map(o => o.peer) } } });
    await prisma.errorLog.deleteMany({ where: { message: { contains: tag } } });
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
  expect((await errorLogs(o.peer)).filter(row => row.dedupKey?.startsWith("customer-dm-routing-held:"))).toHaveLength(0);
});

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
});

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
});

it("a permanent hold (CORE person while the core is switched off) is ACKed, answered by nobody and reported", async () => {
  const o = await owner(); await config([o], 10_000); wire();
  expect((await post(o, rawDm(o))).status).toBe(200); await drain(); // the person now belongs to the core
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn");
  const before = (await tickets(o)).length;
  const reply = await post(o, rawDm(o));
  // Before 13.11: 503 for every retry until Meta dropped the message unseen.
  expect(reply.status, JSON.stringify(reply.body)).toBe(200); await drain();
  // Kill switch still means kill: neither bot answers this CORE person.
  expect(legacySpy).not.toHaveBeenCalled(); expect(io.filter(i => i.kind === "dm")).toHaveLength(0);
  expect((await tickets(o)).length).toBe(before);
  const logged = await waitFor(async () => (await errorLogs(o.peer)).find(row => row.dedupKey === "customer-dm-routing-held:owned_subject_stopped"),
    { label: "строка в журнале ошибок о непереданном сообщении" });
  expect(logged.message).toContain("ответьте человеку вручную");
});

it("a 503 that Meta will retry is never silent any more", async () => {
  const o = await owner(); await config([o], 10_000); wire();
  // A line from an earlier run would hide a missing write (10-minute dedup window).
  const since = new Date(); await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: "meta-webhook-503:dm:" } } });
  // The same MID twice in one signed body: the normalizer refuses an ambiguous frame.
  const mid = randomUUID(); eventIds.push(mid);
  const frame = { sender: { id: o.peer }, recipient: { id: o.externalId }, timestamp: Date.now(), message: { mid, text: "Здравствуйте" } };
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: o.externalId, messaging: [frame, frame] }] });
  expect((await post(o, raw)).status).toBe(503);
  await waitFor(async () => (await prisma.errorLog.count({ where: { source: "meta", dedupKey: { startsWith: "meta-webhook-503:dm:" }, createdAt: { gte: since } } })) > 0,
    { label: "строка в журнале ошибок о 503 для Meta" });
  await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: "meta-webhook-503:dm:" }, createdAt: { gte: since } } });
});
