// PRIVATE NORMAL PG candidate: actual HTTP/HMAC/P11/Core/renderer/P12/legacy
// controllers. Only external HTTP and human pacing sleeps are synthetic.
// NOT RUN. Requires root DDL + part01/02 source, never production credentials.
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
vi.mock("../src/messengers/humanPacing.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: vi.fn(async () => {}),
}));
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureCustomerEndpoint, loadCustomerTransportForConversation } from "../src/lib/customerConversationScope.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { loadCustomerQualifierLane } from "../src/lib/customerQualifierContext.js";
import { ensurePublicCommentInstallation } from "../src/lib/customerPublicCommentStore.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { handleComment } from "../src/messengers/comments.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import * as legacy from "../src/messengers/conversation.js";
import * as routing from "../src/lib/customerAgentIngressRouting.js";

const tag = `routing-http-${randomUUID()}`, key = `${tag}-key`;
const owners: Array<{ id: string; externalId: string; token: string; secret: string; peer: string; scopeId: string; publicScopeId: string }> = [];
const io: Array<{ kind: "core" | "legacy" | "count" | "dm" | "public"; peer?: string }> = [];
const eventIds: string[] = [], sourceIds: string[] = [], providerMids: string[] = [];
let settings: Awaited<ReturnType<typeof readSettings>>, policy: Awaited<ReturnType<typeof readPolicy>>, revisionId = "";
const readSettings = () => prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botCanAnswerComments: true, metaVerifyToken: true,
  geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true, metaAppSecret: true, metaIgAppSecret: true,
  botReplyDelaySec: true, botReplyMaxWaitSec: true,
} });
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
async function owner() {
  const id = randomUUID(), row = { id, externalId: `${tag}-installation-${id}`, token: `${tag}-token-${id}`,
    secret: `${tag}-secret-${id}`, peer: `${tag}-peer-${id}`, scopeId: "", publicScopeId: "" };
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId: row.externalId, title: "Synthetic routing gate",
    username: `routing_agency_${id.replaceAll("-", "")}`, enabled: true, token: encryptSecret(row.token), appSecret: encryptSecret(row.secret) } });
  owners.push(row); resetAccountsCache(); resetMetaAccountCredsCache();
  row.scopeId = (await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: row.peer,
    accountId: id, accountExternalId: row.externalId }))).endpointScopeId;
  const publicScope = await ensurePublicCommentInstallation("INSTAGRAM", row.externalId);
  if (!publicScope) throw new Error("Actual PUBLIC installation missing"); row.publicScopeId = publicScope.installation.id;
  return row;
}
async function config(values: Awaited<ReturnType<typeof owner>>[], percent: number) {
  const rollout = { version: 1, cohortId: randomUUID(), candidateRevisionId: revisionId, percentBasisPoints: percent,
    allowed: values.flatMap(o => [{ surface: "dm", channel: "INSTAGRAM", endpointScopeId: o.scopeId },
      { surface: "public_comment", channel: "INSTAGRAM", endpointScopeId: o.publicScopeId }]) };
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',
    "capabilities"='{"publicRead":true}'::jsonb,"activeAgentRevisionId"=${revisionId},"rolloutConfig"=${JSON.stringify(rollout)}::jsonb WHERE "id"='singleton'`;
}
function rawDm(o: Awaited<ReturnType<typeof owner>>, eventId: string | undefined = randomUUID()) {
  if (eventId) eventIds.push(eventId);
  return JSON.stringify({ object: "instagram", entry: [{ id: o.externalId, messaging: [{ sender: { id: o.peer }, recipient: { id: o.externalId },
    timestamp: Date.now(), message: { ...(eventId ? { mid: eventId } : {}), text: "Здравствуйте, хотел бы получить консультацию." } }] }] });
}
const post = (o: Awaited<ReturnType<typeof owner>>, raw: string) => request(app).post("/api/v1/webhooks/meta")
  .set("Content-Type", "application/json").set("x-hub-signature-256", `sha256=${createHmac("sha256", o.secret).update(raw).digest("hex")}`).send(raw);
async function drain() { await drainBackgroundTasks(15000); await drainBackgroundTasks(15000); }
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), release: () => resolve() }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Routing barrier timed out")), 15000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function wire() {
  vi.stubGlobal("fetch", vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    if (url.origin === "https://routing-model.invalid" && init?.method === "POST") {
      expect(new Headers(init.headers).get("x-goog-api-key")).toBe(key);
      const body = JSON.parse(String(init.body));
      if (url.pathname.endsWith(":countTokens")) { io.push({ kind: "count" }); return new Response(JSON.stringify({ totalTokens: 1000 })); }
      expect(url.pathname.endsWith(":generateContent")).toBe(true);
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
    if (url.origin !== "https://routing-graph.invalid") throw new Error("Unexpected provider target; no real fetch fallback");
    const o = owners.find(row => url.searchParams.get("access_token") === row.token);
    if (!o) throw new Error("Wrong synthetic credential");
    if (init?.method === "GET" && url.pathname === `/v23.0/${o.peer}`) return new Response(JSON.stringify({ id: o.peer, username: "routing_customer" }));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === "POST" && url.pathname === "/v23.0/me/messages") {
      expect(body.recipient).toEqual({ id: o.peer });
      if (!body.message) return new Response("{}"); // actual read/typing wire, not a customer reply
      expect(Object.keys(body.message)).toEqual(["text"]); expect(body.message.text.trim()).not.toBe("");
      const mid=`${tag}-mid-${randomUUID()}`;providerMids.push(mid);
      io.push({ kind: "dm", peer: o.peer }); return new Response(JSON.stringify({ recipient_id: o.peer, message_id: mid }));
    }
    if (init?.method === "POST" && /^\/v23.0\/routing-comment-[^/]+\/replies$/.test(url.pathname)) {
      expect(Object.keys(body)).toEqual(["message"]); expect(body.message.trim()).not.toBe("");
      const mid=`${tag}-public-mid-${randomUUID()}`;providerMids.push(mid);
      io.push({ kind: "public" }); return new Response(JSON.stringify({ id: mid }));
    }
    throw new Error("Unexpected provider method/path/shape");
  }));
}
beforeAll(async () => {
  settings = await readSettings(); policy = await readPolicy();
  vi.stubEnv("IG_PROXY_URL", "https://routing-graph.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubEnv("GEMINI_PROXY_URL", "https://routing-model.invalid"); vi.stubEnv("GEMINI_PROXY_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", key); vi.stubEnv("GEMINI_API_KEY_2", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true,
    botCanAnswerComments: true, botReplyDelaySec: 0, botReplyMaxWaitSec: 1,
    metaVerifyToken: encryptSecret(`${tag}-verify`), geminiApiKey: encryptSecret(key), geminiApiKey2: null, geminiApiKeysExtra: [] } });
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
});
afterEach(async () => { await drain(); vi.restoreAllMocks(); vi.unstubAllGlobals(); io.length = 0; resetAccountsCache(); resetMetaAccountCredsCache(); });
afterAll(async () => {
  try {
    await drain(); const ids = owners.map(o => o.id), scopeIds = owners.flatMap(o => [o.scopeId,o.publicScopeId]);
    const tickets = await prisma.customerPropertyIngressTicket.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { eventKey: true } });
    const keys = tickets.map(t => t.eventKey), parts = await prisma.customerOutboxPart.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { id: true } });
    const native = await prisma.botConversation.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { id: true, contactProfileId:true } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...keys.map(k => `customer-inbox-consume:${k}`),
      ...parts.map(p => `customer-outbox-dispatch:${p.id}`), ...native.map(n => `ai-reply-retry:${n.id}`)] } } });
    await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts.map(p => p.id) } } });
    await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts.map(p => p.id) } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: keys } } });
    await prisma.instagramComment.deleteMany({ where: { accountExternalId: { in: owners.map(o => o.externalId) } } });
    await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: native.map(n => n.id) } } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: ids } } });
    await prisma.processedMessage.deleteMany({ where: { channel: "INSTAGRAM", messageId: { in: eventIds } } });
    await prisma.processedMessage.deleteMany({where:{channel:'out:meta',messageId:{in:providerMids}}});
    await prisma.aiBudgetCounter.deleteMany({where:{channel:{in:['INSTAGRAM','INSTAGRAM_COMMENTS']},peerId:{in:owners.flatMap(o=>[o.peer,`${tag}-public-author-${o.id}`])}}});
    const identity={kind:'IG_ID',value:{in:owners.map(o=>o.peer)}};
    await prisma.contactProfile.deleteMany({where:{id:{in:native.flatMap(n=>n.contactProfileId?[n.contactProfileId]:[])},clientId:null,mergedIntoId:null,
      identities:{some:identity,every:identity},botConversations:{none:{}},telegramConversations:{none:{}},telegramDirectConversations:{none:{}},
      incomingCalls:{none:{}},jobApplications:{none:{}},mergedFrom:{none:{}},linkCandidatesLeft:{none:{}},linkCandidatesRight:{none:{}},mergesIn:{none:{}},mergesOut:{none:{}}}});
  } finally {
    try { if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings }); }
    finally { if (policy) {
      await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: policy.contractVersion,
        rolloutMode: policy.rolloutMode, capabilities: policy.capabilities!, activeAgentRevisionId: policy.activeAgentRevisionId } });
      await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${policy.rolloutConfig === null ? null : JSON.stringify(policy.rolloutConfig)}::jsonb WHERE "id"='singleton'`;
    } vi.unstubAllEnvs(); resetAccountsCache(); resetMetaAccountCredsCache(); }
  }
});
it("100% genuine HTTP CORE input has one model, one accepted OUT and zero legacy controller calls", async () => {
  const o = await owner(); await config([o], 10_000); wire(); const legacySpy = vi.spyOn(legacy, "processMessengerTurn");
  const raw=rawDm(o);expect((await post(o, raw)).status).toBe(200); await drain();
  expect(legacySpy).not.toHaveBeenCalled(); expect(io.filter(i => i.kind === "core")).toHaveLength(0); // job not run by HTTP
  const source = await prisma.customerPropertyIngressTicket.findFirstOrThrow({ where: { endpointScopeId: o.scopeId } });
  expect(source.rolloutAssignmentId).not.toBeNull(); expect(source.intakeAgentRevisionId).toBe(revisionId);
  // Actual recovered FINAL + recorded canonical IN + public projection. This
  // must succeed without using the ordinary legacy facade as a core bypass.
  const prepared = await prepareCustomerDmInboxCoreContext(source.eventKey);
  expect(prepared.status, JSON.stringify(prepared)).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("Genuine CORE projection unavailable");
  const transport = await loadCustomerTransportForConversation(prepared.lane.ticket.conversationId);
  if (!transport) throw new Error("Original actual transport unavailable");
  expect(await loadCustomerQualifierLane({ channel: "INSTAGRAM", subscriberId: o.peer, customerTransport: transport,
    customerAuthenticatedInput: prepared.lane.authenticatedInput,
    customerPropertyAdmission: { status: "admitted", ticket: prepared.lane.ticket } })).toEqual({ mode: "held", reason: "original_core_owns_turn" });
  expect(await legacy.processMessengerTurn({ channel: "INSTAGRAM", subscriberId: o.peer,
    text: "Здравствуйте, хотел бы получить консультацию.", customerTransport: transport,
    customerAuthenticatedInput: prepared.lane.authenticatedInput,
    customerPropertyAdmission: { status: "admitted", ticket: prepared.lane.ticket } })).toMatchObject({ shouldReply: false, silenced: "held" });
  expect(io.filter(i => i.kind === "core" || i.kind === "legacy" || i.kind === "count" || i.kind === "dm")).toHaveLength(0);
  legacySpy.mockClear();
  const planned = await consumeCustomerInboxTicket(source.eventKey); expect(planned.status, JSON.stringify(planned)).toBe("planned");
  if (planned.status !== "planned") throw new Error("Actual P11 owner failed to plan");
  expect(planned.partIds).toHaveLength(1); expect(await dispatchCustomerOutboxPart(planned.partIds[0])).toEqual({ status: "accepted" });
  expect(await consumeCustomerInboxTicket(source.eventKey)).toEqual({ status: "unchanged", reason: "already_planned" });
  expect(io.filter(i => i.kind === "core")).toHaveLength(1); expect(io.filter(i => i.kind === "count")).toHaveLength(1);
  expect(io.filter(i => i.kind === "legacy")).toHaveLength(0); expect(io.filter(i => i.kind === "dm")).toHaveLength(1);
  await prisma.customerRuntimePolicy.update({where:{id:'singleton'},data:{rolloutMode:'OFF'}});
  expect((await post(o,raw)).status).toBe(200);await drain();
  expect(legacySpy).not.toHaveBeenCalled();expect(io.filter(i=>i.kind==='core')).toHaveLength(1);expect(io.filter(i=>i.kind==='dm')).toHaveLength(1);
  expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:source.eventKey}})).rolloutAssignmentId).toBe(source.rolloutAssignmentId);
});
it("configured 0% genuine HTTP LEGACY input still answers under global ACTIVE exactly once", async () => {
  const o = await owner(); await config([o], 0); wire(); const spy = vi.spyOn(legacy, "processMessengerTurn");
  const raw = rawDm(o); expect((await post(o, raw)).status).toBe(200); await drain();
  expect(spy).toHaveBeenCalledTimes(1); expect(io.filter(i => i.kind === "legacy")).toHaveLength(1);
  expect(io.filter(i => i.kind === "core" || i.kind === "count")).toHaveLength(0); expect(io.filter(i => i.kind === "dm")).toHaveLength(1);
  const source = await prisma.customerPropertyIngressTicket.findFirstOrThrow({ where: { endpointScopeId: o.scopeId } });
  expect(source.rolloutAssignmentId).not.toBeNull(); expect(source.intakeAgentRevisionId).toBeNull();
  expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-inbox-consume:${source.eventKey}` } })).toBe(0);
  expect((await post(o, raw)).status).toBe(200); await drain(); expect(io.filter(i => i.kind === "dm")).toHaveLength(1);
});
it("signed env-fallback public ingress commits LEGACY before async even OFF, but cannot create or resume a CORE origin", async () => {
  const a = await owner(), b = await owner(); wire();
  const publicBody = (o: typeof a, id: string, parent?: string) => JSON.stringify({ object: "instagram", entry: [{ id: o.externalId,
    changes: [{ field: "comments", value: { id, ...(parent ? { parent_id: parent } : {}),
      media: { id: `${tag}-publication-${o.id}` }, from: { id: `${tag}-public-author-${o.id}` }, text: "Здравствуйте!" } }] }] });
  // Genuine durable CORE original, before switching this installation to the
  // weaker legacy environment route. No fake source/origin or principal.
  await config([b], 10_000);
  const coreId = `routing-comment-${randomUUID()}`;
  expect((await post(b, publicBody(b, coreId))).status).toBe(200); await drain();
  const core = await prisma.instagramComment.findUniqueOrThrow({ where: { commentId: coreId } });
  expect(core.publicOriginCiphertext).not.toBeNull();
  await prisma.messengerAccount.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { appSecret: null } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaAppSecret: null, metaIgAppSecret: null } });
  vi.stubEnv("META_APP_SECRET", a.secret); vi.stubEnv("META_IG_APP_SECRET", "");
  resetAccountsCache(); resetMetaAccountCredsCache();
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='compat',"rolloutMode"='OFF',
    "activeAgentRevisionId"=NULL,"rolloutConfig"=NULL WHERE "id"='singleton'`;
  const legacyId = `routing-comment-${randomUUID()}`;
  expect((await post(a, publicBody(a, legacyId))).status).toBe(200); await drain();
  const old = await prisma.instagramComment.findUniqueOrThrow({ where: { commentId: legacyId } });
  expect(old.publicRolloutAssignmentId).not.toBeNull(); expect(old.publicOriginCiphertext).toBeNull();
  const [baseline] = await prisma.$queryRaw<Array<{ lane: string; candidateRevisionId: string | null }>>`
    SELECT "lane","candidateRevisionId" FROM "CustomerAgentRolloutAssignment" WHERE "id"=${old.publicRolloutAssignmentId}`;
  expect(baseline).toEqual({ lane: "LEGACY", candidateRevisionId: null });
  expect(await prisma.instagramComment.count({ where: { commentId: legacyId } })).toBe(1);
  await config([a, b], 10_000);
  expect(await handleComment(old)).toBe("replied");
  expect(io.filter(i => i.kind === "core")).toHaveLength(0); expect(io.filter(i => i.kind === "legacy")).toHaveLength(1);
  expect(io.filter(i => i.kind === "public")).toHaveLength(1);
  expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: old.id } })).publicOriginCiphertext).toBeNull();
  // A new subject under ACTIVE still gets only LEGACY with env credentials.
  const freshId = `routing-comment-${randomUUID()}`;
  expect((await post(a, publicBody(a, freshId))).status).toBe(200); await drain();
  expect((await prisma.instagramComment.findUniqueOrThrow({ where: { commentId: freshId } })).publicOriginCiphertext).toBeNull();
  // Same original CORE thread cannot route through legacy after credential
  // strength loss. Exact HMAC is valid, but no new row/origin/model/OUT follows.
  vi.stubEnv("META_APP_SECRET", b.secret); resetMetaAccountCredsCache();
  const tailId = `routing-comment-${randomUUID()}`;
  expect((await post(b, publicBody(b, tailId, coreId))).status).toBe(503); await drain();
  expect(await prisma.instagramComment.count({ where: { commentId: tailId } })).toBe(0);
  expect(io.filter(i => i.kind === "core")).toHaveLength(0); expect(io.filter(i => i.kind === "public")).toHaveLength(1);
  expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: core.id } })).publicOriginCiphertext).toBe(core.publicOriginCiphertext);
});
it("OFF/configNULL capture commits before a real legacy controller waits, so activation cannot move B into CORE", async () => {
  const o = await owner(); wire();
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='compat',"rolloutMode"='OFF',"rolloutConfig"=NULL,"activeAgentRevisionId"=NULL WHERE "id"='singleton'`;
  const started = deferred(), release = deferred(), original = legacy.processMessengerTurn;
  const spy = vi.spyOn(legacy, "processMessengerTurn").mockImplementationOnce(async input => { started.release(); await release.promise; return original(input); });
  let assignmentId = "";
  try {
    expect((await post(o, rawDm(o))).status).toBe(200); await bounded(started.promise);
    const [a] = await prisma.$queryRaw<Array<{ id: string; lane: string; cohortId: string | null; candidateRevisionId: string | null; bucketBps: number | null }>>`
      SELECT "id","lane","cohortId","candidateRevisionId","bucketBps" FROM "CustomerAgentRolloutAssignment" WHERE "endpointScopeId"=${o.scopeId}`;
    expect(a).toMatchObject({ lane: "LEGACY", cohortId: null, candidateRevisionId: null, bucketBps: null }); assignmentId = a.id;
    await config([o], 10_000); expect((await post(o, rawDm(o))).status).toBe(200);
  }
  finally { release.release(); }
  await drain(); expect(spy).toHaveBeenCalledTimes(2);
  expect(await prisma.customerPropertyIngressTicket.count({ where: { endpointScopeId: o.scopeId, intakeAgentRevisionId: { not: null } } })).toBe(0);
  const [after] = await prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomerAgentRolloutAssignment" WHERE "endpointScopeId"=${o.scopeId}`;
  expect(after.id).toBe(assignmentId); expect(io.filter(i => i.kind === "core" || i.kind === "count")).toHaveLength(0);
  expect(io.filter(i => i.kind === "legacy").length).toBeGreaterThan(0); expect(io.filter(i => i.kind === "dm").length).toBeGreaterThan(0);
  // Existing legacy debounce can merge A+B: this case proves one ENGINE, not two required bubbles.
}, 45_000); // Two genuine sequential HTTP/SQL turns plus the activation barrier.
it("required CORE job failure rolls back source/ACK but retains the committed first assignment and never invokes legacy", async () => {
  const o = await owner(); await config([o], 10_000); wire(); const spy = vi.spyOn(legacy, "processMessengerTurn");
  const mid = randomUUID(), raw = rawDm(o, mid), eventKey = customerPropertyEventKey(customerPropertyScopeKey("INSTAGRAM", o.peer, o.id, o.scopeId), "message", mid);
  const blocker = await prisma.backgroundJob.create({ data: { type: "customer-inbox-consume", payload: { version: 1, eventKey },
    dedupeKey: `customer-inbox-consume:${eventKey}`, maxAttempts: 5, runAt: new Date(Date.now()+3600_000) } });
  try {
    expect((await post(o, raw)).status).toBe(503); await drain();
    expect(await prisma.customerPropertyIngressTicket.count({ where: { eventKey } })).toBe(0); expect(spy).not.toHaveBeenCalled(); expect(io).toHaveLength(0);
    const [a] = await prisma.$queryRaw<Array<{ id: string; lane: string }>>`SELECT "id","lane" FROM "CustomerAgentRolloutAssignment" WHERE "endpointScopeId"=${o.scopeId}`;
    expect(a.lane).toBe("CORE");
    await prisma.backgroundJob.delete({ where: { id: blocker.id } });
    expect((await post(o, raw)).status).toBe(200); await drain();
    const stored = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey } });
    expect(stored.rolloutAssignmentId).toBe(a.id); expect(spy).not.toHaveBeenCalled();
  } finally { await prisma.backgroundJob.deleteMany({ where: { id: blocker.id } }); }
});
it("mixed genuine public 0%/100% subjects queue once and each reaches only its original public executor", async () => {
  const a = await owner(), b = await owner(); wire(); await config([a], 0);
  async function publicPost(o: typeof a) {
    const id = `routing-comment-${randomUUID()}`, raw = JSON.stringify({ object: "instagram", entry: [{ id: o.externalId,
      changes: [{ field: "comments", value: { id, media: { id: `${tag}-publication-${o.id}` }, from: { id: `${tag}-public-author-${o.id}` }, text: "Здравствуйте!" } }] }] });
    expect((await post(o, raw)).status).toBe(200); await drain();
    const row = await prisma.instagramComment.findUniqueOrThrow({ where: { commentId: id } }); sourceIds.push(row.id);
    expect(row.publicRolloutAssignmentId).not.toBeNull();
    expect(await prisma.instagramComment.count({ where: { commentId: id } })).toBe(1);
    expect((await prisma.instagramComment.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "WORKING" } })).count).toBe(1);
    return prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id } });
  }
  const old = await publicPost(a); expect(old.publicOriginCiphertext).toBeNull();
  await config([b], 10_000); const fresh = await publicPost(b); expect(fresh.publicOriginCiphertext).not.toBeNull();
  expect(await handleComment(old)).toBe("replied"); expect(await handleComment(fresh)).toBe("replied");
  expect(io.filter(i => i.kind === "legacy")).toHaveLength(1); expect(io.filter(i => i.kind === "core")).toHaveLength(1);
  expect(io.filter(i => i.kind === "public")).toHaveLength(2); expect(io.filter(i => i.kind === "dm")).toHaveLength(0);
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
  await handleComment(await prisma.instagramComment.findUniqueOrThrow({ where: { id: fresh.id } }));
  expect(io.filter(i => i.kind === "public")).toHaveLength(2); // no policy-off legacy resend
});
it("a genuine missing-MID legacy frame records only its subject baseline, never a fake event, before later activation", async () => {
  const o=await owner();wire();const legacySpy=vi.spyOn(legacy,"processMessengerTurn");await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='compat',"rolloutMode"='OFF',"rolloutConfig"=NULL,"activeAgentRevisionId"=NULL WHERE "id"='singleton'`;
  const raw=JSON.stringify({object:'instagram',entry:[{id:o.externalId,messaging:[{sender:{id:o.peer},recipient:{id:o.externalId},timestamp:Date.now(),message:{text:'Здравствуйте, хотел бы получить консультацию.'}}]}]});
  expect((await post(o,raw)).status).toBe(200);await drain();
  const [assignment]=await prisma.$queryRaw<Array<{id:string;lane:string;candidateRevisionId:string|null}>>`SELECT "id","lane","candidateRevisionId" FROM "CustomerAgentRolloutAssignment" WHERE "endpointScopeId"=${o.scopeId}`;
  expect(assignment).toMatchObject({lane:'LEGACY',candidateRevisionId:null});
  expect(await prisma.customerPropertyIngressTicket.count({where:{endpointScopeId:o.scopeId}})).toBe(0);
  await config([o],10000);expect((await post(o,rawDm(o))).status).toBe(200);await drain();
  const source=await prisma.customerPropertyIngressTicket.findFirstOrThrow({where:{endpointScopeId:o.scopeId}});
  expect(source.rolloutAssignmentId).toBe(assignment.id);expect(source.intakeAgentRevisionId).toBeNull();
  expect(io.filter(v=>v.kind==='core'||v.kind==='count')).toHaveLength(0);
  expect(legacySpy).toHaveBeenCalledTimes(2); // Legacy may regenerate a repeated model reply within one controller turn.
  expect(io.filter(v=>v.kind==='legacy').length).toBeGreaterThanOrEqual(2);expect(io.filter(v=>v.kind==='dm')).toHaveLength(2);
}, 45_000); // Missing-MID turn followed by a separate real keyed delivery.
