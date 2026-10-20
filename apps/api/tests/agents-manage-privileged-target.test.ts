import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";

/**
 * Право «управлять сотрудниками» без права раздавать права не даёт захватить
 * учётку того, кто права раздаёт (G5, 02.10.2026).
 *
 * Так было: forbiddenRoleGrant запрещал без permissions.manage только НАЗНАЧЕНИЕ
 * роли ADMIN, а PATCH /agents/:id принимал пароль и телефон-логин любого
 * не-директора. Руководитель с галочкой agents.manage сбрасывал пароль админу,
 * ставил свой номер и входил под ним — с permissions.manage и всем остальным.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const ids: string[] = [];
let actorToken: string;
let actorId: string;
let adminId: string;
let grantorId: string;
let plainAgentId: string;

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

beforeAll(async () => {
  const actor = await mk("Руководитель Без Раздачи", `+992971${runId}`, "MANAGER", {
    granted: ["agents.manage"],
    revoked: [],
  });
  adminId = (await mk("Админ Цель", `+992972${runId}`, "ADMIN")).id;
  grantorId = (await mk("Руководитель Раздающий", `+992973${runId}`, "MANAGER", {
    granted: ["permissions.manage"],
    revoked: [],
  })).id;
  plainAgentId = (await mk("Агент Обычный", `+992974${runId}`, "AGENT")).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: actor.phone, password });
  expect(res.status).toBe(200);
  actorToken = res.body.accessToken;
  grantElevation(actor.id);
  actorId = actor.id;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("agents.manage без permissions.manage", () => {
  it("не сбрасывает пароль администратору", async () => {
    const before = await prisma.agent.findUnique({ where: { id: adminId }, select: { passwordHash: true } });
    const res = await request(app)
      .patch(`/api/v1/agents/${adminId}`)
      .set("Authorization", `Bearer ${actorToken}`)
      .send({ password: "hijacked123456" }); // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    expect(res.status).toBe(403);
    const after = await prisma.agent.findUnique({ where: { id: adminId }, select: { passwordHash: true } });
    expect(after!.passwordHash).toBe(before!.passwordHash);
  });

  it("не меняет телефон-логин администратору", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${adminId}`)
      .set("Authorization", `Bearer ${actorToken}`)
      .send({ phone: `+992975${runId}` });
    expect(res.status).toBe(403);
  });

  it("не трогает и учётку с персональным правом раздавать права", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${grantorId}`)
      .set("Authorization", `Bearer ${actorToken}`)
      .send({ password: "hijacked123456" }); // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    expect(res.status).toBe(403);
  });

  it("не отключает, не замораживает и не удаляет администратора", async () => {
    const off = await request(app)
      .patch(`/api/v1/agents/${adminId}`)
      .set("Authorization", `Bearer ${actorToken}`)
      .send({ isActive: false });
    expect(off.status).toBe(403);
    const frozen = await request(app)
      .post(`/api/v1/agents/${adminId}/freeze`)
      .set("Authorization", `Bearer ${actorToken}`)
      .send({ reason: "проверка" });
    expect(frozen.status).toBe(403);
    const handover = await request(app)
      .post(`/api/v1/agents/${adminId}/handover`)
      .set("Authorization", `Bearer ${actorToken}`)
      .send({ deactivate: true });
    expect(handover.status).toBe(403);
    const del = await request(app).delete(`/api/v1/agents/${adminId}`).set("Authorization", `Bearer ${actorToken}`);
    expect(del.status).toBe(403);
    const admin = await prisma.agent.findUnique({ where: { id: adminId }, select: { isActive: true, frozenAt: true } });
    expect(admin!.isActive).toBe(true);
    expect(admin!.frozenAt).toBeNull();
  });

  it("не снимает второй фактор администратору", async () => {
    await prisma.agent.update({
      where: { id: actorId },
      data: { permissions: { granted: ["agents.manage", "agents.reset2fa"], revoked: [] } },
    });
    invalidateAgentAccess(actorId);
    grantElevation(actorId);
    const res = await request(app).post(`/api/v1/agents/${adminId}/2fa/reset`).set("Authorization", `Bearer ${actorToken}`);
    expect(res.status).toBe(403);
  });

  it("обычному агенту пароль по-прежнему сбрасывает", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${plainAgentId}`)
      .set("Authorization", `Bearer ${actorToken}`)
      .send({ password: "resetbyboss123" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
