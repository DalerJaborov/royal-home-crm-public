import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * КТО ПРИНЯЛ И КТО ВЕДЁТ ОБЪЕКТ МЕНЯЕТ ТОЛЬКО РУКОВОДСТВО (решение владельца
 * 02.10.2026, «да, по советам»; аудит прав 02.10, п.3, и вопрос из журнала
 * глубокой проверки A).
 *
 * У маркетинга и монтажёра есть properties.editForeign — правка чужих карточек
 * по конвейеру. Раньше по нему же они меняли «кто принял» (доля за приём),
 * «кто ведёт» и передавали объект без продавца другому агенту. Теперь это —
 * только у того, кто и правит чужое, и распределяет работу (clients.assign).
 * Остальная правка карточки маркетингу остаётся.
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
let districtId = "";
let firstAgentId = "";
let secondAgentId = "";
let propertyId = "";
let marketingToken = "";
let editorToken = "";
let managerToken = "";

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function current() {
  return prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { intakeAgentId: true, assignedAgentId: true, description: true, version: true },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Район смены агента ${runId}` } })).id;
  const mk = (suffix: string, role: string, name: string) =>
    prisma.agent.create({
      data: { fullName: `${name} ${runId}`, phone: `+99297${suffix}${runId}`, role: role as never, passwordHash },
    });
  const first = await mk("1", "AGENT", "Агент-приёмщик");
  const second = await mk("2", "AGENT", "Агент-второй");
  const marketing = await mk("3", "MARKETING", "Маркетолог");
  const editor = await mk("4", "EDITOR", "Монтажёр");
  const manager = await mk("5", "MANAGER", "Руководитель");
  firstAgentId = first.id;
  secondAgentId = second.id;
  agentIds.push(first.id, second.id, marketing.id, editor.id, manager.id);

  // Без продавца: раньше такую передачу маркетингу разрешали (A4 закрыла
  // только передачу вместе с продавцом).
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект смены агента ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 70000,
        currency: "USD",
        districtId,
        address: `Смена агента ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: first.id,
        assignedAgentId: first.id,
        createdById: first.id,
      },
    })
  ).id;

  marketingToken = await login(marketing.phone);
  editorToken = await login(editor.phone);
  managerToken = await login(manager.phone);
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Маркетинг и монтажёр не меняют приёмщика и ведущего", () => {
  it("маркетинг: «кто принял» и «кто ведёт» молча не меняются, описание сохраняется", async () => {
    const before = await current();
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({
        intakeAgentId: secondAgentId,
        assignedAgentId: secondAgentId,
        description: `Описание от маркетинга ${runId}`,
        version: before.version,
      });
    expect(res.status).toBe(200);
    const after = await current();
    expect(after.intakeAgentId).toBe(firstAgentId);
    expect(after.assignedAgentId).toBe(firstAgentId);
    expect(after.description).toBe(`Описание от маркетинга ${runId}`);
  });

  it("монтажёр: «кто принял» не меняется", async () => {
    const before = await current();
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ intakeAgentId: secondAgentId, version: before.version });
    expect(res.status).toBe(200);
    expect((await current()).intakeAgentId).toBe(firstAgentId);
  });

  it("маркетинг и монтажёр не передают объект даже без продавца — 403", async () => {
    for (const token of [marketingToken, editorToken]) {
      const res = await request(app)
        .post(`/api/v1/properties/${propertyId}/transfer`)
        .set("Authorization", `Bearer ${token}`)
        .send({ toAgentId: secondAgentId, reason: "проверка передачи" });
      expect(res.status).toBe(403);
    }
    const after = await current();
    expect(after.intakeAgentId).toBe(firstAgentId);
    expect(after.assignedAgentId).toBe(firstAgentId);
  });
});

describe("Руководитель меняет как раньше", () => {
  it("PATCH «кто принял» руководителем — меняется", async () => {
    const before = await current();
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ intakeAgentId: secondAgentId, version: before.version });
    expect(res.status).toBe(200);
    expect((await current()).intakeAgentId).toBe(secondAgentId);
  });

  it("передача руководителем — 200", async () => {
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/transfer`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ toAgentId: firstAgentId, reason: "проверка передачи" });
    expect(res.status).toBe(200);
    const after = await current();
    expect(after.intakeAgentId).toBe(firstAgentId);
  });
});
