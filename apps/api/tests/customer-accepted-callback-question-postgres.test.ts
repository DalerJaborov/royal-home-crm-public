// Normal PostgreSQL integration for accepted callback question continuity.
// Normal default PG setup is required. Genuine HMAC/P11/FINAL/principal/claim/
// counted runtime/Core/renderer/seal/P12/kernel are real; ONLY physical HTTP is
// synthetic. No mocked authority, receipt, question sideband or model adapter.
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { customerActionIntentsSchema } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { registerAuthenticatedMetaCustomerRequest, inspectAuthenticatedCustomerInput,
  authenticatedInputMatchesFence } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch, consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { revalidateCustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { loadAcceptedCustomerState } from "../src/lib/customerState.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "../src/lib/customerOutbox.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { createCustomerLeadAfterContactAction } from "../src/lib/customerNewLeadBridge.js";
import { processNewCustomerLeadPolicy } from "../src/services/leads/intake.js";
import { claimCustomerAgentTurnTx } from "../src/lib/customerAgentClaim.js";
import { loadCustomerAgentVerifiedDmContext } from "../src/lib/customerAgentVerifiedContext.js";
import { decodeCustomerAgentRevision } from "../src/lib/customerAgentRevision.js";
import * as workingHours from "../src/lib/workingHours.js";
import { decryptCustomerFinalOrigin } from "../src/lib/customerOriginPayload.js";
import { customerAgentCallbackQuestionText } from "../src/ai/customerAgentRenderer.js";
import { GRAPH_VERSION } from "../src/messengers/metaGraph.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache, resetInstagramProfileCache } from "../src/messengers/meta.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

const accountIds: string[] = [], eventKeys: string[] = [], peers: string[] = [];
const apiKey = "synthetic-accepted-question-gemini-key";
const igOrigin = "https://synthetic-accepted-question-ig.invalid";
const geminiOrigin = "https://synthetic-accepted-question-gemini.invalid";
let savedSettings: Awaited<ReturnType<typeof settingsSnapshot>>;
let revisionId: string;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
function settingsSnapshot() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, metaVerifyToken: true,
  geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true,
} }); }
const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
const decision = (question: "callback_consent" | "budget" | "phone" | "none" | "clarify_previous" | "name", refs: string[] = []) =>
  [{ text: JSON.stringify({ kind: "reply", refs, social: "none", question }) }];

async function fixture() {
  const id = randomUUID(), externalId = `question-own-${id}`, peer = `question-peer-${id}`;
  const secret = `synthetic-question-secret-${id}`, token = `synthetic-question-token-${id}`;
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId, enabled: true,
    username: `synthetic_question_agency_${id.replaceAll("-", "")}`, title: "Synthetic accepted callback question",
    token: encryptSecret(token), appSecret: encryptSecret(secret) } });
  accountIds.push(id); peers.push(peer); resetAccountsCache(); resetMetaAccountCredsCache();
  await rollout.allowDm({ peer, accountId: id, accountExternalId: externalId });
  const physicalPosts: string[] = [], generations: unknown[] = [];
  let rounds: unknown[][] = [];
  let onPhysicalPost: ((text: string) => Promise<Response>) | undefined;
  const fakeHttp = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url)), headers = new Headers(init?.headers);
    if (u.origin === igOrigin) {
      expect(u.searchParams.get("access_token")).toBe(token);
      if (u.pathname === `/${GRAPH_VERSION}/${peer}` && init?.method === "GET") {
        expect(u.searchParams.get("fields")).toBe("username");
        expect([...u.searchParams.keys()].sort()).toEqual(["access_token", "fields"]);
        return new Response(JSON.stringify({ id: peer, username: "synthetic_question_customer" }));
      }
      if (u.pathname === `/${GRAPH_VERSION}/me/messages` && init?.method === "POST") {
        expect([...u.searchParams.keys()]).toEqual(["access_token"]);
        const body = JSON.parse(String(init.body));
        expect(body.recipient).toEqual({ id: peer }); expect(typeof body.message?.text).toBe("string");
        expect(Object.keys(body.message)).toEqual(["text"]);
        physicalPosts.push(body.message.text);
        return onPhysicalPost ? onPhysicalPost(body.message.text)
          : new Response(JSON.stringify({ message_id: `synthetic-question-mid-${randomUUID()}` }));
      }
    }
    if (u.origin === geminiOrigin && init?.method === "POST" && headers.get("x-goog-api-key") === apiKey) {
      if (u.pathname === "/gemini/v1beta/models/gemini-3.6-flash:countTokens") {
        const body = JSON.parse(String(init.body));
        expect(body.generateContentRequest.systemInstruction.parts[0].text).toContain("Royal Home");
        return new Response(JSON.stringify({ totalTokens: 1000 }));
      }
      if (u.pathname === "/gemini/v1beta/models/gemini-3.6-flash:generateContent") {
        const body = JSON.parse(String(init.body));
        const declarations = body.tools?.flatMap((tool: { functionDeclarations?: Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }> }) => tool.functionDeclarations ?? []) ?? [];
        if (declarations.length === 1 && declarations[0].name === "submit_reply") {
          // Existing Client autopilot is a separate real background consumer.
          // Its physical structured extraction must not steal the core script.
          const args = declarations[0].parameters?.properties?.score ? { score: 50, reason: "Synthetic isolated extraction", insight: null } : {};
          return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "submit_reply", args } }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
        }
        generations.push(body);
        const parts = rounds.shift(); if (!parts) throw new Error("Unexpected extra actual model round");
        return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }));
      }
    }
    throw new Error("Unexpected physical I/O in accepted-question fixture");
  });
  vi.stubGlobal("fetch", fakeHttp);
  async function intake(text: string) {
    const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
      sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: randomUUID(), text },
    }] }] }));
    const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
    registerAuthenticatedMetaCustomerRequest(request);
    const result = await persistVerifiedCustomerIngressBatch(request);
    expect(result.status, JSON.stringify(result)).toBe("persisted");
    if (result.status !== "persisted" || result.tickets.length !== 1) throw new Error("Actual signed question intake unavailable");
    const key = result.tickets[0].eventKey; eventKeys.push(key);
    // Do not let a generic test worker consume this fixture outside its oracle.
    await prisma.backgroundJob.updateMany({ where: { dedupeKey: `customer-inbox-consume:${key}` }, data: { runAt: new Date("2099-01-01") } });
    return key;
  }
  async function run(key: string, script: unknown[][]) {
    expect(rounds).toHaveLength(0); rounds = [...script];
    const result = await consumeCustomerInboxTicket(key);
    expect(result.status, JSON.stringify(result)).toBe("planned");
    if (result.status !== "planned") throw new Error(`Actual core did not plan: ${JSON.stringify(result)}`);
    expect(rounds).toHaveLength(0); expect(result.partIds).toHaveLength(1);
    await prisma.backgroundJob.updateMany({ where: { dedupeKey: `customer-outbox-dispatch:${result.partIds[0]}` }, data: { runAt: new Date("2099-01-01") } });
    return prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
  }
  async function questionA(language: "ru" | "tg", number: string | null, question: "callback_consent" | "budget" | "name" = "callback_consent") {
    const text = number ? language === "ru" ? `Мой номер ${number}. Хочу купить квартиру.`
      : `Рақами ман ${number}. Барои харидани хона маслиҳат диҳед.`
      : language === "ru" ? "Хочу купить квартиру, нужна консультация." : "Хона харидан мехоҳам, маслиҳат лозим аст.";
    const key = await intake(text);
    const script = number ? [[{ functionCall: { name: "save_contact", args: { phone: number }, id: `contact-${randomUUID()}` } }], decision(question, ["e0"])]
      : [decision(question)];
    const part = await run(key, script);
    const payload = decodeCustomerOutboxPayload(part); expect(payload.kind).toBe("text");
    if (payload.kind !== "text") throw new Error("Actual renderer text required");
    if (question === "callback_consent") {
      expect(payload.text.endsWith(customerAgentCallbackQuestionText(language))).toBe(true);
      expect(decodeCustomerOutboxPublicData(part)).toMatchObject({ agentRevisionId: revisionId, observations: [],
        callbackQuestion: { version: 1, kind: "callback_consent", language } });
    } else if (question === "name") expect(decodeCustomerOutboxPublicData(part)).toMatchObject({
      agentRevisionId: revisionId, observations: [], nameQuestion: { version: 1, kind: "name", language },
    });
    else expect(decodeCustomerOutboxPublicData(part)).toBeNull();
    return { key, part };
  }
  async function beforeClaim(key: string) {
    const prepared = await prepareCustomerDmInboxCoreContext(key);
    expect(prepared.status, JSON.stringify(prepared)).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("Actual post-consent context did not prepare");
    const lane = prepared.lane, checked = await revalidateCustomerPrincipal(lane.principal);
    expect(checked.status).toBe("current");
    const current = await loadAcceptedCustomerState(lane.ticket);
    if (!current) throw new Error("Actual accepted state absent before claim");
    expect(lane.principal.authority.fence).toEqual(current.fence);
    expect(authenticatedInputMatchesFence(lane.authenticatedInput, current.fence)).toBe(true);
    const input = inspectAuthenticatedCustomerInput(lane.authenticatedInput);
    expect(input?.acceptedFence?.ownerToken).toBe(current.fence.ownerToken);
    const raw = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: key } });
    expect(raw.claimRevision).toBe(0n); expect(raw.leaseOwner).toBeNull(); expect(raw.originCiphertext).toBeTruthy();
    const origin = decryptCustomerFinalOrigin(raw.originCiphertext!);
    expect(origin.eventKey).toBe(key); expect(origin.input.issuedAt).toBe(raw.receivedAt.getTime());
    // Semantic counters may advance through this same IN's consent. Never
    // manually rebind the input/adopt a new controller to make the test pass.
    expect(BigInt(origin.input.acceptedFence.stateRevision)).toBeLessThanOrEqual(BigInt(current.fence.stateRevision));
    expect(origin.input.acceptedFence.ownershipEpoch).toBe(current.fence.ownershipEpoch);
    expect(origin.input.acceptedFence.bindingRevision).toBe(current.fence.bindingRevision);
    return { lane, inquiry: await prisma.customerInquiry.findUniqueOrThrow({ where: { id: current.fence.inquiryId } }) };
  }
  return { intake, run, questionA, beforeClaim, physicalPosts, generations,
    setPhysicalPost(fn: (text: string) => Promise<Response>) { onPhysicalPost = fn; } };
}

beforeAll(async () => {
  savedSettings = await settingsSnapshot();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true,
    botInstagramEnabled: true, metaVerifyToken: encryptSecret("synthetic-question-verify"),
    geminiApiKey: encryptSecret(apiKey), geminiApiKey2: null, geminiApiKeysExtra: [] } });
  vi.stubEnv("IG_PROXY_URL", igOrigin); vi.stubEnv("IG_PROXY_KEY", "");
  vi.stubEnv("GEMINI_PROXY_URL", geminiOrigin); vi.stubEnv("GEMINI_PROXY_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", apiKey); vi.stubEnv("GEMINI_API_KEY_2", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
  resetMetaAccountCredsCache(); resetAccountsCache(); resetInstagramProfileCache();
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
  rollout = await createCustomerRolloutFixture(revisionId);
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    activeAgentRevisionId: revisionId, capabilities: { publicRead: true, contactWrite: true, callbackWrite: true, newLeadBridge: false } } });
});

afterEach(async () => { await drainBackgroundTasks(5000); });

afterAll(async () => {
  try {
    await drainBackgroundTasks(5000);
    const tickets = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: eventKeys } }, select: { conversationId: true } });
    const nativeIds = [...new Set(tickets.flatMap(row => row.conversationId ? [row.conversationId] : []))];
    const natives = await prisma.botConversation.findMany({ where: { id: { in: nativeIds } }, select: { contactProfileId: true } });
    const profileIds = natives.flatMap(row => row.contactProfileId ? [row.contactProfileId] : []);
    const parts = await prisma.customerOutboxPart.findMany({ where: { ticketEventKey: { in: eventKeys } }, select: { id: true } });
    const actions = await prisma.customerAction.findMany({ where: { inquiry: { conversationId: { in: nativeIds } } }, select: { id: true, kind: true, resourceId: true } });
    const actionIds = actions.map(row => row.id), partIds = parts.map(row => row.id);
    const attempts = await prisma.customerDeliveryAttempt.findMany({ where: { partId: { in: partIds } }, select: { providerMid: true, reportedMid: true } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...eventKeys.map(key => `customer-inbox-consume:${key}`),
      ...partIds.map(id => `customer-outbox-dispatch:${id}`), ...actionIds.flatMap(id => [
        `customer-callback-notify:${id}`, `customer-contact-intake:${id}`, `customer-intake-policy:${id}`, `customer-intake-notify:${id}`])] } } });
    await prisma.processedMessage.deleteMany({ where: { channel: "out:meta", messageId: { in: attempts.flatMap(row =>
      [row.providerMid, row.reportedMid].filter((mid): mid is string => !!mid)) } } });
    await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: partIds } } });
    await prisma.customerOutboxPart.deleteMany({ where: { id: { in: partIds } } });
    await prisma.callbackRequest.deleteMany({ where: { customerActionId: { in: actionIds } } });
    await prisma.client.deleteMany({ where: { id: { in: actions.filter(a => a.kind === "new_lead" && a.resourceId).map(a => a.resourceId!) } } });
    await prisma.customerAction.deleteMany({ where: { id: { in: actionIds } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: eventKeys } } });
    await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
    await prisma.outboundShieldState.deleteMany({ where: { endpointScope: { messengerAccountId: { in: accountIds } }, subscriberId: { in: peers } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
    const identity = { kind: "IG_ID", value: { in: peers } };
    await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds }, clientId: null, mergedIntoId: null,
      identities: { some: identity, every: identity }, botConversations: { none: {} }, telegramConversations: { none: {} },
      telegramDirectConversations: { none: {} }, incomingCalls: { none: {} }, jobApplications: { none: {} }, mergedFrom: { none: {} },
      linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} }, mergesIn: { none: {} }, mergesOut: { none: {} } } });
    await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accountIds } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  } finally {
    try {
      try { if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings }); }
      finally { if (rollout) await rollout.restore(); }
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetAccountsCache(); resetMetaAccountCredsCache(); resetInstagramProfileCache(); }
  }
  // Own immutable compiled manifest/provider accounting retained as evidence.
});

describe("actual accepted callback question → real next signed IN", () => {
  it.each([["accepted", false], ["accepted", true], ["unknown", false]] as const)("creates an owned CRM lead only after settled %s send, working=%s; preserves wishes and never retries OUT or hands over", async (outcome, working) => {
    const number = phone();
    // Clock boundary only: all lead/action/assignment decisions still run on
    // the normal database services and receipts, without mocked permissions.
    const hours = vi.spyOn(workingHours, "isWithinWorkingHours").mockResolvedValue(working);
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: {
      publicRead: true, contactWrite: true, callbackWrite: true, newLeadBridge: true,
    } } });
    try {
      const f = await fixture(), a = await f.questionA("ru", number, "name");
      expect(await dispatchCustomerOutboxPart(a.part.id)).toMatchObject({ status: "accepted" });
      const b = await f.intake("Далер");
      const part = await f.run(b, [[{ functionCall: { name: "save_contact", args: { name: "Далер" }, id: "complete-name" } }], decision("none", ["e0"])]);
      const source = await prisma.customerAction.findFirstOrThrow({ where: { inquiryId: part.inquiryId!, kind: "contact", status: "COMMITTED" }, orderBy: { generation: "desc" } });
      expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `customer-contact-intake:${source.id}` } })).toMatchObject({
        type: "customer-contact-intake", payload: { version: 1, actionId: source.id }, maxAttempts: 24,
      });
      expect(await createCustomerLeadAfterContactAction(source.id)).toEqual({ status: "unavailable", reason: "turn_not_settled" });
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: part.originalNativeId } })).clientId).toBeNull();
      if (outcome === "unknown") f.setPhysicalPost(async () => new Response("{}"));
      expect(await dispatchCustomerOutboxPart(part.id)).toMatchObject({ status: outcome });
      const before = await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: part.id } });
      const created = await createCustomerLeadAfterContactAction(source.id);
      expect(created.status, JSON.stringify(created)).toBe("created");
      const action = await prisma.customerAction.findFirstOrThrow({ where: { inquiryId: part.inquiryId!, kind: "new_lead", status: "COMMITTED" } });
      const client = await prisma.client.findUniqueOrThrow({ where: { id: action.resourceId! } });
      expect(client).toMatchObject({ fullName: "Далер", phone: number, assignedAgentId: null, kind: "BUYER" });
      expect(client.requirementsNotes).toContain("Хочу купить квартиру");
      expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: part.originalNativeId } })).clientId).toBe(client.id);
      expect(await prisma.customerAction.count({ where: { inquiryId: part.inquiryId!, kind: { in: ["callback", "handover"] } } })).toBe(0);
      await createCustomerLeadAfterContactAction(source.id);
      expect(await prisma.customerAction.count({ where: { inquiryId: part.inquiryId!, kind: "new_lead" } })).toBe(1);
      expect(await prisma.customerDeliveryAttempt.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
      expect(f.physicalPosts).toHaveLength(2);
      if (outcome === "accepted") {
        await processNewCustomerLeadPolicy(action.id);
        const policyApplied = await prisma.customerAction.findUniqueOrThrow({ where: { id: action.id } });
        expect(policyApplied.policyResult).toMatchObject({ intakeOutcome: { mode: working ? "assigned" : "night_pending" } });
        const next = await f.beforeClaim(await f.intake("А рассрочка?"));
        expect(next.lane.context.knownPhoneSource).toBe("scoped_contact");
        const claim = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, next.lane.principal));
        expect(claim.status).toBe("claimed");
        const currentRevision = decodeCustomerAgentRevision(await prisma.customerAgentRevision.findUniqueOrThrow({ where: { id: revisionId } }));
        const remembered = await loadCustomerAgentVerifiedDmContext({ principal: next.lane.principal, revision: currentRevision });
        expect(remembered).toMatchObject({ status: "current", context: { intake: { role: "buyer" } } });
        if (remembered.status === "current") expect(JSON.stringify(remembered.context.turns)).toContain("Хочу купить квартиру");
        await prisma.customerPropertyIngressTicket.update({ where: { eventKey: next.lane.ticket.eventKey },
          data: { processingState: "FAILED", leaseOwner: null, leaseUntil: null } });
        // A staff rebind A→B→A must not revive the original contact proof merely
        // because the native row again happens to point at the same Client.
        const foreign = await prisma.client.create({ data: { fullName: "Synthetic unrelated rebind", phone: phone(),
          kind: "BUYER", source: "INSTAGRAM" } });
        try {
          await prisma.botConversation.update({ where: { id: part.originalNativeId }, data: { clientId: foreign.id } });
          await prisma.botConversation.update({ where: { id: part.originalNativeId }, data: { clientId: client.id } });
          const rebound = await f.beforeClaim(await f.intake("А условия?"));
          expect(rebound.lane.context.knownPhoneSource).toBe("none");
        } finally { await prisma.client.delete({ where: { id: foreign.id } }); }
      }
    } finally {
      hours.mockRestore();
      await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: {
        publicRead: true, contactWrite: true, callbackWrite: true, newLeadBridge: false,
      } } });
    }
  });
  it.each([["ru", "Далер"], ["tg", "Фаррух"]] as const)("accepted %s name question saves literal next name without phone, callback or staff transfer", async (language, name) => {
    const f = await fixture(), a = await f.questionA(language, null, "name");
    expect(await dispatchCustomerOutboxPart(a.part.id)).toMatchObject({ status: "accepted" });
    const b = await f.intake(name);
    await f.run(b, [[{ functionCall: { name: "save_contact", args: { name }, id: "literal-name" } }], decision("none", ["e0"])]);
    const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: b } });
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: ticket.conversationId! } });
    expect(inquiry.claimedContact).toMatchObject({ name });
    expect(await prisma.customerAction.findMany({ where: { inquiryId: inquiry.id }, select: { kind: true, status: true } })).toEqual([
      { kind: "contact", status: "COMMITTED" },
    ]);
  });

  it("a prepared but unaccepted name question does not authorize a guessed contact", async () => {
    const f = await fixture(); await f.questionA("ru", null, "name");
    const b = await f.intake("Далер");
    await f.run(b, [[{ functionCall: { name: "save_contact", args: { name: "Далер" }, id: "not-accepted-name" } }], decision("name")]);
    const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: b } });
    expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: ticket.conversationId! } } })).toBe(0);
  });
  it.each([["ru", "Да"], ["tg", "Ҳа"]] as const)("%s accepted question and tiny yes commit exactly one real callback", async (language, yes) => {
    const f = await fixture(), number = phone(), a = await f.questionA(language, number);
    expect(await dispatchCustomerOutboxPart(a.part.id)).toEqual({ status: "accepted" });
    const attempt = await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: a.part.id } });
    expect(attempt.outcome).toBe("ACCEPTED"); expect(attempt.providerMid).toBeTruthy();
    const b = await f.intake(yes), prepared = await f.beforeClaim(b);
    const slot = customerActionIntentsSchema.parse(prepared.inquiry.actionIntents).callback;
    expect(slot).toMatchObject({ status: "open", consent: { originalEventKey: b,
      acceptedQuestion: { partId: a.part.id, attemptId: attempt.id, providerMid: attempt.providerMid,
        questionEventKey: a.key, affirmationEventKey: b } } });
    const generation = slot!.generation;
    const partB = await f.run(b, [[{ functionCall: { name: "request_callback", args: { topic: yes }, id: "callback-yes" } }], decision("none", ["e0"])]);
    expect(decodeCustomerOutboxPayload(partB)).toMatchObject({ kind: "text" });
    const action = await prisma.customerAction.findFirstOrThrow({ where: { inquiryId: prepared.inquiry.id, kind: "callback" } });
    expect(action).toMatchObject({ status: "COMMITTED", generation: BigInt(generation) });
    expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { customerActionId: action.id } })).toMatchObject({ phone: number, lifecycleStatus: "QUEUED" });
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-callback-notify:${action.id}` } })).toBe(1);
    const generated = f.generations.length;
    expect(await consumeCustomerInboxTicket(b)).toEqual({ status: "unchanged", reason: "already_planned" });
    expect(f.generations).toHaveLength(generated);
    expect(await prisma.customerAction.count({ where: { inquiryId: prepared.inquiry.id, kind: "callback" } })).toBe(1);
    expect(await prisma.callbackRequest.count({ where: { customerActionId: action.id } })).toBe(1);
  });

  it("actual 2xx without MID stays UNKNOWN, denies yes and never resends", async () => {
    const f = await fixture(), a = await f.questionA("ru", phone());
    f.setPhysicalPost(async () => new Response("{}", { status: 200 }));
    expect(await dispatchCustomerOutboxPart(a.part.id)).toEqual({ status: "unknown" });
    expect(await dispatchCustomerOutboxPart(a.part.id)).toEqual({ status: "unknown" });
    expect(f.physicalPosts).toHaveLength(1);
    expect(await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: a.part.id } })).toMatchObject({ outcome: "UNKNOWN", providerMid: null });
    const b = await f.intake("Да"), generatedBefore = f.generations.length;
    // Actual P11 deliberately holds a new ambiguous sender while its own
    // UNKNOWN send exists. Never fake FINAL/principal just to reach the kernel.
    expect(await consumeCustomerInboxTicket(b)).toMatchObject({ status: "held", reason: "delivery_ambiguous" });
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: a.part.inquiryId! } });
    expect(customerActionIntentsSchema.parse(inquiry.actionIntents).callback).toBeUndefined();
    const rawB = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: b } });
    expect(rawB.originCiphertext).toBeNull(); expect(rawB.agentRevisionId).toBeNull();
    expect(f.generations).toHaveLength(generatedBefore);
    expect(await prisma.customerAction.count({ where: { inquiryId: inquiry.id, kind: "callback" } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: a.part.originalNativeId } })).toBe(0);
  });

  it("actually accepted unrelated question without callback sideband cannot grant callback", async () => {
    const f = await fixture(), a = await f.questionA("ru", phone(), "budget");
    expect(await dispatchCustomerOutboxPart(a.part.id)).toEqual({ status: "accepted" });
    const b = await f.intake("Да"), prepared = await f.beforeClaim(b);
    expect(customerActionIntentsSchema.parse(prepared.inquiry.actionIntents).callback).toBeUndefined();
    await f.run(b, [[{ functionCall: { name: "request_callback", args: { topic: "Да" }, id: "denied-budget" } }], decision("clarify_previous")]);
    expect(await prisma.customerAction.count({ where: { inquiryId: prepared.inquiry.id, kind: "callback" } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: a.part.originalNativeId } })).toBe(0);
  });

  it("MID accepted after B RAW arrival cannot retrospectively authorize B before FINAL", async () => {
    const f = await fixture(), a = await f.questionA("ru", phone());
    let entered!: () => void, release!: (response: Response) => void;
    const inPost = new Promise<void>(resolve => { entered = resolve; });
    const heldPost = new Promise<Response>(resolve => { release = resolve; });
    f.setPhysicalPost(async () => { entered(); return heldPost; });
    const sending = dispatchCustomerOutboxPart(a.part.id);
    let b: string, sent: Awaited<ReturnType<typeof dispatchCustomerOutboxPart>> | undefined;
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([inPost, new Promise<never>((_, reject) => {
        barrierTimer = setTimeout(() => reject(new Error("Physical POST barrier not reached")), 4000); barrierTimer.unref();
      })]);
      b = await f.intake("Да");
      const raw = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: b } });
      expect(raw.originCiphertext).toBeNull(); expect(raw.conversationId).toBeNull();
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(raw.receivedAt.getTime()), { timeout: 1000 });
    } finally {
      if (barrierTimer) clearTimeout(barrierTimer);
      release(new Response(JSON.stringify({ message_id: `synthetic-late-question-${randomUUID()}` })));
      sent = await sending; // Own pending work closes even if the intake oracle failed.
    }
    expect(sent).toEqual({ status: "accepted" });
    const rawB = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: b! } });
    const accepted = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: a.part.id } });
    expect(accepted.acceptedAt!.getTime()).toBeGreaterThan(rawB.receivedAt.getTime());
    const prepared = await f.beforeClaim(b!);
    expect(customerActionIntentsSchema.parse(prepared.inquiry.actionIntents).callback).toBeUndefined();
    await f.run(b!, [[{ functionCall: { name: "request_callback", args: { topic: "Да" }, id: "denied-late" } }], decision("clarify_previous")]);
    expect(await prisma.customerAction.count({ where: { inquiryId: prepared.inquiry.id, kind: "callback" } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: a.part.originalNativeId } })).toBe(0);
  });

  // Three actual ingress/model/dispatch turns can exceed the global 20s budget
  // during a full Windows run under memory pressure. Keep the complete oracle.
  it("accepted yes with no phone keeps open generation; actual phone-only C completes that same intent", async () => {
    const f = await fixture(), a = await f.questionA("ru", null);
    expect(await dispatchCustomerOutboxPart(a.part.id)).toEqual({ status: "accepted" });
    const b = await f.intake("Да"), preparedB = await f.beforeClaim(b);
    const original = customerActionIntentsSchema.parse(preparedB.inquiry.actionIntents).callback;
    expect(original).toMatchObject({ status: "open", consent: { originalEventKey: b, acceptedQuestion: { questionEventKey: a.key } } });
    const partB = await f.run(b, [[{ functionCall: { name: "request_callback", args: { topic: "Да" }, id: "needs-phone" } }], decision("phone")]);
    expect(await prisma.customerAction.count({ where: { inquiryId: preparedB.inquiry.id } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: a.part.originalNativeId } })).toBe(0);
    expect(await dispatchCustomerOutboxPart(partB.id)).toEqual({ status: "accepted" });
    const number = phone(), c = await f.intake(number), preparedC = await f.beforeClaim(c);
    const continuation = customerActionIntentsSchema.parse(preparedC.inquiry.actionIntents).callback;
    expect(continuation?.generation).toBe(original?.generation);
    expect(continuation?.consent?.originalEventKey).toBe(b); expect(continuation?.evidenceRefs).toContain(c);
    await f.run(c, [[{ functionCall: { name: "request_callback", args: { topic: number }, id: "finish-callback" } }], decision("none", ["e0"])]);
    const action = await prisma.customerAction.findFirstOrThrow({ where: { inquiryId: preparedB.inquiry.id, kind: "callback" } });
    expect(action.generation.toString()).toBe(original?.generation);
    expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { customerActionId: action.id } })).toMatchObject({ phone: number });
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-callback-notify:${action.id}` } })).toBe(1);
    expect(await consumeCustomerInboxTicket(c)).toEqual({ status: "unchanged", reason: "already_planned" });
    expect(await prisma.customerAction.count({ where: { inquiryId: preparedB.inquiry.id, kind: "callback" } })).toBe(1);
  }, 60_000);
});
