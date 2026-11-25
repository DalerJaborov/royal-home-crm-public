import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";
import type { PermissionId } from "@royal-home/shared";

/**
 * ДИРЕКТОР БЕЗ КОДА: КАРТОЧКУ ГОТОВИТ actionActorFrom (25.11.2026, живой случай: директор просил
 * Шабнам удалить сотрудницу и получил «Сначала включите Google Authenticator»).
 * stepUpExempt выставляли руками в двух местах, а актор модели строит actionActorFrom
 * (ai/assistant/tools/run.ts) — флага там не было, и createPendingAssistantAction отказывал
 * (TOTP_REQUIRED) ДО показа «Подтвердить». Прежний тест собирал актора руками и этого не видел.
 * Здесь идём через настоящую функцию.
 */

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { actionActorFrom } = await import("../src/ai/assistant/tools/run.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const broker = await import("../src/lib/assistantActions.js");

const runId = `${Date.now()}`.slice(-7) + randomInt(100, 999);
const phone = () => `+99291${randomInt(1_000_000, 9_999_999)}`;
const agentIds: string[] = [];
const savedEnv = process.env.STEP_UP_OWNERS_EXEMPT;
const PERMS = new Set<PermissionId>(["agents.manage"]);

async function agent(fullName: string, role: string) {
  const row = await prisma.agent.create({ data: { fullName, phone: phone(), role: role as never } });
  agentIds.push(row.id);
  return row;
}
const actorOf = (id: string, role: string) =>
  actionActorFrom(actorFromAccess(id, { role: role as never, permissions: PERMS }, "telegram-private"), "telegram");

let directorId = "";
let managerId = "";
let targetId = "";

beforeAll(async () => {
  directorId = (await agent(`Директорготовит${runId}`, "DIRECTOR")).id;
  managerId = (await agent(`Менеджерготовит${runId}`, "MANAGER")).id;
  targetId = (await agent(`Цельготовит${runId}`, "AGENT")).id;
});

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.STEP_UP_OWNERS_EXEMPT;
  else process.env.STEP_UP_OWNERS_EXEMPT = savedEnv;
  await prisma.assistantAction.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("actionActorFrom и освобождение от кода", () => {
  it("флаг у DIRECTOR и ADMIN, у остальных нет", () => {
    process.env.STEP_UP_OWNERS_EXEMPT = "1";
    for (const role of ["DIRECTOR", "ADMIN"]) expect(actorOf("x", role).stepUpExempt, role).toBe(true);
    for (const role of ["MANAGER", "AGENT", "HEAD_OF_SALES", "MARKETING"]) expect(actorOf("x", role).stepUpExempt, role).toBeUndefined();
  });

  it("рубильник STEP_UP_OWNERS_EXEMPT=0 снимает флаг у всех", () => {
    process.env.STEP_UP_OWNERS_EXEMPT = "0";
    for (const role of ["DIRECTOR", "ADMIN", "MANAGER"]) expect(actorOf("x", role).stepUpExempt, role).toBeUndefined();
  });

  it("удаление сотрудника: директору без Authenticator карточка готовится, менеджеру — TOTP_REQUIRED", async () => {
    process.env.STEP_UP_OWNERS_EXEMPT = "1";
    const card = await broker.createPendingAssistantAction(actorOf(directorId, "DIRECTOR"), "delete_staff", { agentId: targetId });
    expect(card.status).toBe("PENDING");
    await expect(broker.createPendingAssistantAction(actorOf(managerId, "MANAGER"), "delete_staff", { agentId: targetId }))
      .rejects.toMatchObject({ code: "TOTP_REQUIRED" });
    process.env.STEP_UP_OWNERS_EXEMPT = "0";
    await expect(broker.createPendingAssistantAction(actorOf(directorId, "DIRECTOR"), "delete_staff", { agentId: targetId }))
      .rejects.toMatchObject({ code: "TOTP_REQUIRED" });
  });
});
