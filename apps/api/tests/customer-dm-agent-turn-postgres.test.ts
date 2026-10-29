import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import dns from "node:dns/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch, consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { runCustomerDmAgentTurn, customerVoiceTriggerForCurrentInput } from "../src/lib/customerDmAgentTurn.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "../src/lib/customerOutbox.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { customerPropertyRegistry } from "../src/lib/customerPropertyRegistry.js";
import * as ttsModule from "../src/ai/tts.js";
import * as audioTranscodeModule from "../src/lib/audioTranscode.js";
import { uploadsDir } from "../src/upload.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import * as runtimeModule from "../src/lib/customerAgentRuntime.js";
import * as actionModule from "../src/lib/customerActionJournal.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { customerDmRoutingForIncoming } from "../src/lib/customerAgentIngressRouting.js";
import { customerFenceSchema } from "@royal-home/shared";
import { readCustomerActionProperty } from "../src/lib/customerActionProperty.js";
import { dushanbeDateString } from "../src/lib/dushanbeTime.js";
import { waitFor } from "./helpers/waitFor.js";

// Actual signed durable intake → FINAL → elected owner → real counted model
// adapter → tools → encrypted P12 plan. Only external HTTP is synthetic.
const accounts: string[] = [], events: string[] = [], mediaFiles: string[] = [], campaigns: string[] = [];
const ownLinkProperties: string[] = [];
let whatsappFixtureAccount: { id: string; externalId: string; secret: string; token: string } | null = null;
let whatsappPeerCounter = 0;
let dnsLookup: ReturnType<typeof vi.spyOn>;
const cohortId = randomUUID();
const allowedEndpoints: Array<{ surface: "dm"; channel: "INSTAGRAM" | "WHATSAPP"; endpointScopeId: string }> = [];
const apiKey = "synthetic-root-customer-core-key";
let settings: Awaited<ReturnType<typeof readSettings>>, policy: Awaited<ReturnType<typeof readPolicy>>;
let revisionId: string;
let savedRolloutConfig: unknown;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botCanSendPhotos: true, botPhotosPerOffer: true,
  botCanSendVoiceReplies: true,
  geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } }); }

async function fixture(text = "Здравствуйте, хочу купить квартиру", legacyAtIntake = false,
  channel: "INSTAGRAM" | "WHATSAPP" = "INSTAGRAM", inboundAudio = false) {
  let id = randomUUID(), externalId = `synthetic-dm-core-own-${id}`;
  let secret = `synthetic-dm-core-secret-${id}`, token = `synthetic-dm-core-token-${id}`;
  if (channel === "WHATSAPP" && whatsappFixtureAccount) ({ id, externalId, secret, token } = whatsappFixtureAccount);
  else {
    await prisma.messengerAccount.create({ data: { id, channel, externalId,
      username: `synthetic_core_agency_${id.replaceAll("-", "")}`, title: "Synthetic full DM core", enabled: true,
      token: encryptSecret(token), appSecret: encryptSecret(secret) } }); accounts.push(id);
    if (channel === "WHATSAPP") whatsappFixtureAccount = { id, externalId, secret, token };
  }
  const peer = channel === "WHATSAPP" ? `992918${String(++whatsappPeerCounter).padStart(6, "0")}` : `synthetic-dm-core-peer-${id}`;
  const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel, subscriberId: peer, accountId: id, accountExternalId: externalId }));
  if (!legacyAtIntake && !allowedEndpoints.some(value => value.endpointScopeId === endpoint.endpointScopeId)) {
    allowedEndpoints.push({ surface: "dm", channel, endpointScopeId: endpoint.endpointScopeId });
  }
  const allowed = [...allowedEndpoints];
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({ version: 1, cohortId,
    candidateRevisionId: revisionId, percentBasisPoints: 10_000, allowed })}::jsonb WHERE "id"='singleton'`;
  const eventId = randomUUID(), assetRef = `synthetic-audio-${id}`;
  const body = channel === "INSTAGRAM" ? { object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: eventId, text },
  }] }] } : { object: "whatsapp_business_account", entry: [{ id: externalId, changes: [{ field: "messages", value: {
    metadata: { phone_number_id: externalId, display_phone_number: "+992 918 999 999" }, contacts: [{ wa_id: peer, profile: { name: "Synthetic customer" } }],
    messages: [{ from: peer, id: eventId, timestamp: String(Math.floor(Date.now() / 1000)),
      ...(inboundAudio ? { type: "audio", audio: { id: assetRef, mime_type: "audio/ogg" } } : { type: "text", text: { body: text } }) }],
  } }] }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  let stored = await persistVerifiedCustomerIngressBatch(request);
  if (legacyAtIntake) {
    expect(stored).toMatchObject({status:"bypass"});
    const messageId = JSON.parse(rawBody.toString()).entry[0].messaging[0].message.mid as string;
    const witness = customerDmRoutingForIncoming(request,{channel:"INSTAGRAM",senderId:peer,accountExternalId:externalId,messageId});
    if(!witness) throw new Error("Actual legacy routing witness missing");
    const admitted = await admitCustomerPropertyInput({channel:"INSTAGRAM",peer,accountId:id,accountExternalId:externalId,
      eventKind:"message",eventId:messageId,evidence:[],customerRoutingWitness:witness});
    if(admitted.status!=="admitted") throw new Error("Actual legacy admission unavailable");
    stored={status:"persisted",tickets:[{eventKey:admitted.ticket.eventKey,order:admitted.ticket.order,fresh:admitted.fresh}],unsupported:0};
  }
  if (stored.status !== "persisted") throw new Error(`Actual synthetic producer did not persist: ${JSON.stringify(stored)}`);
  expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel, accountId: id, accountExternalId: externalId })).toBe(true);
  const eventKey = stored.tickets[0].eventKey; events.push(eventKey);
  const io: string[] = [], bodies: unknown[] = [];
  let generated = 0, countOk = true;
  let missingMetaMid = false;
  let followerState = true;
  let onGenerate: (() => Promise<void>) | undefined;
  let siteRead: ((id: number) => Promise<{ crmShortId: number; sold?: boolean } | null>) | undefined;
  let replies: unknown[][] = [[{ text: JSON.stringify({ kind: "reply", refs: [], social: "greet", question: "budget" }) }]];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if ((u.origin === "https://synthetic-core-instagram.invalid" || u.origin === "https://graph.facebook.com") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      io.push(body.type === "audio" || body.message?.attachment?.type === "audio" ? "meta-audio"
        : body.type === "document" || body.message?.attachment?.type === "file" ? "meta-file"
        : body.message?.attachment?.type === "image" ? "meta-image"
        : body.message?.attachment?.type === "audio" ? "meta-audio"
        : typeof body.message?.text === "string" && body.message.text.startsWith("https://crm-media.synthetic.example/uploads/msg-files/customer-approved-") ? "guide-link" : "meta-text");
      return new Response(JSON.stringify(missingMetaMid ? {} : { message_id: `synthetic-meta-mid-${randomUUID()}` }), { status: 200 });
    }
    if (u.origin === "https://royalhome.tj" && u.pathname === "/api/trpc/listing.getById" && init?.method === undefined) {
      expect(init).toMatchObject({ redirect: "manual", credentials: "omit", headers: { Accept: "application/json" } });
      expect(Object.keys(init.headers!)).toEqual(["Accept"]);
      if (!siteRead) throw Error("Unexpected anonymous website GET");
      const siteId = JSON.parse(u.searchParams.get("input")!).json.id;
      io.push("website"); const identity = await siteRead(siteId);
      return new Response(JSON.stringify(identity ? { result: { data: { json: { id: siteId, crmShortId: identity.crmShortId,
        published: true, sold: identity.sold ?? false, externalId: null, mapAddress: null, lat: null, lng: null } } } } : { error: {} }),
        { status: identity ? 200 : 404, headers: { "content-type": "application/json" } });
    }
    if (u.origin === "https://synthetic-core-instagram.invalid" && u.pathname === `/v23.0/${peer}` &&
        u.searchParams.get("fields") === "username" && u.searchParams.get("access_token") === token &&
        [...u.searchParams.keys()].length === 2 && init?.method === "GET") {
      io.push("profile"); return new Response(JSON.stringify({ id: peer, username: "synthetic_core_customer" }));
    }
    if (u.origin === "https://synthetic-core-instagram.invalid" && u.pathname === `/v23.0/${peer}` &&
        u.searchParams.get("fields") === "username,name,profile_pic,follower_count,is_user_follow_business" &&
        u.searchParams.get("access_token") === token && [...u.searchParams.keys()].length === 2 &&
        (init?.method === undefined || init.method === "GET")) {
      io.push("guide-profile"); return new Response(JSON.stringify({ id: peer, is_user_follow_business: followerState }));
    }
    if (u.origin !== "https://synthetic-core-gemini.invalid" || init?.method !== "POST" ||
        (init.headers as Record<string, string>)?.["x-goog-api-key"] !== apiKey) throw new Error("Unexpected synthetic core HTTP");
    if (u.pathname === "/gemini/v1beta/models/gemini-3.6-flash:countTokens") {
      io.push("count"); const body = JSON.parse(String(init.body));
      expect(body.generateContentRequest.systemInstruction.parts[0].text).toContain("Royal Home");
      expect(body.generateContentRequest.tools[0].functionDeclarations.length).toBeGreaterThanOrEqual(4);
      return new Response(JSON.stringify(countOk ? { totalTokens: 1000 } : { totalTokens: 999999 }));
    }
    if (u.pathname === "/gemini/v1beta/models/gemini-3.6-flash:generateContent") {
      io.push("generate"); bodies.push(JSON.parse(String(init.body)));
      await onGenerate?.();
      const parts = replies[generated++];
      if (!parts) throw new Error("Unexpected extra model round");
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
    }
    throw new Error("Unqualified synthetic endpoint");
  }));
  return { eventKey, io, bodies, setCountInvalid() { countOk = false; }, setMissingMetaMid(value = true) { missingMetaMid = value; },
    setReplies(value: unknown[][]) { replies = value; generated = 0; }, setOnGenerate(value: () => Promise<void>) { onGenerate = value; },
    setFollowerState(value: boolean) { followerState = value; },
    setSiteRead(value: NonNullable<typeof siteRead>) { siteRead = value; },
    async receive(text: string) {
      const nextId = randomUUID();
      const nextBody = channel === "INSTAGRAM" ? { object: "instagram", entry: [{ id: externalId, messaging: [{
        sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: nextId, text },
      }] }] } : { object: "whatsapp_business_account", entry: [{ id: externalId, changes: [{ field: "messages", value: {
        metadata: { phone_number_id: externalId, display_phone_number: "+992 918 999 999" }, contacts: [{ wa_id: peer, profile: { name: "Synthetic customer" } }],
        messages: [{ from: peer, id: nextId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
      } }] }] };
      const body = Buffer.from(JSON.stringify(nextBody));
      const next = { rawBody: body, get: () => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` };
      registerAuthenticatedMetaCustomerRequest(next);
      const saved = await persistVerifiedCustomerIngressBatch(next);
      if (saved.status !== "persisted") throw Error("Actual same-scope signed next input not persisted");
      expect(await verifyAndRegisterMetaCustomerIssuer(next, { channel, accountId: id, accountExternalId: externalId })).toBe(true);
      events.push(saved.tickets[0].eventKey); return saved.tickets[0].eventKey;
    } };
}

beforeAll(async () => {
  dnsLookup = vi.spyOn(dns, "lookup").mockImplementation((async (hostname: string) => {
    if (hostname !== "royalhome.tj") throw Error("Unexpected external DNS in owned integration fixture");
    return [{ address: "203.0.113.10", family: 4 }];
  }) as typeof dns.lookup);
  settings = await readSettings(); policy = await readPolicy();
  const [saved] = await prisma.$queryRaw<Array<{ rolloutConfig: unknown }>>`SELECT "rolloutConfig" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  savedRolloutConfig = saved.rolloutConfig;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true,
    botInstagramEnabled: true, geminiApiKey: encryptSecret(apiKey), geminiApiKey2: null, geminiApiKeysExtra: [] } });
  // Instagram otherwise deliberately inherits GEMINI_PROXY_URL. Exercise its
  // actual separate proxy/auth shaping rather than expecting a direct GET.
  vi.stubEnv("IG_PROXY_URL", "https://synthetic-core-instagram.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubEnv("GEMINI_PROXY_URL", "https://synthetic-core-gemini.invalid");
  vi.stubEnv("GEMINI_PROXY_KEY", ""); vi.stubEnv("GEMINI_API_KEY", apiKey); vi.stubEnv("GEMINI_API_KEY_2", "");
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
  vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "OFF");
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: "scoped", rolloutMode: "ACTIVE", activeAgentRevisionId: revisionId, capabilities: { publicRead: true },
  } });
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({ version: 1, cohortId,
    candidateRevisionId: revisionId, percentBasisPoints: 10_000, allowed: [] })}::jsonb WHERE "id"='singleton'`;
});
afterAll(async () => {
  dnsLookup?.mockRestore();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  try {
  const parts = await prisma.customerOutboxPart.findMany({ where: { ticketEventKey: { in: events } }, select: { id: true } });
  const natives = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: events } }, select: { conversationId: true } });
  const nativeIds = natives.flatMap(row => row.conversationId ? [row.conversationId] : []);
  const actions = await prisma.customerAction.findMany({ where: { inquiry: { conversationId: { in: nativeIds } } }, select: { id: true } });
  const actionIds = actions.map(row => row.id);
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [
    ...events.map(key => `customer-inbox-consume:${key}`), ...parts.map(row => `customer-outbox-dispatch:${row.id}`),
    ...actionIds.map(id => `customer-callback-notify:${id}`),
  ] } } });
  await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts.map(row => row.id) } } });
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts.map(row => row.id) } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
  await prisma.callbackRequest.deleteMany({ where: { customerActionId: { in: actionIds } } });
  await prisma.customerAction.deleteMany({ where: { id: { in: actionIds } } });
  await prisma.leadMagnetCampaign.deleteMany({ where: { id: { in: campaigns } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.outboundShieldState.deleteMany({ where: { endpointScope: { messengerAccountId: { in: accounts } } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accounts } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  await prisma.property.deleteMany({ where: { id: { in: ownLinkProperties } } });
  for (const file of mediaFiles.splice(0)) await rm(file, { force: true });
  } finally {
  if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
  if (policy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: policy.contractVersion, rolloutMode: policy.rolloutMode, capabilities: policy.capabilities!, activeAgentRevisionId: policy.activeAgentRevisionId,
  } });
  if (savedRolloutConfig === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
  else if (savedRolloutConfig !== undefined) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(savedRolloutConfig)}::jsonb WHERE "id"='singleton'`;
  }
  // Immutable manifests and synthetic provider accounting remain in this own
  // disposable DB as evidence; no shared/foreign daily bucket is rewritten.
});

async function ownLinkProperty(data: { siteListingId?: number; status?: "AVAILABLE" | "SOLD"; price?: number } = {}) {
  const p = await prisma.property.create({ data: { title: "Synthetic own-link property", type: "APARTMENT", status: "AVAILABLE",
    publishedOnSite: true, price: 456789, currency: "TJS", rooms: 2, areaSqm: 60, condition: "GOOD", ...data } });
  ownLinkProperties.push(p.id); return p;
}
async function ownMediaProperty() {
  const property = await ownLinkProperty();
  await mkdir(uploadsDir, { recursive: true });
  for (let order = 0; order < 3; order++) {
    const filename = `customer-property-media-${randomUUID()}.png`, file = path.join(uploadsDir, filename);
    mediaFiles.push(file);
    await writeFile(file, await sharp({ create: { width: 24, height: 16, channels: 3,
      background: { r: 40 + order * 50, g: 90, b: 170 - order * 40 } } }).png().toBuffer());
    await prisma.propertyPhoto.create({ data: { propertyId: property.id, url: `/uploads/${filename}`, thumbUrl: `/uploads/${filename}`, order } });
  }
  return property;
}
async function withLivePhotoPolicy<T>(run: () => Promise<T>): Promise<T> {
  const previous = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botCanSendPhotos: true, botPhotosPerOffer: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanSendPhotos: true, botPhotosPerOffer: 2 } });
  vi.stubEnv("CRM_PUBLIC_URL", "https://crm-media.synthetic.example");
  vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "LIVE");
  try { return await run(); }
  finally {
    vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "OFF");
    await prisma.settings.update({ where: { id: "singleton" }, data: previous });
  }
}
async function withLiveGuide<T>(run: () => Promise<T>): Promise<T> {
  vi.stubEnv("CRM_PUBLIC_URL", "https://crm-media.synthetic.example");
  vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "LIVE");
  try { return await run(); }
  finally { vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "OFF"); }
}
async function withVoiceFeature<T>(run: () => Promise<T>, enabled = true, mode: "LIVE" | "PREVIEW" = "LIVE"): Promise<T> {
  const before = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botCanSendVoiceReplies: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanSendVoiceReplies: enabled } });
  vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", mode);
  try { return await run(); }
  finally { vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "OFF");
    await prisma.settings.update({ where: { id: "singleton" }, data: before }); }
}
async function ownBuyerGuide() {
  const id = randomUUID(), filePath = `/uploads/lead-magnets/${id}-${Date.now()}.pdf`, file = path.join(uploadsDir, "lead-magnets", path.basename(filePath));
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = Buffer.from("%PDF-1.4\n% synthetic guide\n"); await writeFile(file, bytes); mediaFiles.push(file);
  const assetHash = createHash("sha256").update(bytes).digest("hex");
  mediaFiles.push(path.join(uploadsDir, "msg-files", `customer-approved-${assetHash}.pdf`));
  const campaign = await prisma.leadMagnetCampaign.create({ data: { id, name: `Synthetic guide ${id}`, enabled: true,
    inviteText: "Synthetic invite", followText: "Synthetic follow", notFollowingText: "Synthetic not following",
    deliveredText: "Synthetic delivered", filePath, fileName: "Перед покупкой квартиры.pdf", fileSize: bytes.length,
    deliverIfUnsure: false } });
  campaigns.push(campaign.id); return campaign;
}
async function mediaPlannedTurn() {
  const property = await ownMediaProperty(), f = await fixture(`Объект №${property.shortId}, пожалуйста, пришлите фото`);
  f.setReplies([[{ functionCall: { name: "get_property_facts", args: { kinds: ["price"] }, id: "media-property-facts" } }],
    [{ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question: "none" }) }]]);
  const result = await runCustomerDmAgentTurn(f.eventKey);
  if (result.status !== "planned") throw new Error(`Photo request did not plan: ${JSON.stringify(result)}`);
  const parts = await prisma.customerOutboxPart.findMany({ where: { id: { in: result.partIds } }, orderBy: { ordinal: "asc" } });
  await prisma.backgroundJob.updateMany({ where: { dedupeKey: { in: result.partIds.map(id => `customer-outbox-dispatch:${id}`) } }, data: { runAt: new Date("2099-01-01") } });
  for (const part of parts) {
    const payload = decodeCustomerOutboxPayload(part);
    if (payload.kind === "image") mediaFiles.push(path.join(uploadsDir, "msg", path.basename(payload.mediaWitness.assetPath)));
  }
  return { property, f, parts };
}
async function voicePlannedTurn() {
  const property = await ownLinkProperty();
  const f = await fixture(`https://royalhome.tj/tg/khona/${property.shortId} Сколько стоит? Пожалуйста, ответьте голосом.`);
  f.setSiteRead(async id => { expect(id).toBe(property.shortId); return { crmShortId: property.shortId }; });
  answerFacts(f);
  const result = await runCustomerDmAgentTurn(f.eventKey);
  if (result.status !== "planned") throw new Error(`Voice request did not plan: ${JSON.stringify(result)}`);
  const parts = await prisma.customerOutboxPart.findMany({ where: { id: { in: result.partIds } }, orderBy: { ordinal: "asc" } });
  await prisma.backgroundJob.updateMany({ where: { dedupeKey: { in: result.partIds.map(id => `customer-outbox-dispatch:${id}`) } }, data: { runAt: new Date("2099-01-01") } });
  for (const part of parts) {
    const payload = decodeCustomerOutboxPayload(part);
    if (payload.kind === "audio") mediaFiles.push(path.join(uploadsDir, "msg-voice", path.basename(payload.mediaWitness.assetPath)));
  }
  return { f, parts };
}
function answerFacts(f: Awaited<ReturnType<typeof fixture>>) {
  f.setReplies([[{ functionCall: { name: "get_property_facts", args: { kinds: ["price", "availability"] }, id: "actual-linked-facts" } }],
    [{ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question: "none" }) }]]);
}
it("actual signed URL turn resolves public site identity to the right CRM card, not a same-number collision", async () => {
  const wrong = await ownLinkProperty({ price: 111111 }), right = await ownLinkProperty({ price: 456789 });
  const f = await fixture(`https://royalhome.tj/tg/khona/${wrong.shortId} Сколько стоит?`);
  f.setSiteRead(async id => { expect(id).toBe(wrong.shortId); return { crmShortId: right.shortId }; }); answerFacts(f);
  const result = await consumeCustomerInboxTicket(f.eventKey);
  expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
  const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
  const payload = decodeCustomerOutboxPayload(part);
  expect(payload).toMatchObject({ text: expect.stringContaining("456 789") });
  expect(payload.kind === "text" ? payload.text.match(/456 789/g) : []).toHaveLength(1);
  expect(JSON.stringify(decodeCustomerOutboxPayload(part))).not.toContain("111 111");
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } });
  const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! } });
  expect(native.customerPropertyFocus).toMatchObject({ status: "resolved", propertyId: right.id });
  expect(f.io.filter(v => v === "website")).toHaveLength(1);
});
it("actual linked sold card answers status only instead of the old price or a phone request", async () => {
  const sold = await ownLinkProperty({ status: "SOLD", price: 987654 });
  const f = await fixture("https://royalhome.tj/en/listing/200000098 Сколько стоит?");
  f.setSiteRead(async () => ({ crmShortId: sold.shortId, sold: true })); answerFacts(f);
  const result = await consumeCustomerInboxTicket(f.eventKey);
  expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
  const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
  expect(decodeCustomerOutboxPayload(part)).toEqual({ kind: "text", text: `Объект №${sold.shortId} уже продан.` });
  expect(await readCustomerActionProperty(customerFenceSchema.parse(part.fenceJson))).toBeNull();
});
it("actual competing local/site bindings remain ambiguous, without leaking either price", async () => {
  await ownLinkProperty({ siteListingId: 200000099, price: 111111 }); const other = await ownLinkProperty({ price: 222222 });
  const f = await fixture("https://royalhome.tj/listing/200000099 Сколько стоит?");
  f.setSiteRead(async () => ({ crmShortId: other.shortId }));
  f.setReplies([[{ functionCall: { name: "get_property_facts", args: { kinds: ["price"] }, id: "conflict" } }],
    [{ text: JSON.stringify({ kind: "clarify", refs: ["e0"], social: "none", question: "property" }) }]]);
  const result = await consumeCustomerInboxTicket(f.eventKey);
  expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
  const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
  expect(JSON.stringify(decodeCustomerOutboxPayload(part))).not.toMatch(/111 111|222 222/);
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } });
  expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! } })).customerPropertyFocus)
    .toMatchObject({ status: "ambiguous", propertyId: null });
});
it.each(["pause", "newer-input"])("actual %s during site GET stops the original turn before model or outbox", async reason => {
  const property = await ownLinkProperty(), f = await fixture("https://royalhome.tj/listing/200000100 Сколько стоит?");
  f.setSiteRead(async () => {
    if (reason === "newer-input") await f.receive("Теперь интересует другой объект");
    else {
      const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } });
      await prisma.botConversation.update({ where: { id: row.conversationId! }, data: { pausedUntil: new Date(Date.now() + 60_000) } });
    }
    return { crmShortId: property.shortId };
  }); answerFacts(f);
  expect(await consumeCustomerInboxTicket(f.eventKey)).toMatchObject({ status: "held" });
  expect(f.io).toEqual(["profile", "website"]);
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
});
it("actual AVAILABLE to SOLD change after a fact round holds the old-price OUT", async () => {
  const property = await ownLinkProperty(), f = await fixture("https://royalhome.tj/listing/200000101 Сколько стоит?");
  f.setSiteRead(async () => ({ crmShortId: property.shortId })); answerFacts(f);
  let rounds = 0;
  f.setOnGenerate(async () => { if (++rounds === 2) await prisma.property.update({ where: { id: property.id }, data: { status: "SOLD" } }); });
  expect(await consumeCustomerInboxTicket(f.eventKey)).toMatchObject({ status: "held" });
  expect(f.io.filter(v => v === "generate")).toHaveLength(2);
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
});
it("an unresolved new link B clears the prior resolved A in the same genuine conversation", async () => {
  const a = await ownLinkProperty({ price: 444444 }), f = await fixture("https://royalhome.tj/listing/200000102 Сколько стоит?");
  f.setSiteRead(async id => id === 200000102 ? { crmShortId: a.shortId } : null); answerFacts(f);
  expect(await consumeCustomerInboxTicket(f.eventKey)).toMatchObject({ status: "planned" });
  const b = await f.receive("https://royalhome.tj/listing/200000103 Сколько стоит?");
  f.setReplies([[{ functionCall: { name: "get_property_facts", args: { kinds: ["price"] }, id: "missing-new-B" } }],
    [{ text: JSON.stringify({ kind: "clarify", refs: ["e0"], social: "none", question: "property" }) }]]);
  const result = await consumeCustomerInboxTicket(b);
  expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
  const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
  expect(JSON.stringify(decodeCustomerOutboxPayload(part))).not.toContain("444 444");
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: b } });
  expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! } })).customerPropertyFocus)
    .toMatchObject({ status: "missing", propertyId: null });
});
it("an unknown own-site path cannot fall through to the legacy last-number resolver", async () => {
  await ownLinkProperty({ siteListingId: 200000104, price: 555555 });
  const f = await fixture("https://royalhome.tj/listing/admin/200000104 Сколько стоит?");
  f.setReplies([[{ functionCall: { name: "get_property_facts", args: { kinds: ["price"] }, id: "unknown-path" } }],
    [{ text: JSON.stringify({ kind: "clarify", refs: ["e0"], social: "none", question: "property" }) }]]);
  const result = await consumeCustomerInboxTicket(f.eventKey);
  expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
  expect(f.io).not.toContain("website");
  const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
  expect(JSON.stringify(decodeCustomerOutboxPayload(part))).not.toContain("555 555");
});
it("original runtime cancellation during the public GET cannot produce model or OUT", async () => {
  const actual = runtimeModule.openPinnedCustomerAgentRuntime;
  let original: Extract<Awaited<ReturnType<typeof actual>>, { status: "ready" }>["runtime"] | undefined;
  const open = vi.spyOn(runtimeModule, "openPinnedCustomerAgentRuntime").mockImplementation(async input => {
    const value = await actual(input); if (value.status === "ready") original = value.runtime; return value;
  });
  try {
    const property = await ownLinkProperty(), f = await fixture("https://royalhome.tj/listing/200000105 Сколько стоит?");
    f.setSiteRead(async () => { if (!original) throw Error("Original elected runtime missing"); original.stop(); return { crmShortId: property.shortId }; });
    answerFacts(f); expect(await consumeCustomerInboxTicket(f.eventKey)).toMatchObject({ status: "held" });
    expect(original?.operation.signal?.aborted).toBe(true);
    expect(f.io.filter(value => value === "generate" || value === "count")).toEqual([]);
    expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
  } finally { open.mockRestore(); }
});

describe("actual durable DM common core", () => {
  it("plans one real counted turn and duplicate consumption cannot generate or enqueue again", async () => {
    const f = await fixture();
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } })).toMatchObject({
      intakeAgentRevisionId: revisionId, agentRevisionId: null, providerOperationId: null, providerDeadlineAt: null,
    });
    const result = await consumeCustomerInboxTicket(f.eventKey);
    expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw new Error(JSON.stringify(result));
    expect(result.partIds).toHaveLength(1);
    const row = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
    expect(row).toMatchObject({ status: "READY", agentRevisionId: revisionId, sourceKind: "BOT_TURN" });
    // SQL permits v2 only for the sealed buyer-guide follow purpose. An
    // ordinary v1 text plan cannot acquire v2 metadata or authority by row edit.
    await expect(prisma.$executeRaw`UPDATE "CustomerOutboxPart" SET "payloadVersion"=2 WHERE "id"=${row.id}`).rejects.toBeTruthy();
    expect(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ payloadVersion: 1, approvedAssetPurpose: null });
    const invalidId = randomUUID(), invalidPartKey = createHash("sha256").update(`invalid-follow-${invalidId}`).digest("hex");
    await expect(prisma.$executeRaw`INSERT INTO "CustomerOutboxPart"
      ("id","partKey","ticketEventKey","inquiryId","originalNativeId","conversationId","turnKey","ordinal","mode","sourceKind","sourceKey",
       "channel","endpointScopeId","transportJson","payloadEncrypted","payloadHash","payloadVersion","fenceJson","p03Json","receiptRefsJson",
       "agentRevisionId","approvedAssetPurpose","status","claimRevision","createdAt","updatedAt")
      SELECT ${invalidId},${invalidPartKey},source."ticketEventKey",source."inquiryId",source."originalNativeId",NULL,${randomUUID()},0,'LIVE','BOT_TURN',
       source."sourceKey",source."channel",source."endpointScopeId",source."transportJson",source."payloadEncrypted",${row.payloadHash},2,
       source."fenceJson",NULL,'[]'::jsonb,source."agentRevisionId",'buyer_guide_follow','SUPPRESSED',0,now(),now()
      FROM "CustomerOutboxPart" source WHERE source."id"=${row.id}`).rejects.toBeTruthy();
    expect(row.partKey).toBe(createHash("sha256").update(JSON.stringify([row.inquiryId, "BOT_TURN", f.eventKey, 0, "LIVE"])).digest("hex"));
    expect(decodeCustomerOutboxPayload(row)).toEqual({ kind: "text", text: "Здравствуйте!\nКакой бюджет вы рассматриваете?" });
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-outbox-dispatch:${row.id}` } })).toBe(1);
    expect(await consumeCustomerInboxTicket(f.eventKey)).toEqual({ status: "unchanged", reason: "already_planned" });
    expect(f.io.filter(value => value === "count")).toHaveLength(1);
    expect(f.io.filter(value => value === "generate")).toHaveLength(1);
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } })).toMatchObject({ processingState: "PLANNED", leaseOwner: null });
  });
  it("keeps explicit photo requests text-only while media execution is OFF", async () => {
    expect(process.env.CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE).toBe("OFF");
    const property = await ownMediaProperty(), f = await fixture(`Объект №${property.shortId}, пожалуйста, пришлите фото`);
    f.setReplies([[{ functionCall: { name: "get_property_facts", args: { kinds: ["price"] }, id: "off-photo-facts" } }],
      [{ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question: "none" }) }]]);
    const result = await runCustomerDmAgentTurn(f.eventKey);
    expect(result.status).toBe("planned"); if (result.status !== "planned") throw new Error(JSON.stringify(result));
    const rows = await prisma.customerOutboxPart.findMany({ where: { id: { in: result.partIds } }, orderBy: { ordinal: "asc" } });
    expect(rows).toHaveLength(1);
    expect(decodeCustomerOutboxPayload(rows[0]).kind).toBe("text");
    expect(f.io).not.toContain("meta-image");
  });
  it("plans the approved Instagram buyer-guide link after text, then suppresses it if the native opt-out changes", async () => {
    await withLiveGuide(async () => {
      await ownBuyerGuide();
      const f = await fixture("Хочу памятку по документам для покупки квартиры");
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const result = await runCustomerDmAgentTurn(f.eventKey);
      expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
      const parts = await prisma.customerOutboxPart.findMany({ where: { id: { in: result.partIds } }, orderBy: { ordinal: "asc" } });
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatchObject({ ordinal: 0, approvedAssetPurpose: null, payloadVersion: 1 });
      expect(decodeCustomerOutboxPayload(parts[0])).toMatchObject({ kind: "text", text: expect.stringContaining("Памятка по покупке квартиры.") });
      const link = decodeCustomerOutboxPayload(parts[1]);
      expect(parts[1]).toMatchObject({ ordinal: 1, approvedAssetPurpose: "buyer_guide", payloadVersion: 1, p03Json: null, receiptRefsJson: [] });
      expect(link).toMatchObject({ kind: "link", url: expect.stringMatching(/^https:\/\/crm-media\.synthetic\.example\/uploads\/msg-files\/customer-approved-/u),
        mediaWitness: { approvedFile: { sha256: expect.any(String), sourceId: expect.any(String), deliveryKind: "link" } } });
      expect(await dispatchCustomerOutboxPart(parts[0].id)).toEqual({ status: "accepted" });
      await prisma.botConversation.update({ where: { id: parts[0].originalNativeId }, data: { optedOutAt: new Date() } });
      expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "suppressed" });
      expect(f.io.filter(value => value === "meta-text")).toHaveLength(1);
      expect(f.io).not.toContain("guide-link");
    });
  });
  it("sends the current approved guide as a native WhatsApp file, records accepted state, and never sends it twice", async () => {
    await withLiveGuide(async () => {
      await ownBuyerGuide();
      const f = await fixture("Хочу памятку по документам для покупки квартиры", false, "WHATSAPP");
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const result = await runCustomerDmAgentTurn(f.eventKey);
      expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
      const parts = await prisma.customerOutboxPart.findMany({ where: { id: { in: result.partIds } }, orderBy: { ordinal: "asc" } });
      expect(parts).toHaveLength(2);
      const file = decodeCustomerOutboxPayload(parts[1]);
      if (file.kind !== "file") throw new Error("Expected a verified native guide file payload");
      expect(file).toMatchObject({ kind: "file", name: "Перед покупкой квартиры.pdf",
        mediaWitness: { approvedFile: { channel: "WHATSAPP", deliveryKind: "file" } } });
      expect(await dispatchCustomerOutboxPart(parts[0].id)).toEqual({ status: "accepted" });
      expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "accepted" });
      expect(f.io.filter(value => value === "meta-file")).toHaveLength(1);
      const nativeId = parts[0].originalNativeId;
      const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: nativeId } });
      expect(native).toMatchObject({ guideSentAt: expect.any(Date) });
      const acceptedFile = (native.messages as Array<Record<string, unknown>>).find(message => message.customerOutboxPartId === parts[1].id);
      expect(acceptedFile).toMatchObject({ customerApprovedFile: { kind: "file", assetPath: file.mediaWitness.approvedFile.assetPath },
        attachments: [{ kind: "file", url: file.mediaWitness.approvedFile.publicUrl, mime: "application/pdf" }] });

      const nextEvent = await f.receive("Можно еще раз прислать памятку?");
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const second = await runCustomerDmAgentTurn(nextEvent);
      expect(second.status, JSON.stringify(second)).toBe("planned"); if (second.status !== "planned") throw Error(JSON.stringify(second));
      const secondParts = await prisma.customerOutboxPart.findMany({ where: { id: { in: second.partIds } }, orderBy: { ordinal: "asc" } });
      expect(secondParts).toHaveLength(1); expect(secondParts[0].approvedAssetPurpose).toBeNull();
      expect(decodeCustomerOutboxPayload(secondParts[0])).toMatchObject({ kind: "text", text: "Памятка уже отправлена в этом чате." });
      expect(secondParts[0].payloadVersion).toBe(1);
      expect(f.io.filter(value => value === "meta-file")).toHaveLength(1);
    });
  });
  it("accepts one fixed Instagram follow instruction, then offers the file only after follower confirmation within the wait", async () => {
    await withLiveGuide(async () => {
      await ownBuyerGuide();
      const f = await fixture("Хочу памятку по документам для покупки квартиры"); f.setFollowerState(false);
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const prompt = await runCustomerDmAgentTurn(f.eventKey);
      expect(prompt.status, JSON.stringify(prompt)).toBe("planned"); if (prompt.status !== "planned") throw Error(JSON.stringify(prompt));
      const promptParts = await prisma.customerOutboxPart.findMany({ where: { id: { in: prompt.partIds } }, orderBy: { ordinal: "asc" } });
      expect(promptParts).toHaveLength(1);
      expect(promptParts[0]).toMatchObject({ ordinal: 0, payloadVersion: 2, approvedAssetPurpose: "buyer_guide_follow" });
      expect(decodeCustomerOutboxPayload(promptParts[0])).toMatchObject({ kind: "text", text: "Этот файл доступен подписчикам страницы. Подпишитесь и напишите здесь." });
      expect(decodeCustomerOutboxPublicData(promptParts[0])).toMatchObject({ guideFollow: { version: 1, kind: "buyer_guide_follow" } });
      expect(await dispatchCustomerOutboxPart(promptParts[0].id)).toEqual({ status: "accepted" });
      const waiting = await prisma.botConversation.findUniqueOrThrow({ where: { id: promptParts[0].originalNativeId } });
      expect(waiting).toMatchObject({ guideSentAt: null, guideAwaitFollowAt: expect.any(Date) });

      f.setFollowerState(true);
      const nextEvent = await f.receive("Я подписался, отправьте памятку");
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const delivery = await runCustomerDmAgentTurn(nextEvent);
      expect(delivery.status, JSON.stringify(delivery)).toBe("planned"); if (delivery.status !== "planned") throw Error(JSON.stringify(delivery));
      const fileParts = await prisma.customerOutboxPart.findMany({ where: { id: { in: delivery.partIds } }, orderBy: { ordinal: "asc" } });
      expect(fileParts).toHaveLength(2); expect(fileParts[1]).toMatchObject({ approvedAssetPurpose: "buyer_guide", payloadVersion: 1 });
      expect(decodeCustomerOutboxPayload(fileParts[1]).kind).toBe("link");
      expect(await dispatchCustomerOutboxPart(fileParts[0].id)).toEqual({ status: "accepted" });
      expect(await dispatchCustomerOutboxPart(fileParts[1].id)).toEqual({ status: "accepted" });
      expect(await prisma.botConversation.findUniqueOrThrow({ where: { id: promptParts[0].originalNativeId } }))
        .toMatchObject({ guideSentAt: expect.any(Date), guideAwaitFollowAt: null });
    });
  });
  it("starts a fresh seven-day wait from a newly accepted follow prompt after the prior wait expired", async () => {
    await withLiveGuide(async () => {
      await ownBuyerGuide();
      const f = await fixture("Хочу памятку по документам для покупки квартиры"); f.setFollowerState(false);
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const first = await runCustomerDmAgentTurn(f.eventKey);
      expect(first.status).toBe("planned"); if (first.status !== "planned") throw Error(JSON.stringify(first));
      const [firstPrompt] = await prisma.customerOutboxPart.findMany({ where: { id: { in: first.partIds } } });
      expect(firstPrompt.approvedAssetPurpose).toBe("buyer_guide_follow");
      expect(await dispatchCustomerOutboxPart(firstPrompt.id)).toEqual({ status: "accepted" });
      const oldWait = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await prisma.botConversation.update({ where: { id: firstPrompt.originalNativeId }, data: { guideAwaitFollowAt: oldWait } });

      const nextEvent = await f.receive("Хочу памятку по документам для покупки квартиры еще раз");
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const second = await runCustomerDmAgentTurn(nextEvent);
      expect(second.status).toBe("planned"); if (second.status !== "planned") throw Error(JSON.stringify(second));
      const [secondPrompt] = await prisma.customerOutboxPart.findMany({ where: { id: { in: second.partIds } } });
      expect(secondPrompt.approvedAssetPurpose).toBe("buyer_guide_follow");
      expect(await dispatchCustomerOutboxPart(secondPrompt.id)).toEqual({ status: "accepted" });
      const accepted = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: secondPrompt.id } });
      const conversation = await prisma.botConversation.findUniqueOrThrow({ where: { id: firstPrompt.originalNativeId } });
      expect(accepted.acceptedAt).toBeInstanceOf(Date);
      expect(conversation.guideAwaitFollowAt).toEqual(accepted.acceptedAt);
      expect(conversation.guideAwaitFollowAt!.getTime()).toBeGreaterThan(oldWait.getTime());
    });
  });
  it("a queued or ambiguous follow instruction reserves the workflow and cannot enqueue a duplicate prompt", async () => {
    await withLiveGuide(async () => {
      await ownBuyerGuide();
      const f = await fixture("Хочу памятку по документам для покупки квартиры"); f.setFollowerState(false);
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const first = await runCustomerDmAgentTurn(f.eventKey);
      expect(first.status).toBe("planned"); if (first.status !== "planned") throw Error(JSON.stringify(first));
      const firstParts = await prisma.customerOutboxPart.findMany({ where: { id: { in: first.partIds } }, orderBy: { ordinal: "asc" } });
      expect(firstParts).toHaveLength(1); expect(firstParts[0].approvedAssetPurpose).toBe("buyer_guide_follow");

      const nextEvent = await f.receive("Памятку можно получить?");
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const second = await runCustomerDmAgentTurn(nextEvent);
      // The closed intent can produce an honest plain-text status while the
      // first instruction is unresolved, without minting a duplicate prompt.
      expect(second.status).toBe("planned");
      const secondParts = await prisma.customerOutboxPart.findMany({ where: { ticketEventKey: nextEvent } });
      expect(secondParts).toHaveLength(1);
      expect(secondParts[0].approvedAssetPurpose).toBeNull();
      expect(decodeCustomerOutboxPayload(secondParts[0])).toMatchObject({ kind: "text", text: "Сейчас не могу отправить памятку." });
      expect(await prisma.customerOutboxPart.count({ where: { originalNativeId: firstParts[0].originalNativeId,
        approvedAssetPurpose: "buyer_guide_follow" } })).toBe(1);
    });
  });
  it("keeps an aged UNKNOWN follow prompt immutable but allows a fresh confirmed request to receive the first guide file", async () => {
    await withLiveGuide(async () => {
      await ownBuyerGuide();
      const f = await fixture("Хочу памятку по документам для покупки квартиры"); f.setFollowerState(false);
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const first = await runCustomerDmAgentTurn(f.eventKey);
      expect(first.status).toBe("planned"); if (first.status !== "planned") throw Error(JSON.stringify(first));
      const [follow] = await prisma.customerOutboxPart.findMany({ where: { id: { in: first.partIds } }, orderBy: { ordinal: "asc" } });
      expect(follow.approvedAssetPurpose).toBe("buyer_guide_follow");
      const historicAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await prisma.customerOutboxPart.update({ where: { id: follow.id }, data: { createdAt: historicAt } });
      f.setMissingMetaMid();
      expect(await dispatchCustomerOutboxPart(follow.id)).toEqual({ status: "unknown" });
      const unknownBefore = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: follow.id } });
      const attemptsBefore = await prisma.customerDeliveryAttempt.findMany({ where: { partId: follow.id } });
      expect(unknownBefore.status).toBe("UNKNOWN"); expect(attemptsBefore).toHaveLength(1);

      f.setFollowerState(true); f.setMissingMetaMid(false);
      const nextEvent = await f.receive("Хочу памятку по документам для покупки квартиры, пришлите пожалуйста");
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const fresh = await runCustomerDmAgentTurn(nextEvent);
      expect(fresh.status, JSON.stringify(fresh)).toBe("planned"); if (fresh.status !== "planned") throw Error(JSON.stringify(fresh));
      const newParts = await prisma.customerOutboxPart.findMany({ where: { id: { in: fresh.partIds } }, orderBy: { ordinal: "asc" } });
      expect(newParts).toHaveLength(2); expect(newParts[1].approvedAssetPurpose).toBe("buyer_guide");
      expect(decodeCustomerOutboxPayload(newParts[1])).toMatchObject({ kind: "link",
        url: expect.stringMatching(/^https:\/\/crm-media\.synthetic\.example\/uploads\/msg-files\/customer-approved-/u) });
      expect(await dispatchCustomerOutboxPart(newParts[0].id)).toEqual({ status: "accepted" });
      expect(await dispatchCustomerOutboxPart(newParts[1].id)).toEqual({ status: "accepted" });
      expect(f.io.filter(value => value === "guide-link")).toHaveLength(1);
      expect(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: follow.id } })).toEqual(unknownBefore);
      expect(await prisma.customerDeliveryAttempt.findMany({ where: { partId: follow.id } })).toEqual(attemptsBefore);
      expect(await prisma.customerOutboxPart.count({ where: { originalNativeId: follow.originalNativeId, approvedAssetPurpose: "buyer_guide_follow" } })).toBe(1);
      expect(await prisma.customerOutboxPart.count({ where: { originalNativeId: follow.originalNativeId, approvedAssetPurpose: "buyer_guide" } })).toBe(1);
    });
  });
  it("suppresses a queued buyer-guide follow instruction if the media execution gate is switched OFF", async () => {
    await withLiveGuide(async () => {
      await ownBuyerGuide();
      const f = await fixture("Хочу памятку по документам для покупки квартиры"); f.setFollowerState(false);
      f.setReplies([[{ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", attachment: "buyer_guide" }) }]]);
      const result = await runCustomerDmAgentTurn(f.eventKey);
      expect(result.status).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
      const [part] = await prisma.customerOutboxPart.findMany({ where: { id: { in: result.partIds } } });
      expect(part.approvedAssetPurpose).toBe("buyer_guide_follow");
      vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "OFF");
      expect(await dispatchCustomerOutboxPart(part.id)).toEqual({ status: "suppressed" });
      expect(f.io).not.toContain("meta-text");
    });
  });
  it("synthesizes only the explicit sealed reply, sends the witnessed audio after text, and projects its accepted MID", async () => {
    const tts = vi.spyOn(ttsModule, "synthesizeChatVoiceReply").mockResolvedValue({
      audioBase64: Buffer.alloc(24_000, 7).toString("base64"), sampleRateHz: 24_000,
    });
    const transcode = vi.spyOn(audioTranscodeModule, "transcodeToM4a").mockResolvedValue(Buffer.from("synthetic-m4a-audio"));
    try {
      await withVoiceFeature(async () => {
        const { f, parts } = await voicePlannedTurn();
        expect(parts).toHaveLength(2); expect(parts[0].ordinal).toBe(0); expect(parts[1].ordinal).toBe(1);
        expect(decodeCustomerOutboxPayload(parts[0]).kind).toBe("text");
        const audio = decodeCustomerOutboxPayload(parts[1]);
        expect(parts[1].approvedAssetPurpose).toBeNull();
        expect(audio).toMatchObject({ kind: "audio", mediaWitness: { synthesizer: "gemini_tts", voiceReplies: true,
          endpoint: { channel: "INSTAGRAM" }, assetPath: expect.stringMatching(/\.m4a$/u) } });
        expect(tts).toHaveBeenCalledTimes(1);
        expect(await dispatchCustomerOutboxPart(parts[0].id)).toEqual({ status: "accepted" });
        expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "accepted" });
        expect(f.io.filter(value => value === "meta-audio")).toHaveLength(1);
        const history = await prisma.botConversation.findUniqueOrThrow({ where: { id: parts[1].originalNativeId } });
        expect(history.messages).toEqual(expect.arrayContaining([expect.objectContaining({ customerOutboxPartId: parts[1].id,
          mid: expect.stringMatching(/^synthetic-meta-mid-/u), attachments: [expect.objectContaining({ kind: "audio",
            mid: expect.stringMatching(/^synthetic-meta-mid-/u) })] })]));
      });
    } finally { tts.mockRestore(); transcode.mockRestore(); }
  });
  it("mirrors a current authenticated WhatsApp audio message only when voice is not explicitly declined", async () => {
    const tts = vi.spyOn(ttsModule, "synthesizeChatVoiceReply").mockResolvedValue({
      audioBase64: Buffer.alloc(24_000, 7).toString("base64"), sampleRateHz: 24_000,
    });
    const transcode = vi.spyOn(audioTranscodeModule, "transcodeToOggOpus").mockResolvedValue(Buffer.from("synthetic-ogg-audio"));
    const actualOpen = runtimeModule.openPinnedCustomerAgentRuntime;
    const open = vi.spyOn(runtimeModule, "openPinnedCustomerAgentRuntime").mockImplementation(async input => {
      const result = await actualOpen(input);
      if (result.status === "ready") result.runtime.mediaEnabled = false; // No inbound-media/provider work in this test.
      return result;
    });
    try {
      await withVoiceFeature(async () => {
        const f = await fixture("", false, "WHATSAPP", true);
        // The audio fixture has no transcript, so its honest text-first reply is
        // a clarification, not a fabricated content answer without evidence.
        f.setReplies([[{ text: JSON.stringify({ kind: "clarify", refs: [], social: "none", question: "clarify_previous" }) }]]);
        const result = await runCustomerDmAgentTurn(f.eventKey);
        expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw Error(JSON.stringify(result));
        const parts = await prisma.customerOutboxPart.findMany({ where: { id: { in: result.partIds } }, orderBy: { ordinal: "asc" } });
        expect(parts).toHaveLength(2); expect(await dispatchCustomerOutboxPart(parts[0].id)).toEqual({ status: "accepted" });
        const audio = decodeCustomerOutboxPayload(parts[1]);
        expect(audio).toMatchObject({ kind: "audio", mediaWitness: { voiceTrigger: { kind: "inbound_voice",
          messageId: expect.any(String), attachmentId: expect.stringMatching(/^synthetic-audio-/u) }, endpoint: { channel: "WHATSAPP" } } });
        expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "accepted" });
        expect(tts).toHaveBeenCalledTimes(1); expect(f.io.filter(value => value === "meta-audio")).toHaveLength(1);
      });
      expect(customerVoiceTriggerForCurrentInput({ inputText: "ответьте только текстом", eventId: "current-message", eventKind: "message" },
        [{ kind: "audio", assetRef: "original-audio" }])).toBeNull();
      expect(customerVoiceTriggerForCurrentInput({ inputText: "Пожалуйста, ответьте голосом", eventId: "current-message", eventKind: "message" },
        [{ kind: "audio", assetRef: "original-audio" }])).toEqual({ kind: "explicit_request", messageId: "current-message" });
    } finally { open.mockRestore(); tts.mockRestore(); transcode.mockRestore(); }
  });
  it("does no TTS in PREVIEW and suppresses queued audio after a native pause without retrying", async () => {
    const tts = vi.spyOn(ttsModule, "synthesizeChatVoiceReply").mockResolvedValue({
      audioBase64: Buffer.alloc(24_000, 7).toString("base64"), sampleRateHz: 24_000,
    });
    try {
      const preview = await withVoiceFeature(async () => voicePlannedTurn(), true, "PREVIEW");
      expect(preview.parts).toHaveLength(1); expect(tts).not.toHaveBeenCalled();
      const capabilityOff = await withVoiceFeature(async () => voicePlannedTurn(), false, "LIVE");
      expect(capabilityOff.parts).toHaveLength(1); expect(tts).not.toHaveBeenCalled();
      const transcode = vi.spyOn(audioTranscodeModule, "transcodeToM4a").mockResolvedValue(Buffer.from("synthetic-m4a-audio"));
      try {
        const live = await withVoiceFeature(async () => voicePlannedTurn());
        expect(live.parts).toHaveLength(2); expect(tts).toHaveBeenCalledTimes(1);
        expect(await dispatchCustomerOutboxPart(live.parts[0].id)).toEqual({ status: "accepted" });
        await prisma.botConversation.update({ where: { id: live.parts[0].originalNativeId },
          data: { pausedUntil: new Date(Date.now() + 60_000) } });
        expect(await dispatchCustomerOutboxPart(live.parts[1].id)).toEqual({ status: "suppressed" });
        expect(live.f.io).not.toContain("meta-audio");
      } finally { transcode.mockRestore(); }
    } finally { tts.mockRestore(); }
  });
  it("does not call paid TTS when LIVE has no safe public voice asset base", async () => {
    const previousPublicBase = process.env.CRM_PUBLIC_URL;
    vi.stubEnv("CRM_PUBLIC_URL", "https://user:secret@crm-media.synthetic.example");
    const tts = vi.spyOn(ttsModule, "synthesizeChatVoiceReply");
    try {
      const result = await withVoiceFeature(async () => voicePlannedTurn(), true, "LIVE");
      expect(result.parts).toHaveLength(1);
      expect(tts).not.toHaveBeenCalled();
    } finally {
      tts.mockRestore();
      vi.stubEnv("CRM_PUBLIC_URL", previousPublicBase ?? "");
    }
  });
  it("does not resend voice after an ambiguous provider outcome", async () => {
    const tts = vi.spyOn(ttsModule, "synthesizeChatVoiceReply").mockResolvedValue({
      audioBase64: Buffer.alloc(24_000, 7).toString("base64"), sampleRateHz: 24_000,
    });
    const transcode = vi.spyOn(audioTranscodeModule, "transcodeToM4a").mockResolvedValue(Buffer.from("synthetic-m4a-audio"));
    try {
      await withVoiceFeature(async () => {
        const { f, parts } = await voicePlannedTurn();
        expect(await dispatchCustomerOutboxPart(parts[0].id)).toEqual({ status: "accepted" });
        f.setMissingMetaMid();
        expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "unknown" });
        expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "unknown" });
        expect(f.io.filter(value => value === "meta-audio")).toHaveLength(1);
        expect(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: parts[1].id } })).toMatchObject({ status: "UNKNOWN" });
      });
    } finally { tts.mockRestore(); transcode.mockRestore(); }
  });
  it("plans text first and only the owner's existing photo cap as independently witnessed parts", async () => {
    await withLivePhotoPolicy(async () => {
      const { property, f, parts } = await mediaPlannedTurn();
      expect(parts).toHaveLength(3);
      expect(parts.map(row => row.ordinal)).toEqual([0, 1, 2]);
      expect(parts.map(row => row.status)).toEqual(["READY", "READY", "READY"]);
      const text = decodeCustomerOutboxPayload(parts[0]);
      expect(text.kind).toBe("text");
      expect(parts[0].p03Json).not.toBeNull();
      expect(parts[1].p03Json).toBeNull(); expect(parts[2].p03Json).toBeNull();
      expect(parts[1].receiptRefsJson).toEqual([]); expect(parts[2].receiptRefsJson).toEqual([]);
      const media = [decodeCustomerOutboxPayload(parts[1]), decodeCustomerOutboxPayload(parts[2])];
      expect(media.every(item => item.kind === "image")).toBe(true);
      for (const item of media) {
        if (item.kind !== "image") continue;
        expect(item.mediaWitness).toMatchObject({ propertyId: property.id, shortId: property.shortId,
          agentRevisionId: revisionId, eventKey: parts[0].ticketEventKey, photosPerOffer: 2,
          endpoint: { channel: "INSTAGRAM", peerId: expect.any(String) } });
        expect(item.url).toBe(item.mediaWitness.publicUrl);
      }
      expect(await dispatchCustomerOutboxPart(parts[0].id)).toEqual({ status: "accepted" });
      expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "accepted" });
      expect(await dispatchCustomerOutboxPart(parts[2].id)).toEqual({ status: "accepted" });
      expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "accepted" });
      expect((await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: parts[1].id } })).projectionRecordedAt).toBeInstanceOf(Date);
      expect(f.io.filter(value => value === "meta-text")).toHaveLength(1);
      expect(f.io.filter(value => value === "meta-image")).toHaveLength(2);
      const history = await prisma.botConversation.findUniqueOrThrow({ where: { id: parts[0].originalNativeId } });
      expect(history.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ customerOutboxPartId: parts[1].id, mid: expect.stringMatching(/^synthetic-meta-mid-/),
          customerPropertyReference: { scopeKey: media[0].kind === "image" ? media[0].mediaWitness.scopeKey : "", propertyId: property.id },
          customerPropertyMedia: expect.objectContaining({ propertyId: property.id }),
          attachments: [expect.objectContaining({ kind: "image", mime: "image/jpeg", mid: expect.stringMatching(/^synthetic-meta-mid-/) })] }),
        expect.objectContaining({ customerOutboxPartId: parts[2].id, customerPropertyMedia: expect.objectContaining({ propertyId: property.id }) }),
      ]));
      const photoMessage = (history.messages as unknown as Array<Record<string, unknown>>).find(message => message.customerOutboxPartId === parts[1].id)!;
      const photoMid = String(photoMessage.mid);
      expect(await customerPropertyRegistry.reply(photoMid, { conversationId: parts[1].originalNativeId,
        scopeKey: (media[0] as Extract<typeof media[number], { kind: "image" }>).mediaWitness.scopeKey,
        channel: "INSTAGRAM", accountId: parts[1].transportJson && (parts[1].transportJson as { accountId: string }).accountId,
        endpointScopeId: parts[1].endpointScopeId })).toContain(property.id);
    });
  });
  it("retains already accepted text and never retries an image whose provider result is UNKNOWN", async () => {
    await withLivePhotoPolicy(async () => {
      const { f, parts } = await mediaPlannedTurn();
      expect(await dispatchCustomerOutboxPart(parts[0].id)).toEqual({ status: "accepted" });
      f.setMissingMetaMid();
      expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "unknown" });
      expect(await dispatchCustomerOutboxPart(parts[1].id)).toEqual({ status: "unknown" });
      expect(f.io.filter(value => value === "meta-text")).toHaveLength(1);
      expect(f.io.filter(value => value === "meta-image")).toHaveLength(1);
      const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: parts[1].id } });
      expect(part.status).toBe("UNKNOWN");
      const history = await prisma.botConversation.findUniqueOrThrow({ where: { id: part.originalNativeId } });
      expect(history.messages).toEqual(expect.arrayContaining([expect.objectContaining({
        customerOutboxPartId: parts[0].id, role: "assistant",
      })]));
      expect(history.messages).not.toEqual(expect.arrayContaining([expect.objectContaining({
        customerOutboxPartId: parts[1].id, attachments: expect.any(Array),
      })]));
    });
  });
  it("suppresses media after either photo permission is revoked or source bytes change, without recalling text", async () => {
    await withLivePhotoPolicy(async () => {
      const a = await mediaPlannedTurn();
      expect(await dispatchCustomerOutboxPart(a.parts[0].id)).toEqual({ status: "accepted" });
      await prisma.settings.update({ where: { id: "singleton" }, data: { botCanSendPhotos: false } });
      expect(await dispatchCustomerOutboxPart(a.parts[1].id)).toEqual({ status: "suppressed" });
      expect(a.f.io).not.toContain("meta-image");

      await prisma.settings.update({ where: { id: "singleton" }, data: { botCanSendPhotos: true, botPhotosPerOffer: 2 } });
      const b = await mediaPlannedTurn();
      expect(await dispatchCustomerOutboxPart(b.parts[0].id)).toEqual({ status: "accepted" });
      const payload = decodeCustomerOutboxPayload(b.parts[1]);
      if (payload.kind !== "image") throw new Error("Image expected");
      await writeFile(path.join(uploadsDir, path.basename(payload.mediaWitness.sourcePath)), await sharp({ create: {
        width: 24, height: 16, channels: 3, background: { r: 5, g: 240, b: 40 } } }).png().toBuffer());
      expect(await dispatchCustomerOutboxPart(b.parts[1].id)).toEqual({ status: "suppressed" });
      expect(b.f.io).not.toContain("meta-image");
    });
  });
  it("suppresses queued property images when customer opt-out or a manual pause is set after text acceptance", async () => {
    await withLivePhotoPolicy(async () => {
      const optedOut = await mediaPlannedTurn();
      expect(await dispatchCustomerOutboxPart(optedOut.parts[0].id)).toEqual({ status: "accepted" });
      await prisma.botConversation.update({ where: { id: optedOut.parts[0].originalNativeId }, data: { optedOutAt: new Date() } });
      expect(await dispatchCustomerOutboxPart(optedOut.parts[1].id)).toEqual({ status: "suppressed" });
      expect(optedOut.f.io).not.toContain("meta-image");

      const paused = await mediaPlannedTurn();
      expect(await dispatchCustomerOutboxPart(paused.parts[0].id)).toEqual({ status: "accepted" });
      await prisma.botConversation.update({ where: { id: paused.parts[0].originalNativeId },
        data: { pausedUntil: new Date(Date.now() + 60 * 60_000) } });
      expect(await dispatchCustomerOutboxPart(paused.parts[1].id)).toEqual({ status: "suppressed" });
      expect(paused.f.io).not.toContain("meta-image");
    });
  });
  it("binds actual planned image parts to the registered revision and leaves them queued until dispatch", async () => {
    await withLivePhotoPolicy(async () => {
      const { f, parts } = await mediaPlannedTurn();
      const payload = decodeCustomerOutboxPayload(parts[1]);
      if (payload.kind !== "image") throw new Error("Image expected");
      expect(payload.mediaWitness.agentRevisionId).toBe(revisionId);
      expect(parts[1].agentRevisionId).toBe(revisionId);
      const before = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: parts[1].id } });
      const stale = JSON.stringify({ ...payload, mediaWitness: { ...payload.mediaWitness, agentRevisionId: "d".repeat(64) } });
      await expect(prisma.customerOutboxPart.update({ where: { id: parts[1].id }, data: {
        payloadEncrypted: encryptSecret(stale), payloadHash: createHash("sha256").update(stale).digest("hex"),
      } })).rejects.toThrow(/customer outbox original target and payload are immutable/u);
      const after = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: parts[1].id } });
      expect(after.payloadHash).toBe(before.payloadHash);
      expect(decodeCustomerOutboxPayload(after)).toMatchObject({ kind: "image", mediaWitness: { agentRevisionId: revisionId } });
      expect(f.io).not.toContain("meta-image");
    });
  });
  it("refuses an oversized counted request without a generation, refund or new operation on retry", async () => {
    const f = await fixture(); f.setCountInvalid();
    expect(await runCustomerDmAgentTurn(f.eventKey)).toMatchObject({ status: "held" });
    const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } });
    expect(row.providerOperationId).toBeTruthy();
    const op = await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: row.providerOperationId! } });
    expect(op.status).toBe("HELD"); expect(op.reservedUsd.toNumber()).toBeGreaterThan(0);
    expect(await runCustomerDmAgentTurn(f.eventKey)).toMatchObject({ status: "held" });
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } })).providerOperationId).toBe(row.providerOperationId);
    expect(f.io.filter(value => value === "count")).toHaveLength(1); expect(f.io).not.toContain("generate");
    expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
  });
  it("keeps the accepted model usage but holds OUT when an employee pauses the original native during generation", async () => {
    const f = await fixture(); f.setOnGenerate(async () => {
      const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } });
      await prisma.botConversation.update({ where: { id: row.conversationId! }, data: { pausedUntil: new Date(Date.now() + 60_000) } });
    });
    expect(await runCustomerDmAgentTurn(f.eventKey)).toMatchObject({ status: "held" });
    expect(f.io.filter(value => value === "generate")).toHaveLength(1);
    expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
    const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } });
    expect(await prisma.aiLog.count({ where: { operationId: row.providerOperationId, attemptState: "SETTLED" } })).toBe(1);
  });
  it("a real private greeting never gains an unsolicited phone even if the model selects the contact", async () => {
    const f = await fixture("Здравствуйте");
    f.setReplies([[{ functionCall: { name: "get_agency_contact", args: {}, id: "unrequested-contact" } }],
      [{ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "greet", question: "none" }) }]]);
    const result = await runCustomerDmAgentTurn(f.eventKey);
    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw Error("Expected a private greeting");
    const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
    expect(decodeCustomerOutboxPayload(part)).toEqual({ kind: "text", text: "Здравствуйте!" });
  });
  it("shadow (the default) validates and counts the model's phrase but the customer still gets the template; live sends exactly the validated phrase through delivery sealing", async () => {
    const say = "Давайте разберёмся вместе.";
    const reply = (extra: Record<string, unknown> = {}) => [{ text: JSON.stringify({ kind: "reply", refs: [], social: "greet", question: "budget", ...extra }) }];
    const sayHits = async (guard: string) => (await prisma.guardHit.findFirst({ where: { guard, day: dushanbeDateString() } }))?.count ?? 0;
    vi.stubEnv("CUSTOMER_AGENT_SAY_MODE", "");
    const shadow = await fixture(), shadowBefore = await sayHits("say_dropped_shadow");
    shadow.setReplies([reply({ say })]);
    const shadowResult = await runCustomerDmAgentTurn(shadow.eventKey);
    if (shadowResult.status !== "planned") throw Error(JSON.stringify(shadowResult));
    expect(decodeCustomerOutboxPayload(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: shadowResult.partIds[0] } })))
      .toEqual({ kind: "text", text: "Здравствуйте!\nКакой бюджет вы рассматриваете?" });
    await waitFor(async () => await sayHits("say_dropped_shadow") > shadowBefore);
    vi.stubEnv("CUSTOMER_AGENT_SAY_MODE", "live");
    try {
      const usedBefore = await sayHits("say_used");
      const live = await fixture();
      live.setReplies([reply({ say })]);
      const liveResult = await runCustomerDmAgentTurn(live.eventKey);
      if (liveResult.status !== "planned") throw Error(JSON.stringify(liveResult));
      expect(decodeCustomerOutboxPayload(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: liveResult.partIds[0] } })))
        .toEqual({ kind: "text", text: `Здравствуйте!\n${say}\nКакой бюджет вы рассматриваете?` });
      await waitFor(async () => await sayHits("say_used") > usedBefore);
      const refusedBefore = await sayHits("say_dropped_number_or_date");
      const refused = await fixture();
      refused.setReplies([reply({ say: "Это стоит пять тысяч." })]);
      const refusedResult = await runCustomerDmAgentTurn(refused.eventKey);
      if (refusedResult.status !== "planned") throw Error(JSON.stringify(refusedResult));
      expect(decodeCustomerOutboxPayload(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: refusedResult.partIds[0] } })))
        .toEqual({ kind: "text", text: "Здравствуйте!\nКакой бюджет вы рассматриваете?" });
      await waitFor(async () => await sayHits("say_dropped_number_or_date") > refusedBefore);
    } finally { vi.stubEnv("CUSTOMER_AGENT_SAY_MODE", ""); // not unstubAllEnvs: beforeAll stubs the synthetic provider origins with the same API
    }
  });
  it("real function rounds persist canonical call-only agency contact and the original evidence sideband", async () => {
    const f = await fixture("Какой у вас номер телефона и работаете ли вы с арендой?");
    f.setReplies([[{ functionCall: { name: "get_agency_contact", args: {}, id: "contact" } },
      { functionCall: { name: "get_company_policy", args: { topic: "rental" }, id: "rental" } }],
    [{ text: JSON.stringify({ kind: "reply", refs: ["e0", "e1"], social: "none", question: "none" }) }]]);
    const result = await runCustomerDmAgentTurn(f.eventKey);
    expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw new Error(JSON.stringify(result));
    const row = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
    const payload = decodeCustomerOutboxPayload(row);
    expect(payload.kind).toBe("text"); if (payload.kind !== "text") throw new Error("Text expected");
    expect(payload.text).toContain("+992 44 650 14 14"); expect(payload.text).not.toContain("60 01");
    expect(payload.text).not.toContain("WhatsApp");
    expect(decodeCustomerOutboxPublicData(row)).toMatchObject({ agentRevisionId: revisionId,
      observations: [{ kind: "company_policy", topic: "rental" }] });
    expect(f.io.filter(value => value === "count")).toHaveLength(2);
    expect(f.io.filter(value => value === "generate")).toHaveLength(2);
  });
  it("a rental inquiry persists the complete refusal without the model's unrelated jobs question", async () => {
    const f = await fixture("Здравствуйте! Мне нужно квартира аренда");
    f.setReplies([[{ functionCall: { name: "get_company_policy", args: { topic: "rental" }, id: "rental" } }],
      [{ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "greet", question: "topic" }) }]]);
    const result = await runCustomerDmAgentTurn(f.eventKey);
    expect(result.status, JSON.stringify(result)).toBe("planned"); if (result.status !== "planned") throw new Error(JSON.stringify(result));
    const row = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
    const payload = decodeCustomerOutboxPayload(row);
    expect(payload).toMatchObject({ kind: "text", text: "Здравствуйте!\nСейчас арендой не занимаемся: не сдаём и не подбираем в аренду." });
    expect(decodeCustomerOutboxPublicData(row)).toMatchObject({ observations: [{ kind: "company_policy", topic: "rental" }] });
    expect(decodeCustomerOutboxPublicData(row)).not.toHaveProperty("callbackQuestion");
  });
  it("raw policy change revokes execution without replacing the original intake A with B", async () => {
    const f = await fixture();
    const row = await prisma.customerAgentRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const other = { ...(row.manifestJson as Record<string, unknown>), promptHash: "b".repeat(64) };
    const otherId = customerAgentManifestId(other);
    await prisma.customerAgentRevision.upsert({ where: { id: otherId }, create: { id: otherId, manifestJson: other }, update: {} });
    try {
      await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { activeAgentRevisionId: otherId } });
      const result = await consumeCustomerInboxTicket(f.eventKey);
      expect(result).toMatchObject({status:"held",reason:"pending_verifier_or_age_stale"});
      expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:f.eventKey}})).toMatchObject({intakeAgentRevisionId:revisionId,agentRevisionId:null});
      expect(await prisma.customerOutboxPart.count({where:{ticketEventKey:f.eventKey}})).toBe(0);
      expect(f.io).toHaveLength(0);
    } finally { await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { activeAgentRevisionId: revisionId } }); }
  });
  it("actual model handover commits task and fixed ACK plan without another model round or BOT revival", async () => {
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: { publicRead: true, handoverWrite: true } } });
    try {
      const f = await fixture("Мне не звонили, соедините меня с сотрудником");
      f.setReplies([[{ functionCall: { name: "request_handover", args: { topic: "Мне не звонили, соедините меня с сотрудником" }, id: "handover" } }]]);
      const result = await consumeCustomerInboxTicket(f.eventKey);
      expect(result.status, JSON.stringify(result)).toBe("planned");
      if (result.status !== "planned") throw new Error(JSON.stringify(result));
      expect(result.partIds).toHaveLength(1);
      const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
      expect(part).toMatchObject({ sourceKind: "HANDOVER_ACK", status: "READY", agentRevisionId: revisionId });
      expect(decodeCustomerOutboxPayload(part)).toEqual({ kind: "text", text: "Заявка на связь с сотрудником сохранена." });
      const task = await prisma.callbackRequest.findFirstOrThrow({ where: { conversationId: part.originalNativeId } });
      expect(task).toMatchObject({ requestKind: "HUMAN", lifecycleStatus: "QUEUED", lifecycleRevision: 1n });
      expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-callback-notify:${task.customerActionId}` } })).toBe(1);
      expect(await prisma.customerInquiry.findUniqueOrThrow({ where: { id: part.inquiryId! } })).toMatchObject({ ownerMode: "HOLD", ownerAgentId: null });
      expect(await consumeCustomerInboxTicket(f.eventKey)).toEqual({ status: "unchanged", reason: "already_planned" });
      expect(f.io.filter(value => value === "generate")).toHaveLength(1);
      expect(f.io.filter(value => value === "count")).toHaveLength(1);
      expect(await prisma.customerAction.count({ where: { inquiryId: part.inquiryId! } })).toBe(1);
    } finally {
      await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: { publicRead: true } } });
    }
  });
  it("activation cannot upgrade a legacy-owned NULL intake into a second core response", async () => {
    const f = await fixture("Здравствуйте", true);
    expect(await consumeCustomerInboxTicket(f.eventKey)).toMatchObject({ status: "held", reason: "historical_payload_unavailable" });
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:f.eventKey}})).toMatchObject({processingState:null,payloadVersion:null,intakeAgentRevisionId:null});
    expect(await runCustomerDmAgentTurn(f.eventKey)).toEqual({ status: "held", reason: "intake_revision_missing" });
    await expect(prisma.customerPropertyIngressTicket.update({ where: { eventKey: f.eventKey }, data: { intakeAgentRevisionId: revisionId } })).rejects.toThrow();
    expect(f.io).toHaveLength(0);
    expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
  });
  it("a real handover committed during original operation cancellation retains task/usage but cannot plan ACK", async () => {
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: { publicRead: true, handoverWrite: true } } });
    const actualOpen = runtimeModule.openPinnedCustomerAgentRuntime, actualExecute = actionModule.executeCustomerAction;
    let original: Extract<Awaited<ReturnType<typeof actualOpen>>, { status: "ready" }>["runtime"] | undefined;
    let actionId: string | undefined;
    const open = vi.spyOn(runtimeModule, "openPinnedCustomerAgentRuntime").mockImplementation(async input => {
      const value = await actualOpen(input); if (value.status === "ready") original = value.runtime; return value;
    });
    const execute = vi.spyOn(actionModule, "executeCustomerAction").mockImplementation(async (authority, command) => {
      const value = await actualExecute(authority, command); // Real DB/kernel transaction, no receipt mock.
      if (value.status === "created" && value.receipt.kind === "handover") {
        actionId = value.receipt.actionId;
        if (!original) throw new Error("Original actual runtime missing");
        original.stop(); // Task already committed; real original signal, not a fabricated flag.
      }
      return value;
    });
    try {
      const f = await fixture("Мне не звонили");
      f.setReplies([[{ functionCall: { name: "request_handover", args: { topic: "Мне не звонили" }, id: "handover" } }]]);
      expect((await consumeCustomerInboxTicket(f.eventKey)).status).toBe("held");
      expect(original?.operation.signal?.aborted).toBe(true); expect(actionId).toBeTruthy();
      const action = await prisma.customerAction.findUniqueOrThrow({ where: { id: actionId! } });
      expect(action).toMatchObject({ kind: "handover", status: "COMMITTED", receiptVersion: 2 });
      expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { customerActionId: actionId! } }))
        .toMatchObject({ requestKind: "HUMAN", lifecycleStatus: "QUEUED", lifecycleRevision: 1n });
      expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-callback-notify:${actionId}` } })).toBe(1);
      expect(await prisma.customerInquiry.findUniqueOrThrow({ where: { id: action.inquiryId } })).toMatchObject({ ownerMode: "HOLD" });
      const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } });
      expect(await prisma.aiLog.count({ where: { operationId: ticket.providerOperationId, attemptState: "SETTLED" } })).toBe(1);
      expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
      expect(f.io.filter(value => value === "generate")).toHaveLength(1);
      expect((await consumeCustomerInboxTicket(f.eventKey)).status).toBe("held");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      execute.mockRestore(); open.mockRestore();
      await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: { publicRead: true } } });
    }
  });
});
