import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Смена роли сбрасывает личные надстройки прав (G9, 02.10.2026).
 *
 * Так было: PATCH /agents/:id менял роль, а колонку permissions не трогал.
 * Руководителю с личными галочками «финансы» и «номера клиентов» понижали роль
 * до агента — и он продолжал видеть деньги и номера, хотя директор ждал пресет
 * агента.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const ids: string[] = [];
let directorId: string;
let directorToken: string;
let targetId: string;

beforeAll(async () => {
  const dPhone = `+992981${runId}`;
  const tPhone = `+992982${runId}`;
  await prisma.agent.deleteMany({ where: { phone: { in: [dPhone, tPhone] } } });
  const director = await prisma.agent.create({
    data: { fullName: "Директор смены роли", phone: dPhone, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4) },
  });
  directorId = director.id;
  ids.push(director.id);
  const target = await prisma.agent.create({
    data: {
      fullName: "Руководитель с галочками",
      phone: tPhone,
      role: "MANAGER",
      passwordHash: await bcrypt.hash(password, 4),
      permissions: { granted: ["finance.view", "clients.viewPhone"], revoked: [] },
    },
  });
  targetId = target.id;
  ids.push(target.id);
  const login = await request(app).post("/api/v1/auth/login").send({ phone: dPhone, password });
  directorToken = login.body.accessToken;
  grantElevation(directorId);
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
  await prisma.session.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("PATCH /agents/:id — смена роли", () => {
  it("понижение до агента снимает личные галочки", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${targetId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ role: "AGENT" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true, permissions: true } });
    expect(row!.role).toBe("AGENT");
    expect(row!.permissions).toBeNull();

    const perms = await request(app).get(`/api/v1/agents/${targetId}/permissions`).set("Authorization", `Bearer ${directorToken}`);
    expect(perms.status).toBe(200);
    expect(perms.body.overrides).toEqual({ granted: [], revoked: [] });
  });

  it("снятые галочки видны в журнале действий", async () => {
    const entry = await waitFor(
      () =>
        prisma.auditLog.findFirst({
          where: { entityId: targetId, action: "AGENT_PERMISSIONS_RESET_ON_ROLE_CHANGE" },
        }),
      { label: "запись о сбросе прав" }
    );
    expect(JSON.stringify(entry!.meta)).toContain("finance.view");
  });

  it("правка без смены роли галочки не трогает", async () => {
    await prisma.agent.update({
      where: { id: targetId },
      data: { permissions: { granted: ["finance.view"], revoked: [] } },
    });
    const res = await request(app)
      .patch(`/api/v1/agents/${targetId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ role: "AGENT", fullName: "Агент с галочкой" });
    expect(res.status).toBe(200);
    const row = await prisma.agent.findUnique({ where: { id: targetId }, select: { permissions: true } });
    expect(row!.permissions).toEqual({ granted: ["finance.view"], revoked: [] });
  });
});
