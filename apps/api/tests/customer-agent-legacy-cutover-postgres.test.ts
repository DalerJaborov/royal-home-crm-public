// Допуск перевода LEGACY → ядро (решение владельца 31.10.2026) на настоящей
// базе: ручной режим и незавершённая работа держат субъекта в LEGACY, свободный
// субъект готов. Отдельно закреплено, почему сама смена полосы требует
// миграции: назначение неизменяемо и единственно на субъекта.
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import type { CustomerAgentEnrollmentSubject, CustomerAgentRolloutConfig } from "@royal-home/shared";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { enrollCustomerAgentSubjectTx } from "../src/lib/customerAgentEnrollment.js";
import { registerAuthenticatedMetaCustomerRequest, verifyMetaCustomerReferralTarget } from "../src/lib/customerIngressAuthority.js";
import { normalizeAuthenticatedCustomerIngress } from "../src/lib/customerIngressNormalize.js";
import { ensureCustomerEndpoint, ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { customerAgentLegacyCutoverEnabled, readCustomerLegacyCutoverReadiness } from "../src/lib/customerAgentLegacyCutover.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";

const accounts: string[] = [], scopes: string[] = [], natives: string[] = [], jobs: string[] = [];
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
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: randomUUID(), text: "Салом" } }] }] }));
  const request = { rawBody, get: (name: string) => name === "x-hub-signature-256"
    ? `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` : undefined };
  registerAuthenticatedMetaCustomerRequest(request);
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
  return { value, nativeId: native.id, readiness: { channel: "INSTAGRAM", peer, endpointScopeId, scopeKey }, enrolled };
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
    } finally { vi.unstubAllGlobals(); resetAccountsCache(); resetMetaAccountCredsCache(); }
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
it("the LEGACY assignment cannot be flipped in place or appended without a migration", async () => {
  const s = await legacySubject();
  if (s.enrolled.lane !== "LEGACY" || !s.enrolled.assignment) throw new Error("Persisted LEGACY assignment required");
  const a = s.enrolled.assignment;
  await expect(prisma.$executeRaw`UPDATE "CustomerAgentRolloutAssignment" SET "lane"='CORE' WHERE "id"=${a.id}`).rejects.toThrow();
  await expect(prisma.$executeRaw`INSERT INTO "CustomerAgentRolloutAssignment"
    ("id","cohortId","surface","endpointScopeId","subjectKey","bucketBps","lane","candidateRevisionId","createdAt")
    VALUES (${randomUUID()},${a.cohortId},'dm',${a.endpointScopeId},${a.subjectKey},${a.bucketBps},'CORE',${a.candidateRevisionId},now())`).rejects.toThrow();
  const [row] = await prisma.$queryRaw<Array<{ lane: string }>>`SELECT "lane" FROM "CustomerAgentRolloutAssignment" WHERE "id"=${a.id}`;
  expect(row.lane).toBe("LEGACY");
});
