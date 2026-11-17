// Перевод LEGACY → ядро (решение владельца 31.10.2026) на настоящей базе:
// допуск (ручной режим, незавершённая работа, UNKNOWN держат LEGACY) и сам
// перевод через настоящий подписанный вход и производитель входящих:
// новое сообщение уходит в ядро ровно одним заданием, старый движок молчит,
// повторы не дают второго ответа, прежняя строка LEGACY неизменна.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import type { CustomerAgentEnrollmentSubject, CustomerAgentRolloutConfig } from "@royal-home/shared";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { enrollCustomerAgentSubjectTx, readCustomerDmSubjectExecution } from "../src/lib/customerAgentEnrollment.js";
import { customerDmRoutingForIncoming, inspectCustomerDmRouting } from "../src/lib/customerAgentIngressRouting.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { loadCustomerQualifierLane } from "../src/lib/customerQualifierContext.js";
import { registerAuthenticatedMetaCustomerRequest, verifyMetaCustomerReferralTarget } from "../src/lib/customerIngressAuthority.js";
import { normalizeAuthenticatedCustomerIngress } from "../src/lib/customerIngressNormalize.js";
import { ensureCustomerEndpoint, ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { customerAgentLegacyCutoverEnabled, readCustomerLegacyCutoverReadiness } from "../src/lib/customerAgentLegacyCutover.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";

const accounts: string[] = [], scopes: string[] = [], natives: string[] = [], jobs: string[] = [], events: string[] = [], parts: string[] = [];
let revisionId: string;
let savedPolicy: Awaited<ReturnType<typeof policySnapshot>>;
let savedConfig: unknown;
let savedSettings: { botEnabled: boolean; metaEnabled: boolean; botInstagramEnabled: boolean } | null = null;
function policySnapshot() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true,
} }); }

async function legacySubject() {
  const id = randomUUID(), externalId = `cutover-install-${id}`, secret = `synthetic-cutover-secret-${id}`;
  await prisma.messengerAccount.create({ data: { id, externalId, channel: "INSTAGRAM", enabled: true,
    username: `synthetic_cutover_${id.replaceAll("-", "")}`, title: "Synthetic cutover account",
    token: encryptSecret(`synthetic-cutover-token-${id}`), appSecret: encryptSecret(secret) } });
  accounts.push(id); resetAccountsCache(); resetMetaAccountCredsCache();
  const peer = `cutover-peer-${randomUUID()}`;
  // Свежий объект запроса на каждую доставку (как у настоящего вебхука); тело
  // и подпись одинаковые при повторной доставке того же сообщения.
  const message = (text: string, mid: string = randomUUID()) => {
    const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
      sender: { id: peer }, recipient: { id: externalId }, timestamp: 1_790_000_000_000, message: { mid, text } }] }] }));
    const req = { rawBody, get: (name: string) => name === "x-hub-signature-256"
      ? `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` : undefined };
    registerAuthenticatedMetaCustomerRequest(req);
    return { req, incoming: { channel: "INSTAGRAM", senderId: peer, accountExternalId: externalId, messageId: mid } };
  };
  const request = message("Салом").req;
  const [entry] = normalizeAuthenticatedCustomerIngress(request).entries;
  expect(await verifyMetaCustomerReferralTarget(request, { channel: "INSTAGRAM", peer: entry.peer, accountExternalId: entry.accountExternalId })).toBe(true);
  const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM",
    subscriberId: peer, accountId: id, accountExternalId: externalId }));
  scopes.push(endpoint.endpointScopeId);
  // Старый клиент: диалог старого движка существовал до раскатки ядра.
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: peer, transport: endpoint }));
  natives.push(native.id);
  const { endpointScopeId, scopeRevision, channel, accountId, transportKey } = endpoint;
  const value: CustomerAgentEnrollmentSubject = { surface: "dm", endpoint: { endpointScopeId, scopeRevision, channel, accountId, transportKey }, peer };
  const config: CustomerAgentRolloutConfig = { version: 1, cohortId: randomUUID(), candidateRevisionId: revisionId, percentBasisPoints: 10_000,
    allowed: [{ surface: "dm", channel: "INSTAGRAM", endpointScopeId }] };
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',
    "activeAgentRevisionId"=${revisionId},"rolloutConfig"=${JSON.stringify(config)}::jsonb WHERE "id"='singleton'`;
  const enrolled = await prisma.$transaction(tx => enrollCustomerAgentSubjectTx(tx, value));
  expect(enrolled.lane).toBe("LEGACY"); // Прежний диалог = baseline, даже при 100%.
  const scopeKey = customerPropertyScopeKey("INSTAGRAM", peer, accountId, endpointScopeId);
  return { value, nativeId: native.id, readiness: { channel: "INSTAGRAM", peer, endpointScopeId, scopeKey }, enrolled, message, externalId, endpoint };
}
const ready = (r: Awaited<ReturnType<typeof legacySubject>>["readiness"]) => prisma.$transaction(tx => readCustomerLegacyCutoverReadiness(tx, r));

beforeAll(async () => {
  savedPolicy = await policySnapshot();
  const [row] = await prisma.$queryRaw<Array<{ rolloutConfig: unknown }>>`SELECT "rolloutConfig" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  savedConfig = row.rolloutConfig;
  savedSettings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Cutover readiness must not call providers"); }));
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
});
afterAll(async () => {
  try {
    await prisma.backgroundJob.deleteMany({ where: { id: { in: jobs } } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: events.map(key => `customer-inbox-consume:${key}`) } } });
    await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: { in: scopes } } });
    // Сначала поколение 1 (ссылается на 0), остальное уходит каскадом по области.
    await prisma.$executeRaw`DELETE FROM "CustomerAgentRolloutAssignment" WHERE "generation">0 AND "endpointScopeId" = ANY(${scopes})`;
    await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...new Set(scopes)] } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  } finally {
    try {
      if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
      if (savedPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: savedPolicy });
      if (savedConfig === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
      else if (savedConfig !== undefined) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(savedConfig)}::jsonb WHERE "id"='singleton'`;
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetAccountsCache(); resetMetaAccountCredsCache(); }
  }
});

it("the switch is off unless the owner sets it explicitly", () => {
  expect(customerAgentLegacyCutoverEnabled({})).toBe(false);
  expect(customerAgentLegacyCutoverEnabled({ CUSTOMER_AGENT_LEGACY_CUTOVER: "off" })).toBe(false);
  expect(customerAgentLegacyCutoverEnabled({ CUSTOMER_AGENT_LEGACY_CUTOVER: "1" })).toBe(false);
  expect(customerAgentLegacyCutoverEnabled({ CUSTOMER_AGENT_LEGACY_CUTOVER: "on" })).toBe(true);
});
it("an idle legacy subject without manual mode is ready", async () => {
  const s = await legacySubject();
  expect(await ready(s.readiness)).toEqual({ ready: true, nativeId: s.nativeId });
});
it("operator pause keeps the subject in LEGACY until the pause ends", async () => {
  const s = await legacySubject();
  await prisma.botConversation.update({ where: { id: s.nativeId }, data: { pausedUntil: new Date(Date.now() + 3_600_000), botPausedAt: new Date() } });
  expect(await ready(s.readiness)).toEqual({ ready: false, reason: "manual_pause" });
  await prisma.botConversation.update({ where: { id: s.nativeId }, data: { pausedUntil: new Date(Date.now() - 1000) } });
  expect((await ready(s.readiness)).ready).toBe(true);
});
it("HUMAN owner, closed inquiry and spam silence keep LEGACY", async () => {
  const human = await legacySubject();
  await prisma.customerInquiry.update({ where: { conversationId: human.nativeId }, data: { ownerMode: "HUMAN", ownerAgentId: `synthetic-agent-${randomUUID()}` } });
  expect(await ready(human.readiness)).toEqual({ ready: false, reason: "human_owner" });
  const closed = await legacySubject();
  await prisma.customerInquiry.update({ where: { conversationId: closed.nativeId }, data: { closedAt: new Date() } });
  expect(await ready(closed.readiness)).toEqual({ ready: false, reason: "inquiry_closed" });
  const spam = await legacySubject();
  await prisma.botConversation.update({ where: { id: spam.nativeId }, data: { spamFlaggedAt: new Date(), spamFlagReason: "synthetic" } });
  expect(await ready(spam.readiness)).toEqual({ ready: false, reason: "spam_silenced" });
});
it("unfinished legacy work holds the subject until it completes", async () => {
  const s = await legacySubject();
  await prisma.botConversation.update({ where: { id: s.nativeId }, data: { pendingMessages: ["ещё печатаю"], pendingSince: new Date() } });
  expect(await ready(s.readiness)).toEqual({ ready: false, reason: "legacy_batch_pending" });
  await prisma.botConversation.update({ where: { id: s.nativeId }, data: { pendingMessages: [], pendingSince: null } });
  const job = await prisma.backgroundJob.create({ data: { type: "ai-reply-retry", payload: { conversationId: s.nativeId },
    maxAttempts: 1, dedupeKey: `ai-reply-retry:${s.nativeId}` } });
  jobs.push(job.id);
  expect(await ready(s.readiness)).toEqual({ ready: false, reason: "legacy_job_pending" });
  await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: "DONE" } });
  expect(await ready(s.readiness)).toEqual({ ready: true, nativeId: s.nativeId });
});
const lanes = (scopeId: string) => prisma.$queryRaw<Array<{ id: string; lane: string; generation: number; supersedesAssignmentId: string | null;
  transitionReason: string | null }>>`SELECT "id","lane","generation","supersedesAssignmentId","transitionReason"
  FROM "CustomerAgentRolloutAssignment" WHERE "endpointScopeId"=${scopeId} ORDER BY "generation"`;
const consumeJobs = (keys: string[]) => prisma.backgroundJob.count({ where: { dedupeKey: { in: keys.map(key => `customer-inbox-consume:${key}`) } } });
type Subject = Awaited<ReturnType<typeof legacySubject>>;
type Delivery = ReturnType<Subject["message"]>;
async function produce(req: Delivery["req"]) {
  const result = await persistVerifiedCustomerIngressBatch(req);
  if (result.status === "persisted") events.push(...result.tickets.map(t => t.eventKey));
  return result;
}
/** Что увидит старый движок: вебхук (routes/webhooks.ts ~:1701), processMessengerTurn и квалификатор. */
async function legacyEngine(s: Subject, delivery: Delivery) {
  const witness = customerDmRoutingForIncoming(delivery.req, delivery.incoming);
  const route = witness ? inspectCustomerDmRouting(witness)!.execution.lane : null;
  const subject = await readCustomerDmSubjectExecution(prisma, { endpointScopeId: s.endpoint.endpointScopeId, scopeRevision: s.endpoint.scopeRevision,
    channel: "INSTAGRAM", accountId: s.endpoint.accountId, transportKey: s.endpoint.transportKey }, s.value.peer);
  const qualifier = await loadCustomerQualifierLane({ channel: "INSTAGRAM", subscriberId: s.value.peer, accountExternalId: s.externalId });
  return { route, subject: subject?.lane ?? null, qualifier: qualifier.mode };
}
const cutoverAudits = (scopeId: string) => prisma.auditLog.count({ where: { action: "CUSTOMER_AGENT_LANE_CUTOVER",
  meta: { path: ["endpointScopeId"], equals: scopeId } } });

it("flag off: a legacy subject keeps the old engine, nothing is appended", async () => {
  vi.stubEnv("CUSTOMER_AGENT_LEGACY_CUTOVER", "");
  const s = await legacySubject(), m = s.message("Нархи хона чанд?");
  expect(await produce(m.req)).toEqual({ status: "bypass", reason: "unsupported" });
  expect(await legacyEngine(s, m)).toEqual({ route: "LEGACY", subject: "LEGACY", qualifier: "legacy" });
  expect((await lanes(s.endpoint.endpointScopeId)).map(r => r.lane)).toEqual(["LEGACY"]);
  expect(await cutoverAudits(s.endpoint.endpointScopeId)).toBe(0);
});
it("flag on: the next new message of an idle legacy subject goes to the core once; the old engine is silent", async () => {
  vi.stubEnv("CUSTOMER_AGENT_LEGACY_CUTOVER", "on");
  const s = await legacySubject(), m = s.message("Хочу двухкомнатную в Сино");
  if (s.enrolled.lane !== "LEGACY" || !s.enrolled.assignment) throw new Error("Original LEGACY required");
  const original = s.enrolled.assignment;
  const produced = await produce(m.req);
  expect(produced.status).toBe("persisted"); if (produced.status !== "persisted") throw new Error("Core source required");
  expect(produced.tickets).toHaveLength(1); expect(produced.tickets[0].fresh).toBe(true);
  const key = produced.tickets[0].eventKey;
  const rows = await lanes(s.endpoint.endpointScopeId);
  expect(rows).toEqual([
    { id: original.id, lane: "LEGACY", generation: 0, supersedesAssignmentId: null, transitionReason: null },
    { id: expect.any(String), lane: "CORE", generation: 1, supersedesAssignmentId: original.id, transitionReason: "legacy_cutover_owner_31_10" },
  ]);
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: key },
    select: { rolloutAssignmentId: true, intakeAgentRevisionId: true } });
  expect(ticket).toEqual({ rolloutAssignmentId: rows[1].id, intakeAgentRevisionId: revisionId });
  expect(await consumeJobs([key])).toBe(1); // Ровно один ход ядра.
  expect(await legacyEngine(s, m)).toEqual({ route: "CORE", subject: "CORE", qualifier: "held" });
  // Лид и заявка: customerActionJournal (~:361) и customerNewLeadBridge (~:158)
  // ищут у билета назначение lane='CORE' — у переведённого оно есть.
  const [lead] = await prisma.$queryRaw<Array<{ managed: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" t
    JOIN "CustomerAgentRolloutAssignment" a ON a."id"=t."rolloutAssignmentId" WHERE t."eventKey"=${key} AND a."lane"='CORE'
      AND a."surface"='dm' AND a."endpointScopeId"=${s.endpoint.endpointScopeId}) AS managed`;
  expect(lead.managed).toBe(true);
  const audits = await prisma.auditLog.findMany({ where: { action: "CUSTOMER_AGENT_LANE_CUTOVER", entityId: rows[1].id } });
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ entityType: "CustomerAgentRolloutAssignment", agentId: null, meta: {
    fromAssignmentId: original.id, fromLane: "LEGACY", toLane: "CORE", reason: "legacy_cutover_owner_31_10" } });
  // Повторная доставка того же сообщения: тот же билет, без второго задания, строки и аудита.
  const again = await produce(s.message("Хочу двухкомнатную в Сино", m.incoming.messageId).req);
  expect(again).toMatchObject({ status: "persisted", tickets: [{ eventKey: key, fresh: false }] });
  expect(await consumeJobs([key])).toBe(1);
  expect(await lanes(s.endpoint.endpointScopeId)).toHaveLength(2);
  expect(await cutoverAudits(s.endpoint.endpointScopeId)).toBe(1);
  // Прежняя строка LEGACY по-прежнему неизменяема.
  await expect(prisma.$executeRaw`UPDATE "CustomerAgentRolloutAssignment" SET "lane"='CORE' WHERE "id"=${original.id}`).rejects.toThrow();
});
it("a redelivered OLD legacy message after the cutover gets no second answer from either engine", async () => {
  vi.stubEnv("CUSTOMER_AGENT_LEGACY_CUTOVER", "");
  const s = await legacySubject(), old = s.message("Старое сообщение до перевода");
  expect(await produce(old.req)).toEqual({ status: "bypass", reason: "unsupported" }); // Ответил старый движок.
  vi.stubEnv("CUSTOMER_AGENT_LEGACY_CUTOVER", "on");
  expect((await produce(s.message("Новое сообщение").req)).status).toBe("persisted");
  const before = await prisma.backgroundJob.count({ where: { dedupeKey: { startsWith: "customer-inbox-consume:" } } });
  const redelivery = s.message("Старое сообщение до перевода", old.incoming.messageId);
  expect((await produce(redelivery.req)).status).toBe("unavailable"); // Вебхук ответит 503 — без хода.
  expect(await prisma.backgroundJob.count({ where: { dedupeKey: { startsWith: "customer-inbox-consume:" } } })).toBe(before);
  const engine = await legacyEngine(s, redelivery);
  expect(engine.route).not.toBe("LEGACY"); expect(engine.subject).toBe("CORE");
  expect((await lanes(s.endpoint.endpointScopeId)).map(r => r.lane)).toEqual(["LEGACY", "CORE"]);
});
it("manual mode, unfinished work and an UNKNOWN delivery keep the subject LEGACY under the flag", async () => {
  vi.stubEnv("CUSTOMER_AGENT_LEGACY_CUTOVER", "on");
  const paused = await legacySubject();
  await prisma.botConversation.update({ where: { id: paused.nativeId }, data: { pausedUntil: new Date(Date.now() + 3_600_000), botPausedAt: new Date() } });
  const pm = paused.message("Есть кто?");
  expect(await produce(pm.req)).toEqual({ status: "bypass", reason: "unsupported" });
  expect((await legacyEngine(paused, pm)).route).toBe("LEGACY");
  const busy = await legacySubject();
  await prisma.botConversation.update({ where: { id: busy.nativeId }, data: { pendingMessages: ["первая часть"], pendingSince: new Date() } });
  expect(await produce(busy.message("вторая часть").req)).toEqual({ status: "bypass", reason: "unsupported" });
  const unknown = await legacySubject();
  const id = randomUUID(), text = "synthetic legacy reply";
  const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: unknown.nativeId }, select: { id: true } });
  await prisma.customerOutboxPart.create({ data: { id, partKey: createHash("sha256").update(id).digest("hex"), sourceKind: "STAFF_ANSWER",
    inquiryId: inquiry.id,
    sourceKey: `synthetic:${id}`, originalNativeId: unknown.nativeId, conversationId: unknown.nativeId, turnKey: `synthetic:${id}`, ordinal: 0,
    mode: "LIVE", channel: "INSTAGRAM", endpointScopeId: unknown.endpoint.endpointScopeId, transportJson: {}, fenceJson: {}, receiptRefsJson: [],
    payloadEncrypted: encryptSecret(text), payloadHash: createHash("sha256").update(text).digest("hex"), payloadVersion: 1, status: "UNKNOWN" } });
  parts.push(id);
  expect(await ready(unknown.readiness)).toEqual({ ready: false, reason: "delivery_unsettled" });
  expect(await produce(unknown.message("Ответьте").req)).toEqual({ status: "bypass", reason: "unsupported" });
  expect(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id }, select: { status: true } })).toEqual({ status: "UNKNOWN" });
  for (const s of [paused, busy, unknown]) {
    expect((await lanes(s.endpoint.endpointScopeId)).map(r => r.lane)).toEqual(["LEGACY"]);
    expect(await cutoverAudits(s.endpoint.endpointScopeId)).toBe(0);
  }
});
it("the database refuses a cutover row that breaks the rules", async () => {
  const s = await legacySubject();
  if (s.enrolled.lane !== "LEGACY" || !s.enrolled.assignment) throw new Error("Original LEGACY required");
  const a = s.enrolled.assignment;
  const insert = (generation: number, supersedes: string | null, reason: string | null, lane = "CORE") => prisma.$executeRaw`INSERT INTO "CustomerAgentRolloutAssignment"
    ("id","cohortId","surface","endpointScopeId","subjectKey","bucketBps","lane","candidateRevisionId","createdAt","generation","supersedesAssignmentId","transitionReason")
    VALUES (${randomUUID()},${a.cohortId},'dm',${a.endpointScopeId},${a.subjectKey},${a.bucketBps},${lane},${a.candidateRevisionId},now(),${generation},${supersedes},${reason})`;
  await expect(insert(0, null, null)).rejects.toThrow(); // Второе поколение 0 — уникальность.
  await expect(insert(1, null, "legacy_cutover_owner_31_10")).rejects.toThrow(); // Без предшественника.
  await expect(insert(1, a.id, "other_reason")).rejects.toThrow(); // Чужая причина.
  await expect(insert(2, a.id, "legacy_cutover_owner_31_10")).rejects.toThrow(); // Пропуск поколения.
  await expect(insert(1, a.id, "legacy_cutover_owner_31_10", "LEGACY")).rejects.toThrow(); // Только в ядро.
  expect((await lanes(s.endpoint.endpointScopeId)).map(r => r.lane)).toEqual(["LEGACY"]);
});
