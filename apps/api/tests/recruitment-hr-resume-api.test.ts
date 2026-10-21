import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";

const marker = `synthetic-hr-${randomUUID()}`;
const roleKey = `synthetic-${randomUUID()}`;
const ids: string[] = [];
let actorId: string, token: string, nativeId: string, inquiryId: string, accountId: string;
const auth = () => ({ Authorization: `Bearer ${token}` });
async function candidate(status = "NEW", extra: Record<string, unknown> = {}) {
  const row = await prisma.jobApplication.create({ data: { name: marker, channel: "WHATSAPP", status, ...extra } });
  ids.push(row.id); return row;
}
beforeAll(async () => {
  const actor = await prisma.agent.create({ data: { fullName: marker, phone: marker, passwordHash: "synthetic-unused", role: "MANAGER" } });
  actorId = actor.id; token = signAccessToken({ sub: actor.id, role: actor.role });
  await prisma.recruitmentPosition.create({ data: { key: roleKey, titleRu: "SMM тест", titleTg: "SMM санҷиш", isOpen: true } });
  const account = await prisma.messengerAccount.create({ data: { title: marker, channel: "WHATSAPP", externalId: randomUUID(), enabled: true, token: "synthetic-unused" } });
  accountId = account.id;
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "WHATSAPP", subscriberId: marker, accountId }));
  nativeId = native.id;
  const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: nativeId } });
  inquiryId = inquiry.id;
  await prisma.botConversation.update({ where: { id: nativeId }, data: { messages: [{ role: "user", content: "Тестовое резюме из нового ядра" }] } });
});
afterAll(async () => {
  await prisma.recruitmentCommunication.deleteMany({ where: { jobApplicationId: { in: ids } } });
  await prisma.jobApplication.deleteMany({ where: { id: { in: ids } } });
  if (inquiryId) await prisma.customerInquiry.delete({ where: { id: inquiryId } });
  if (nativeId) await prisma.botConversation.delete({ where: { id: nativeId } });
  await prisma.recruitmentPosition.delete({ where: { key: roleKey } });
  if (accountId) await prisma.messengerAccount.delete({ where: { id: accountId } });
  await prisma.agent.delete({ where: { id: actorId } });
});

it("assigns a historical application explicitly without fabricating a managed source", async () => {
  const row = await candidate();
  await request(app).patch(`/api/v1/vacancies/${row.id}`).set(auth()).send({ positionKey: roleKey }).expect(200);
  expect(await prisma.jobApplication.findUnique({ where: { id: row.id } })).toMatchObject({ hrPositionKey: roleKey,
    customerInquiryId: null, customerPositionKey: null, customerApplicationRevision: null });
  const result = await request(app).get("/api/v1/vacancies").set(auth()).query({ includeFiltered: "true", includeNoPhone: "true", positionKey: roleKey }).expect(200);
  const actual = result.body.items.find((item: { id: string }) => item.id === row.id);
  expect(actual.positionKey).toBe(roleKey); expect(actual.positionTitle).toBe("SMM тест");
  expect(actual.recruitmentAssessment.missing).not.toContain("age");
});
it("shows incomplete active candidates while excluding final HR stages, with independent stage counts", async () => {
  const active = await candidate("NEW", { hrPositionKey: roleKey, eligible: null });
  await candidate("REJECTED", { hrPositionKey: roleKey });
  const result = await request(app).get("/api/v1/vacancies").set(auth()).query({ includeFiltered: "true", includeNoPhone: "true",
    activeOnly: "true", q: marker, positionKey: roleKey }).expect(200);
  expect(result.body.items.some((item: { id: string }) => item.id === active.id)).toBe(true);
  expect(result.body.items.every((item: { status: string }) => item.status !== "REJECTED")).toBe(true);
  expect(result.body.counts.REJECTED).toBe(1);
});
it("loads the actual linked native conversation for a new-core application", async () => {
  const core = await candidate("NEW", { customerInquiryId: inquiryId, customerPositionKey: roleKey, customerApplicationRevision: 1n });
  const result = await request(app).get(`/api/v1/vacancies/${core.id}/conversation`).set(auth()).expect(200);
  expect(result.body.messages[0].content).toBe("Тестовое резюме из нового ядра");
  await request(app).patch(`/api/v1/vacancies/${core.id}`).set(auth()).send({ positionKey: roleKey }).expect(409);
});
it("retains an explicit staff phone correction and blocks the retired automatic-call API", async () => {
  const row = await candidate();
  await request(app).patch(`/api/v1/vacancies/${row.id}`).set(auth()).send({ phone: "+992000000001" }).expect(200);
  expect(await prisma.jobApplication.findUnique({ where: { id: row.id } })).toMatchObject({ phone: "+992000000001", recruitmentPhoneOverride: true });
  const result = await request(app).patch(`/api/v1/vacancies/${row.id}`).set(auth()).send({ inviteCall: true }).expect(400);
  expect(result.body.code).toBe("RECRUITMENT_PREVIEW_REQUIRED");
  expect(await prisma.interviewInviteCall.count({ where: { jobApplicationId: row.id } })).toBe(0);
});
it("cannot change a live assistant call's appointment or recipient, while allowing HR notes", async () => {
  const row = await candidate();
  await prisma.recruitmentCommunication.create({ data: { id: randomUUID(), previewId: randomUUID(), jobApplicationId: row.id,
    actorId, purpose: "INVITE", channel: "ASSISTANT_CALL", status: "ACCEPTED", previewHash: "synthetic",
    snapshotJson: {}, expiresAt: new Date(Date.now() + 60_000) } });
  await request(app).patch(`/api/v1/vacancies/${row.id}`).set(auth()).send({ status: "REJECTED" }).expect(409);
  await request(app).patch(`/api/v1/vacancies/${row.id}`).set(auth()).send({ phone: "+992000000002" }).expect(409);
  await request(app).patch(`/api/v1/vacancies/${row.id}`).set(auth()).send({ interviewNote: "Тестовая заметка" }).expect(200);
  expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("NEW");
});
it("cannot call a record explicitly marked as not a candidate", async () => {
  const row = await candidate("NOT_CANDIDATE", { phone: "+992000000001" });
  await request(app).post(`/api/v1/vacancies/${row.id}/call`).set(auth()).send({}).expect(404);
});
