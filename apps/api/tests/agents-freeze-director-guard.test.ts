import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Заморозка/разморозка и возврат передачи дел не обходят защиту учётки
 * директора и раздающего права (аудит Codex 04.10.2026, ACCESS-06).
 *
 * Так было: freeze звал только forbiddenPrivilegedTarget, а он пропускает любого
 * с permissions.manage (пресет ADMIN) — админ со step-up замораживал ДИРЕКТОРА,
 * освобождая его лиды. unfreeze не звал ни одной защиты, а revert передачи дел —
 * только директорскую, без «раздающего права».
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const ids: string[] = [];
const batchIds: string[] = [];
let adminToken: string;
let managerToken: string;
let directorId: string;
let otherAdminId: string;

async function mk(fullName: string, phone: string, role: string, permissions?: unknown) {
  await prisma.agent.deleteMany({ where: { phone } });
  const a = await prisma.agent.create({
    data: {
      fullName,
      phone,
      role: role as never,
      passwordHash: await bcrypt.hash(password, 10),
      ...(permissions ? { permissions: permissions as never } : {}),
    },
  });
  ids.push(a.id);
  return a;
}

async function loginOf(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const admin = await mk("Админ Заморозчик", `+992981${runId}`, "ADMIN");
  const manager = await mk("Руководитель Без Раздачи", `+992982${runId}`, "MANAGER", {
    granted: ["agents.manage"],
    revoked: [],
  });
  directorId = (await mk("Директор Цель", `+992983${runId}`, "DIRECTOR")).id;
  otherAdminId = (await mk("Админ Цель", `+992984${runId}`, "ADMIN")).id;
  adminToken = await loginOf(admin.phone);
  managerToken = await loginOf(manager.phone);
  grantElevation(admin.id);
  grantElevation(manager.id);
});

afterAll(async () => {
  await prisma.agentHandoverBatch.deleteMany({ where: { id: { in: batchIds } } });
  await prisma.session.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("защита целевой учётки на заморозке, разморозке и возврате передачи", () => {
  it("админ не замораживает директора", async () => {
    const res = await request(app)
      .post(`/api/v1/agents/${directorId}/freeze`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "проверка защиты" });
    expect(res.status).toBe(403);
    const director = await prisma.agent.findUnique({ where: { id: directorId }, select: { frozenAt: true } });
    expect(director!.frozenAt).toBeNull();
  });

  it("админ не размораживает замороженного директора", async () => {
    await prisma.agent.update({ where: { id: directorId }, data: { frozenAt: new Date(), frozenReason: "тест" } });
    const res = await request(app)
      .post(`/api/v1/agents/${directorId}/unfreeze`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(403);
    const director = await prisma.agent.findUnique({ where: { id: directorId }, select: { frozenAt: true } });
    expect(director!.frozenAt).not.toBeNull();
    await prisma.agent.update({ where: { id: directorId }, data: { frozenAt: null, frozenReason: null } });
  });

  it("agents.manage без permissions.manage не размораживает админа", async () => {
    await prisma.agent.update({ where: { id: otherAdminId }, data: { frozenAt: new Date(), frozenReason: "тест" } });
    const res = await request(app)
      .post(`/api/v1/agents/${otherAdminId}/unfreeze`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({});
    expect(res.status).toBe(403);
    const target = await prisma.agent.findUnique({ where: { id: otherAdminId }, select: { frozenAt: true } });
    expect(target!.frozenAt).not.toBeNull();
    await prisma.agent.update({ where: { id: otherAdminId }, data: { frozenAt: null, frozenReason: null } });
  });

  it("agents.manage без permissions.manage не возвращает передачу дел админа", async () => {
    const batch = await prisma.agentHandoverBatch.create({
      data: { fromAgentId: otherAdminId, actorId: null, items: [] },
    });
    batchIds.push(batch.id);
    const res = await request(app)
      .post(`/api/v1/agents/handovers/${batch.id}/revert`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({});
    expect(res.status).toBe(403);
    const after = await prisma.agentHandoverBatch.findUnique({ where: { id: batch.id }, select: { revertedAt: true } });
    expect(after!.revertedAt).toBeNull();
  });
});
