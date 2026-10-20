import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomInt } from "node:crypto";

/**
 * B13 глубокой проверки 02.10.2026, решение владельца «да, по советам»:
 * ручное назначение клиента проверяет получателя. Отключённому или
 * замороженному (отпуск, больничный) — НЕЛЬЗЯ, с понятной причиной; сотруднику
 * не в роли агента (директор, менеджер) — МОЖНО, экран предупреждает сам.
 * Раньше /assign пропускал замороженного, а создание клиента — любого.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const password = "testpass123";
const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
let directorPhone = "";
let directorId = "";
let frozenId = "";
let inactiveId = "";
let managerId = "";
let leavingId = "";
let token = "";
const clientIds: string[] = [];

async function makeClient(name: string) {
  const c = await prisma.client.create({
    data: { fullName: `${name} B13`, phone: phone(), kind: "BUYER", source: "WALK_IN", status: "NEW" },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  const mk = async (fullName: string, role: "AGENT" | "DIRECTOR" | "MANAGER", extra: Record<string, unknown> = {}) => {
    const p = phone();
    const a = await prisma.agent.create({ data: { fullName, phone: p, role, passwordHash, ...extra } });
    return { id: a.id, phone: p };
  };
  const director = await mk("Директор B13", "DIRECTOR");
  directorId = director.id;
  directorPhone = director.phone;
  frozenId = (await mk("Фаррух в отпуске B13", "AGENT", { frozenAt: new Date() })).id;
  inactiveId = (await mk("Уволенный B13", "AGENT", { isActive: false })).id;
  managerId = (await mk("Менеджер B13", "MANAGER")).id;
  leavingId = (await mk("Уходящий B13", "AGENT")).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: directorPhone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
  grantElevation(directorId);
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { phone: { startsWith: "+99293" }, fullName: { endsWith: "B13" } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([directorId, frozenId, inactiveId, managerId, leavingId]);
  await prisma.$disconnect();
});

describe("B13: ручное назначение — проверка получателя", () => {
  it("замороженному назначить нельзя — понятная причина, клиент остаётся без него", async () => {
    const c = await makeClient("Клиент для замороженного");
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId: frozenId });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("заморож");
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id }, select: { assignedAgentId: true } });
    expect(after.assignedAgentId).toBeNull();
  });

  it("отключённому назначить нельзя — ответ называет сотрудника и причину", async () => {
    const c = await makeClient("Клиент для отключённого");
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId: inactiveId });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Уволенный B13");
    expect(res.body.error).toContain("отключ");
  });

  it("сотруднику не в роли агента (менеджер) назначить можно", async () => {
    const c = await makeClient("Клиент для менеджера");
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${token}`)
      .send({ agentId: managerId });
    expect(res.status).toBe(200);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id }, select: { assignedAgentId: true } });
    expect(after.assignedAgentId).toBe(managerId);
  });

  it("создание клиента сразу на замороженного — отказ, карточка не заводится", async () => {
    const p = phone();
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Новый на замороженного B13", phone: p, source: "WALK_IN", kind: "BUYER", assignedAgentId: frozenId });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("заморож");
    expect(await prisma.client.count({ where: { phone: p } })).toBe(0);
  });

  it("«Передача дел» замороженному — отказ", async () => {
    const res = await request(app)
      .post(`/api/v1/agents/${leavingId}/handover`)
      .set("Authorization", `Bearer ${token}`)
      .send({ toAgentId: frozenId, deactivate: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("заморож");
  });
});
