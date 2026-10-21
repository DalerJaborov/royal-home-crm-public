import { createHmac, randomInt, randomUUID } from "node:crypto";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { app } from "../src/app.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { createCustomerAgentMutationSession } from "../src/lib/customerAgentMutationSession.js";
import { inspectCustomerWriteAuthority } from "../src/lib/customerState.js";
import { loadCustomerActionReceipt } from "../src/lib/customerActionJournal.js";
import { revalidateCustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { GRAPH_VERSION } from "../src/messengers/metaGraph.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";
import { claimCustomerAgentTurnTx } from "../src/lib/customerAgentClaim.js";
import { recordCustomerRecruitmentAttachments } from "../src/lib/customerRecruitmentAttachments.js";
import { storeFetchedAttachments } from "../src/messengers/attachments.js";
import { privateFilePath } from "../src/lib/privateFiles.js";
import { createCustomerLeadAfterContactAction } from "../src/lib/customerNewLeadBridge.js";

// Normal PG: real raw HMAC → durable producer → FINAL recovery → recorded IN →
// actual principal/intent/authority/kernel/receipt continuation. ONLY bounded
// username GET is fake; unexpected/paid/provider POSTs throw. No forged grants.
const accounts: string[] = [], events: string[] = [], natives: string[] = [], peers: string[] = [], profileIds: string[] = [];
let savedSettings: Awaited<ReturnType<typeof settingsSnapshot>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
let hr: { id: string; token: string };
const hash = "8".repeat(64), manifest = { coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash,
  knowledgeSchemaHash: hash, knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 120_000 } };
const revisionId = customerAgentManifestId(manifest);
function settingsSnapshot() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, metaVerifyToken: true, botCanBookShowings: true, botCanHandleVacancies: true,
} }); }
function phone() { return `+99293${randomInt(1_000_000, 9_999_999)}`; }
function wait() { return { signal: new AbortController().signal, deadlineAt: Date.now() + 90_000 }; }
async function fixture(text: string) {
  const id = randomUUID(), externalId = `mutation-account-${id}`, secret = `mutation-secret-${id}`, token = `mutation-token-${id}`;
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId, title: "Synthetic mutation session",
    username: `mutation_agency_${id.replaceAll("-", "")}`, token: encryptSecret(token), appSecret: encryptSecret(secret), enabled: true } });
  accounts.push(id); resetAccountsCache();
  const peer = `mutation-peer-${randomUUID()}`, mid = randomUUID(); peers.push(peer);
  await rollout.allowDm({ peer, accountId: id, accountExternalId: externalId });
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid, text },
  }] }] }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  const admitted = await persistVerifiedCustomerIngressBatch(request);
  if (admitted.status !== "persisted" || admitted.tickets.length !== 1) throw new Error("Actual mutation fixture intake unavailable");
  const eventKey = admitted.tickets[0].eventKey; events.push(eventKey);
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url)), headers = new Headers(init?.headers);
    if (u.origin !== "https://graph.instagram.com" || u.pathname !== `/${GRAPH_VERSION}/${peer}` || u.search !== "?fields=username" ||
        init?.method !== "GET" || headers.get("Authorization") !== `Bearer ${token}`) throw new Error("Unexpected mutation fixture I/O");
    return new Response(JSON.stringify({ id: peer, username: "synthetic_mutation_customer" }));
  }); vi.stubGlobal("fetch", fetch);
  const prepared = await prepareCustomerDmInboxCoreContext(eventKey);
  if (prepared.status !== "prepared") throw new Error(`Actual mutation fixture context held: ${prepared.status}:${"reason" in prepared ? prepared.reason : ""}`);
  const lane = prepared.lane; natives.push(lane.ticket.conversationId);
  const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: lane.ticket.conversationId }, select: { contactProfileId: true } });
  if (native.contactProfileId) profileIds.push(native.contactProfileId);
  const created = await createCustomerAgentMutationSession(lane);
  if (created.status !== "ready") throw new Error(`Actual mutation session held: ${created.reason}`);
  return { lane, session: created.session, inquiryId: lane.principal.authority.fence.inquiryId, fetch };
}
async function zeroEffects(inquiryId: string) { expect(await prisma.customerAction.count({ where: { inquiryId } })).toBe(0); }
beforeAll(async () => {
  const actor = await prisma.agent.create({ data: { fullName: "Synthetic recruitment reviewer", phone: `synthetic-hr-${randomUUID()}`,
    role: "MANAGER", passwordHash: "synthetic-unused-password-hash" } });
  hr = { id: actor.id, token: signAccessToken({ sub: actor.id, role: "MANAGER" }) };
  savedSettings = await settingsSnapshot();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true,
    metaVerifyToken: encryptSecret("synthetic-mutation-verify-token"), botCanHandleVacancies: true } });
  await prisma.customerAgentRevision.upsert({ where: { id: revisionId }, create: { id: revisionId, manifestJson: manifest }, update: {} });
  rollout = await createCustomerRolloutFixture(revisionId);
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true, callbackWrite: true, handoverWrite: true }, activeAgentRevisionId: revisionId } });
  vi.stubEnv("IG_PROXY_URL", ""); vi.stubEnv("GEMINI_PROXY_URL", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  const actions = await prisma.customerAction.findMany({ where: { inquiry: { conversationId: { in: natives } } }, select: { id: true } });
  const ids = actions.map(row => row.id);
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...events.map(key => `customer-inbox-consume:${key}`),
    ...ids.flatMap(id => [`customer-callback-notify:${id}`, `customer-contact-intake:${id}`])] } } });
  await prisma.callbackRequest.deleteMany({ where: { customerActionId: { in: ids } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
  await prisma.customerAction.deleteMany({ where: { id: { in: ids } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
  await prisma.outboundShieldState.deleteMany({ where: { endpointScope: { messengerAccountId: { in: accounts } } } });
  const ownedIdentity = { kind: "IG_ID", value: { in: peers } };
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds }, clientId: null, mergedIntoId: null,
    identities: { some: ownedIdentity, every: ownedIdentity }, botConversations: { none: {} }, telegramConversations: { none: {} },
    telegramDirectConversations: { none: {} }, incomingCalls: { none: {} }, jobApplications: { none: {} }, mergedFrom: { none: {} },
    linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} }, mergesIn: { none: {} }, mergesOut: { none: {} } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accounts } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } }); resetAccountsCache();
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  if (rollout) await rollout.restore();
  if (hr) await prisma.agent.delete({ where: { id: hr.id } });
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  // Content-addressed fixture manifest retained; historical no-delete guard is not bypassed.
});
it("current literal phone commits one contact and yields genuine continued principal + fresh receipt authority", async () => {
  const value = phone(), f = await fixture(value), before = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.lane.ticket.eventKey } });
  expect(await f.session.execute({ name: "save_contact", args: { phone: value } }, wait())).toEqual({ status: "observed", observation: { kind: "receipt", outcome: "contact_saved" } });
  expect(f.session.principal).not.toBe(f.lane.principal); expect((await revalidateCustomerPrincipal(f.lane.principal)).status).toBe("denied");
  expect(await f.session.assertCurrent(wait())).toBe(true); expect(f.session.receipts).toHaveLength(1); expect(f.session.receiptAuthorities).toHaveLength(1);
  expect(inspectCustomerWriteAuthority(f.session.receiptAuthorities[0])).toMatchObject({ purpose: "receipt", kind: "contact", eventKey: f.lane.ticket.eventKey });
  expect(await loadCustomerActionReceipt(f.session.receiptAuthorities[0], f.session.receipts[0].actionId)).toMatchObject({ status: "already_committed" });
  const after = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.lane.ticket.eventKey } });
  expect(after.order).toBe(before.order); expect(after.receivedAt).toEqual(before.receivedAt); expect(after.originCapturedAt).toEqual(before.originCapturedAt);
  expect(await prisma.customerAction.count({ where: { inquiryId: f.inquiryId, kind: "contact" } })).toBe(1);
  expect(await prisma.client.count({ where: { customerIntakeActionId: f.session.receipts[0].actionId } })).toBe(0);
  expect(JSON.stringify({ status: "observed", observation: { kind: "receipt", outcome: f.session.receipts[0].outcome } })).not.toContain(value);
});
it("genuine SMM candidate input saves an own HR application and one receipt without phone, lead, callback or HR verdict", async () => {
  const key = `synthetic-video-${randomUUID()}`;
  await prisma.recruitmentPosition.create({ data: { key, titleRu: "SMM-специалист / видеограф", titleTg: "Мутахассиси SMM / видеограф", isOpen: true } });
  try {
    const text = "Вакансия видеограф: снимаю и монтирую 2 года. Моя работа https://portfolio.invalid/reel/one";
    const f = await fixture(text);
    expect(f.session.availableToolNames).toContain("save_job_application");
    expect(f.session.availableToolNames).not.toContain("request_callback");
    const command = { name: "save_job_application", args: {} };
    const result = await f.session.execute(command, wait());
    expect(result).toEqual({ status: "observed", observation: { kind: "receipt", outcome: "job_application_saved" } });
    expect(await f.session.execute(command, wait())).toEqual(result);
    const rows = await prisma.jobApplication.findMany({ where: { customerInquiryId: f.inquiryId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customerPositionKey: key, customerApplicationRevision: 1n, rawText: text,
      phone: null, clientId: null, conversationId: null, eligible: null, priority: null, interviewAt: null, status: "NEW" });
    expect(rows[0].customerPortfolio).toEqual([{ kind: "link", url: "https://portfolio.invalid/reel/one", sourceEventKey: f.lane.ticket.eventKey }]);
    expect(await prisma.customerAction.count({ where: { inquiryId: f.inquiryId } })).toBe(1);
    expect(await prisma.callbackRequest.count({ where: { customerActionId: f.session.receipts[0].actionId } })).toBe(0);
    expect(await prisma.client.count({ where: { customerIntakeActionId: f.session.receipts[0].actionId } })).toBe(0);
    expect((await loadCustomerActionReceipt(f.session.receiptAuthorities[0], f.session.receipts[0].actionId)).status).toBe("already_committed");
    expect(JSON.stringify(result)).not.toContain("portfolio.invalid");
  } finally {
    await prisma.jobApplication.deleteMany({ where: { customerPositionKey: key } });
    await prisma.recruitmentPosition.delete({ where: { key } });
  }
});
it("closing an opening after the genuine session read denies intake without a journal row or success receipt", async () => {
  const key = `synthetic-closed-${randomUUID()}`;
  await prisma.recruitmentPosition.create({ data: { key, titleRu: "SMM-специалист / видеограф", titleTg: "Мутахассиси SMM / видеограф", isOpen: true } });
  try {
    const f = await fixture("Вакансия видеограф: мои работы https://portfolio.invalid/two");
    expect(f.session.availableToolNames).toContain("save_job_application");
    await prisma.recruitmentPosition.update({ where: { key }, data: { isOpen: false } });
    expect((await f.session.execute({ name: "save_job_application", args: {} }, wait())).status).toBe("denied");
    expect(f.session.receipts).toHaveLength(0); await zeroEffects(f.inquiryId);
    expect(await prisma.jobApplication.count({ where: { customerInquiryId: f.inquiryId } })).toBe(0);
  } finally { await prisma.recruitmentPosition.delete({ where: { key } }); }
});
it("a job candidate who supplies a name and phone stays an HR application even with the real-estate intake capability enabled", async () => {
  const key = `synthetic-job-contact-${randomUUID()}`;
  const policy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: { capabilities: true } });
  await prisma.recruitmentPosition.create({ data: { key, titleRu: "SMM-специалист / видеограф", titleTg: "Мутахассиси SMM / видеограф", isOpen: true } });
  try {
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: { publicRead: true, contactWrite: true,
      callbackWrite: true, handoverWrite: true, newLeadBridge: true } } });
    const value = phone(), f = await fixture(`Вакансия видеограф. Меня зовут Анвар. Мой номер ${value}.`);
    expect((await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, f.lane.principal))).status).toBe("claimed");
    expect((await f.session.execute({ name: "save_contact", args: { name: "Анвар", phone: value } }, wait())).status).toBe("observed");
    const contact = f.session.receipts.find(receipt => receipt.kind === "contact")!;
    expect((await f.session.execute({ name: "save_job_application", args: {} }, wait())).status).toBe("observed");
    expect(await createCustomerLeadAfterContactAction(contact.actionId)).toMatchObject({ status: "stale", reason: "current_intake_context_required" });
    expect(await prisma.client.count({ where: { customerIntakeActionId: contact.actionId } })).toBe(0);
    expect(await prisma.jobApplication.findFirst({ where: { customerInquiryId: f.inquiryId } })).toMatchObject({ name: "Анвар", phone: value, clientId: null });
  } finally {
    await prisma.jobApplication.deleteMany({ where: { customerPositionKey: key } });
    await prisma.recruitmentPosition.delete({ where: { key } });
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: policy.capabilities! } });
  }
});
it("keeps actual private portfolio bytes on the original signed user entry and own HR receipt, never a model file path", async () => {
  const key = `synthetic-media-${randomUUID()}`, directory = mkdtempSync(join(tmpdir(), "synthetic-recruitment-"));
  vi.stubEnv("PRIVATE_UPLOADS_DIR", directory);
  let savedFile: string | null = null;
  await prisma.recruitmentPosition.create({ data: { key, titleRu: "SMM-специалист / видеограф", titleTg: "Мутахассиси SMM / видеограф", isOpen: true } });
  try {
    const f = await fixture("Вакансия видеограф: присылаю свою работу");
    const claimed = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, f.lane.principal));
    expect(claimed.status).toBe("claimed"); if (claimed.status !== "claimed") throw Error("Genuine current claim required");
    const files = await storeFetchedAttachments({ images: [{ kind: "image", mediaType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6txAAAAAASUVORK5CYII=" }], audios: [] });
    expect(files).toHaveLength(1); savedFile = privateFilePath(files[0].file!)!; expect(savedFile).toBeTruthy();
    await recordCustomerRecruitmentAttachments(f.lane.principal, claimed.claim, files);
    await recordCustomerRecruitmentAttachments(f.lane.principal, claimed.claim, files);
    expect((await f.session.execute({ name: "save_job_application", args: { file: "foreign-private-file" } }, wait())).status).toBe("denied");
    expect((await f.session.execute({ name: "save_job_application", args: {} }, wait())).status).toBe("observed");
    const row = await prisma.jobApplication.findUniqueOrThrow({ where: { customerInquiryId_customerPositionKey: { customerInquiryId: f.inquiryId, customerPositionKey: key } } });
    expect(row.customerPortfolio).toEqual([{ ...files[0], sourceEventKey: f.lane.ticket.eventKey }]);
    const headers = { Authorization: `Bearer ${hr.token}` };
    const listing = await request(app).get("/api/v1/vacancies?bucket=incomplete&limit=200").set(headers);
    expect(listing.status).toBe(200);
    expect(listing.body.items.find((item: { id: string }) => item.id === row.id)).toMatchObject({
      customerApplicationRevision: "1", positionTitle: "SMM-специалист / видеограф", rejectReasons: [], missing: [],
    });
    const resource = `/api/v1/vacancies/${row.id}/portfolio/0`;
    expect((await request(app).get(resource)).status).toBe(401);
    const opened = await request(app).get(resource).set(headers);
    expect(opened.status).toBe(200); expect(opened.headers["cache-control"]).toContain("no-store");
    expect(opened.headers["content-type"]).toContain("image/png");
    await prisma.jobApplication.update({ where: { id: row.id }, data: { status: "NOT_CANDIDATE" } });
    expect((await request(app).get(resource).set(headers)).status).toBe(404);
  } finally {
    await prisma.jobApplication.deleteMany({ where: { customerPositionKey: key } });
    await prisma.recruitmentPosition.delete({ where: { key } });
    if (savedFile) unlinkSync(savedFile); rmdirSync(directory);
  }
});
it.each([["Меня зовут Али.", "Али"], ["Номи ман Фаррух.", "Фаррух"]])("real explicit RU/TG name-only input saves contact: %s", async (text, name) => {
  const f = await fixture(text);
  expect(await f.session.execute({ name: "save_contact", args: { name } }, wait())).toMatchObject({ status: "observed", observation: { outcome: "contact_saved" } });
});
it.each(["Это не мой номер", "Мне прислали номер", "Запишите номер собственника", "Рақами ман нест"]) (
  "refusal/reported/third-party current text denies before intent/state/resource mutation: %s", async prefix => {
    const value = phone(), f = await fixture(`${prefix} ${value}`), before = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } });
    expect((await f.session.execute({ name: "save_contact", args: { phone: value } }, wait())).status).toBe("denied");
    const after = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } });
    expect(after.stateRevision).toBe(before.stateRevision); expect(after.intentRevision).toBe(before.intentRevision); expect(after.actionIntents).toEqual(before.actionIntents);
    await zeroEffects(f.inquiryId);
  });
it("same-IN contact then callback refreshes prior receipt grants instead of adopting stale authority", async () => {
  const value = phone(), text = `Мой номер ${value}. Перезвоните мне`, f = await fixture(text);
  expect((await f.session.execute({ name: "save_contact", args: { phone: value } }, wait())).status).toBe("observed");
  const oldAuthority = f.session.receiptAuthorities[0], contactReceipt = f.session.receipts[0];
  expect(await f.session.execute({ name: "request_callback", args: { topic: text } }, wait())).toMatchObject({ status: "observed", observation: { outcome: "callback_requested" } });
  expect(f.session.receipts).toHaveLength(2); expect(f.session.receiptAuthorities).toHaveLength(2);
  expect((await loadCustomerActionReceipt(oldAuthority, contactReceipt.actionId)).status).toBe("stale");
  for (const [index, receipt] of f.session.receipts.entries()) {
    expect(inspectCustomerWriteAuthority(f.session.receiptAuthorities[index])?.fence).toEqual(f.session.principal.authority.fence);
    expect((await loadCustomerActionReceipt(f.session.receiptAuthorities[index], receipt.actionId)).status).toBe("already_committed");
  }
  expect(await prisma.callbackRequest.count({ where: { customerActionId: f.session.receipts[1].actionId } })).toBe(1);
});
it("dropped ACK after actual commit recovers exact journal read-only, never executes a duplicate", async () => {
  const value = phone(), f = await fixture(value), original = prisma.$transaction.bind(prisma); let dropped = false;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any, options?: any) => {
    const result = await original(callback, options);
    if (!dropped && result && typeof result === "object" && "status" in result && result.status === "created" &&
        "receipt" in result && result.receipt && typeof result.receipt === "object" && "inquiryId" in result.receipt && result.receipt.inquiryId === f.inquiryId) {
      dropped = true; throw new Error("Synthetic lost acknowledgement AFTER committed transaction");
    }
    return result;
  });
  try { expect((await f.session.execute({ name: "save_contact", args: { phone: value } }, wait())).status).toBe("observed"); }
  finally { spy.mockRestore(); }
  expect(dropped).toBe(true); expect(await prisma.customerAction.count({ where: { inquiryId: f.inquiryId, kind: "contact" } })).toBe(1);
  expect((await f.session.execute({ name: "save_contact", args: { phone: value } }, wait())).status).toBe("observed");
  expect(await prisma.customerAction.count({ where: { inquiryId: f.inquiryId } })).toBe(1);
});
it("the actual legacy showing switch restricts discovery and is rechecked before an already offered write", async () => {
  const policy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
  const prior = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botCanBookShowings: true } });
  try {
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
      capabilities: { publicRead: true, contactWrite: true, callbackWrite: true, handoverWrite: true, showingWrite: true } } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanBookShowings: true } });
    const offered = await fixture("Хочу посмотреть квартиру завтра");
    expect(offered.session.availableToolNames).toContain("book_showing");
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanBookShowings: false } });
    expect(await offered.session.execute({ name: "book_showing", args: { propertyShortId: 1, at: "2027-01-01T10:00:00+05:00" } }, wait()))
      .toMatchObject({ status: "denied", reason: "showings_disabled" });
    await zeroEffects(offered.inquiryId);
    const disabled = await fixture("Можно осмотр?");
    expect(disabled.session.availableToolNames).not.toContain("book_showing");
  } finally {
    await prisma.settings.update({ where: { id: "singleton" }, data: prior });
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: policy.capabilities! } });
  }
});

it("handover complaint commits real existing task/job and HOLD without BOT revival or customer ACK", async () => {
  const text = "Мне не звонили", f = await fixture(text);
  expect(await f.session.execute({ name: "request_handover", args: { topic: text } }, wait())).toMatchObject({ status: "denied", reason: "handover_committed_ack_purpose_unavailable" });
  expect(f.session.state).toBe("handover_committed"); expect(f.session.receipts).toEqual([]); expect(f.session.receiptAuthorities).toEqual([]);
  expect(f.session.committedReceipts).toHaveLength(1); const receipt = f.session.committedReceipts[0];
  expect(receipt.outcome).toBe("handover_requested");
  expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { customerActionId: receipt.actionId } })).toMatchObject({ requestKind: "HUMAN", lifecycleStatus: "QUEUED" });
  expect(await prisma.backgroundJob.findUnique({ where: { dedupeKey: `customer-callback-notify:${receipt.actionId}` } })).not.toBeNull();
  expect((await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } })).ownerMode).toBe("HOLD"); expect(await f.session.assertCurrent(wait())).toBe(false);
});
it("copied principal and stale owner are denied without effects", async () => {
  const value = phone(), f = await fixture(value);
  expect(await createCustomerAgentMutationSession({ ...f.lane, principal: JSON.parse(JSON.stringify(f.lane.principal)) })).toMatchObject({ status: "held" });
  await prisma.botConversation.update({ where: { id: f.lane.ticket.conversationId }, data: { pausedUntil: new Date(Date.now() + 600_000) } });
  expect((await f.session.execute({ name: "save_contact", args: { phone: value } }, wait())).status).toBe("denied"); await zeroEffects(f.inquiryId);
});
it("already aborted operation causes no contact intent/resource mutation", async () => {
  const value = phone(), f = await fixture(value), before = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } }), controller = new AbortController(); controller.abort();
  expect((await f.session.execute({ name: "save_contact", args: { phone: value } }, { signal: controller.signal, deadlineAt: Date.now() + 90_000 })).status).toBe("denied");
  const after = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } }); expect(after.stateRevision).toBe(before.stateRevision); expect(after.intentRevision).toBe(before.intentRevision);
  await zeroEffects(f.inquiryId);
});
