import { createHmac, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { customerAgentDecisionSchema, customerAgentToolCallSchema } from "@royal-home/shared";
import { prisma } from "../../src/db.js";
import { encryptSecret } from "../../src/crypto.js";
import { verifySignature, resetMetaAccountCredsCache } from "../../src/messengers/meta.js";
import { registerAuthenticatedMetaCustomerRequest } from "../../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch, consumeCustomerInboxTicket } from "../../src/lib/customerIngressProducer.js";
import { createCustomerAgentProviderSnapshot } from "../../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../../src/lib/customerAgentRegistration.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "../../src/lib/customerOutbox.js";
import { dispatchCustomerOutboxPart } from "../../src/lib/customerDeliveryDispatcher.js";
import { ensureCustomerEndpoint } from "../../src/lib/customerConversationScope.js";

// External model scripts are synthetic. Everything from verified raw admission
// through Core/tools/journal/P12 runs normally against the owned test DB.
type ModelPart = { text: string } | { functionCall: { name: string; args: unknown; id: string } };
export const call = (name: string, args: unknown, id: string): ModelPart => {
  customerAgentToolCallSchema.parse({ name, args }); return { functionCall: { name, args, id } };
};
export function decision(value: unknown): ModelPart {
  return { text: JSON.stringify(customerAgentDecisionSchema.parse(value)) };
}
export const reply = (refs: string[] = [], question = "none") => decision({ kind: "reply", refs, social: "none", question });
/** Malformed output is allowed ONLY for a named negative control. */
export const invalidDecision = (value: unknown): ModelPart => {
  expect(customerAgentDecisionSchema.safeParse(value).success).toBe(false);
  return { text: JSON.stringify(value) };
};

export async function createCustomerCoreGoldenFixture(options: { media?: boolean; publicEnvelope?: boolean } = {}) {
  const tag = `synthetic-core-companion-${randomUUID()}`, key = `${tag}-gemini-key`;
  const globalIgSecret = `${tag}-global-ig-secret`;
  // A public envelope = the account owns a DIFFERENT app secret and the request is signed by a global key. Without an own secret two global keys now prove the namespace (F02, 23.10.2026).
  const accounts: string[] = [], events: string[] = [], partIds: string[] = [], properties: string[] = [], districts: string[] = [];
  const owners = new Map<string, { id: string; externalId: string; token: string; secret: string; peer: string }>();
  const ioViolations: string[] = [], bodies: unknown[] = [], physical: string[] = [], mids: string[] = [];
  let scripts: ModelPart[][] = [], generated = 0, counted = 0;
  const mediaFixtures = new Map<string, { mimeType: string; body: Buffer }>();
  const publicationFixtures = new Map<string, Array<{ id: string; permalink: string; media_type: string; media_url?: string;
    children?: { data: Array<{ id: string; media_type: string; media_url: string }> } }>>();
  const savedSettings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
    botEnabled: true, metaEnabled: true, botInstagramEnabled: true, geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true,
    metaAppSecret: true, metaIgAppSecret: true,
  } });
  const savedPolicy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
    contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true,
  } });
  const [savedRollout] = await prisma.$queryRaw<Array<{ rolloutConfig: unknown }>>`SELECT "rolloutConfig" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  async function restore() {
    try { await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings }); }
    finally {
      try {
        await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: savedPolicy });
        if (savedRollout.rolloutConfig === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
        else await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(savedRollout.rolloutConfig)}::jsonb WHERE "id"='singleton'`;
      }
      finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetMetaAccountCredsCache(); }
    }
  }
  let revision: Awaited<ReturnType<typeof registerCurrentCustomerAgentRevision>>;
  const cohortId = randomUUID();
  try {
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true,
    botInstagramEnabled: true, geminiApiKey: encryptSecret(key), geminiApiKey2: null, geminiApiKeysExtra: [],
    ...(options.publicEnvelope ? { metaAppSecret: encryptSecret(`${tag}-other-global-app-secret`),
      metaIgAppSecret: encryptSecret(globalIgSecret) } : {}) } });
  vi.stubEnv("IG_PROXY_URL", "https://synthetic-core-instagram.invalid"); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubEnv("GEMINI_PROXY_URL", "https://synthetic-core-gemini.invalid"); vi.stubEnv("GEMINI_PROXY_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", key); vi.stubEnv("GEMINI_API_KEY_2", "");
  // Synthetic stand ONLY. This is not production activation or a legacy-OFF companion.
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "1");
  revision = await registerCurrentCustomerAgentRevision(options.media
    ? (await import("../../src/ai/customerAgentProviderConfig.js")).createCustomerAgentMediaProviderSnapshot()
    : createCustomerAgentProviderSnapshot());
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    activeAgentRevisionId: revision.id, capabilities: { publicRead: true, contactWrite: true, callbackWrite: true } } });
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({ version: 1, cohortId,
    candidateRevisionId: revision.id, percentBasisPoints: 10_000, allowed: [] })}::jsonb WHERE "id"='singleton'`;
  } catch (error) { await restore(); throw error; }
  function denied(code: string): never { ioViolations.push(code); throw new Error(code); }
  const fetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    try {
    const url = new URL(String(target)), headers = new Headers(init?.headers);
    if (options.media && (url.origin === "https://synthetic-core-cdn.invalid" || url.origin === "https://fixture.cdninstagram.com")) {
      const fixture = mediaFixtures.get(url.toString());
      if (!fixture || init?.method && init.method !== "GET" || headers.get("authorization") || headers.get("x-goog-api-key")) return denied("unexpected_synthetic_media_request");
      return new Response(new Uint8Array(fixture.body), { headers: { "content-type": fixture.mimeType, "content-length": String(fixture.body.length) } });
    }
    if (url.origin === "https://synthetic-core-instagram.invalid") {
      const owner = [...owners.values()].find(o => url.searchParams.get("access_token") === o.token);
      if (!owner) return denied("unowned_synthetic_meta_credential");
      if (options.media && init?.method === "GET" && url.searchParams.get("fields") === "id,permalink,media_type,media_url,children{id,media_type,media_url}") {
        const items = publicationFixtures.get(owner.id) ?? [];
        if (url.pathname === "/v23.0/me/media" && url.searchParams.get("limit") === "100") return new Response(JSON.stringify({ data: items }));
        if (/^\/v23\.0\/\d+$/.test(url.pathname) && [...url.searchParams.keys()].sort().join(",") === "access_token,fields") {
          const item = items.find(item => url.pathname === `/v23.0/${item.id}`);
          return new Response(JSON.stringify(item ?? { error: { code: 100, error_subcode: 33 } }), { status: item ? 200 : 400 });
        }
        return denied("unexpected_publication_read");
      }
      if (init?.method === "GET" && url.pathname === `/v23.0/${owner.peer}` &&
          url.searchParams.get("fields") === "username" && [...url.searchParams.keys()].sort().join(",") === "access_token,fields") {
        return new Response(JSON.stringify({ id: owner.peer, username: "synthetic_companion_customer" }));
      }
      if (init?.method === "POST" && url.pathname === "/v23.0/me/messages" &&
          [...url.searchParams.keys()].join(",") === "access_token") {
        const body = JSON.parse(String(init.body));
        expect(Object.keys(body).sort()).toEqual(["message", "recipient"]);
        expect(body.recipient).toEqual({ id: owner.peer }); expect(Object.keys(body.message)).toEqual(["text"]);
        expect(typeof body.message.text).toBe("string"); expect(body.message.text.trim()).not.toBe("");
        const mid = `${tag}-accepted-${randomUUID()}`; mids.push(mid); physical.push(body.message.text);
        return new Response(JSON.stringify({ recipient_id: owner.peer, message_id: mid }));
      }
      return denied("unexpected_synthetic_meta_method_path_or_shape");
    }
    if (url.origin !== "https://synthetic-core-gemini.invalid" || init?.method !== "POST" || url.search ||
        headers.get("x-goog-api-key") !== key) return denied("unexpected_synthetic_model_target_or_credential");
    if (url.pathname === "/gemini/v1beta/models/gemini-3.6-flash:countTokens") {
      const body = JSON.parse(String(init.body));
      const declarations = body.generateContentRequest.tools[0].functionDeclarations;
      if (options.media && declarations.length === 1 && declarations[0].name === "perceive_customer_media") {
        expect(body.generateContentRequest.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["perceive_customer_media"] } });
        expect(body.generateContentRequest.systemInstruction.parts[0].text).toContain("Tajik CYRILLIC");
        expect(body.generateContentRequest.contents[0].parts.some((part: { inline_data?: unknown }) => !!part.inline_data)).toBe(true);
      } else {
        expect(body.generateContentRequest.systemInstruction.parts[0].text).toContain("Royal Home");
        expect(declarations.length).toBeGreaterThanOrEqual(4);
      }
      counted++; return new Response(JSON.stringify({ totalTokens: 1000 }));
    }
    if (url.pathname !== "/gemini/v1beta/models/gemini-3.6-flash:generateContent") return denied("unexpected_synthetic_model_method_path");
    bodies.push(JSON.parse(String(init.body))); const parts = scripts.shift(); generated++;
    if (!parts) return denied("unscripted_extra_generation");
    return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
    } catch (error) { ioViolations.push("synthetic_wire_contract_failure"); throw error; }
  });
  vi.stubGlobal("fetch", fetch);
  return {
    revision, bodies, physical, ioViolations, counts: () => ({ generated, counted }),
    publicationFixture(owner: { id: string }, items: NonNullable<ReturnType<typeof publicationFixtures.get>>) {
      if (!options.media || !owners.has(owner.id)) throw Error("Owned media fixture required");
      publicationFixtures.set(owner.id, items);
    },
    mediaFixture(mimeType: string, body: Buffer, metaCdn = false) {
      if (!options.media) throw new Error("Explicit media fixture profile required");
      const url = `https://${metaCdn ? "fixture.cdninstagram.com" : "synthetic-core-cdn.invalid"}/${randomUUID()}`;
      mediaFixtures.set(url, { mimeType, body }); return url;
    },
    script(rounds: ModelPart[][]) { expect(scripts).toHaveLength(0); scripts = rounds; },
    assertIoClean() {
      try { expect(ioViolations).toEqual([]); expect(scripts).toHaveLength(0); }
      finally { scripts = []; ioViolations.length = 0; }
    },
    async owner() {
      const id = randomUUID(), o = { id, externalId: `${tag}-account-${accounts.length}`, token: `${tag}-token-${accounts.length}`,
        secret: `${tag}-secret-${accounts.length}`, peer: `${tag}-peer-${accounts.length}` };
      await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId: o.externalId,
        username: `synthetic_companion_agency_${id.replaceAll("-", "")}`, title: "Synthetic golden companion", enabled: true,
        token: encryptSecret(o.token), appSecret: encryptSecret(o.secret) } });
      const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: o.peer,
        accountId: id, accountExternalId: o.externalId }));
      await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=jsonb_set("rolloutConfig",'{allowed}',
        COALESCE("rolloutConfig"->'allowed','[]'::jsonb) || ${JSON.stringify([{ surface: "dm", channel: "INSTAGRAM", endpointScopeId: endpoint.endpointScopeId }])}::jsonb)
        WHERE "id"='singleton'`;
      accounts.push(id); owners.set(id, o); resetMetaAccountCredsCache(); return o;
    },
    async capture(o: { id: string; externalId: string; token: string; secret: string; peer: string }, text: string,
      attachments?: Array<{ type: string; payload: { url?: string; reel_video_id?: string; ig_post_media_id?: string } }>) {
      const eventId = `${tag}-in-${randomUUID()}`, rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: o.externalId,
        messaging: [{ sender: { id: o.peer }, recipient: { id: o.externalId }, timestamp: Date.now(), message: { mid: eventId, text,
          ...(attachments ? { attachments } : {}) } }] }] }));
      const signature = `sha256=${createHmac("sha256", options.publicEnvelope ? globalIgSecret : o.secret).update(rawBody).digest("hex")}`;
      expect(await verifySignature(rawBody, signature)).toBe(true);
      const request = { rawBody, get: () => signature }; registerAuthenticatedMetaCustomerRequest(request);
      const stored = await persistVerifiedCustomerIngressBatch(request);
      expect(stored.status, JSON.stringify(stored)).toBe("persisted"); if (stored.status !== "persisted" || stored.tickets.length !== 1) throw new Error("Actual companion intake failed");
      const eventKey = stored.tickets[0].eventKey; events.push(eventKey); return eventKey;
    },
    async deliver(eventKey: string) {
      const before = physical.length, planned = await consumeCustomerInboxTicket(eventKey);
      expect(planned.status, JSON.stringify(planned)).toBe("planned");
      if (planned.status !== "planned") throw new Error("Actual worker did not plan");
      expect(planned.partIds).toHaveLength(1); partIds.push(...planned.partIds);
      const id = planned.partIds[0], row = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "READY", agentRevisionId: revision.id, sourceKind: "BOT_TURN" });
      const payload = decodeCustomerOutboxPayload(row); expect(payload.kind).toBe("text");
      if (payload.kind !== "text") throw new Error("Text output required");
      expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "accepted" });
      expect(physical.slice(before)).toEqual([payload.text]);
      const accepted = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } });
      expect(accepted).toMatchObject({ status: "ACCEPTED" }); expect(accepted.acceptedAt).not.toBeNull(); expect(accepted.projectionRecordedAt).not.toBeNull();
      const attempts = await prisma.customerDeliveryAttempt.findMany({ where: { partId: id } });
      expect(attempts).toHaveLength(1); expect(mids).toContain(attempts[0].providerMid);
      expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "accepted" });
      expect(await consumeCustomerInboxTicket(eventKey)).toEqual({ status: "unchanged", reason: "already_planned" });
      expect(physical.slice(before)).toEqual([payload.text]);
      return { text: payload.text, row: accepted, publicData: decodeCustomerOutboxPublicData(row) };
    },
    async publicCard() {
      const district = await prisma.district.create({ data: { name: `${tag}-public-district-${districts.length}`, city: "Душанбе" } }); districts.push(district.id);
      const property = await prisma.property.create({ data: { title: "Synthetic public apartment", type: "APARTMENT", areaSqm: 65,
        price: 500000, currency: "TJS", rooms: 2, districtId: district.id, condition: "GOOD", status: "AVAILABLE",
        address: `${tag}-PRIVATE-OWNER-HOUSE-SENTINEL`, publishedOnSite: true, instagramUrl: `https://www.instagram.com/p/${randomUUID().replaceAll("-", "")}/` } });
      properties.push(property.id); return { property, district };
    },
    async cleanup() {
      try {
        const scopes = await prisma.customerEndpointScope.findMany({ where: { messengerAccountId: { in: accounts } }, select: { id: true } });
        const scopeIds = scopes.map(row => row.id);
        const inquiries = await prisma.customerInquiry.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { id: true } });
        const inquiryIds = inquiries.map(row => row.id), natives = await prisma.botConversation.findMany({ where: { accountId: { in: accounts } }, select: { id: true } });
        const nativeIds = natives.map(row => row.id);
        const actions = await prisma.customerAction.findMany({ where: { inquiryId: { in: inquiryIds } }, select: { id: true } });
        const actionIds = actions.map(row => row.id), actualParts = await prisma.customerOutboxPart.findMany({ where: { ticketEventKey: { in: events } }, select: { id: true } });
        const ownParts = actualParts.map(row => row.id);
        const attempts = await prisma.customerDeliveryAttempt.findMany({ where: { partId: { in: ownParts } }, select: { providerMid: true } });
        await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [
          ...events.map(id => `customer-inbox-consume:${id}`), ...ownParts.map(id => `customer-outbox-dispatch:${id}`),
          ...actionIds.map(id => `customer-callback-notify:${id}`),
        ] } } });
        // Exact owned scope/MID cleanup; no shared WEBSITE scope/global pulse deletion.
        await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
        await prisma.processedMessage.deleteMany({ where: { channel: "out:meta", messageId: { in: attempts.flatMap(row => row.providerMid ? [row.providerMid] : []) } } });
        await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: ownParts } } });
        await prisma.customerOutboxPart.deleteMany({ where: { id: { in: ownParts } } });
        await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
        await prisma.callbackRequest.deleteMany({ where: { customerActionId: { in: actionIds } } });
        await prisma.customerAction.deleteMany({ where: { id: { in: actionIds } } });
        await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiryIds } } });
        await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
        await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
        await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
        await prisma.property.deleteMany({ where: { id: { in: properties } } }); await prisma.district.deleteMany({ where: { id: { in: districts } } });
      } finally { await restore(); }
      // Immutable revision/archive/provider accounting retained in owned DB.
      // No Client/Profile deletion or global budget resets.
    },
  };
}
