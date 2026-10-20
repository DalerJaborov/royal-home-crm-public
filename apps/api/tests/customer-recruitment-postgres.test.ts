import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import { beforeAll, afterAll, expect, it } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { revokeElevation } from "../src/lib/stepUp.js";
import { readCustomerOpenVacancies, customerOpenVacanciesCurrent } from "../src/lib/recruitmentPositions.js";

const tag = `synthetic-recruitment-${randomUUID()}`, password = "synthetic-recruitment-password-only";
const key = `synthetic-${randomUUID()}`, otherKey = `synthetic-${randomUUID()}`, code = `Synthetic${randomUUID().replaceAll("-", "")}`;
const data = { titleRu: "Тестовая должность", titleTg: "Вазифаи санҷишӣ", detailsRu: "Только опубликованные условия", detailsTg: "Танҳо шартҳои нашршуда", isOpen: true, postCodes: [code], keywords: [code.toLowerCase().slice(0, 40)], expectedRevision: 0 };
const actors: Array<{ id: string; token: string }> = [];
let settings: { botCanHandleVacancies: boolean } | null;
const auth = (actor: { token: string }) => ({ Authorization: `Bearer ${actor.token}` });
async function actor(role: "DIRECTOR" | "MANAGER" | "AGENT") {
  const row = await prisma.agent.create({ data: { fullName: tag, phone: `${tag}-${role}`, role, passwordHash: await bcrypt.hash(password, 4) } });
  const value = { id: row.id, token: signAccessToken({ sub: row.id, role }) }; actors.push(value); return value;
}
let director: Awaited<ReturnType<typeof actor>>, manager: Awaited<ReturnType<typeof actor>>, agent: Awaited<ReturnType<typeof actor>>;
beforeAll(async () => {
  settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botCanHandleVacancies: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanHandleVacancies: true } });
  director = await actor("DIRECTOR"); manager = await actor("MANAGER"); agent = await actor("AGENT");
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
