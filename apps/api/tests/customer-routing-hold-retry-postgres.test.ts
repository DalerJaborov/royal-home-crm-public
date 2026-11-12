// A transient routing hold keeps 503 end to end (13.11.2026): the endpoint
// scope changes between the capture and the routing transaction
// (`captured_scope_changed`). Meta must retry, the attempt must be visible in
// the error log, nothing may be written or answered, and the retry succeeds.
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const staleScope = { on: false };
vi.mock("../src/lib/customerConversationScope.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/lib/customerConversationScope.js")>();
  return { ...original, ensureCustomerEndpoint: (async (...args: Parameters<typeof original.ensureCustomerEndpoint>) => {
    const endpoint = await original.ensureCustomerEndpoint(...args);
    // Simulates a credential rotation that bumped the scope right after capture.
    return staleScope.on ? { ...endpoint, scopeRevision: (BigInt(endpoint.scopeRevision) + 1n).toString() } : endpoint;
  }) as typeof original.ensureCustomerEndpoint };
});
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import * as legacy from "../src/messengers/conversation.js";
import { waitFor } from "./helpers/waitFor.js";

const tag = `hold-retry-${randomUUID()}`, id = randomUUID();
const account = { externalId: `${tag}-installation`, secret: `${tag}-secret`, token: `${tag}-token`, peer: `${tag}-peer` };
let scopeId = "", policy: Awaited<ReturnType<typeof readPolicy>>;
let saved: { metaEnabled: boolean; metaVerifyToken: string | null } | null = null;
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
const post = (raw: string) => request(app).post("/api/v1/webhooks/meta").set("Content-Type", "application/json")
  .set("x-hub-signature-256", `sha256=${createHmac("sha256", account.secret).update(raw).digest("hex")}`).send(raw);

beforeAll(async () => {
  // No real provider traffic: every Graph/model call answers an error.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "synthetic" } }), { status: 400 })));
  vi.stubEnv("IG_PROXY_URL", "https://hold-retry-graph.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  policy = await readPolicy();
  saved = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaEnabled: true, metaVerifyToken: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaEnabled: true, metaVerifyToken: encryptSecret(`${tag}-verify`) } });
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId: account.externalId, title: "Synthetic hold retry",
    username: `hold_retry_${id.replaceAll("-", "")}`, enabled: true, token: encryptSecret(account.token), appSecret: encryptSecret(account.secret) } });
  resetAccountsCache(); resetMetaAccountCredsCache();
  scopeId = (await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: account.peer,
    accountId: id, accountExternalId: account.externalId }))).endpointScopeId;
  const revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
  // Account NOT in the rollout: a LEGACY subject, so the retry needs no model at all.
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',"activeAgentRevisionId"=${revisionId},
    "rolloutConfig"=${JSON.stringify({ version: 1, cohortId: randomUUID(), candidateRevisionId: revisionId, percentBasisPoints: 10_000, allowed: [] })}::jsonb
    WHERE "id"='singleton'`;
});
afterAll(async () => {
  try {
    await drainBackgroundTasks(15000);
    const rows = await prisma.customerPropertyIngressTicket.findMany({ where: { endpointScopeId: scopeId }, select: { eventKey: true } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: rows.map(row => `customer-inbox-consume:${row.eventKey}`) } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: scopeId } });
    const native = await prisma.botConversation.findMany({ where: { endpointScopeId: scopeId }, select: { id: true } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: native.map(n => `ai-reply-retry:${n.id}`) } } });
    await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: scopeId } });
    await prisma.botConversation.deleteMany({ where: { endpointScopeId: scopeId } });
    await prisma.customerAgentRolloutAssignment.deleteMany({ where: { endpointScopeId: scopeId } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: scopeId } });
    await prisma.messengerAccount.deleteMany({ where: { id } });
    await prisma.errorLog.deleteMany({ where: { message: { contains: tag } } });
  } finally {
    if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: policy.contractVersion,
      rolloutMode: policy.rolloutMode, activeAgentRevisionId: policy.activeAgentRevisionId } });
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${policy.rolloutConfig === null ? null : JSON.stringify(policy.rolloutConfig)}::jsonb WHERE "id"='singleton'`;
    resetAccountsCache(); resetMetaAccountCredsCache(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});

it("captured_scope_changed answers 503, writes nothing, is logged, and the redelivery is accepted", async () => {
  const legacySpy = vi.spyOn(legacy, "processMessengerTurn").mockResolvedValue({ reply: "", ready: false, accepted: false, shouldReply: false });
  const mid = randomUUID();
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: account.externalId, messaging: [{ sender: { id: account.peer },
    recipient: { id: account.externalId }, timestamp: Date.now(), message: { mid, text: "Здравствуйте" } }] }] });
  staleScope.on = true;
  try { expect((await post(raw)).status).toBe(503); } finally { staleScope.on = false; }
  await drainBackgroundTasks(15000);
  expect(legacySpy).not.toHaveBeenCalled();
  expect(await prisma.customerAgentRolloutAssignment.count({ where: { endpointScopeId: scopeId } })).toBe(0);
  expect(await prisma.botConversation.count({ where: { endpointScopeId: scopeId } })).toBe(0);
  await waitFor(async () => (await prisma.errorLog.count({ where: { dedupKey: "meta-webhook-503:dm:routing_held",
    message: { contains: account.externalId } } })) > 0, { label: "строка журнала о 503 для этого аккаунта" });
  const retry = await post(raw);
  expect(retry.status, JSON.stringify(retry.body)).toBe(200); await drainBackgroundTasks(15000);
  expect(legacySpy).toHaveBeenCalledTimes(1);
  expect((await prisma.customerAgentRolloutAssignment.findFirst({ where: { endpointScopeId: scopeId } }))?.lane).toBe("LEGACY");
}, 90_000);
