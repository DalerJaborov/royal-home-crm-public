import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch, consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { runCustomerDmAgentTurn } from "../src/lib/customerDmAgentTurn.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "../src/lib/customerOutbox.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import * as runtimeModule from "../src/lib/customerAgentRuntime.js";
import * as actionModule from "../src/lib/customerActionJournal.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { customerDmRoutingForIncoming } from "../src/lib/customerAgentIngressRouting.js";

// Actual signed durable intake → FINAL → elected owner → real counted model
// adapter → tools → encrypted P12 plan. Only external HTTP is synthetic.
const accounts: string[] = [], events: string[] = [];
const cohortId = randomUUID();
const allowedEndpoints: Array<{ surface: "dm"; channel: "INSTAGRAM"; endpointScopeId: string }> = [];
const apiKey = "synthetic-root-customer-core-key";
let settings: Awaited<ReturnType<typeof readSettings>>, policy: Awaited<ReturnType<typeof readPolicy>>;
let revisionId: string;
let savedRolloutConfig: unknown;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } }); }

async function fixture(text = "Здравствуйте, хочу купить квартиру", legacyAtIntake = false) {
  const id = randomUUID(), externalId = `synthetic-dm-core-own-${id}`, peer = `synthetic-dm-core-peer-${id}`;
  const secret = `synthetic-dm-core-secret-${id}`, token = `synthetic-dm-core-token-${id}`;
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId,
    username: `synthetic_core_agency_${id.replaceAll("-", "")}`, title: "Synthetic full DM core", enabled: true,
    token: encryptSecret(token), appSecret: encryptSecret(secret) } }); accounts.push(id);
  const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId: id, accountExternalId: externalId }));
  if (!legacyAtIntake) allowedEndpoints.push({ surface: "dm", channel: "INSTAGRAM", endpointScopeId: endpoint.endpointScopeId });
  const allowed = [...allowedEndpoints];
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({ version: 1, cohortId,
    candidateRevisionId: revisionId, percentBasisPoints: 10_000, allowed })}::jsonb WHERE "id"='singleton'`;
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: randomUUID(), text },
  }] }] }));
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
  if (stored.status !== "persisted") throw new Error("Actual synthetic producer did not persist");
  expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel: "INSTAGRAM", accountId: id, accountExternalId: externalId })).toBe(true);
  const eventKey = stored.tickets[0].eventKey; events.push(eventKey);
  const io: string[] = [], bodies: unknown[] = [];
  let generated = 0, countOk = true;
  let onGenerate: (() => Promise<void>) | undefined;
  let replies: unknown[][] = [[{ text: JSON.stringify({ kind: "reply", refs: [], social: "greet", question: "budget" }) }]];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin === "https://synthetic-core-instagram.invalid" && u.pathname === `/v23.0/${peer}` &&
        u.searchParams.get("fields") === "username" && u.searchParams.get("access_token") === token &&
        [...u.searchParams.keys()].length === 2 && init?.method === "GET") {
      io.push("profile"); return new Response(JSON.stringify({ id: peer, username: "synthetic_core_customer" }));
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
  return { eventKey, io, bodies, setCountInvalid() { countOk = false; },
    setReplies(value: unknown[][]) { replies = value; }, setOnGenerate(value: () => Promise<void>) { onGenerate = value; } };
}

beforeAll(async () => {
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
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: "scoped", rolloutMode: "ACTIVE", activeAgentRevisionId: revisionId, capabilities: { publicRead: true },
  } });
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify({ version: 1, cohortId,
    candidateRevisionId: revisionId, percentBasisPoints: 10_000, allowed: [] })}::jsonb WHERE "id"='singleton'`;
});
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
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
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accounts } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
  if (policy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: policy.contractVersion, rolloutMode: policy.rolloutMode, capabilities: policy.capabilities!, activeAgentRevisionId: policy.activeAgentRevisionId,
  } });
  if (savedRolloutConfig === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
  else if (savedRolloutConfig !== undefined) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(savedRolloutConfig)}::jsonb WHERE "id"='singleton'`;
  // Immutable manifests and synthetic provider accounting remain in this own
  // disposable DB as evidence; no shared/foreign daily bucket is rewritten.
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
    expect(decodeCustomerOutboxPayload(row)).toEqual({ kind: "text", text: "Здравствуйте!\nКакой бюджет вы рассматриваете?" });
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-outbox-dispatch:${row.id}` } })).toBe(1);
    expect(await consumeCustomerInboxTicket(f.eventKey)).toEqual({ status: "unchanged", reason: "already_planned" });
    expect(f.io.filter(value => value === "count")).toHaveLength(1);
    expect(f.io.filter(value => value === "generate")).toHaveLength(1);
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } })).toMatchObject({ processingState: "PLANNED", leaseOwner: null });
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
