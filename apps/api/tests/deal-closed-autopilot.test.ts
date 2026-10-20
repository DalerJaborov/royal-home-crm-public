import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * «Коротко от ИИ» обязано узнать об исходе сделки (найдено 18.09.2026): до
 * этой правки сводка на карточке клиента ничего не знала о закрытой/отменённой
 * сделке, пока её случайно не пересчитывал следующий звонок или сообщение.
 * routes/deals.ts теперь зовёт runClientAutopilotInBackground(clientId,
 * "deal_closed") ровно на СЕТТЛЕНИИ (COMPLETED/CANCELLED) — мокаем автопилот,
 * чтобы проверить сам факт вызова, не гоняя настоящий ИИ-скоринг в фоне.
 */

const runClientAutopilotInBackground = vi.fn();
vi.mock("../src/lib/clientAutopilot.js", () => ({ runClientAutopilotInBackground }));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const request = (await import("supertest")).default;

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let directorId = "";
let agentId = "";
let token = "";
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент автопилота-сделки ${runId}-${clientIds.length}`,
      phone: `+992961${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(price: number) {
  const p = await prisma.property.create({
    data: {
      title: `Объект автопилота-сделки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price,
      currency: "TJS",
      districtId,
      address: "Тестовая, автопилот сделки",
      condition: "GOOD",
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeShowing(clientId: string, propertyId: string) {
  await prisma.interaction.create({
    data: { clientId, propertyId, agentId, type: "SHOWING", notes: "Показ проведён", completedAt: new Date() },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-автопилот-сделки-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: `Директор автопилот-сделки ${runId}`, phone: `+992962${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент автопилот-сделки ${runId}`, phone: `+992963${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Закрытие/отмена сделки зовёт автопилот карточки клиента", () => {
  it("директор завершает сделку одним действием → автопилот зовётся с deal_closed", async () => {
    runClientAutopilotInBackground.mockClear();
    const [client, property] = await Promise.all([makeClient(), makeProperty(100000)]);
    await makeShowing(client.id, property.id);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "COMPLETED", soldPrice: 100000, commissionRealtorAmount: 500, commissionCompanyAmount: 500 });
    expect(res.status).toBe(200);

    expect(runClientAutopilotInBackground).toHaveBeenCalledWith(client.id, "deal_closed");
  });

  it("сделку отменяют → автопилот тоже зовётся с deal_closed", async () => {
    runClientAutopilotInBackground.mockClear();
    const [client, property] = await Promise.all([makeClient(), makeProperty(80000)]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "CANCELLED" });
    expect(res.status).toBe(200);

    expect(runClientAutopilotInBackground).toHaveBeenCalledWith(client.id, "deal_closed");
  });

  it("новая сделка и смена этапа — автопилот зовётся с deal_changed, не deal_closed (29.09.2026)", async () => {
    runClientAutopilotInBackground.mockClear();
    const [client, property] = await Promise.all([makeClient(), makeProperty(90000)]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const res = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "AGREEMENT_PENDING" });
    expect(res.status).toBe(200);

    // Сводка ИИ — единственный рассказ о клиенте (блок «Путь клиента» убран), и
    // этап сделки обязан попасть в неё сразу.
    expect(runClientAutopilotInBackground).toHaveBeenCalledWith(client.id, "deal_changed");
    expect(runClientAutopilotInBackground).toHaveBeenCalledTimes(2); // создание + смена этапа
    expect(runClientAutopilotInBackground).not.toHaveBeenCalledWith(client.id, "deal_closed");
  });
});
