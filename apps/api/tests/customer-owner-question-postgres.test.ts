import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { customerOwnerReplyTargetSchema } from "@royal-home/shared";
import request from "supertest";
import { app } from "../src/app.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { prisma } from "../src/db.js";
import { loadCustomerStateSnapshot } from "../src/lib/customerState.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { createOwnerQuestionTx } from "../src/lib/ownerQuestionMutation.js";
import { answerOwnerQuestion, notifyStaleOwnerQuestions } from "../src/lib/ownerQuestionAnswer.js";
import { loadPendingOwnerQuestions } from "../src/lib/ownerQuestions.js";
import { customerOwnerQuestionNotifyJob } from "../src/jobs/customerOwnerQuestionNotify.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

const { push, shortReply } = vi.hoisted(() => ({ push: vi.fn(async (..._args: unknown[]) => 1), shortReply: vi.fn(async (..._args: unknown[]) => null) }));
vi.mock("../src/push.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: push }));
vi.mock("../src/ai/leadQualifier.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/leadQualifier.js")>()), shortAgentReply: shortReply }));

/** Real PG effect-kernel/staff/job gates. EXECUTING journal rows are trusted
 * server fixtures, NOT proof of customer authorization; signed ingress and the
 * root journal dispatcher need their separate integration tests. No provider,
 * customer principal or permission grant is mocked. */
const runId = randomUUID();
let fixture: CustomerMessengerFixture;
let directorId: string; let dashboardOnlyId: string; let ownAgentId: string; let maskedStaffId: string; let propertyId: string;
const actionIds: string[] = [];
const questionIds: string[] = [];
const extraFixtures: CustomerMessengerFixture[] = [];
const inquiryIds: string[] = [];

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const createAgent = (role: "DIRECTOR" | "AGENT", permissions?: { granted: string[]; revoked: string[] }) => prisma.agent.create({ data: {
    fullName: `Owner fixture ${runId}`, phone: `synthetic-owner-${randomUUID()}`, passwordHash: "not-a-login", role, permissions,
  } });
  directorId = (await createAgent("DIRECTOR")).id;
  dashboardOnlyId = (await createAgent("AGENT", { granted: ["dashboard.analytics"], revoked: ["messages.view", "messages.viewOwn"] })).id;
  ownAgentId = (await createAgent("AGENT", { granted: ["dashboard.analytics", "messages.viewOwn"], revoked: ["messages.view"] })).id;
  maskedStaffId = (await createAgent("AGENT", { granted: ["dashboard.analytics", "messages.view"], revoked: ["clients.viewPhone"] })).id;
  propertyId = (await prisma.property.create({ data: { title: `Public owner fixture ${runId}`, type: "APARTMENT", areaSqm: 65,
    price: 750000, currency: "TJS", status: "AVAILABLE", condition: "GOOD", publishedChannels: ["INSTAGRAM"] } })).id;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External I/O forbidden in owner question domain gate"); }));
});
afterAll(async () => {
  await prisma.ownerQuestion.deleteMany({ where: { id: { in: questionIds } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: actionIds.map(id => `customer_owner_question_notify:${id}`) } } });
  await prisma.customerAction.deleteMany({ where: { id: { in: actionIds } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  for (const extra of extraFixtures) await extra.dispose();
  await fixture?.dispose();
  if (propertyId) await prisma.property.delete({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, dashboardOnlyId, ownAgentId, maskedStaffId].filter(Boolean) } } });
  vi.unstubAllGlobals();
});

async function staged(route = fixture) {
  const native = await route.ensureConversation(`owner-peer-${randomUUID()}`);
  const nativeRow = await prisma.botConversation.findUniqueOrThrow({ where: { id: native.id }, select: { subscriberId: true } });
  // Durable ordering evidence only: this helper deliberately has no FINAL-IN
  // brand. It must not be presented as customer authorization for the journal.
  const admission = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: nativeRow.subscriberId,
    accountId: route.id, accountExternalId: route.externalId, transport: route.transport,
    eventKind: "message", eventId: randomUUID(), evidence: [], deferFocusUntilClassification: true });
  if (admission.status !== "admitted") throw new Error(`Kernel fixture admission denied: ${admission.reason}`);
  const state = await loadCustomerStateSnapshot({ conversationId: native.id });
  if (!state) throw new Error("Missing real canonical fixture state");
  inquiryIds.push(state.fence.inquiryId);
  const target = customerOwnerReplyTargetSchema.parse({ version: 1, nativeKind: "bot", inquiryId: state.fence.inquiryId,
    nativeId: native.id, channel: "INSTAGRAM", peer: state.fence.endpoint.peerId, accountId: route.id,
    endpointScopeId: route.transport.endpointScopeId, transportKey: route.transport.transportKey,
    scopeRevision: state.fence.scopeRevision, bindingRevision: state.fence.bindingRevision, generation: "1" });
  const actionId = randomUUID(); actionIds.push(actionId);
  await prisma.customerAction.create({ data: { id: actionId, inquiryId: target.inquiryId, kind: "owner_question", generation: 1n,
    status: "EXECUTING", stateRevision: BigInt(state.fence.stateRevision), intentRevision: BigInt(state.fence.intentRevision),
    ownershipEpoch: BigInt(state.fence.ownershipEpoch), bindingRevision: BigInt(target.bindingRevision),
    scopeRevision: BigInt(target.scopeRevision), policyRevision: BigInt(state.fence.policyRevision), evidenceRefs: [admission.ticket.eventKey] } });
  return { actionId, target, eventKey: admission.ticket.eventKey };
}
async function commitQuestion(route = fixture, questionText = `Есть ли мебель? ${runId}`) {
  const value = await staged(route);
  const question = await prisma.$transaction(async tx => {
    const saved = await createOwnerQuestionTx(tx, { ...value, propertyId, question: questionText, replyTarget: value.target });
    await tx.customerInquiry.update({ where: { id: value.target.inquiryId }, data: { actionIntents: {
      owner_question: { generation: "1", status: "committed", evidenceRefs: [value.eventKey] },
    } } });
    await tx.customerAction.update({ where: { id: value.actionId }, data: { status: "COMMITTED", resourceType: "OwnerQuestion",
      resourceId: saved.resourceId, receiptVersion: 2, publicRef: randomUUID(), resourceRevision: BigInt(saved.resourceRevision), committedAt: new Date() } });
    return saved;
  });
  questionIds.push(question.resourceId);
  const jobs = await prisma.backgroundJob.findMany({ where: { dedupeKey: `customer_owner_question_notify:${value.actionId}` } });
  expect(jobs).toHaveLength(1); expect(jobs[0].payload).toEqual({ version: 1, actionId: value.actionId });
  await prisma.backgroundJob.update({ where: { id: jobs[0].id }, data: { runAt: new Date("2099-01-01T00:00:00.000Z") } });
  return { ...value, questionId: question.resourceId };
}
async function row(id: string) { return prisma.ownerQuestion.findUniqueOrThrow({ where: { id } }); }

describe("Managed owner questions: local receipt, exact target and staff CAS", () => {
  it("twenty retained HELD answers cannot starve a later unanswered staff question", async () => {
    const held: string[] = [];
    for (let index = 0; index < 20; index++) {
      const value = await commitQuestion(); held.push(value.questionId);
      await prisma.ownerQuestion.update({ where: { id: value.questionId }, data: {
        askedAt: new Date(Date.UTC(2001, 0, 1, 0, index)), answer: "Ответ сохранён для доставки.",
        answeredAt: new Date("2001-01-02T00:00:00Z"), deliveryStatus: "HELD",
      } });
    }
    const pending = await commitQuestion();
    await prisma.ownerQuestion.update({ where: { id: pending.questionId }, data: { askedAt: new Date("2002-01-01T00:00:00Z") } });
    const queue = await loadPendingOwnerQuestions(20, directorId);
    expect(queue[0].id).toBe(pending.questionId);
    expect(queue[0].answer).toBeNull();
    expect(await prisma.ownerQuestion.count({ where: { id: { in: held }, deliveryStatus: "HELD", deliveredAt: null } })).toBe(20);
    expect((await loadPendingOwnerQuestions(100, directorId)).filter(item => held.includes(item.id))).toHaveLength(20);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // This queue-pressure fixture is intentionally older than all other staff
    // work. Remove only its own rows so later HTTP projection tests remain
    // independent of a saturated queue retained by an earlier test.
    await prisma.ownerQuestion.deleteMany({ where: { id: { in: [...held, pending.questionId] } } });
  });
  it("real staff HTTP answer requires a revision and acknowledges persistence without claiming delivery", async () => {
    const value = await commitQuestion();
    const token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
    const path = `/api/v1/me/owner-questions/${value.questionId}/answer`;
    const missing = await request(app).post(path).set("Authorization", `Bearer ${token}`).send({ answer: "Мебель остаётся в квартире." });
    expect(missing.status).toBe(400);
    expect((await row(value.questionId)).answer).toBeNull();
    const stale = await request(app).post(path).set("Authorization", `Bearer ${token}`).send({ answer: "Мебель остаётся в квартире.", expectedRevision: "2" });
    expect(stale.status).toBe(409);
    expect((await row(value.questionId)).answer).toBeNull();
    const saved = await request(app).post(path).set("Authorization", `Bearer ${token}`).send({ answer: "Мебель остаётся в квартире.", expectedRevision: "1" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, delivered: false, deliveryStatus: "HELD", managedRevision: "2" });
    expect(saved.body.message).toContain("сохранён");
    const duplicate = await request(app).post(path).set("Authorization", `Bearer ${token}`).send({ answer: "Другой ответ не заменяет первый.", expectedRevision: "1" });
    expect(duplicate.status).toBe(409);
    expect((await row(value.questionId)).answer).toBe("Мебель остаётся в квартире.");
    expect((await row(value.questionId)).deliveredAt).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("staff HTTP projection masks contacts in both question and saved answer according to current rights", async () => {
    const phone = "+992901234567", handle = "@synthetic_contact";
    const value = await commitQuestion(fixture, `Уточните по мебели: ${phone} ${handle}`);
    expect((await answerOwnerQuestion(value.questionId, `Ответ: ${phone} ${handle}`, directorId, { expectedRevision: "1" })).ok).toBe(true);
    const maskedToken = signAccessToken({ sub: maskedStaffId, role: "AGENT" });
    const masked = await request(app).get("/api/v1/me/owner-questions").set("Authorization", `Bearer ${maskedToken}`);
    expect(masked.status).toBe(200);
    const projection = masked.body.items.find((item: { id: string }) => item.id === value.questionId);
    expect(projection).toBeDefined();
    expect(projection.question).not.toContain("901234567");
    expect(projection.answer).not.toContain("901234567");
    expect(projection.question).not.toContain(handle);
    expect(projection.answer).not.toContain(handle);
    const full = await request(app).get("/api/v1/me/owner-questions").set("Authorization", `Bearer ${signAccessToken({ sub: directorId, role: "DIRECTOR" })}`);
    const fullProjection = full.body.items.find((item: { id: string }) => item.id === value.questionId);
    expect(fullProjection.question).toContain(phone);
    expect(fullProjection.answer).toContain(handle);
    expect((await row(value.questionId)).question).toContain(phone);
    expect((await row(value.questionId)).answer).toContain(handle);
  });
  it("dashboard-only staff token cannot use the managed HTTP answer or see the managed queue", async () => {
    const value = await commitQuestion(), token = signAccessToken({ sub: dashboardOnlyId, role: "AGENT" });
    const queue = await request(app).get("/api/v1/me/owner-questions").set("Authorization", `Bearer ${token}`);
    expect(queue.status).toBe(200);
    expect(queue.body.items.some((item: { id: string }) => item.id === value.questionId)).toBe(false);
    const result = await request(app).post(`/api/v1/me/owner-questions/${value.questionId}/answer`)
      .set("Authorization", `Bearer ${token}`).send({ answer: "Этот ответ не должен сохраниться.", expectedRevision: "1" });
    expect(result.status).toBe(403);
    expect((await row(value.questionId)).answer).toBeNull();
  });
  it("rejects the root client before any local effect", async () => {
    const value = await staged();
    await expect(createOwnerQuestionTx(prisma, { actionId: value.actionId, replyTarget: value.target, propertyId, question: "Мебель остаётся?" }))
      .rejects.toThrow("active customer transaction");
    expect(await prisma.ownerQuestion.count({ where: { customerActionId: value.actionId } })).toBe(0);
  });
  it("persists exact target and required notification atomically, with no second resource on duplicate", async () => {
    const value = await commitQuestion();
    const saved = await row(value.questionId);
    expect(saved).toMatchObject({ customerActionId: value.actionId, clientId: null, managedRevision: 1n, deliveryStatus: "QUEUED", deliveredAt: null });
    expect(saved.replyTarget).toEqual(value.target);
    await expect(prisma.$transaction(tx => createOwnerQuestionTx(tx, { actionId: value.actionId, propertyId, question: "Повтор", replyTarget: value.target }))).rejects.toThrow();
    expect(await prisma.ownerQuestion.count({ where: { customerActionId: value.actionId } })).toBe(1);
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer_owner_question_notify:${value.actionId}` } })).toBe(1);
  });
  it("required queue failure rolls back the new question", async () => {
    const value = await staged();
    await prisma.backgroundJob.create({ data: { type: "customer_owner_question_notify", payload: { version: 1, actionId: value.actionId },
      maxAttempts: 1, dedupeKey: `customer_owner_question_notify:${value.actionId}`, runAt: new Date("2099-01-01T00:00:00.000Z") } });
    await expect(prisma.$transaction(tx => createOwnerQuestionTx(tx, { actionId: value.actionId, propertyId,
      question: "Есть ли парковка?", replyTarget: value.target }))).rejects.toThrow();
    expect(await prisma.ownerQuestion.count({ where: { customerActionId: value.actionId } })).toBe(0);
  });
  it("two simultaneous staff answers have one CAS winner, persisted HELD before any OUT", async () => {
    const value = await commitQuestion();
    const results = await Promise.all(["Мебель остаётся.", "Мебели нет."].map(answer => answerOwnerQuestion(value.questionId, answer, directorId, { expectedRevision: "1" })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.status === 409)).toHaveLength(1);
    const saved = await row(value.questionId);
    expect(saved.answer).toBeTruthy(); expect(saved.answeredAt).not.toBeNull();
    expect(saved).toMatchObject({ deliveryStatus: "HELD", managedRevision: 2n, deliveredAt: null, answeredById: directorId });
    expect(saved.replyTarget).toEqual(value.target);
    expect((await loadPendingOwnerQuestions(100, directorId)).some(item => item.id === value.questionId && item.answer === saved.answer)).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("dashboard-only and foreign own-agent rights do not expose or answer managed questions", async () => {
    const value = await commitQuestion();
    for (const actor of [dashboardOnlyId, ownAgentId]) {
      expect(await answerOwnerQuestion(value.questionId, "Чужой ответ", actor, { expectedRevision: "1" })).toMatchObject({ ok: false, status: 403 });
      expect((await loadPendingOwnerQuestions(100, actor)).some(item => item.id === value.questionId)).toBe(false);
    }
    expect((await row(value.questionId)).answeredAt).toBeNull();
    expect((await loadPendingOwnerQuestions(100)).some(item => item.id === value.questionId)).toBe(false);
  });
  it("scope credential/resource revision change saves HELD with original target, without adopting a Client channel", async () => {
    const isolated = await createCustomerMessengerFixture("INSTAGRAM"); extraFixtures.push(isolated);
    const value = await commitQuestion(isolated);
    await prisma.messengerAccount.update({ where: { id: isolated.id }, data: { externalId: `rotated-${randomUUID()}` } });
    expect(await answerOwnerQuestion(value.questionId, "Уточнили условия.", directorId, { expectedRevision: "1" })).toMatchObject({
      ok: true, delivered: false, deliveryStatus: "HELD", holdReason: "original_target_changed",
    });
    expect((await row(value.questionId)).replyTarget).toEqual(value.target);
  });
  it("native tombstone permits historical staff answer but never a replacement recipient", async () => {
    const value = await commitQuestion();
    await prisma.botConversation.delete({ where: { id: value.target.nativeId } });
    expect(await answerOwnerQuestion(value.questionId, "Сохранили ответ для ручной проверки.", directorId, { expectedRevision: "1" })).toMatchObject({
      ok: true, delivered: false, holdReason: "original_target_changed",
    });
    expect((await row(value.questionId)).deliveredAt).toBeNull();
    expect((await row(value.questionId)).replyTarget).toEqual(value.target);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("legacy reminder never generates text or sends for managed rows", async () => {
    const value = await commitQuestion();
    const marker = `managed-owner-reminder-${value.questionId}`;
    await prisma.botConversation.update({ where: { id: value.target.nativeId }, data: { messages: [{ role: "user", content: marker }] } });
    await prisma.ownerQuestion.update({ where: { id: value.questionId }, data: { askedAt: new Date("2020-01-01T00:00:00Z") } });
    shortReply.mockClear();
    await notifyStaleOwnerQuestions();
    expect((await row(value.questionId)).autoRepliedAt).toBeNull();
    expect(shortReply.mock.calls.some(args => JSON.stringify(args).includes(marker))).toBe(false);
  });
  it("staff notification observes one committed resource and never claims customer delivery", async () => {
    const value = await commitQuestion(); push.mockClear();
    await customerOwnerQuestionNotifyJob.run({ version: 1, actionId: value.actionId });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toContain(directorId);
    expect(push.mock.calls[0]?.[0]).not.toContain(dashboardOnlyId);
    expect(push.mock.calls[0]?.[1]).toMatchObject({ url: `/messages?open=${value.target.nativeId}` });
    expect((await row(value.questionId)).deliveredAt).toBeNull();
  });
});
