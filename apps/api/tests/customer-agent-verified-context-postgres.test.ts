import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { verifySignature, resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { claimCustomerAgentTurnTx, type CustomerAgentClaim } from "../src/lib/customerAgentClaim.js";
import { createCustomerOutboxPartsTx } from "../src/lib/customerOutbox.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { loadCustomerAgentVerifiedDmContext } from "../src/lib/customerAgentVerifiedContext.js";
import { loadCustomerStateSnapshot, transitionCustomerState, issueCustomerWriteAuthority } from "../src/lib/customerState.js";
import { openAuthenticatedCustomerContactIntent } from "../src/lib/customerContactIntent.js";
import { createCustomerAgentMutationSession } from "../src/lib/customerAgentMutationSession.js";
import { executeCustomerAction } from "../src/lib/customerActionJournal.js";
import { continueCustomerAgentAfterLocalAuthority } from "../src/lib/customerAgentContinuation.js";
import * as principals from "../src/lib/customerPrincipal.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";
import type { CustomerAgentRevision } from "@royal-home/shared";

// Normal PG: actual signed raw intake, pending→FINAL, canonical accept/record,
// genuine principal/claim/revision and real accepted P12 attempts. Fake ONLY
// the bounded Instagram username GET and physical message POST. No model I/O.
const tag = `synthetic-memory-${randomUUID()}`, accounts: string[] = [], events: string[] = [], parts: string[] = [];
let savedSettings: Awaited<ReturnType<typeof settings>>, savedPolicy: Awaited<ReturnType<typeof policy>>;
let revision: Readonly<CustomerAgentRevision>, staffId: string | undefined;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
const owners = new Map<string, { id: string; externalId: string; secret: string; token: string }>();
const physical: string[] = [], claims = new Map<string, CustomerAgentClaim>();
function settings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } }); }
function policy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true } }); }
async function owner() {
  const id = randomUUID(), o = { id, externalId: `${tag}-account-${accounts.length}`, secret: `${tag}-secret-${accounts.length}`, token: `${tag}-token-${accounts.length}` };
  await prisma.messengerAccount.create({ data: { id, externalId: o.externalId, channel: "INSTAGRAM", title: "Synthetic scoped memory",
    username: `synthetic_memory_${id.replaceAll("-", "")}`, token: encryptSecret(o.token), appSecret: encryptSecret(o.secret), enabled: true } });
  accounts.push(id); owners.set(o.externalId, o); resetMetaAccountCredsCache(); return o;
}
async function capture(o: Awaited<ReturnType<typeof owner>>, peer: string, text: string) {
  await rollout.allowDm({ peer, accountId: o.id, accountExternalId: o.externalId });
  const eventId = `${tag}-mid-${randomUUID()}`, rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: o.externalId,
    messaging: [{ sender: { id: peer }, recipient: { id: o.externalId }, timestamp: Date.now(), message: { mid: eventId, text } }] }] }));
  const signature = `sha256=${createHmac("sha256", o.secret).update(rawBody).digest("hex")}`;
  expect(await verifySignature(rawBody, signature)).toBe(true);
  const request = { rawBody, get: () => signature }; registerAuthenticatedMetaCustomerRequest(request);
  const received = await persistVerifiedCustomerIngressBatch(request);
  expect(received.status).toBe("persisted"); if (received.status !== "persisted" || received.tickets.length !== 1) throw new Error("Actual memory intake failed");
  events.push(received.tickets[0].eventKey); return received.tickets[0].eventKey;
}
async function message(o: Awaited<ReturnType<typeof owner>>, peer: string, text: string) {
  const eventKey = await capture(o, peer, text), prepared = await prepareCustomerDmInboxCoreContext(eventKey);
  expect(prepared.status).toBe("prepared"); if (prepared.status !== "prepared") throw new Error(`Actual memory context held: ${prepared.status}`);
  return prepared.lane;
}
type Lane = Awaited<ReturnType<typeof message>>;
async function acceptedQuestion(lane: Lane, question: "budget" | "rooms" | "location", extraRaw = "") {
  const elected = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, lane.principal));
  expect(elected.status).toBe("claimed"); if (elected.status !== "claimed") throw new Error("Actual history claim unavailable");
  const text = renderCustomerAgentDecision({ decision: { kind: "clarify", refs: [], social: "none", question }, evidence: [],
    language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 3000, surface: "dm", knowledgeSourceHash: revision.knowledgeSourceHash });
  if (!text) throw new Error("Actual history renderer refused question");
  // extraRaw is an intentional negative historical payload, not a positive
  // model fixture: the loader must NOT import arbitrary accepted private text.
  const ids = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal: lane.principal, agentClaim: elected.claim,
    parts: [{ payload: { kind: "text", text: text + extraRaw } }] })); parts.push(...ids);
  expect(await dispatchCustomerOutboxPart(ids[0])).toEqual({ status: "accepted" });
  const p = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: ids[0] } });
  expect(p.projectionRecordedAt).not.toBeNull();
  expect(await prisma.customerDeliveryAttempt.count({ where: { partId: p.id, outcome: "ACCEPTED", providerMid: { not: null } } })).toBe(1);
  return { text, id: ids[0] };
}
async function currentClaim(lane: Lane): Promise<CustomerAgentClaim> {
  const previous = claims.get(lane.ticket.eventKey); if (previous) return previous;
  const elected = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, lane.principal));
  expect(elected.status).toBe("claimed"); if (elected.status !== "claimed") throw new Error("Actual current memory claim/pin unavailable");
  claims.set(lane.ticket.eventKey, elected.claim); return elected.claim;
}
async function memory(lane: Lane) {
  await currentClaim(lane);
  const value = await loadCustomerAgentVerifiedDmContext({ principal: lane.principal, revision });
  expect(value.status).toBe("current"); if (value.status !== "current") throw new Error(`Actual memory held: ${value.reason}`);
  return value.context;
}
async function serverOwner(lane: Lane, mode: "HUMAN" | "BOT") {
  const snapshot = await loadCustomerStateSnapshot({ conversationId: lane.ticket.conversationId });
  if (!snapshot) throw new Error("Actual state missing for server takeover fixture");
  const changed = await prisma.$transaction(tx => transitionCustomerState(tx, snapshot.fence,
    { type: "owner", mode, agentId: mode === "HUMAN" ? staffId ?? null : null, token: randomUUID(), leaseUntil: null }));
  expect(changed.status).toBe("applied");
}
beforeAll(async () => {
  savedSettings = await settings(); savedPolicy = await policy();
  const staff = await prisma.agent.create({ data: { fullName: "Synthetic memory takeover", phone: `${tag}-staff`,
    role: "AGENT", passwordHash: "synthetic-not-a-login-hash", isActive: true } }); staffId = staff.id;
  revision = await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot());
  rollout = await createCustomerRolloutFixture(revision.id);
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true, callbackWrite: true }, activeAgentRevisionId: revision.id } });
  vi.stubEnv("IG_PROXY_URL", ""); vi.stubEnv("GEMINI_PROXY_URL", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function transport() {
  const fetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target)), headers = new Headers(init?.headers);
    if (url.origin !== "https://graph.instagram.com") throw new Error("Unexpected memory provider origin");
    const o = [...owners.values()].find(value => headers.get("Authorization") === `Bearer ${value.token}`);
    if (!o) throw new Error("Unexpected memory provider credential");
    if (init?.method === "GET" && url.pathname.startsWith(`/v23.0/${tag}-peer-`) && url.search === "?fields=username") {
      return new Response(JSON.stringify({ id: url.pathname.split("/").at(-1), username: "synthetic_memory_customer" }));
    }
    if (init?.method === "POST" && url.pathname === "/v23.0/me/messages" && url.search === "") {
      const body = JSON.parse(String(init.body)); expect(Object.keys(body).sort()).toEqual(["message", "recipient"]);
      physical.push(body.message.text); return new Response(JSON.stringify({ recipient_id: body.recipient.id, message_id: `${tag}-out-${randomUUID()}` }));
    }
    throw new Error("Unexpected memory provider path/method");
  }); vi.stubGlobal("fetch", fetch); return fetch;
}
afterAll(async () => {
  try {
    const scopes = await prisma.customerEndpointScope.findMany({ where: { messengerAccountId: { in: accounts } }, select: { id: true } });
    const scopeIds = scopes.map(row => row.id), inquiries = await prisma.customerInquiry.findMany({ where: { endpointScopeId: { in: scopeIds } }, select: { id: true } });
    const inquiryIds = inquiries.map(row => row.id);
    const actions = await prisma.customerAction.findMany({ where: { inquiryId: { in: inquiryIds } }, select: { id: true } });
    const actionIds = actions.map(row => row.id);
    if (actionIds.length || inquiryIds.length) await prisma.backgroundJob.deleteMany({ where: { OR: [
      ...actionIds.map(id => ({ payload: { path: ["actionId"], equals: id } })),
      ...inquiryIds.map(id => ({ payload: { path: ["inquiryId"], equals: id } })),
    ] } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [
      ...events.map(id => `customer-inbox-consume:${id}`), ...parts.map(id => `customer-outbox-dispatch:${id}`),
    ] } } });
    const accepted = await prisma.customerDeliveryAttempt.findMany({ where: { partId: { in: parts } }, select: { providerMid: true } });
    await prisma.processedMessage.deleteMany({ where: { channel: "out:meta", messageId: {
      in: accepted.flatMap(value => value.providerMid ? [value.providerMid] : []),
    } } });
    await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts } } });
    await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.callbackRequest.deleteMany({ where: { customerActionId: { in: actionIds } } });
    await prisma.customerAction.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
    await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiryIds } } });
    await prisma.botConversation.deleteMany({ where: { accountId: { in: accounts } } });
    await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
    if (staffId) await prisma.agent.deleteMany({ where: { id: staffId } });
  } finally {
    if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
    if (savedPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: savedPolicy });
    if (rollout) await rollout.restore();
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetMetaAccountCredsCache();
  }
  // No Client/Profile deletion, no shared scopes or immutable revision/archive deletion.
});

it("two authenticated IN and accepted public questions retain property intent before short installment follow-up", async () => {
  const fetch = transport(), o = await owner(), peer = `${tag}-peer-${randomUUID()}`;
  const a = await message(o, peer, "Ищу двухкомнатную квартиру в Сино"), qa = await acceptedQuestion(a, "budget");
  const b = await message(o, peer, "До 500000 сомони"), qb = await acceptedQuestion(b, "location");
  const c = await message(o, peer, "А рассрочка?"), before = fetch.mock.calls.length;
  const context = await memory(c);
  expect(context.turns).toEqual([{ role: "user", text: "Ищу двухкомнатную квартиру в Сино" },
    { role: "assistant", text: qa.text }, { role: "user", text: "До 500000 сомони" }, { role: "assistant", text: qb.text }]);
  expect(context.turns.some(t => t.text === "А рассрочка?")).toBe(false); expect(fetch.mock.calls.length).toBe(before);
  expect(context.publicState).toEqual((await loadCustomerStateSnapshot({ conversationId: c.ticket.conversationId }))?.publicState);
});
it("ordinary own names survive but phone/URL/handle/email/control IDs and arbitrary private assistant text do not", async () => {
  transport(); const o = await owner(), peer = `${tag}-peer-${randomUUID()}`, id = randomUUID();
  const a = await message(o, peer, `Я Рустам, ищу квартиру. +992 93 344 55 66 @memoryuser https://private.invalid/?key=secret x@private.invalid ${id}`);
  const q = await acceptedQuestion(a, "rooms", "\nPRIVATE CRM DOSSIER SENTINEL: секретный клиент");
  const b = await message(o, peer, "2"), context = await memory(b), text = JSON.stringify(context);
  expect(text).toContain("Я Рустам, ищу квартиру"); expect(text).toContain(q.text);
  for (const privateValue of ["+992 93 344 55 66", "@memoryuser", "https://private.invalid", "x@private.invalid", id, "PRIVATE CRM DOSSIER SENTINEL"]) expect(text).not.toContain(privateValue);
});
it("foreign account/peer history and unclassified pending envelope never enter current memory", async () => {
  transport(); const o = await owner(), foreign = await owner(), peer = `${tag}-peer-${randomUUID()}`;
  await message(foreign, `${tag}-peer-${randomUUID()}`, "FOREIGN ACCOUNT SENTINEL");
  await message(o, `${tag}-peer-${randomUUID()}`, "FOREIGN PEER SENTINEL");
  await capture(o, peer, "PENDING WITHOUT FINAL SENTINEL");
  const current = await message(o, peer, "Какая комиссия?"), context = await memory(current);
  expect(context.turns).toEqual([]); expect(JSON.stringify(context)).not.toMatch(/FOREIGN|PENDING WITHOUT FINAL/);
});
it("a server HUMAN→BOT takeover advances ownership epoch and old epoch history is omitted", async () => {
  transport(); const o = await owner(), peer = `${tag}-peer-${randomUUID()}`;
  const a = await message(o, peer, "OLD OWNER EPOCH SENTINEL"); await acceptedQuestion(a, "rooms");
  await serverOwner(a, "HUMAN"); await serverOwner(a, "BOT");
  const b = await message(o, peer, "Ищу дом"), context = await memory(b);
  expect(context.turns).toEqual([]); expect(JSON.stringify(context)).not.toContain("OLD OWNER EPOCH SENTINEL");
});
it("actual controller revocation after first current check holds whole result instead of returning old context", async () => {
  transport(); const o = await owner(), peer = `${tag}-peer-${randomUUID()}`;
  await message(o, peer, "Ищу квартиру"); const b = await message(o, peer, "А рассрочка?");
  await currentClaim(b);
  const real = principals.revalidateCustomerPrincipal; let checks = 0;
  vi.spyOn(principals, "revalidateCustomerPrincipal").mockImplementation(async principal => {
    const value = await real(principal); if (++checks === 1 && value.status === "current") await serverOwner(b, "HUMAN"); return value;
  });
  expect(await loadCustomerAgentVerifiedDmContext({ principal: b.principal, revision })).toMatchObject({ status: "held", reason: "original_context_changed" });
});
it("actual committed contact receipt is not assistant memory or consent for an old callback command", async () => {
  transport(); const o = await owner(), peer = `${tag}-peer-${randomUUID()}`;
  await message(o, peer, "Позвоните мне");
  const digits = String(parseInt(randomUUID().replaceAll("-", "").slice(0, 6), 16)).padStart(7, "0").slice(-7), phone = `+99293${digits}`;
  const a = await message(o, peer, `Мой номер ${phone}`), elected = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, a.principal));
  if (elected.status !== "claimed") throw new Error("Actual receipt claim missing");
  const command = { name: "save_contact", args: { phone } } as const;
  expect(await openAuthenticatedCustomerContactIntent(a.authenticatedInput, a.ticket, command)).toBe("opened");
  const authority = await issueCustomerWriteAuthority(a.authenticatedInput, a.ticket, "contact");
  if (!authority) throw new Error("Actual current contact authority missing");
  const committed = await executeCustomerAction(authority, command);
  expect(committed.status).toBe("created"); if (committed.status !== "created") throw new Error("Actual contact commit failed");
  const receiptAuthority = await issueCustomerWriteAuthority(a.authenticatedInput, a.ticket, "contact", prisma, "receipt");
  if (!receiptAuthority) throw new Error("Actual current receipt authority missing");
  const continued = await continueCustomerAgentAfterLocalAuthority(a.principal, receiptAuthority);
  if (continued.status !== "current") throw new Error("Actual receipt continuation missing");
  const ids = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal: continued.principal, agentClaim: elected.claim,
    parts: [{ payload: { kind: "text", text: "Контактные данные сохранены." }, receipts: [committed.receipt] }], receiptAuthorities: [receiptAuthority] }));
  parts.push(...ids); expect(await dispatchCustomerOutboxPart(ids[0])).toEqual({ status: "accepted" });
  const b = await message(o, peer, "А рассрочка?"), context = await memory(b);
  expect(JSON.stringify(context)).not.toContain("Контактные данные сохранены"); expect(JSON.stringify(context)).not.toContain(phone);
  const activeClaim = await currentClaim(b);
  const opened = await createCustomerAgentMutationSession({ principal: b.principal, authenticatedInput: b.authenticatedInput,
    ticket: b.ticket, agentClaim: activeClaim });
  expect(opened.status).toBe("ready"); if (opened.status !== "ready") throw new Error("Actual current mutation session unavailable");
  expect(opened.session.availableToolNames).toContain("request_callback");
  const wait = { signal: new AbortController().signal, deadlineAt: activeClaim.deadlineAt };
  expect(await opened.session.execute({ name: "request_callback", args: { topic: "Позвоните мне" } }, wait))
    .toMatchObject({ status: "denied" });
  expect(opened.session.committedReceipts).toHaveLength(0);
  expect(await prisma.callbackRequest.count({ where: { conversationId: b.ticket.conversationId } })).toBe(0);
});
