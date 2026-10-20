import { createHmac, createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { registerAuthenticatedMetaCustomerRequest, inspectAuthenticatedCustomerInput } from "../src/lib/customerIngressAuthority.js";
import { customerPrincipalAuthenticatedInput, type CustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { persistVerifiedMetaPublicCommentBatch } from "../src/lib/customerPublicCommentProducer.js";
import { prepareCustomerPublicAgentDraft, finishPublicAgentDecision, publicAgentCommentLane } from "../src/lib/customerPublicAgentTurn.js";
import { finishUnsentPublicAgentFailure, expireUnsentPublicAgentPlans } from "../src/lib/customerPublicAgentFailure.js";
import { handleComment } from "../src/messengers/comments.js";
import { publicCommentOrigin, readPublicSourceRow } from "../src/lib/customerPublicCommentStore.js";
import { ensurePublicCommentInstallation } from "../src/lib/customerPublicCommentStore.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "../src/lib/customerOutbox.js";
import { customerAgentToolCallSchema, type BotTurnTracePayload } from "@royal-home/shared";
import { AGENCY_FACTS } from "../src/ai/agencyFacts.js";
import { loadPeerAiBudget, AI_TURNS_PER_DAY_STRANGER, AI_HARD_LIMIT_MULTIPLIER } from "../src/lib/aiDailyBudget.js";
import { PUBLIC_AGENCY_CONTACT } from "../src/lib/publicAgencyContact.js";
import * as accountsModule from "../src/messengers/accounts.js";
import * as legacyAi from "../src/ai/client.js";
import * as meta from "../src/messengers/meta.js";
import * as traceStore from "../src/lib/botTurnTraceStore.js";
import * as publicStore from "../src/lib/customerPublicCommentStore.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { readCustomerPublicOutreachMemory } from "../src/lib/customerPublicOutreachMemory.js";

// NORMAL PG: actual signed producer/default issuer/AEAD pin/registration,
// common model+count+durable budget/core/seal/P12. Only provider HTTP is fake.
// No mocked principal, runtime, permission, model adapter or successful receipt.
const tag = `synthetic-public-core-${randomUUID()}`;
const dmEvents:string[]=[],dmScopes:string[]=[],dmConversations:string[]=[];
const sourceIds: string[] = [], accountIds: string[] = [], resources: string[] = [], propertyIds: string[] = [], authors: string[] = [];
const cohortId = randomUUID();
const allowedEndpoints: Array<{ surface: "public_comment"; channel: "INSTAGRAM" | "FACEBOOK"; endpointScopeId: string }> = [];
let districtId: string | undefined;
const extraDistrictIds: string[] = [];
let savedSettings: Awaited<ReturnType<typeof readSettings>>;
let savedPolicy: Awaited<ReturnType<typeof readPolicy>>;
let revisionId = "";
let savedRolloutConfig: unknown;
const fakeGeminiKey = `${tag}-gemini-key`, fakeProxyKey = `${tag}-proxy-key`;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, botCanAnswerComments: true, botInstagramEnabled: true, botFacebookEnabled: true, metaEnabled: true,
  metaVerifyToken: true, geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true,
} }); }
async function fixture(text = "Какая комиссия?", channel: "INSTAGRAM" | "FACEBOOK" = "INSTAGRAM", reuse?: {
  accountId: string; resource: string; secret: string; token: string; publication: string; authorId: string; parentId: string;
}, publicationOverride?: string) {
  const accountId = reuse?.accountId ?? randomUUID(), resource = reuse?.resource ?? `${tag}-${accountIds.length}`, secret = reuse?.secret ?? `${tag}-secret-${accountIds.length}`;
  const token = reuse?.token ?? `${tag}-token-${accountIds.length}`, commentId = `${tag}-comment-${sourceIds.length}`, publication = reuse?.publication ?? publicationOverride ?? `${tag}-publication-${sourceIds.length}`;
  if (!reuse) await prisma.messengerAccount.create({ data: { id: accountId, externalId: resource, channel, enabled: true,
    title: "Synthetic common public core", username:`synthetic_public_${accountId.replaceAll("-","")}`,
    token: encryptSecret(token), appSecret: encryptSecret(secret) } });
  if (!reuse) { accountIds.push(accountId); resources.push(resource); } meta.resetMetaAccountCredsCache();
  const installation = await ensurePublicCommentInstallation(channel, resource);
  if (!installation) throw new Error("Actual public endpoint scope unavailable");
  if (!allowedEndpoints.some(value => value.endpointScopeId === installation.installation.id))
    allowedEndpoints.push({ surface: "public_comment", channel, endpointScopeId: installation.installation.id });
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({ version: 1, cohortId,
    candidateRevisionId: revisionId, percentBasisPoints: 10_000, allowed: allowedEndpoints })}::jsonb WHERE "id"='singleton'`;
  const authorId = reuse?.authorId ?? `${tag}-author-${sourceIds.length}`; authors.push(authorId);
  const value = channel === "INSTAGRAM" ? { id: commentId, media: { id: publication }, from: { id: authorId }, text,
    ...(reuse ? { parent_id: reuse.parentId } : {}) }
    : { item: "comment", verb: "add", comment_id: commentId, post_id: publication, from: { id: authorId }, message: text,
      ...(reuse ? { parent_id: reuse.parentId } : {}) };
  const rawBody = Buffer.from(JSON.stringify({ object: channel === "INSTAGRAM" ? "instagram" : "page",
    entry: [{ id: resource, changes: [{ field: channel === "INSTAGRAM" ? "comments" : "feed", value }] }] }));
  const request = { rawBody, get: (name: string) => name === "x-hub-signature-256"
    ? `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` : undefined };
  registerAuthenticatedMetaCustomerRequest(request);
  const captured = await persistVerifiedMetaPublicCommentBatch(request);
  expect(captured.status, JSON.stringify(captured)).toBe("persisted");
  if (captured.status !== "persisted" || captured.sources.length !== 1) throw new Error("Actual signed comment capture failed");
  const ref = captured.sources[0]; sourceIds.push(ref.id);
  const source = await readPublicSourceRow(ref); if (!source) throw new Error("Captured source missing");
  const origin = publicCommentOrigin(source);
  expect(origin.agentPin.agentRevisionId).toBe(revisionId);
  expect(origin.proof.installation.resourceId).toBe(resource);
  // Same existing queue claim, not source proof or a new permission.
  const row = await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } });
  const claimed = await prisma.instagramComment.updateMany({ where: { id: row.id, status: "PENDING", updatedAt: row.updatedAt },
    data: { status: "WORKING", attempts: { increment: 1 } } });
  expect(claimed.count).toBe(1);
  return { ref, accountId, resource, secret, token, commentId, publication,
    row: await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Script = { call: { name: string; args: unknown } } | { decision: unknown };
function wire(f: Fixture, script: Script[], options: { missingMid?: boolean; narration?: boolean; beforeFinal?: () => Promise<void>;
  publicationMeta?: { id: string; permalink: string }; afterMetadata?: () => Promise<void> } = {}) {
  let counts = 0, generations = 0, unexpected = 0, metadataReads = 0;
  const posts: Array<{ path: string; text: string }> = [], modelBodies: string[] = [];
  const fetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    const headers = new Headers(init?.headers);
    if (url.origin === "https://synthetic-public-model.invalid" && init?.method === "POST" &&
        url.pathname === "/gemini/v1beta/models/gemini-3.6-flash:countTokens") {
      expect(headers.get("x-proxy-key")).toBe(fakeProxyKey); expect(headers.get("x-goog-api-key")).toBe(fakeGeminiKey); counts++;
      const body = JSON.parse(String(init.body)); expect(body.generateContentRequest.model).toBe("models/gemini-3.6-flash");
      return new Response(JSON.stringify({ totalTokens: 1000 }));
    }
    if (url.origin === "https://synthetic-public-model.invalid" && init?.method === "POST" &&
        url.pathname === "/gemini/v1beta/models/gemini-3.6-flash:generateContent") {
      expect(headers.get("x-proxy-key")).toBe(fakeProxyKey);
      modelBodies.push(String(init.body));
      const body = JSON.parse(String(init.body));
      expect(body.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name).sort()).toEqual([
        "get_agency_contact", "get_company_information", "get_company_policy", "get_property_facts", "search_public_properties",
      ]);
      expect(String(init.body)).not.toContain(f.accountId); expect(String(init.body)).not.toContain(f.token);
      const step = script[generations++]; if (!step) throw new Error("Unexpected additional generation");
      if ("decision" in step) await options.beforeFinal?.();
      const parts = "call" in step ? [...(options.narration ? [{ text: "Проверю данные", thoughtSignature: "synthetic-signature" }] : []), { functionCall: { ...step.call, id: `synthetic-call-${generations}` } }]
        : [{ text: JSON.stringify(step.decision) }];
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
    }
    const expectedGraph = f.row.channel === "INSTAGRAM" ? "https://synthetic-public-graph.invalid" : "https://graph.facebook.com";
    if (url.origin === expectedGraph && url.pathname === `/v23.0/${f.publication}` && init?.method === "GET" && url.searchParams.get("fields") === "id,permalink") {
      expect(url.searchParams.get("access_token")).toBe(f.token); metadataReads++;
      await options.afterMetadata?.();
      return new Response(JSON.stringify(options.publicationMeta ?? { error: { code: 100 } }), { status: options.publicationMeta ? 200 : 400 });
    }
    const expectedPath = `/v23.0/${f.commentId}/${f.row.channel === "INSTAGRAM" ? "replies" : "comments"}`;
    if (url.origin === expectedGraph && url.pathname === expectedPath && init?.method === "POST") {
      if (f.row.channel === "INSTAGRAM") expect(url.searchParams.get("access_token")).toBe(f.token);
      else expect(headers.get("Authorization")).toBe(`Bearer ${f.token}`);
      const physical = JSON.parse(String(init.body)); expect(Object.keys(physical)).toEqual(["message"]);
      const text: string = physical.message; expect(text).toBeTruthy();
      posts.push({ path: url.pathname, text: text! });
      return new Response(JSON.stringify(options.missingMid ? { success: true } : { id: `${tag}-accepted-${f.ref.id}` }));
    }
    unexpected++; throw new Error("Unexpected synthetic provider origin/path/method; original fetch never called");
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, posts, modelBodies, metadataReads: () => metadataReads, stats: () => ({ counts, generations, unexpected }) };
}
const reply = { kind: "reply", refs: ["e0"], social: "none", question: "none" };
const commission: Script[] = [{ call: { name: "get_company_policy", args: { topic: "commission" } } }, { decision: reply }];
async function handle(f: Fixture) { return handleComment(await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } })); }
async function part(f: Fixture) { return prisma.customerOutboxPart.findFirstOrThrow({ where: { sourceKey: `meta:${f.ref.id}`, sourceKind: "PUBLIC_COMMENT_REPLY" } }); }
beforeAll(async () => {
  savedSettings = await readSettings(); savedPolicy = await readPolicy();
  const [saved] = await prisma.$queryRaw<Array<{ rolloutConfig: unknown }>>`SELECT "rolloutConfig" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  savedRolloutConfig = saved.rolloutConfig;
  vi.stubEnv("GEMINI_PROXY_URL", "https://synthetic-public-model.invalid"); vi.stubEnv("GEMINI_PROXY_KEY", fakeProxyKey);
  vi.stubEnv("IG_PROXY_URL", "https://synthetic-public-graph.invalid"); vi.stubEnv("IG_PROXY_KEY", fakeProxyKey);
  vi.stubEnv("GEMINI_API_KEY", ""); vi.stubEnv("GEMINI_API_KEY_2", "");
  const revision = await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot()); revisionId = revision.id;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botCanAnswerComments: true,
    botInstagramEnabled: true, botFacebookEnabled: true, metaEnabled: true, metaVerifyToken: encryptSecret(`${tag}-verify`),
    geminiApiKey: encryptSecret(fakeGeminiKey), geminiApiKey2: null, geminiApiKeysExtra: [] } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: "scoped", rolloutMode: "ACTIVE", capabilities: { publicRead: true }, activeAgentRevisionId: revisionId } });
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({ version: 1, cohortId,
    candidateRevisionId: revisionId, percentBasisPoints: 10_000, allowed: [] })}::jsonb WHERE "id"='singleton'`;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); meta.resetMetaAccountCredsCache(); });
afterAll(async () => {
  try {
    await prisma.backgroundJob.deleteMany({where:{dedupeKey:{in:dmEvents.map(key=>`customer-inbox-consume:${key}`)}}});
    await prisma.customerPropertyIngressTicket.deleteMany({where:{eventKey:{in:dmEvents}}});
    await prisma.botConversation.deleteMany({where:{id:{in:dmConversations}}});
    await prisma.customerInquiry.deleteMany({where:{endpointScopeId:{in:dmScopes}}});
    await prisma.outboundShieldState.deleteMany({where:{endpointScopeId:{in:dmScopes}}});
    await prisma.customerEndpointScope.deleteMany({where:{id:{in:dmScopes}}});
    await prisma.customerPublicEffect.deleteMany({ where: { sourceId: { in: sourceIds } } });
    const rows = await prisma.customerOutboxPart.findMany({ where: { sourceKey: { in: sourceIds.map(id => `meta:${id}`) } }, select: { id: true } });
    const ids = rows.map(row => row.id);
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: ids.map(id => `customer-outbox-dispatch:${id}`) } } });
    await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: ids } } });
    await prisma.customerOutboxPart.deleteMany({ where: { id: { in: ids } } });
    await prisma.instagramComment.deleteMany({ where: { id: { in: sourceIds } } });
    await prisma.customerEndpointScope.deleteMany({ where: { realmKey: "customer-public", publicResourceId: { in: resources } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.aiBudgetCounter.deleteMany({ where: { channel: { in: ["INSTAGRAM_COMMENTS", "FACEBOOK_COMMENTS"] }, peerId: { in: authors } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
    await prisma.district.deleteMany({ where: { id: { in: extraDistrictIds } } });
  } finally {
    if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
    if (savedPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: savedPolicy });
    if (savedRolloutConfig === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
    else if (savedRolloutConfig !== undefined) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(savedRolloutConfig)}::jsonb WHERE "id"='singleton'`;
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); meta.resetMetaAccountCredsCache();
  }
  // Actual immutable revision/archive and provider audit rows intentionally retained.
});

it.each(["INSTAGRAM", "FACEBOOK"] as const)("%s: actual signed/core/count/company witness/P12 receipt, zero legacy/DM", async channel => {
  const f = await fixture("Какая комиссия?", channel), w = wire(f, commission);
  const accountLookup = vi.spyOn(accountsModule, "resolveIncomingAccount");
  const legacyModel = vi.spyOn(legacyAi, "callAiText");
  expect(await handle(f)).toBe("replied");
  expect(w.stats()).toEqual({ counts: 2, generations: 2, unexpected: 0 }); expect(w.posts).toHaveLength(1);
  const peer = await loadPeerAiBudget(`${f.row.channel}_COMMENTS`, f.row.authorId, null);
  expect(peer.row.aiTurnsToday).toBe(1); expect(peer.budget.known).toBe(false);
  expect(w.posts[0].text).toMatch(/2\s*%/); expect(w.posts[0].text).not.toMatch(/WhatsApp|записал|сохранил/iu);
  const p = await part(f); expect(p).toMatchObject({ agentRevisionId: revisionId, status: "ACCEPTED", inquiryId: null, conversationId: null });
  expect(decodeCustomerOutboxPayload(p)).toEqual({ kind: "text", text: w.posts[0].text });
  expect(decodeCustomerOutboxPublicData(p)).toMatchObject({ agentRevisionId: revisionId, observations: [{ kind: "company_policy", topic: "commission" }] });
  expect(await prisma.customerDeliveryAttempt.count({ where: { partId: p.id, outcome: "ACCEPTED", providerMid: `${tag}-accepted-${f.ref.id}` } })).toBe(1);
  expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } })).status).toBe("REPLIED");
  expect(accountLookup).not.toHaveBeenCalled(); expect(legacyModel).not.toHaveBeenCalled();
  expect(await prisma.botConversation.count({ where: { accountId: f.accountId } })).toBe(0);
});
it("actual publication-mapped price is useful, private street and CRM ID never reach model/wire", async () => {
  const f = await fixture("Какая цена?");
  const district = await prisma.district.create({ data: { name: `${tag}-district`, city: "Душанбе" } }); districtId = district.id;
  const property = await prisma.property.create({ data: { title: "Synthetic public core property", type: "APARTMENT", rooms: 2,
    districtId: district.id, areaSqm: 65, price: 500000, currency: "TJS", condition: "GOOD", status: "AVAILABLE",
    publishedOnSite: true, address: "PRIVATE PUBLIC CORE STREET SENTINEL", publishedPostIds: { INSTAGRAM: f.publication } } });
  propertyIds.push(property.id);
  // Core pre-read supplies mandatory facts even when the model omits all refs.
  const w = wire(f, [{ decision: { ...reply, refs: [] } }]);
  expect(await handle(f)).toBe("replied"); expect(w.posts).toHaveLength(1);
  expect(w.posts[0].text.replace(/[\u00a0\u202f ]/g, "")).toContain("500000");
  for (const text of [...w.modelBodies, ...w.posts.map(post => post.text)]) {
    expect(text).not.toContain(property.id); expect(text).not.toContain(property.address);
  }
  expect(w.stats()).toEqual({ counts: 1, generations: 1, unexpected: 0 });
  expect(decodeCustomerOutboxPublicData(await part(f))).toMatchObject({ observations: [
    { kind: "publication_properties", cards: [{ propertyId: property.id }] },
  ] });
});
it("actual publication-mapped floor answers the question without phone, private address or an unrelated questionnaire", async () => {
  const f=await fixture("Какой этаж?");
  const property=await prisma.property.create({data:{title:"Synthetic structured facts",type:"APARTMENT",rooms:2,
    areaSqm:64.5,price:500000,currency:"TJS",condition:"GOOD",status:"AVAILABLE",publishedOnSite:true,
    floor:5,totalFloors:9,address:"PRIVATE FLOOR ADDRESS SENTINEL",publishedPostIds:{INSTAGRAM:f.publication}}});propertyIds.push(property.id);
  const w=wire(f,[{decision:{...reply,refs:[]}}]);
  expect(await handle(f)).toBe("replied");expect(w.posts).toHaveLength(1);
  expect(w.posts[0].text).toContain("5 из 9");
  expect(w.posts[0].text).not.toMatch(/телефон|Площадь|Комнат|PRIVATE FLOOR|650 14/);
  expect((await part(f)).status).toBe("ACCEPTED");
});
it("a published repost resolves generic details before asking for an object or phone", async () => {
  const f = await fixture("Можно подробнее?");
  const p = await prisma.property.create({ data: { title: "Synthetic repost", type: "APARTMENT", rooms: 2, areaSqm: 60,
    price: 321000, currency: "TJS", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true } }); propertyIds.push(p.id);
  await prisma.propertySocialRepost.create({ data: { propertyId: p.id, round: 1, hook: "Synthetic", channel: "INSTAGRAM", status: "PUBLISHED", mediaId: f.publication } });
  const w = wire(f, [{ decision: { ...reply, refs: [] } }]);
  expect(await handle(f)).toBe("replied"); expect(w.posts[0].text).toContain("321 000");
  expect(w.posts[0].text).not.toMatch(/номер телефона|Какой объект/);
  expect((await part(f)).status).toBe("ACCEPTED");
});
async function manualPublication(text = "Можно подробнее?") {
  const publicationId = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 20)}`).toString();
  const f = await fixture(text, "INSTAGRAM", undefined, publicationId), code = randomUUID().replaceAll("-", "");
  const permalink = `https://www.instagram.com/reel/${code}/?igsh=synthetic`;
  const p = await prisma.property.create({ data: { title: "Synthetic manually published apartment", type: "APARTMENT", rooms: 2,
    areaSqm: 65, price: 678000, currency: "TJS", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true,
    instagramUrl: permalink, address: "PRIVATE MANUAL POST ADDRESS" } }); propertyIds.push(p.id);
  return { f, p, code, permalink };
}
it("own verified media metadata resolves a manually published reel through its exact permalink, once per turn", async () => {
  const { f, p, code, permalink } = await manualPublication();
  const w = wire(f, [{ decision: { ...reply, refs: [] } }], { publicationMeta: { id: f.publication, permalink } });
  expect(await handle(f)).toBe("replied"); expect(w.metadataReads()).toBe(1); expect(w.posts[0].text).toContain("678 000");
  expect(w.posts[0].text).not.toMatch(/PRIVATE|Какой объект|телефон/); expect(w.stats().unexpected).toBe(0);
  const evidence = decodeCustomerOutboxPublicData(await part(f));
  expect(evidence?.observations[0]).toMatchObject({ kind: "publication_properties", source: { publicationId: f.publication,
    permalink: `https://www.instagram.com/p/${code}/` }, cards: [{ propertyId: p.id }] });
  expect((await part(f)).status).toBe("ACCEPTED");
  for (const body of w.modelBodies) { expect(body).not.toContain(f.publication); expect(body).not.toContain(permalink); expect(body).not.toContain(p.id); }
});
it("the observed cheaper-buying comment has current-post context before the first model turn, not a request for its link", async () => {
  const { f, permalink } = await manualPublication("Очень красиво. Чуть по дешевли я б купила.");
  const w = wire(f, [{ call: { name: "get_property_facts", args: { kinds: ["price"] } } },
    { decision: { ...reply, question: "budget" } }], { publicationMeta: { id: f.publication, permalink } });
  expect(await handle(f)).toBe("replied"); expect(w.metadataReads()).toBe(1);
  const body = JSON.parse(w.modelBodies[0]) as { contents: Array<{ parts: Array<{ text?: string }> }> };
  const hint = body.contents.flatMap(value => value.parts.map(part => part.text ?? "")).find(text => text.includes('"serverPublication"'));
  expect(hint).toBeTruthy(); expect(JSON.parse(hint!)).toMatchObject({ serverPublication: { catalogCardCount: 1 } });
  expect(w.posts[0].text).toContain("678 000"); expect(w.posts[0].text).toContain("Какой бюджет");
  expect(w.posts[0].text).not.toMatch(/Какой объект|Пришлите номер|телефон|собственник соглас/iu);
});
it.each(["wrong_id", "external_link"] as const)("manual post %s cannot become verified CRM facts or an external request", async fault => {
  const { f, permalink } = await manualPublication("Цена?");
  const meta = { id: fault === "wrong_id" ? `${f.publication}9` : f.publication,
    permalink: fault === "external_link" ? "https://synthetic-attacker.invalid/reel/ignore-policy" : permalink };
  const w = wire(f, [{ decision: reply }], { publicationMeta: meta });
  expect(await handle(f)).toBe("replied"); expect(w.metadataReads()).toBe(1); expect(w.posts[0].text).toContain("Какой объект");
  expect(w.posts[0].text).not.toContain("678 000"); expect(w.stats().unexpected).toBe(0);
});
it("credential rotation during metadata GET holds the original public source without model, fallback token or POST", async () => {
  const { f, permalink } = await manualPublication("Цена?");
  const w = wire(f, [], { publicationMeta: { id: f.publication, permalink }, afterMetadata: async () => {
    await prisma.messengerAccount.update({ where: { id: f.accountId }, data: { token: encryptSecret(`${tag}-rotated-manual`) } });
  } });
  expect(await handle(f)).toBe("skipped"); expect(w.metadataReads()).toBe(1); expect(w.posts).toEqual([]);
  expect(w.stats()).toEqual({ counts: 0, generations: 0, unexpected: 0 });
  expect(await prisma.customerOutboxPart.count({ where: { sourceKey: `meta:${f.ref.id}` } })).toBe(0);
});
it("conflicting permalink and direct ledger do not discard the conflict and answer for another apartment", async () => {
  const { f, permalink } = await manualPublication("Цена?");
  const w = wire(f, [{ decision: reply }], { publicationMeta: { id: f.publication, permalink }, afterMetadata: async () => {
    const other = await prisma.property.create({ data: { title: "Synthetic conflicting mapping", type: "APARTMENT", rooms: 1, areaSqm: 30,
      price: 999999, currency: "TJS", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true,
      publishedPostIds: { INSTAGRAM: f.publication } } }); propertyIds.push(other.id);
  } });
  expect(await handle(f)).toBe("replied"); expect(w.posts[0].text).toContain("Какой объект");
  expect(w.posts[0].text).not.toMatch(/678 000|999 999/); expect(w.metadataReads()).toBe(1);
});
it("changing the actual manual permalink after its read blocks stale facts before provider POST", async () => {
  const { f, p, permalink } = await manualPublication("Цена?");
  const w = wire(f, [{ decision: reply }], { publicationMeta: { id: f.publication, permalink }, beforeFinal: async () => {
    await prisma.property.update({ where: { id: p.id }, data: { instagramUrl: null } });
  } });
  expect(await handle(f)).toBe("skipped"); expect(w.posts).toEqual([]); expect(w.metadataReads()).toBe(1);
});
it("a genuine post digest returns current cards through public witness and accepted provider receipt", async () => {
  const f = await fixture("Какие цены?");
  const properties = [];
  for (const price of [410000, 520000]) {
    const p = await prisma.property.create({ data: { title: "Synthetic digest", type: "APARTMENT", rooms: 2, areaSqm: 60,
      price, currency: "TJS", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true } }); propertyIds.push(p.id); properties.push(p.id);
  }
  const digest = await prisma.socialDigestPost.create({ data: { kind: "ROOMS", title: "Synthetic", propertyIds: properties,
    channel: "INSTAGRAM", status: "PUBLISHED", mediaId: f.publication } });
  try {
    const w = wire(f, [{ decision: reply }]);
    expect(await handle(f)).toBe("replied"); expect(w.posts[0].text).toContain("410 000"); expect(w.posts[0].text).toContain("520 000");
    expect((await part(f)).status).toBe("ACCEPTED");
    expect(decodeCustomerOutboxPublicData(await part(f))?.observations[0].kind).toBe("publication_properties");
  } finally { await prisma.socialDigestPost.delete({ where: { id: digest.id } }); }
});
it("public continuation reads only a genuine same-author ancestor with accepted reply", async () => {
  const parent = await fixture("Какая комиссия?"); wire(parent, commission); expect(await handle(parent)).toBe("replied");
  const stored = await prisma.instagramComment.findUniqueOrThrow({ where: { id: parent.ref.id } });
  const child = await fixture("Поясните", "INSTAGRAM", { ...parent, authorId: parent.row.authorId, parentId: stored.replyCommentId! });
  const w = wire(child, commission);
  expect(await handle(child)).toBe("replied"); expect(w.modelBodies[0]).toContain("Какая комиссия?"); expect(w.modelBodies[0]).toContain("Комиссия для продавца");
  const stranger = await fixture("Поясните", "INSTAGRAM", { ...parent, authorId: `${tag}-stranger`, parentId: stored.replyCommentId! });
  const otherWire = wire(stranger, commission); expect(await handle(stranger)).toBe("replied");
  expect(otherWire.modelBodies[0]).not.toContain("Какая комиссия?"); expect(otherWire.modelBodies[0]).not.toContain("Комиссия для продавца");
  await prisma.instagramComment.update({ where: { id: parent.ref.id }, data: { text: "Edited parent must not be memory" } });
  const edited = await fixture("Поясните", "INSTAGRAM", { ...parent, authorId: parent.row.authorId, parentId: stored.replyCommentId! });
  const editedWire = wire(edited, commission); expect(await handle(edited)).toBe("replied");
  expect(editedWire.modelBodies[0]).not.toContain("Edited parent must not be memory");
  expect(editedWire.modelBodies[0]).not.toContain("Какая комиссия?");
});
it("public next collection excludes only actual accepted replies to the same author and publication", async () => {
  const f = await fixture("Покажите квартиры");
  const district = await prisma.district.create({ data: { name: `synthetic-next-${randomUUID()}`, city: "Душанбе" } }); extraDistrictIds.push(district.id);
  for (let i = 0; i < 4; i++) {
    const p = await prisma.property.create({ data: { title: "Synthetic public next card", districtId: district.id, type: "APARTMENT", rooms: 2,
      areaSqm: 60, price: 500000, currency: "TJS", status: "AVAILABLE", condition: "GOOD", publishedOnSite: true } }); propertyIds.push(p.id);
  }
  const args = { type: "APARTMENT", districtName: district.name };
  const first = wire(f, [{ call: { name: "search_public_properties", args } }, { decision: reply }]);
  expect(await handle(f)).toBe("replied"); expect(first.posts).toHaveLength(1);
  const row = await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } });
  const child = await fixture("Ещё варианты", "INSTAGRAM", { ...f, authorId: f.row.authorId, parentId: row.replyCommentId! });
  wire(child, [{ call: { name: "search_public_properties", args: { ...args, nextPage: true } } }, { decision: reply }]);
  expect(await handle(child)).toBe("replied");
  const before = decodeCustomerOutboxPublicData(await part(f))?.observations[0];
  const next = decodeCustomerOutboxPublicData(await part(child))?.observations[0];
  expect(before?.kind === "property_search" && before.cards.length).toBe(3);
  expect(next?.kind === "property_search" && next.cards.length).toBe(1);
  if (before?.kind === "property_search" && next?.kind === "property_search") expect(before.cards.map(card => card.facts.shortId)).not.toContain(next.cards[0].facts.shortId);
});
it("changing the actual floor after a read blocks stale facts before physical publication", async () => {
  const f=await fixture("Этаж?");
  const property=await prisma.property.create({data:{title:"Synthetic changing facts",type:"APARTMENT",rooms:2,
    areaSqm:64.5,price:500000,currency:"TJS",condition:"GOOD",status:"AVAILABLE",publishedOnSite:true,
    floor:5,totalFloors:9,publishedPostIds:{INSTAGRAM:f.publication}}});propertyIds.push(property.id);
  const w=wire(f,[{decision:reply}],{beforeFinal:async()=>{await prisma.property.update({where:{id:property.id},data:{floor:6}});}});
  expect(await handle(f)).toBe("skipped");expect(w.posts).toHaveLength(0);
  expect(await prisma.customerOutboxPart.count({where:{sourceKey:`meta:${f.ref.id}`}})).toBe(0);
});
it("actual skip and moderation proposal use fresh scoped terminal CAS without Graph moderation", async () => {
  for (const decision of [{ kind: "skip", reason: "no_reply_needed" }, { kind: "moderation_proposal", action: "delete", reason: "spam" }]) {
    const f = await fixture("Synthetic public branch"), w = wire(f, [{ decision }]);
    expect(await handle(f)).toBe(decision.kind === "skip" ? "skipped" : "escalated");
    const row = await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } });
    expect(row.status).toBe(decision.kind === "skip" ? "SKIPPED" : "ESCALATED"); expect(row.status).not.toBe("DELETED");
    expect(row.replyCommentId).toBeNull(); expect(row.repliedAt).toBeNull(); expect(w.posts).toHaveLength(0);
    expect(w.stats()).toEqual({ counts: 1, generations: 1, unexpected: 0 });
    expect(await prisma.customerOutboxPart.count({ where: { sourceKey: `meta:${f.ref.id}` } })).toBe(0);
  }
});

const sellerAdvert = "Продаю квартиру 2 комнаты, 65 м2, цена 650000 сомони, +992987654321";
function moderationWire(f: Fixture, fault: "none" | "unknown_dm" | "false_hide" | "changed_during_hide" | "invalid_dm_mid" = "none") {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    expect(url.origin).toBe("https://synthetic-public-graph.invalid");
    expect(url.searchParams.get("access_token")).toBe(f.token);
    if(init?.method==="GET" && url.searchParams.get("fields")==="username") {
      return new Response(JSON.stringify({id:url.pathname.split("/").at(-1),username:"synthetic_private_customer"}));
    }
    if (url.pathname === `/v23.0/${f.commentId}` && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({ hide: true }); calls.push("hide");
      if (fault === "changed_during_hide") await prisma.settings.update({ where: { id: "singleton" }, data: { botCanAnswerComments: false } });
      return new Response(JSON.stringify({ success: fault !== "false_hide" }));
    }
    if (url.pathname === "/v23.0/me/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.recipient).toEqual({ comment_id: f.commentId });
      expect(body.message.text).toContain("Royal Home"); expect(body.message.text).not.toMatch(/987654321|покупател|передал|сотрудник/iu);
      calls.push("private_reply");
      if (fault === "unknown_dm") throw new Error("Synthetic lost provider response after POST");
      return new Response(JSON.stringify({ message_id: fault === "invalid_dm_mid" ? " " : `synthetic-owner-${f.ref.id}`,recipient_id:`native-dm-${f.ref.id}` }));
    }
    if (url.pathname === `/v23.0/${f.commentId}` && init?.method === "DELETE") {
      calls.push("delete"); return new Response(JSON.stringify({ success: true }));
    }
    throw new Error("Unexpected wire: model or other target is forbidden");
  }));
  return calls;
}
it.each([sellerAdvert,`Хавлии фуруши дорем дар поени корвон каседа даркор нависа е занг зана ${'+9929'+'0'.repeat(8)}`])("uses signed CORE origin: hide, one accepted private reply, delete; records actual immutable receipts and no CRM handover: %s", async text => {
  const f = await fixture(text), calls = moderationWire(f);
  expect(await handle(f)).toBe("deleted");
  expect(calls).toEqual(["hide", "private_reply", "delete"]);
  const row = await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } });
  expect(row.status).toBe("DELETED"); expect(row.dmSentAt).not.toBeNull(); expect(row.note).toContain("private_reply:accepted");
  const receipts = await prisma.customerPublicEffect.findMany({ where: { sourceId: f.ref.id }, orderBy: { createdAt: "asc" } });
  expect(receipts.map(x => [x.kind,x.status])).toEqual([["hide","ACCEPTED"],["private_reply","ACCEPTED"],["delete","ACCEPTED"]]);
  expect(receipts[1].providerId).toBe(`synthetic-owner-${f.ref.id}`);
  expect(receipts[1].recipientKey).toMatch(/^[a-f0-9]{64}$/);
  expect(receipts[1].payloadEncrypted).not.toContain("Royal Home");
  await expect(prisma.customerPublicEffect.update({ where: { id: receipts[1].id }, data: { status: "IN_FLIGHT", finishedAt: null } })).rejects.toThrow();
  expect(await prisma.customerOutboxPart.count({ where: { sourceKey: `meta:${f.ref.id}` } })).toBe(0);
  expect(await handle(f)).toBe("skipped"); expect(calls).toHaveLength(3);
});
async function signedDmPrincipal(f:Fixture,peer:string):Promise<CustomerPrincipal>;
async function signedDmPrincipal(f:Fixture,peer:string,expectHeld:true):Promise<null>;
async function signedDmPrincipal(f:Fixture,peer:string,expectHeld=false):Promise<CustomerPrincipal|null>{
  const scope=await prisma.$transaction(tx=>ensureCustomerEndpoint(tx,{channel:"INSTAGRAM",subscriberId:peer,accountId:f.accountId,accountExternalId:f.resource}));
  dmScopes.push(scope.endpointScopeId);
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({version:1,cohortId,candidateRevisionId:revisionId,percentBasisPoints:10000,
    allowed:[...allowedEndpoints,{surface:"dm",channel:"INSTAGRAM",endpointScopeId:scope.endpointScopeId}]})}::jsonb WHERE "id"='singleton'`;
  const rawBody=Buffer.from(JSON.stringify({object:"instagram",entry:[{id:f.resource,messaging:[{sender:{id:peer},recipient:{id:f.resource},timestamp:Date.now(),message:{mid:`${tag}-dm-${randomUUID()}`,text:"Сино"}}]}]}));
  const req={rawBody,get:()=>`sha256=${createHmac("sha256",f.secret).update(rawBody).digest("hex")}`};registerAuthenticatedMetaCustomerRequest(req);
  expect(await meta.verifySignature(rawBody,req.get())).toBe(true);
  const captured=await persistVerifiedCustomerIngressBatch(req);
  if(expectHeld){
    // Phase-A global peer collision guard intentionally refuses the same peer
    // on another account. Do not forge a principal to get past that boundary.
    expect(captured).toEqual({status:"unavailable",reason:"routing_held"});return null;
  }
  expect(captured.status,JSON.stringify(captured)).toBe("persisted");if(captured.status!=="persisted")throw Error("Signed DM missing");
  const ticket=captured.tickets[0];dmEvents.push(ticket.eventKey);
  const prepared=await prepareCustomerDmInboxCoreContext(ticket.eventKey);
  expect(prepared.status,JSON.stringify(prepared)).toBe("prepared");if(prepared.status!=="prepared")throw Error(`Signed DM context unavailable:${prepared.status}`);
  dmConversations.push(prepared.lane.ticket.conversationId);
  return prepared.lane.principal;
}
it("outreach memory follows only Meta's returned private recipient, not public author ID or another account",async()=>{
  const f=await fixture(sellerAdvert);moderationWire(f);expect(await handle(f)).toBe("deleted");
  const right=await signedDmPrincipal(f,`native-dm-${f.ref.id}`);
  const effect=await prisma.customerPublicEffect.findFirstOrThrow({where:{sourceId:f.ref.id,kind:"private_reply"}});
  expect(effect.recipientKey).toBe(createHash("sha256").update(JSON.stringify([effect.endpointScopeId,right.scope.peer])).digest("hex"));
  expect(right.visibility).toBe("private_dm");expect(right.assurance).toBe("protected_namespace");
  const memory=await readCustomerPublicOutreachMemory(right);
  const frame=customerPrincipalAuthenticatedInput(right),evidence=frame && inspectAuthenticatedCustomerInput(frame);
  const snapshot=await publicStore.loadPublicCommentSource({table:"meta",id:f.ref.id});
  expect(memory,JSON.stringify({finishedAt:effect.finishedAt,issuedAt:evidence?.issuedAt,sourceRevision:effect.sourceRevision.toString(),proof:snapshot?.proof,
    installation:snapshot?.currentInstallation})).toHaveLength(1);expect(memory[0].text).toContain("В каком районе");
  expect(JSON.stringify(memory)).not.toContain("987654321");
  const wrong=await signedDmPrincipal(f,f.row.authorId);expect(await readCustomerPublicOutreachMemory(wrong)).toEqual([]);
  const other=await fixture();moderationWire(other);
  await signedDmPrincipal(other,`native-dm-${f.ref.id}`,true);
  const foreign=await signedDmPrincipal(other,`other-dm-${f.ref.id}`);
  expect(await readCustomerPublicOutreachMemory(foreign)).toEqual([]);
  expect(await readCustomerPublicOutreachMemory({...right})).toEqual([]);
});
it("UNKNOWN private reply stays hidden, is never resent and never triggers delete or staff fallback", async () => {
  const f = await fixture(sellerAdvert), calls = moderationWire(f,"unknown_dm");
  expect(await handle(f)).toBe("hidden"); expect(calls).toEqual(["hide","private_reply"]);
  expect((await prisma.instagramComment.findUniqueOrThrow({where:{id:f.ref.id}})).status).toBe("HIDDEN");
  expect(await prisma.customerPublicEffect.findFirst({where:{sourceId:f.ref.id,kind:"private_reply"}})).toMatchObject({status:"UNKNOWN",providerId:null});
  await handle(f); expect(calls).toHaveLength(2);
});
it("a blank provider ID cannot authorize delete or appear as a successful personal reply",async()=>{
  const f=await fixture(sellerAdvert),calls=moderationWire(f,"invalid_dm_mid");
  expect(await handle(f)).toBe("hidden");expect(calls).toEqual(["hide","private_reply"]);
  expect(await prisma.customerPublicEffect.findFirst({where:{sourceId:f.ref.id,kind:"private_reply"}})).toMatchObject({status:"UNKNOWN",providerId:null});
  expect((await prisma.instagramComment.findUniqueOrThrow({where:{id:f.ref.id}})).dmSentAt).toBeNull();
});
it("two concurrent handlers for the same source cannot send two personal replies",async()=>{
  const f=await fixture(sellerAdvert),calls=moderationWire(f);
  await Promise.all([handle(f),handle(f)]);
  expect(calls).toEqual(["hide","private_reply","delete"]);
  expect(await prisma.customerPublicEffect.count({where:{sourceId:f.ref.id,kind:"private_reply"}})).toBe(1);
});
it("a recent real legacy private reply blocks another DM without blocking removal",async()=>{
  const f=await fixture(sellerAdvert),calls=moderationWire(f);
  await prisma.instagramComment.update({where:{id:f.ref.id},data:{dmSentAt:new Date()}});
  expect(await handle(f)).toBe("deleted");expect(calls).toEqual(["hide","delete"]);
  expect(await prisma.customerPublicEffect.count({where:{sourceId:f.ref.id,kind:"private_reply"}})).toBe(0);
});
it("the durable author receipt blocks outreach on a second signed comment even if its UI projection was lost",async()=>{
  const f=await fixture(sellerAdvert),firstCalls=moderationWire(f);
  expect(await handle(f)).toBe("deleted");expect(firstCalls).toHaveLength(3);
  await prisma.instagramComment.update({where:{id:f.ref.id},data:{dmSentAt:null}});
  const commentId=`${tag}-second-${randomUUID()}`;
  const rawBody=Buffer.from(JSON.stringify({object:"instagram",entry:[{id:f.resource,changes:[{field:"comments",value:{id:commentId,
    media:{id:f.publication},from:{id:f.row.authorId},text:sellerAdvert}}]}]}));
  const req={rawBody,get:()=>`sha256=${createHmac("sha256",f.secret).update(rawBody).digest("hex")}`};registerAuthenticatedMetaCustomerRequest(req);
  const captured=await persistVerifiedMetaPublicCommentBatch(req);
  expect(captured.status).toBe("persisted");if(captured.status!=="persisted")throw Error("Signed source missing");
  const ref=captured.sources[0];sourceIds.push(ref.id);
  await prisma.instagramComment.update({where:{id:ref.id},data:{status:"WORKING",attempts:1}});
  const second={...f,ref,commentId,row:await prisma.instagramComment.findUniqueOrThrow({where:{id:ref.id}})},calls=moderationWire(second);
  expect(await handle(second)).toBe("deleted");expect(calls).toEqual(["hide","delete"]);
  expect(await prisma.customerPublicEffect.count({where:{sourceId:ref.id,kind:"private_reply"}})).toBe(0);
});
it("provider success:false cannot become hidden/deleted or authorize private outreach", async () => {
  const f=await fixture(sellerAdvert),calls=moderationWire(f,"false_hide");
  await handle(f);expect(calls).toEqual(["hide"]);
  expect((await prisma.instagramComment.findUniqueOrThrow({where:{id:f.ref.id}})).status).toBe("SKIPPED");
  expect(await prisma.customerPublicEffect.findFirst({where:{sourceId:f.ref.id}})).toMatchObject({status:"REFUSED"});
});
it("turning comments off during provider I/O retains the accepted receipt but stops DM/delete and stale UI projection", async () => {
  const f=await fixture(sellerAdvert),calls=moderationWire(f,"changed_during_hide");
  try {
    expect(await handle(f)).toBe("skipped"); expect(calls).toEqual(["hide"]);
    expect(await prisma.customerPublicEffect.findFirst({where:{sourceId:f.ref.id,kind:"hide"}})).toMatchObject({status:"ACCEPTED"});
    expect((await prisma.instagramComment.findUniqueOrThrow({where:{id:f.ref.id}})).status).toBe("WORKING");
  } finally {await prisma.settings.update({where:{id:"singleton"},data:{botCanAnswerComments:true}});}
});
it("actual settings revocation before the physical gate sends zero HTTP requests", async () => {
  const f=await fixture(sellerAdvert),calls=moderationWire(f),real=publicStore.readPublicCommentMetaToken;
  vi.spyOn(publicStore,"readPublicCommentMetaToken").mockImplementationOnce(async stamp=>{
    await prisma.settings.update({where:{id:"singleton"},data:{botCanAnswerComments:false}});return real(stamp);
  });
  try {expect(await handle(f)).toBe("skipped");expect(calls).toEqual([]);}
  finally {await prisma.settings.update({where:{id:"singleton"},data:{botCanAnswerComments:true}});}
});
it("invalid final preserves same-turn verified public policy and sends once, without staff escalation", async () => {
  const f=await fixture(), w=wire(f,[{call:{name:"get_agency_contact",args:{}}},commission[0],{decision:{kind:"wrong",text:"Обещаю вам скидку 99%"}}],{narration:true});
  expect(await handle(f)).toBe("replied"); expect(w.posts).toHaveLength(1);
  expect(w.posts[0].text).toMatch(/2\s*%/); expect(w.posts[0].text).not.toMatch(/99|скидку|сотрудник|передал/iu);
  expect((await part(f)).status).toBe("ACCEPTED");
  expect((await prisma.instagramComment.findUniqueOrThrow({where:{id:f.ref.id}})).status).toBe("REPLIED");
  expect(w.stats()).toEqual({counts:3,generations:3,unexpected:0});
});
it("invalid public final without evidence closes FAILED once, without reply, staff handover or another generation", async () => {
  const f=await fixture("КАДом вариятхо дорен"),w=wire(f,[{decision:{kind:"wrong",text:"PRIVATE synthetic invalid"}}]);
  const before=await prisma.customerAction.count();
  expect(await handle(f)).toBe("skipped"); expect(w.posts).toHaveLength(0);
  const row=await prisma.instagramComment.findUniqueOrThrow({where:{id:f.ref.id}});
  expect(row).toMatchObject({status:"FAILED",note:"managed_core:failed:invalid_model_decision",replyCommentId:null,repliedAt:null});
  expect(row.publicOriginCiphertext).toBe(f.row.publicOriginCiphertext);
  expect(await finishUnsentPublicAgentFailure(f.ref,"invalid_model_decision")).toBe(false);
  expect(await prisma.customerAction.count()).toBe(before);expect(w.stats().generations).toBe(1);
});
it("expired unsent plan is terminal but staff-owned or changed source is never closed", async () => {
  const f=await fixture(), w=wire(f,[]),now=Date.now();
  expect(await finishUnsentPublicAgentFailure(f.ref,"expired")).toBe(false);
  vi.spyOn(Date,"now").mockReturnValue(now+121000);
  try {
    expect(await expireUnsentPublicAgentPlans()).toBeGreaterThanOrEqual(1);
    expect((await prisma.instagramComment.findUniqueOrThrow({where:{id:f.ref.id}})).status).toBe("FAILED");
  } finally {vi.restoreAllMocks();}
  const staff=await fixture();await prisma.instagramComment.update({where:{id:staff.ref.id},data:{status:"WORKING_STAFF"}});
  expect(await finishUnsentPublicAgentFailure(staff.ref,"invalid_model_decision")).toBe(false);
  const edited=await fixture();await prisma.instagramComment.update({where:{id:edited.ref.id},data:{text:"Changed original"}});
  expect(await finishUnsentPublicAgentFailure(edited.ref,"invalid_model_decision")).toBe(false);
  expect(w.posts).toHaveLength(0);
});
it("25 expired UNKNOWN deliveries do not starve an unsent expired plan behind the cleanup bound", async () => {
  const unknown: Fixture[]=[];
  for(let i=0;i<25;i++) {
    const f=await fixture(),w=wire(f,commission,{missingMid:true});
    expect(await handle(f)).toBe("skipped");
    const output=await prisma.customerOutboxPart.findFirst({where:{sourceKey:`meta:${f.ref.id}`}});
    expect(output,JSON.stringify({index:i,stats:w.stats(),source:await prisma.instagramComment.findUnique({where:{id:f.ref.id},select:{status:true,note:true}})})).not.toBeNull();
    expect(output?.status).toBe("UNKNOWN");
    expect(w.posts).toHaveLength(1);unknown.push(f);
  }
  const unsent=await fixture();wire(unsent,[]);
  vi.spyOn(Date,"now").mockReturnValue(Date.now()+121000);
  try {
    expect(await expireUnsentPublicAgentPlans()).toBeGreaterThanOrEqual(1);
    expect((await prisma.instagramComment.findUniqueOrThrow({where:{id:unsent.ref.id}})).status).toBe("FAILED");
    for(const f of unknown) expect((await part(f)).status).toBe("UNKNOWN");
  } finally {vi.restoreAllMocks();}
},60000);
it("unsupported model callback tool cannot create action/contact/native or any public/private OUT", async () => {
  const f = await fixture("Не публикуйте мой номер");
  const before = { actions: await prisma.customerAction.count(), callbacks: await prisma.callbackRequest.count() };
  const forbidden = { name: "request_callback", args: { topic: "Не публикуйте мой номер" } };
  expect(customerAgentToolCallSchema.safeParse(forbidden).success).toBe(true);
  const w = wire(f, [{ call: forbidden }]);
  expect(await handle(f)).toBe("skipped"); expect(w.posts).toHaveLength(0);
  expect(w.stats().unexpected).toBe(0); expect(w.stats().generations).toBe(1);
  expect(await prisma.customerAction.count()).toBe(before.actions); expect(await prisma.callbackRequest.count()).toBe(before.callbacks);
  expect(await prisma.botConversation.count({ where: { accountId: f.accountId } })).toBe(0);
  expect(await prisma.customerOutboxPart.count({ where: { sourceKey: `meta:${f.ref.id}` } })).toBe(0);
});
it("UNKNOWN physical public receipt stays durable and cannot regenerate/repost on same source", async () => {
  const traceEnabled = process.env.BOT_TURN_TRACE_ENABLED, traceKey = process.env.BOT_TURN_TRACE_HMAC_KEY;
  const traces: BotTurnTracePayload[] = [];
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "1"); vi.stubEnv("BOT_TURN_TRACE_HMAC_KEY", `${tag}-trace-only-secret`);
  const record = vi.spyOn(traceStore, "enqueueBotTurnTrace").mockImplementation(value => { traces.push(value); });
  try {
  const f = await fixture(), w = wire(f, commission, { missingMid: true });
  expect(await handle(f)).toBe("skipped"); expect((await part(f)).status).toBe("UNKNOWN");
  expect(await finishUnsentPublicAgentFailure(f.ref,"invalid_model_decision")).toBe(false);
  expect((await part(f)).status).toBe("UNKNOWN");
  expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } })).replyText).toBeNull();
  expect(await handle(f)).toBe("skipped");
  expect(w.stats()).toEqual({ counts: 2, generations: 2, unexpected: 0 }); expect(w.posts).toHaveLength(1);
  const peer = await loadPeerAiBudget(`${f.row.channel}_COMMENTS`, f.row.authorId, null);
  expect(peer.row.aiTurnsToday).toBe(1); expect(peer.budget.known).toBe(false);
  await vi.waitFor(() => expect(traces.some(row => row.completedAt && row.managedDelivery?.status === "unknown")).toBe(true));
  const delivery = traces.find(row => row.completedAt && row.managed?.phase === "delivery")!;
  const planning = traces.find(row => row.completedAt && row.managed?.phase === "planning" && row.customerCore?.status === "ready")!;
  expect(delivery.managedDelivery).toEqual({ status: "unknown", projectionPending: false });
  expect(delivery.traceId).not.toBe(planning.traceId);
  expect(delivery.eventKey).toBe(planning.eventKey);
  expect(delivery.managed?.operationKey).toBe(planning.managed?.operationKey);
  expect(planning.outgoing).toEqual([]);
  expect(planning.modelAttempts).toHaveLength(2);
  for (const privateValue of [f.accountId, f.token, f.ref.id, f.commentId, fakeGeminiKey, f.row.authorId]) {
    expect(JSON.stringify(traces)).not.toContain(privateValue);
  }
  } finally {
    record.mockRestore(); vi.stubEnv("BOT_TURN_TRACE_ENABLED", traceEnabled ?? ""); vi.stubEnv("BOT_TURN_TRACE_HMAC_KEY", traceKey ?? "");
  }
});
it("credential rotation during real generation holds original source before public POST", async () => {
  const f = await fixture(), w = wire(f, commission, { beforeFinal: async () => {
    await prisma.messengerAccount.update({ where: { id: f.accountId }, data: { token: encryptSecret(`${tag}-rotated-token`) } });
  } });
  expect(await handle(f)).toBe("skipped"); expect(w.posts).toHaveLength(0); expect(w.stats().generations).toBe(2);
  expect(w.stats().unexpected).toBe(0); expect(await prisma.customerOutboxPart.count({ where: { sourceKey: `meta:${f.ref.id}` } })).toBe(0);
});
it("stale skip principal cannot close source after exact text/revision edit", async () => {
  const f = await fixture("Synthetic skip"), w = wire(f, [{ decision: { kind: "skip", reason: "no_reply_needed" } }]);
  const draft = await prepareCustomerPublicAgentDraft(f.ref);
  expect(draft.status).toBe("skip"); if (draft.status !== "skip") throw new Error("Actual skip unavailable");
  await prisma.instagramComment.update({ where: { id: f.ref.id }, data: { text: "Synthetic revised question" } });
  const edited = await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } });
  expect(await finishPublicAgentDecision(draft.principal, { kind: "skip", reason: "no_reply_needed" })).toBe(false);
  expect(await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } })).toEqual(edited);
  expect(w.posts).toHaveLength(0); expect(w.stats().unexpected).toBe(0);
});
it("retained managed origin after OFF never enters legacy account/model/funnel", async () => {
  const f = await fixture(), w = wire(f, []), lookup = vi.spyOn(accountsModule, "resolveIncomingAccount"), legacy = vi.spyOn(legacyAi, "callAiText");
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
  try { expect(await handle(f)).toBe("skipped"); expect(w.fetch).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); }
  finally { await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "ACTIVE" } }); }
});

it.each([false, true])("public phone question keeps commission; agency phone only on explicit customer request=%s", async requested => {
  const f = await fixture(requested ? "Какая комиссия и ваш номер телефона?" : "Какая комиссия?"), w = wire(f, [commission[0], { decision: { ...reply, question: "phone" } }]);
  expect(await handle(f)).toBe("replied"); expect(w.posts).toHaveLength(1);
  expect(w.posts[0].text).toMatch(/2\s*%/);
  if (requested) expect(w.posts[0].text).toContain(PUBLIC_AGENCY_CONTACT.phone);
  else expect(w.posts[0].text).not.toContain(PUBLIC_AGENCY_CONTACT.phone);
  expect(w.posts[0].text).not.toMatch(/ваш.*номер|номератон|WhatsApp/iu);
  expect(w.stats()).toEqual({ counts: 2, generations: 2, unexpected: 0 });
});
it.each(["👍👍👍👍👍👍👍🔥🔥🔥🔥🔥🔥🔥", "🔥🔥👏", "Раҳмат ❤️", "Беҳтарин хона бдай 👏👏", "Зебо бдай 🔥"])("real public pipeline thanks for %s, seals and delivers once without Gemini/legacy/handover", async text => {
  const f = await fixture(text), w = wire(f, []), legacy = vi.spyOn(legacyAi, "callAiText");
  const outcome = await handle(f);
  const disposition = outcome === "replied" ? null : await prisma.instagramComment.findUniqueOrThrow({
    where: { id: f.ref.id }, select: { status: true, note: true, attempts: true } });
  expect(outcome, JSON.stringify(disposition)).toBe("replied");
  expect(w.stats()).toEqual({ counts: 0, generations: 0, unexpected: 0 });
  expect(w.posts).toHaveLength(1); expect(legacy).not.toHaveBeenCalled();
  expect(w.posts[0].text).toMatch(/Спасибо|Благодарим|Ташаккур|Раҳмат/u);
  if (text === "Раҳмат ❤️") expect(w.posts[0].text).toMatch(/Ташаккур|Раҳмат/u);
  expect(w.posts[0].text).not.toMatch(/992|позвон|Понял|Фаҳмидам|рақам/iu);
  expect((await part(f)).status).toBe("ACCEPTED");
  const row = await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } });
  expect(row.status).toBe("REPLIED"); expect(row.replyText).toBe(w.posts[0].text); expect(row.replyCommentId).toBeTruthy();
  expect(await handle(f)).toBe("skipped"); expect(w.posts).toHaveLength(1);
});
it.each(['Кимат','@synthetic_reader безеб','Ика бардакай'])('real public pipeline answers a criticism in Tajik without model, card dump or phone: %s',async text=>{
  const f=await fixture(text),w=wire(f,[]);
  expect(await handle(f)).toBe('replied');
  expect(w.stats()).toEqual({counts:0,generations:0,unexpected:0});
  expect(w.posts).toHaveLength(1);expect(w.posts[0].text).toMatch(/Кадом|Фаҳмидам/u);
  expect(w.posts[0].text).not.toMatch(/992|Нархи объект|сохтмон/u);
  expect((await part(f)).status).toBe('ACCEPTED');
});
it("public company witness is rechecked after seal at actual beforePOST, never silently dropped", async () => {
  const f = await fixture(), w = wire(f, commission), load = meta.loadCredentials;
  const prior = Object.getOwnPropertyDescriptor(AGENCY_FACTS.commission, "sellerPercent")!;
  vi.spyOn(meta, "loadCredentials").mockImplementationOnce(async () => {
    Object.defineProperty(AGENCY_FACTS.commission, "sellerPercent", { ...prior, value: Number(prior.value) + 1 });
    return load();
  });
  try {
    expect(await handle(f)).toBe("skipped"); expect(w.posts).toHaveLength(0); expect(w.stats().unexpected).toBe(0);
    expect(w.stats().generations).toBe(2);
    const p = await part(f); expect(p.status).not.toBe("ACCEPTED");
    expect(decodeCustomerOutboxPublicData(p)?.observations).toMatchObject([{ kind: "company_policy", topic: "commission" }]);
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } })).status).not.toBe("REPLIED");
  } finally { Object.defineProperty(AGENCY_FACTS.commission, "sellerPercent", prior); }
});
it("exhausted real author budget blocks first count/generation/OUT without granting known-client allowance", async () => {
  const f = await fixture(), w = wire(f, []);
  const peer = await loadPeerAiBudget("INSTAGRAM_COMMENTS", f.row.authorId, null);
  const cap = AI_TURNS_PER_DAY_STRANGER * AI_HARD_LIMIT_MULTIPLIER;
  await prisma.aiBudgetCounter.update({ where: { id: peer.row.id }, data: { aiBudgetDate: peer.budget.dayKey, aiTurnsToday: cap } });
  expect(await handle(f)).toBe("skipped"); expect(w.fetch).not.toHaveBeenCalled();
  expect((await loadPeerAiBudget("INSTAGRAM_COMMENTS", f.row.authorId, null)).row.aiTurnsToday).toBe(cap);
  expect(await prisma.customerOutboxPart.count({ where: { sourceKey: `meta:${f.ref.id}` } })).toBe(0);
});
it("last permitted author turn keeps both model rounds and useful reply, spends exactly once", async () => {
  const f = await fixture(), w = wire(f, commission);
  const peer = await loadPeerAiBudget("INSTAGRAM_COMMENTS", f.row.authorId, null);
  const cap = AI_TURNS_PER_DAY_STRANGER * AI_HARD_LIMIT_MULTIPLIER;
  await prisma.aiBudgetCounter.update({ where: { id: peer.row.id }, data: { aiBudgetDate: peer.budget.dayKey, aiTurnsToday: cap - 1 } });
  expect(await handle(f)).toBe("replied"); expect(w.posts).toHaveLength(1); expect(w.posts[0].text).toMatch(/2\s*%/);
  expect(w.stats()).toEqual({ counts: 2, generations: 2, unexpected: 0 });
  expect((await loadPeerAiBudget("INSTAGRAM_COMMENTS", f.row.authorId, null)).row.aiTurnsToday).toBe(cap);
});
it.each(["ACTIVE", "SHADOW", "OFF"] as const)("older NULL-origin queued row remains legacy under %s, missing row stays managed-held", async mode => {
  const own = `${tag}-old-${mode}`;
  const row = await prisma.instagramComment.create({ data: { channel: "INSTAGRAM", commentId: own, mediaId: own,
    authorId: own, text: "Synthetic older queued comment", status: "PENDING", replyDueAt: new Date() } }); sourceIds.push(row.id);
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: mode } });
  try {
    expect(await publicAgentCommentLane(row.id)).toBe("legacy");
    expect(await publicAgentCommentLane(`${tag}-missing`)).toBe("managed");
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id } })).publicOriginCiphertext).toBeNull();
  } finally { await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "ACTIVE" } }); }
});
