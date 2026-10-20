import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { propertyOwnerAgentId } from "../src/lib/propertyOwner.js";

/**
 * «Чей объект» — ОДНО правило на список, карту и профиль сотрудника (28.09.2026,
 * жалоба владельца «объекты Нозы не показывает админке, или показывает как-то
 * не так»). До этой правки «Мои объекты» смотрели только на intakeAgentId,
 * профиль — на OR трёх полей, а строка списка подписывала чужое имя. Тест
 * сверяет каждую выдачу с самим правилом `propertyOwnerAgentId`.
 */

const runId = Date.now();
const password = "testpass123";
let districtId: string;
let nozaId: string;
let otherId: string;
let directorToken: string;
const ids: Record<string, string> = {};

async function makeProperty(key: string, owners: { intakeAgentId?: string; assignedAgentId?: string; createdById?: string }) {
  const p = await prisma.property.create({
    data: {
      title: `Хозяин ${key} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 5",
      condition: "GOOD",
      status: "AVAILABLE",
      ...owners,
    },
  });
  ids[key] = p.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Хозяин-объекта-${runId}` } })).id;
  nozaId = (await prisma.agent.create({ data: { fullName: "Ноза Тест", phone: `+992971${runId}`, role: "AGENT", passwordHash } })).id;
  otherId = (await prisma.agent.create({ data: { fullName: "Другой Тест", phone: `+992972${runId}`, role: "AGENT", passwordHash } })).id;
  const director = await prisma.agent.create({ data: { fullName: "Директор Тест", phone: `+992973${runId}`, role: "DIRECTOR", passwordHash } });

  await makeProperty("accepted", { intakeAgentId: nozaId, assignedAgentId: otherId });
  await makeProperty("dealOnly", { assignedAgentId: nozaId });
  await makeProperty("createdOnly", { createdById: nozaId });
  await makeProperty("acceptedByOther", { intakeAgentId: otherId, assignedAgentId: nozaId, createdById: nozaId });

  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(res.status).toBe(200);
  directorToken = res.body.accessToken;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [`+992971${runId}`, `+992972${runId}`, `+992973${runId}`] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function expectedNozaIds(): Promise<string[]> {
  const rows = await prisma.property.findMany({ where: { id: { in: Object.values(ids) } } });
  return rows.filter((p) => propertyOwnerAgentId(p) === nozaId).map((p) => p.id).sort();
}

describe("Чей объект — одно правило", () => {
  it("правило само по себе: принял → ведёт → завёл", async () => {
    expect((await expectedNozaIds()).length).toBe(3);
  });

  it("список «Мои объекты» агента совпадает с правилом", async () => {
    const res = await request(app)
      .get(`/api/v1/properties?agentId=${nozaId}&districtId=${districtId}&pageSize=50`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const got = (res.body.items as { id: string }[]).map((p) => p.id).sort();
    expect(got).toEqual(await expectedNozaIds());
  });

  it("фильтр агента складывается с поиском, а не затирает его", async () => {
    const res = await request(app)
      .get(`/api/v1/properties?agentId=${nozaId}&districtId=${districtId}&q=${encodeURIComponent("dealOnly")}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const got = (res.body.items as { id: string }[]).map((p) => p.id);
    expect(got).toEqual([ids.dealOnly]);
  });

  it("профиль сотрудника считает те же объекты", async () => {
    const res = await request(app).get(`/api/v1/agents/${nozaId}/overview`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.properties.total).toBe((await expectedNozaIds()).length);
  });
});
