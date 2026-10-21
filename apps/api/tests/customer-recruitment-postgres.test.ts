import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { revokeElevation, isElevated } from "../src/lib/stepUp.js";
import { SETTINGS_MAINTENANCE_DEADLINE } from "../src/lib/settingsMaintenance.js";
import { readCustomerOpenVacancies, customerOpenVacanciesCurrent } from "../src/lib/recruitmentPositions.js";

const tag = `synthetic-recruitment-${randomUUID()}`, password = "synthetic-recruitment-password-only";
const key = `synthetic-${randomUUID()}`, otherKey = `synthetic-${randomUUID()}`, code = `Synthetic${randomUUID().replaceAll("-", "")}`;
const data = { titleRu: "Тестовая должность", titleTg: "Вазифаи санҷишӣ", detailsRu: "Только опубликованные условия", detailsTg: "Танҳо шартҳои нашршуда", isOpen: true, postCodes: [code], keywords: [code.toLowerCase().slice(0, 40)], expectedRevision: 0 };
const actors: Array<{ id: string; token: string }> = [];
let settings: { botCanHandleVacancies: boolean } | null;
const auth = (actor: { token: string }) => ({ Authorization: `Bearer ${actor.token}` });
async function actor(role: "DIRECTOR" | "ADMIN" | "MANAGER" | "AGENT") {
  const row = await prisma.agent.create({ data: { fullName: tag, phone: `${tag}-${role}`, role, passwordHash: await bcrypt.hash(password, 4) } });
  const value = { id: row.id, token: signAccessToken({ sub: row.id, role }) }; actors.push(value); return value;
}
let director: Awaited<ReturnType<typeof actor>>, admin: Awaited<ReturnType<typeof actor>>, manager: Awaited<ReturnType<typeof actor>>, agent: Awaited<ReturnType<typeof actor>>;
it("the temporary settings policy saves a real catalog row without SMS or a fabricated MFA grant, expires and retains staff rights", async () => {
  const maintenanceKey = `maintenance-${randomUUID()}`;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
  vi.stubEnv("SETTINGS_STEP_UP_MAINTENANCE_UNTIL", SETTINGS_MAINTENANCE_DEADLINE);
  revokeElevation(director.id);
  const token = () => ({ Authorization: `Bearer ${signAccessToken({ sub: director.id, role: "DIRECTOR" })}` });
  try {
    const status = await request(app).get("/api/v1/auth/step-up").set(token());
    expect(status.body).toMatchObject({ elevated: false, expiresAt: null, settingsMaintenanceUntil: SETTINGS_MAINTENANCE_DEADLINE });
    const payload = { ...data, postCodes: [], keywords: [] };
    expect((await request(app).put(`/api/v1/vacancies/positions/${maintenanceKey}`).send(payload)).status).toBe(401);
    const managerAuth = { Authorization: `Bearer ${signAccessToken({ sub: manager.id, role: "MANAGER" })}` };
    expect((await request(app).put(`/api/v1/vacancies/positions/${maintenanceKey}`).set(managerAuth).send(payload)).status).toBe(403);
    expect((await request(app).put(`/api/v1/vacancies/positions/${maintenanceKey}`).set(token()).send(payload)).status).toBe(200);
    expect(await prisma.recruitmentPosition.findUnique({ where: { key: maintenanceKey } })).toMatchObject({ isOpen: true, revision: 1 });
    expect(isElevated(director.id)).toBe(false);
    expect(await prisma.auditLog.count({ where: { agentId: director.id, action: "SETTINGS_MAINTENANCE_ACCESS" } })).toBe(1);
    // People is a Settings tab too: reach validation without creating staff,
    // sending a code or fabricating elevation. Role permissions still apply.
    expect((await request(app).post("/api/v1/agents").set(token()).send({})).status).toBe(400);
    const agentAuth = { Authorization: `Bearer ${signAccessToken({ sub: agent.id, role: "AGENT" })}` };
    expect((await request(app).post("/api/v1/agents").set(agentAuth).send({})).status).toBe(403);
    expect((await request(app).put("/api/v1/agents/synthetic/permissions").set(agentAuth).send({})).status).toBe(403);
    const adminAuth = { Authorization: `Bearer ${signAccessToken({ sub: admin.id, role: "ADMIN" })}` };
    expect((await request(app).post("/api/v1/agents").set(adminAuth).send({})).status).toBe(400);
    try {
      await prisma.agent.update({ where: { id: admin.id }, data: { permissions: { revoked: ["agents.manage"] } } });
      invalidateAgentAccess(admin.id);
      expect((await request(app).post("/api/v1/agents").set(adminAuth).send({})).status).toBe(403);
      await prisma.agent.update({ where: { id: admin.id }, data: { permissions: { revoked: ["settings.manage"] } } });
      invalidateAgentAccess(admin.id);
      expect((await request(app).post("/api/v1/agents").set(adminAuth).send({})).status).toBe(428);
      await prisma.agent.update({ where: { id: admin.id }, data: { permissions: { revoked: [] }, totpEnabled: true } });
      invalidateAgentAccess(admin.id);
      expect((await request(app).post("/api/v1/agents").set(adminAuth).send({})).status).toBe(428);
    } finally {
      await prisma.agent.update({ where: { id: admin.id }, data: { permissions: { revoked: [] }, totpEnabled: false } });
      invalidateAgentAccess(admin.id);
    }
    expect(isElevated(director.id)).toBe(false);
    expect((await request(app).post("/api/v1/me/2fa/disable").set(token()).send({})).status).toBe(428);
    vi.setSystemTime(new Date(SETTINGS_MAINTENANCE_DEADLINE));
    expect((await request(app).post("/api/v1/agents").set(token()).send({})).status).toBe(428);
    expect((await request(app).put(`/api/v1/vacancies/positions/${maintenanceKey}`).set(token()).send({ ...payload, expectedRevision: 1 })).status).toBe(428);
    expect(await prisma.recruitmentPosition.findUnique({ where: { key: maintenanceKey } })).toMatchObject({ revision: 1 });
  } finally {
    vi.useRealTimers(); vi.unstubAllEnvs();
    await prisma.recruitmentPosition.deleteMany({ where: { key: maintenanceKey } });
  }
});
beforeAll(async () => {
  settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botCanHandleVacancies: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanHandleVacancies: true } });
  director = await actor("DIRECTOR"); admin = await actor("ADMIN"); manager = await actor("MANAGER"); agent = await actor("AGENT");
});
afterAll(async () => {
  await prisma.recruitmentPosition.deleteMany({ where: { key: { in: [key, otherKey] } } });
  for (const item of actors) revokeElevation(item.id);
  await prisma.auditLog.deleteMany({ where: { agentId: { in: actors.map(a => a.id) } } });
  await prisma.agent.deleteMany({ where: { id: { in: actors.map(a => a.id) } } });
  if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
});
it("requires actual staff access and genuine elevation for public job changes", async () => {
  expect((await request(app).get("/api/v1/vacancies/positions")).status).toBe(401);
  expect((await request(app).get("/api/v1/vacancies/positions").set(auth(agent))).status).toBe(403);
  expect((await request(app).get("/api/v1/vacancies/positions").set(auth(manager))).status).toBe(200);
  expect((await request(app).put(`/api/v1/vacancies/positions/${key}`).set(auth(manager)).send(data)).status).toBe(403);
  expect((await request(app).put(`/api/v1/vacancies/positions/${key}`).set(auth(director)).send(data)).status).toBe(428);
  expect(await prisma.recruitmentPosition.findUnique({ where: { key } })).toBeNull();
  expect((await request(app).post("/api/v1/auth/step-up").set(auth(director)).send({ password })).status).toBe(200);
});
it("creates one opening, rejects a stale retry and atomically rolls back conflicting ads", async () => {
  expect((await request(app).put(`/api/v1/vacancies/positions/${key}`).set(auth(director)).send(data)).status).toBe(200);
  expect((await request(app).put(`/api/v1/vacancies/positions/${key}`).set(auth(director)).send({ ...data, isOpen: false })).status).toBe(409);
  expect((await request(app).put(`/api/v1/vacancies/positions/${otherKey}`).set(auth(director)).send(data)).status).toBe(409);
  expect(await prisma.recruitmentPosition.findUnique({ where: { key: otherKey } })).toBeNull();
  expect(await prisma.auditLog.count({ where: { entityId: key, action: "RECRUITMENT_POSITION_UPDATE" } })).toBe(1);
  const visible = await readCustomerOpenVacancies();
  expect(visible.positions.find(p => p.key === key)?.postCodes).toEqual([code]);
  expect(JSON.stringify(visible)).not.toMatch(/passwordHash|contactProfile|candidate|eligible|priority/u);
  expect(await customerOpenVacanciesCurrent(visible)).toBe(true);
  expect((await request(app).put(`/api/v1/vacancies/positions/${key}`).set(auth(director)).send({ ...data, isOpen: false, expectedRevision: 1 })).status).toBe(200);
  expect(await customerOpenVacanciesCurrent(visible)).toBe(false);
  expect((await readCustomerOpenVacancies()).positions.some(p => p.key === key)).toBe(false);
});
it("a staff vacancy switch disables offers without deleting positions or candidate applications", async () => {
  const applications = await prisma.jobApplication.count();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanHandleVacancies: false } });
  expect(await readCustomerOpenVacancies()).toMatchObject({ collecting: false, positions: [] });
  expect(await prisma.recruitmentPosition.count({ where: { key } })).toBe(1);
  expect(await prisma.jobApplication.count()).toBe(applications);
});
it("the DB source constraint rejects managed IDs with a NULL resource revision while retaining all-NULL historical rows", async () => {
  const scope=await prisma.customerEndpointScope.create({data:{realmKey:`${tag}-source`,channel:"INSTAGRAM",transportKey:`${tag}-transport`}});
  const inquiry=await prisma.customerInquiry.create({data:{endpointScopeId:scope.id,peerId:`${tag}-source-peer`}});
  try {
    const legacy=await prisma.jobApplication.create({data:{channel:"INSTAGRAM",contactName:tag}});
    expect(legacy.customerApplicationRevision).toBeNull();
    await expect(prisma.jobApplication.create({data:{channel:"INSTAGRAM",contactName:tag,
      customerInquiryId:inquiry.id,customerPositionKey:key,customerApplicationRevision:null}})).rejects.toThrow(/JobApplication_customer_source_check/);
    for(const source of [
      {customerInquiryId:inquiry.id,customerPositionKey:null,customerApplicationRevision:null},
      {customerInquiryId:null,customerPositionKey:key,customerApplicationRevision:null},
      {customerInquiryId:null,customerPositionKey:null,customerApplicationRevision:1n},
      {customerInquiryId:inquiry.id,customerPositionKey:key,customerApplicationRevision:0n},
      {customerInquiryId:inquiry.id,customerPositionKey:key,customerApplicationRevision:-1n},
    ]) await expect(prisma.jobApplication.create({data:{channel:"INSTAGRAM",contactName:tag,...source}})).rejects.toThrow(/JobApplication_customer_source_check/);
    const valid=await prisma.jobApplication.create({data:{channel:"INSTAGRAM",contactName:tag,
      customerInquiryId:inquiry.id,customerPositionKey:key,customerApplicationRevision:1n}});
    expect(valid.customerApplicationRevision).toBe(1n);
  } finally {
    await prisma.jobApplication.deleteMany({where:{contactName:tag}});
    await prisma.customerInquiry.delete({where:{id:inquiry.id}});
    await prisma.customerEndpointScope.delete({where:{id:scope.id}});
  }
});
