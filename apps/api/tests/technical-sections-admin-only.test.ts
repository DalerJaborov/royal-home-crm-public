import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, resolvePermissions, canViewTechnical, describePermissions, normalizeOverrides, type Role } from "@royal-home/shared";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ТЕХНИЧЕСКИЕ РАЗДЕЛЫ — ТОЛЬКО ДИРЕКТОР И АДМИНИСТРАТОР (владелец 28.11.2026):
 * «Резервные копии», «Интеграции и каналы», «Что не доехало», «Здоровье системы»,
 * журнал ошибок и журнал помощницы. Всё держится на одном праве auditLog.view,
 * а граница роли (canViewTechnical) не даёт расширить его личной галочкой.
 */
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now().toString(36).slice(-6);
const password = "testpass123";
const ids: string[] = [];
const tokens = new Map<Role, string>();

const TECH_ROUTES = [
  "/api/v1/backups",
  "/api/v1/integrations",
  "/api/v1/stuck-work",
  "/api/v1/errors",
  "/api/v1/ai/assistant-audit",
] as const;

describe("граница роли для технических прав (без базы)", () => {
  it("auditLog.view есть только у директора и администратора, личной галочкой не выдаётся", () => {
    for (const role of ROLES) {
      const plain = resolvePermissions(role, null).has("auditLog.view");
      const granted = resolvePermissions(role, { granted: ["auditLog.view"], revoked: [] }).has("auditLog.view");
      const expected = role === "ADMIN" || role === "DIRECTOR";
      expect(plain, `${role} по умолчанию`).toBe(expected);
      expect(granted, `${role} с галочкой`).toBe(expected);
      expect(canViewTechnical(role)).toBe(expected);
    }
  });

  it("в экране прав у не-админов этой галочки нет, а надстройка о ней не хранится", () => {
    expect(describePermissions("AGENT", null).some((p) => p.id === "auditLog.view")).toBe(false);
    expect(describePermissions("ADMIN", null).some((p) => p.id === "auditLog.view")).toBe(true);
    expect(normalizeOverrides("MARKETING", { granted: ["auditLog.view"], revoked: [] }).granted).toEqual([]);
  });
});

describe("серверные маршруты технических разделов — по каждой роли", () => {
  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    for (const [i, role] of ROLES.entries()) {
      const agent = await prisma.agent.create({
        data: {
          fullName: `Тест Техраздел ${role}`,
          phone: `+99297${i}${runId}`.slice(0, 13),
          role,
          passwordHash,
          // личная галочка не должна пробить границу роли
          permissions: { granted: ["auditLog.view"], revoked: [] },
        },
      });
      ids.push(agent.id);
      const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
      expect(res.status, `вход ${role}`).toBe(200);
      tokens.set(role, res.body.accessToken as string);
    }
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { agentId: { in: ids } } });
    await deleteAgentsWithTraces(ids);
  });

  for (const role of ROLES) {
    it(`${role}: ${role === "ADMIN" || role === "DIRECTOR" ? "открыто" : "отказ 403"}`, async () => {
      const open = role === "ADMIN" || role === "DIRECTOR";
      for (const url of TECH_ROUTES) {
        const res = await request(app).get(url).set("Authorization", `Bearer ${tokens.get(role)}`);
        if (open) expect(res.status, `${role} ${url}`).toBe(200);
        else expect(res.status, `${role} ${url}`).toBe(403);
      }
    });
  }
});
