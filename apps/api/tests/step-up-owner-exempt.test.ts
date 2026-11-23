import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";
import request from "supertest";
import type { PermissionId } from "@royal-home/shared";

/**
 * ДИРЕКТОР И АДМИНИСТРАТОР БЕЗ КОДА ПОДТВЕРЖДЕНИЯ (23.11.2026, владелец: «выключить Google
 * Authenticator для директора и администратора полностью: для любых действий из Телеграма и
 * для настроек, такая защита не нужна»).
 *
 * Держим: роль решает (DIRECTOR/ADMIN — да, остальные — нет); REST за requireElevation
 * пропускает директора без окна и по-прежнему 428 для того, у кого окна нет и роль не та;
 * экран Настроек получает elevated=true; карточка Шабнам (Telegram) для директора без
 * Authenticator создаётся и исполняется без кода; для обычного сотрудника ничего не изменилось;
 * STEP_UP_OWNERS_EXEMPT=0 возвращает прежнюю защиту.
 */

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { invalidateAgentAccess, loadAgentAccess } = await import("../src/auth/middleware.js");
const { revokeElevation, stepUpExemptRole } = await import("../src/lib/stepUp.js");
await import("../src/ai/assistant/tools/index.js");
const broker = await import("../src/lib/assistantActions.js");

type Actor = import("../src/lib/assistantActions.js").AssistantActionActor;

const runId = `${Date.now()}`.slice(-7) + randomInt(100, 999);
const phone = () => `+99291${randomInt(1_000_000, 9_999_999)}`;
const agentIds: string[] = [];
let directorId = "";
let adminId = "";
let managerId = "";
const savedEnv = process.env.STEP_UP_OWNERS_EXEMPT;

async function agent(fullName: string, role: string) {
  const row = await prisma.agent.create({ data: { fullName, phone: phone(), role: role as never } });
  agentIds.push(row.id);
  return row;
}

async function telegramActor(id: string): Promise<Actor> {
  invalidateAgentAccess(id);
  const access = (await loadAgentAccess(id))!;
  return {
    agentId: id, channel: "telegram", telegramPrivate: true, can: (p: PermissionId) => access.permissions.has(p),
    ...(stepUpExemptRole(access.role) ? { stepUpExempt: true } : {}),
  };
}

const bearer = (id: string, role: string) => `Bearer ${signAccessToken({ sub: id, role: role as never })}`;

beforeAll(async () => {
  directorId = (await agent(`Директорбезкода${runId}`, "DIRECTOR")).id;
  adminId = (await agent(`Админбезкода${runId}`, "ADMIN")).id;
  managerId = (await agent(`Менеджертест${runId}`, "MANAGER")).id;
});

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.STEP_UP_OWNERS_EXEMPT;
  else process.env.STEP_UP_OWNERS_EXEMPT = savedEnv;
  for (const id of agentIds) revokeElevation(id);
  const created = await prisma.agent.findMany({ where: { fullName: { contains: `Новичокбезкода${runId}` } }, select: { id: true } });
  agentIds.push(...created.map((c) => c.id));
  await prisma.assistantAction.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("директор и администратор без подтверждения личности", () => {
  it("роль решает, рубильник возвращает защиту", () => {
    process.env.STEP_UP_OWNERS_EXEMPT = "1";
    expect(stepUpExemptRole("DIRECTOR")).toBe(true);
    expect(stepUpExemptRole("ADMIN")).toBe(true);
    for (const role of ["MANAGER", "AGENT", "HEAD_OF_SALES", "MARKETING", null, undefined]) expect(stepUpExemptRole(role)).toBe(false);
    process.env.STEP_UP_OWNERS_EXEMPT = "0";
    expect(stepUpExemptRole("DIRECTOR")).toBe(false);
    expect(stepUpExemptRole("ADMIN")).toBe(false);
  });

  it("REST за requireElevation: директор и админ проходят без окна, с выключенным послаблением — 428", async () => {
    process.env.STEP_UP_OWNERS_EXEMPT = "1";
    for (const [id, role] of [[directorId, "DIRECTOR"], [adminId, "ADMIN"]] as const) {
      revokeElevation(id);
      const res = await request(app).post("/api/v1/agents").set("Authorization", bearer(id, role)).send({});
      expect(res.status, JSON.stringify(res.body)).not.toBe(428);
    }
    process.env.STEP_UP_OWNERS_EXEMPT = "0";
    revokeElevation(directorId);
    const guarded = await request(app).post("/api/v1/agents").set("Authorization", bearer(directorId, "DIRECTOR")).send({});
    expect(guarded.status).toBe(428);
  });

  it("экран Настроек: статус подтверждения для директора — открыт, для менеджера — нет", async () => {
    process.env.STEP_UP_OWNERS_EXEMPT = "1";
    revokeElevation(directorId);
    const owner = await request(app).get("/api/v1/auth/step-up").set("Authorization", bearer(directorId, "DIRECTOR"));
    expect(owner.status).toBe(200);
    expect(owner.body.elevated).toBe(true);
    const manager = await request(app).get("/api/v1/auth/step-up").set("Authorization", bearer(managerId, "MANAGER"));
    expect(manager.body.elevated).toBe(false);
  });

  it("Шабнам в Telegram: директор без Authenticator создаёт и исполняет карточку сотрудника без кода", async () => {
    process.env.STEP_UP_OWNERS_EXEMPT = "1";
    const args = { fullName: `Новичокбезкода${runId}`, phone: phone(), role: "AGENT" };
    const card = await broker.createPendingAssistantAction(await telegramActor(directorId), "create_staff", args);
    const done = await broker.confirmAssistantAction(card.id, await telegramActor(directorId));
    expect(done.action.status).toBe("EXECUTED");
    expect(await prisma.agent.count({ where: { fullName: args.fullName } })).toBe(1);
  });

  it("с выключенным послаблением Telegram снова требует Authenticator (412 без него)", async () => {
    process.env.STEP_UP_OWNERS_EXEMPT = "0";
    await expect(broker.createPendingAssistantAction(await telegramActor(directorId), "create_staff", { fullName: `Новичокбезкода${runId}Б`, phone: phone(), role: "AGENT" }))
      .rejects.toMatchObject({ status: 412, code: "TOTP_REQUIRED" });
  });
});
