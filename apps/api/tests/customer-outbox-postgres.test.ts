import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { registerAuthenticatedMetaCustomerRequest, registerAuthenticatedWebsiteCustomerRequest,
  verifyAndRegisterMetaCustomerIssuer, captureAuthenticatedCustomerInput, recoverCustomerPendingEnvelope,
  recoverAuthenticatedCustomerInput } from "../src/lib/customerIngressAuthority.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { loadPublicCustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { recordScopedCustomerInput } from "../src/lib/customerQualifierLedger.js";
import { createCustomerOutboxPartsTx } from "../src/lib/customerOutbox.js";
import { dispatchCustomerOutboxPart, acceptLateCustomerDeliveryMid } from "../src/lib/customerDeliveryDispatcher.js";
import { inspectCustomerDeliveryObservation } from "../src/lib/customerDeliveryObservation.js";
import * as adapters from "../src/lib/customerDeliveryAdapters.js";
import { isOwnCustomerOutboxEcho } from "../src/lib/customerOutboxEcho.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

// Normal PG setup. Real HMAC companion, admission, principal, local transactions,
// Shield and actual Meta send adapter; only physical fetch is synthetic. These
// are direct FINAL-IN adapter fixtures, not signed HTTP route/restart proof.
const accounts: string[] = [], natives: string[] = [], parts: string[] = [];
const ticketKeys: string[] = [];
const runId = randomUUID();
const shieldKeys: { endpointScopeId: string; subscriberId: string }[] = [];
let settings: Awaited<ReturnType<typeof readSettings>>, policy: Awaited<ReturnType<typeof readPolicy>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botWebsiteChatEnabled: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } }); }
async function installation(website = false) {
  const accountId = website ? null : randomUUID(), externalId = `synthetic-outbox-${randomUUID()}`, peer = `synthetic-peer-${randomUUID()}`;
  const secret = `synthetic-secret-${randomUUID()}`, channel = website ? "WEBSITE" as const : "INSTAGRAM" as const;
  if (accountId) {
    await prisma.messengerAccount.create({ data: { id: accountId, channel, externalId, title: "Synthetic durable delivery",
      token: encryptSecret(`synthetic-token-${accountId}`), appSecret: encryptSecret(secret), enabled: true } }); accounts.push(accountId);
    await rollout.allowDm({ peer, accountId, accountExternalId: externalId });
  }
  return {peer,accountId,externalId,secret,channel};
}
async function fixture(texts: string[] = ["Здравствуйте"], website = false, mode: "LIVE" | "SHADOW" = "LIVE",
  installed?: Awaited<ReturnType<typeof installation>>) {
  const {peer,accountId,externalId,secret,channel}=installed??await installation(website);
  const eventId = randomUUID(), inputText = "Подскажите подробнее";
  const rawBody = Buffer.from(JSON.stringify(website ? { sessionId: peer, messageId: eventId, text: inputText }
    : { object: "instagram", entry: [{ id: externalId, messaging: [{ sender: { id: peer }, recipient: { id: externalId },
      timestamp: Date.now(), message: { mid: eventId, text: inputText } }] }] }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  if (accountId) {
    registerAuthenticatedMetaCustomerRequest(request);
    expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel, accountId, accountExternalId: externalId })).toBe(true);
  } else registerAuthenticatedWebsiteCustomerRequest(request);
  const persisted = await persistVerifiedCustomerIngressBatch(request);
  expect(persisted.status).toBe("persisted"); if (persisted.status !== "persisted") throw new Error("Synthetic pending intake failed");
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel, subscriberId: peer, accountId,
    ...(accountId ? { accountExternalId: externalId } : {}) })); natives.push(native.id);
  shieldKeys.push({ endpointScopeId: native.transport.endpointScopeId, subscriberId: peer });
  ticketKeys.push(...persisted.tickets.map(ticket => ticket.eventKey));
  await prisma.backgroundJob.updateMany({ where: { dedupeKey: { in: persisted.tickets.map(ticket => `customer-inbox-consume:${ticket.eventKey}`) } }, data: { runAt: new Date("2099-01-01") } });
  const frame = captureAuthenticatedCustomerInput(request, { channel, peer, eventId, inputText,
    eventKind: website ? "website_message" : "message", ...(accountId ? { accountExternalId: externalId } : {}) });
  if (!frame) throw new Error("Synthetic actual input missing");
  const admission = await admitCustomerPropertyInput({ channel, peer, eventId, eventKind: website ? "website_message" : "message",
    accountId, authenticatedInput: frame, evidence: [], ...(accountId ? { accountExternalId: externalId } : {}) });
  if (admission.status !== "admitted") throw new Error(`Admission denied: ${admission.reason}`);
  expect(await recordScopedCustomerInput({ channel, subscriberId: peer }, frame, admission.ticket)).toBe(true);
  const loaded = await loadPublicCustomerPrincipal({ admission: admission.ticket, authenticatedInput: frame,
    visibility: website ? "website_chat" : "private_dm" });
  if (loaded.status !== "public_only") throw new Error(`Principal denied: ${loaded.status}`);
  const ids = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal: loaded.principal,
    parts: texts.map(text => ({ payload: { kind: "text", text } })), mode })); parts.push(...ids);
  await prisma.backgroundJob.updateMany({ where: { dedupeKey: { in: ids.map(id => `customer-outbox-dispatch:${id}`) } }, data: { runAt: new Date("2099-01-01") } });
  return { ids, nativeId: native.id, scopeId: native.transport.endpointScopeId, principal: loaded.principal };
}
beforeAll(async () => {
  settings = await readSettings(); policy = await readPolicy(); rollout = await createCustomerRolloutFixture();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botWebsiteChatEnabled: true } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: "scoped", rolloutMode: "ACTIVE", capabilities: { publicRead: true, contactWrite: false, callbackWrite: false, newLeadBridge: false },
  } });
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message_id: `synthetic-mid-${randomUUID()}` }), { status: 200 })));
});
afterAll(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: parts.map(id => `customer-outbox-dispatch:${id}`) } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: ticketKeys.map(eventKey => `customer-inbox-consume:${eventKey}`) } } });
  const attempts = await prisma.customerDeliveryAttempt.findMany({ where: { partId: { in: parts } }, select: { providerMid: true } });
  await prisma.processedMessage.deleteMany({ where: { channel: "out:meta", messageId: { in: attempts.flatMap(attempt => attempt.providerMid ? [attempt.providerMid] : []) } } });
  await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts } } });
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: ticketKeys } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
  if (shieldKeys.length) await prisma.outboundShieldState.deleteMany({ where: { OR: shieldKeys } });
  await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accounts } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  // WEBSITE installation scope is shared routing state: never delete by a
  // captured scope ID merely because one synthetic session used it.
  if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
  if (policy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: policy.contractVersion, rolloutMode: policy.rolloutMode, capabilities: policy.capabilities!,
  } });
  if (rollout) await rollout.restore();
});

describe("actual durable text delivery boundaries", () => {
  it("keeps accepted own MID exact-scoped and independent of the original-arrival ambiguity cutoff", async () => {
    const f = await fixture(), mid = `synthetic-observed-${randomUUID()}`;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ message_id: mid }), { status: 200 }));
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "accepted" });
    const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId } });
    expect(await inspectCustomerDeliveryObservation({ endpointScopeId: f.scopeId, peerId: native.subscriberId, mid,
      observedAt: new Date("2000-01-01") })).toMatchObject({ status: "known_own", partId: f.ids[0] });
    expect(await inspectCustomerDeliveryObservation({ endpointScopeId: randomUUID(), peerId: native.subscriberId, mid }))
      .toEqual({ status: "none" });
  });
  it("does not apply a future ambiguous attempt to an earlier input and never resends UNKNOWN", async () => {
    const f = await fixture();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "unknown" });
    const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId } });
    const target = { endpointScopeId: f.scopeId, peerId: native.subscriberId };
    expect(await inspectCustomerDeliveryObservation({ ...target, observedAt: new Date("2000-01-01") })).toEqual({ status: "none" });
    expect(await inspectCustomerDeliveryObservation(target)).toEqual({ status: "ambiguous_own_send" });
    expect(await inspectCustomerDeliveryObservation({ ...target, observedAt: new Date("2099-01-01") })).toEqual({ status: "ambiguous_own_send" });
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("the same reported MID in two independently captured endpoint namespaces does not collide", async () => {
    // Install both namespaces before issuing either original execution fence.
    const a=await installation(),b=await installation();
    const first = await fixture(undefined,false,"LIVE",a), second = await fixture(undefined,false,"LIVE",b), mid = `synthetic-cross-scope-${randomUUID()}`;
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ message_id: mid }), { status: 200 }));
    expect(await dispatchCustomerOutboxPart(first.ids[0])).toEqual({ status: "accepted" });
    expect(await dispatchCustomerOutboxPart(second.ids[0])).toEqual({ status: "accepted" });
    const rows = await prisma.customerDeliveryAttempt.findMany({ where: { partId: { in: [first.ids[0], second.ids[0]] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.outcome === "ACCEPTED" && row.providerMid === mid && row.reportedMid === mid)).toBe(true);
    expect(new Set(rows.map(row => row.endpointScopeId)).size).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("persists an attempt before physical POST, then durable MID before projection", async () => {
    const f = await fixture();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      expect(await prisma.customerDeliveryAttempt.findMany({ where: { partId: f.ids[0] } })).toMatchObject([{ outcome: "IN_FLIGHT", providerMid: null }]);
      return new Response(JSON.stringify({ message_id: `synthetic-mid-before-projection-${runId}` }), { status: 200 });
    });
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "accepted" });
    expect(await prisma.customerDeliveryAttempt.findMany({ where: { partId: f.ids[0] } })).toMatchObject([{ outcome: "ACCEPTED", providerMid: `synthetic-mid-before-projection-${runId}` }]);
    expect((await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: f.ids[0] } })).projectionRecordedAt).toBeInstanceOf(Date);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("2xx without MID remains UNKNOWN and duplicate jobs do not POST again", async () => {
    const f = await fixture(); vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "unknown" });
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "unknown" });
    expect(await prisma.customerDeliveryAttempt.findMany({ where: { partId: f.ids[0] } })).toMatchObject([{ outcome: "UNKNOWN", providerMid: null }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("first accepted and second unknown never resend either physical part", async () => {
    const f = await fixture(["Первая часть", "Вторая часть"]);
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "accepted" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await dispatchCustomerOutboxPart(f.ids[1])).toEqual({ status: "unknown" });
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "accepted" });
    expect(await dispatchCustomerOutboxPart(f.ids[1])).toEqual({ status: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("projection failure preserves acceptance and subsequent repair performs no POST", async () => {
    const f = await fixture(); const fault = vi.spyOn(adapters, "projectCustomerDeliveryPartTx").mockRejectedValueOnce(new Error("synthetic projection failure"));
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "accepted", projectionPending: true }); fault.mockRestore();
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "accepted" }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("projects an accepted part once through retained null/primitive history and retries without another POST", async () => {
    const f = await fixture(["Проверенный ответ"]), id = f.ids[0], mid = `synthetic-history-shape-${runId}`;
    const retained = [null, "legacy text item", 17, false];
    // Preserve malformed retained records: only the exact part-ID lookup may
    // skip them. Never clean/normalize native history to make projection pass.
    await prisma.$executeRaw`UPDATE "BotConversation" SET "messages"=${JSON.stringify(retained)}::jsonb || "messages" WHERE "id"=${f.nativeId}`;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ message_id: mid }), { status: 200 }));
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "accepted" });
    const part = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } });
    expect(part.status).toBe("ACCEPTED"); expect(part.acceptedAt).toBeInstanceOf(Date);
    expect(part.projectionRecordedAt).toBeInstanceOf(Date);
    const attempts = await prisma.customerDeliveryAttempt.findMany({ where: { partId: id } });
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ outcome: "ACCEPTED", providerMid: mid, reportedMid: mid });
    const before = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId } });
    const history = Array.isArray(before.messages) ? before.messages : [];
    expect(history.slice(0, retained.length)).toEqual(retained);
    expect(history.filter(item => item !== null && typeof item === "object" && !Array.isArray(item) && item.customerOutboxPartId === id))
      .toMatchObject([{ role: "assistant", content: "Проверенный ответ", customerOutboxPartId: id, mid }]);
    expect(history.filter(item => item !== null && typeof item === "object" && !Array.isArray(item) && item.customerOutboxPartId === id)).toHaveLength(1);
    await expect(dispatchCustomerOutboxPart(id)).resolves.toEqual({ status: "accepted" });
    await expect(dispatchCustomerOutboxPart(id)).resolves.toEqual({ status: "accepted" });
    const afterPart = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } });
    expect(afterPart.projectionRecordedAt).toEqual(part.projectionRecordedAt); expect(afterPart.acceptedAt).toEqual(part.acceptedAt);
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId } })).messages).toEqual(before.messages);
    expect(await prisma.customerDeliveryAttempt.findMany({ where: { partId: id } })).toEqual(attempts);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("two actual workers race for one part without a second provider POST", async () => {
    const f = await fixture(); await Promise.all([dispatchCustomerOutboxPart(f.ids[0]), dispatchCustomerOutboxPart(f.ids[0])]);
    expect(fetch).toHaveBeenCalledTimes(1); expect(await prisma.customerDeliveryAttempt.count({ where: { partId: f.ids[0] } })).toBe(1);
  });
  it("takeover before dispatch suppresses unsent part without creating attempt", async () => {
    const f = await fixture(); await prisma.botConversation.update({ where: { id: f.nativeId }, data: { pausedUntil: new Date(Date.now() + 60_000), botPausedAt: new Date() } });
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "suppressed" });
    expect(await prisma.customerDeliveryAttempt.count({ where: { partId: f.ids[0] } })).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });
  it("late exact-attempt MID associates without resend; wrong scope cannot associate", async () => {
    const f = await fixture(); vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "unknown" });
    const attempt = await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: f.ids[0] } });
    expect(await acceptLateCustomerDeliveryMid({ attemptId: attempt.id, endpointScopeId: randomUUID(), mid: `synthetic-late-mid-${runId}` })).toBe(false);
    expect(await acceptLateCustomerDeliveryMid({ attemptId: attempt.id, endpointScopeId: f.scopeId, mid: `synthetic-late-mid-${runId}` })).toBe(true);
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "accepted" }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("an ambiguous scoped MID retains its observation without accepting a second part", async () => {
    const f = await fixture(["Первая уникальная часть", "Вторая уникальная часть"]), mid = `synthetic-conflicting-${randomUUID()}`;
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ message_id: mid }), { status: 200 }));
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "accepted" });
    expect(await dispatchCustomerOutboxPart(f.ids[1])).toEqual({ status: "unknown" });
    expect(await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: f.ids[1] } })).toMatchObject({
      outcome: "UNKNOWN", providerMid: null, reportedMid: mid, errorCode: "mid_conflict",
    });
    expect((await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: f.ids[1] } })).acceptedAt).toBeNull();
    expect(await dispatchCustomerOutboxPart(f.ids[1])).toEqual({ status: "unknown" }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("shadow plan creates no send job and a serialized principal cannot issue live parts", async () => {
    const f = await fixture(["Только shadow"], false, "SHADOW");
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-outbox-dispatch:${f.ids[0]}` } })).toBe(0);
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "suppressed" });
    await expect(prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal: JSON.parse(JSON.stringify(f.principal)),
      parts: [{ payload: { kind: "text", text: "Нельзя отправлять" } }] }))).rejects.toThrow("Server customer delivery context required");
    expect(await prisma.customerOutboxPart.count({ where: { originalNativeId: f.nativeId } })).toBe(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("website env-only origin remains HELD without fabricating a replayable part or OUT", async () => {
    const sessionId = `synthetic-website-${randomUUID()}`, eventId = randomUUID();
    const request = { rawBody: Buffer.from(JSON.stringify({ sessionId, messageId: eventId, text: "Здравствуйте" })), get: () => "synthetic-website-key" };
    registerAuthenticatedWebsiteCustomerRequest(request);
    const pending = await persistVerifiedCustomerIngressBatch(request);
    expect(pending.status).toBe("persisted"); if (pending.status !== "persisted") throw new Error("Website pending observation failed");
    ticketKeys.push(...pending.tickets.map(ticket => ticket.eventKey));
    for (const ticket of pending.tickets) {
      expect(await recoverCustomerPendingEnvelope(ticket.eventKey)).toEqual({ status: "held", reason: "pending_verifier_or_age_stale" });
      expect((await recoverAuthenticatedCustomerInput(ticket.eventKey)).status).toBe("held");
      expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: ticket.eventKey } })).toBe(0);
    }
    expect(await prisma.botConversation.count({ where: { channel: "WEBSITE", subscriberId: sessionId } })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("provable non-delivery retries and ambiguous-send resolution (F14)", () => {
  it("429 is a provable NOT_SENT: one bounded retry through READY, then accepted; two attempts are recorded", async () => {
    const f = await fixture(); const id = f.ids[0];
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 429 }));
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "waiting" });
    const queued = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } });
    expect(queued.status).toBe("READY"); expect(queued.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "waiting" }); expect(fetch).toHaveBeenCalledTimes(1);
    await prisma.customerOutboxPart.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "accepted" });
    const attempts = await prisma.customerDeliveryAttempt.findMany({ where: { partId: id }, orderBy: { attemptNo: "asc" } });
    expect(attempts).toMatchObject([{ attemptNo: 1, outcome: "NOT_SENT", errorCode: "http_429" }, { attemptNo: 2, outcome: "ACCEPTED" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("an ambiguous 500 stays UNKNOWN and is never resent", async () => {
    const f = await fixture(); const id = f.ids[0];
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "unknown" });
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(await prisma.customerDeliveryAttempt.count({ where: { partId: id } })).toBe(1);
  });
  it("a hard 4xx is REJECTED and never retried", async () => {
    const f = await fixture(); const id = f.ids[0];
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 400 }));
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "suppressed" });
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "suppressed" }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("the retry budget is bounded: three 429 in a row end as NOT_SENT with no fourth POST", async () => {
    const f = await fixture(); const id = f.ids[0];
    vi.mocked(fetch).mockImplementation(async () => new Response("{}", { status: 429 }));
    for (let i = 0; i < 5; i++) {
      await prisma.customerOutboxPart.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } }).catch(() => {});
      await dispatchCustomerOutboxPart(id);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } })).status).toBe("NOT_SENT");
  });
  it("an own send left UNKNOWN stops holding later input after the ambiguity window", async () => {
    const f = await fixture(); vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await dispatchCustomerOutboxPart(f.ids[0])).toEqual({ status: "unknown" });
    const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId } });
    const target = { endpointScopeId: f.scopeId, peerId: native.subscriberId };
    expect(await inspectCustomerDeliveryObservation(target)).toEqual({ status: "ambiguous_own_send" });
    await prisma.$executeRaw`UPDATE "CustomerOutboxPart" SET "createdAt"=now()-interval '16 minutes' WHERE "id"=${f.ids[0]}`;
    expect(await inspectCustomerDeliveryObservation(target)).toEqual({ status: "none" });
  });
  it("the echo of an UNKNOWN own send settles it ACCEPTED exactly once, without a POST; two candidates stay UNKNOWN", async () => {
    const f = await fixture(["Эхо-ответ"]); const id = f.ids[0], mid = `synthetic-echo-${runId}`;
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await dispatchCustomerOutboxPart(id)).toEqual({ status: "unknown" });
    const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: f.nativeId } });
    const echo = { conversationId: f.nativeId, accountId: native.accountId, channel: native.channel, peer: native.subscriberId, text: "Эхо-ответ", messageId: mid };
    expect(await isOwnCustomerOutboxEcho({ ...echo, text: "Совсем другой текст" })).toBe(false);
    expect((await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } })).status).toBe("UNKNOWN");
    expect(await isOwnCustomerOutboxEcho(echo)).toBe(true);
    expect(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "ACCEPTED" });
    expect(await prisma.customerDeliveryAttempt.findMany({ where: { partId: id } })).toMatchObject([{ outcome: "ACCEPTED", providerMid: mid }]);
    expect(await inspectCustomerDeliveryObservation({ endpointScopeId: f.scopeId, peerId: native.subscriberId, mid })).toMatchObject({ status: "known_own", partId: id });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
