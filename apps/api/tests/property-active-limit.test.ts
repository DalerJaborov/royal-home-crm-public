import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Лимит активных объектов агента (спецификация владельца, Этап 9: «освобождает
 * одно место из лимита» по завершении). 0 = выключен — владелец не назвал число,
 * поэтому нет умолчания, кроме «без лимита».
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let adminToken: string;
const agentIds: string[] = [];
const propertyIds: string[] = [];

/** Отдельный агент на тест — иначе объекты, заведённые в одном тесте, засчитались
 *  бы в лимит следующего, и тесты стали бы зависеть от порядка выполнения. */
async function makeAgent() {
  const id = (
    await prisma.agent.create({
      data: {
        fullName: `Агент лимита ${agentIds.length}`,
        phone: `+992952${agentIds.length}${runId.toString().slice(-6)}`,
        role: "AGENT",
        passwordHash: "x",
      },
    })
  ).id;
  agentIds.push(id);
  return id;
}

async function createViaApi(intakeAgentId: string) {
  const res = await request(app)
    .post("/api/v1/properties")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      type: "APARTMENT",
      areaSqm: 50,
      rooms: 2,
      floor: 3,
      totalFloors: 9,
      windowCount: 3,
      price: 300000,
      currency: "TJS",
      districtId,
      address: `Тестовая лимит, ${propertyIds.length}`,
      condition: "GOOD",
      // НЕ +992900000000 (17.09.2026): это номер сидового директора, и
      // guard на номер сотрудника (lib/staffPhoneGuard.ts) теперь его
      // справедливо отбивает — контакт владельца здесь для теста лимита
      // не важен, годится любой не занятый сотрудником номер.
      ownerContact: `+992937${runId.toString().slice(-6)}`,
      intakeAgentId,
    });
  if (res.body?.id) propertyIds.push(res.body.id);
  return res;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-лимит-${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await prisma.agent.create({
    data: { fullName: "Админ лимита", phone: `+992950${runId.toString().slice(-6)}`, role: "ADMIN", passwordHash },
  });
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: `+992950${runId.toString().slice(-6)}`, password });
  adminToken = res.body.accessToken;
});

afterEach(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyActiveLimit: 0 } });
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { phone: `+992950${runId.toString().slice(-6)}` } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Лимит активных объектов", () => {
  it("выключен (0) — создаётся сколько угодно", async () => {
    const agentId = await makeAgent();
    const a = await createViaApi(agentId);
    const b = await createViaApi(agentId);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("включённый лимит блокирует создание сверх него", async () => {
    const agentId = await makeAgent();
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyActiveLimit: 1 } });

    const first = await createViaApi(agentId);
    expect(first.status).toBe(201);

    const second = await createViaApi(agentId);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/лимит/i);
  });

  it("объект, вышедший из конвейера в продажу, освобождает место", async () => {
    const agentId = await makeAgent();
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyActiveLimit: 1 } });

    const first = await createViaApi(agentId);
    expect(first.status).toBe(201);

    // Второй пока не проходит — лимит занят.
    const blocked = await createViaApi(agentId);
    expect(blocked.status).toBe(409);

    // Тот же приём, что и в property-goes-on-sale.test.ts: 6 фото (владелец
    // 05.08.2026: минимум обязателен) + ссылка на видео снимают блокеры выхода в продажу.
    await prisma.propertyPhoto.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        propertyId: first.body.id,
        url: `/uploads/test${i}.jpg`,
        thumbUrl: `/uploads/test${i}-thumb.jpg`,
        order: i,
      })),
    });
    const toSale = await request(app)
      .patch(`/api/v1/properties/${first.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "AVAILABLE", instagramUrl: "https://instagram.com/reel/test" });
    expect(toSale.status).toBe(200);

    const afterFree = await createViaApi(agentId);
    expect(afterFree.status).toBe(201);
  });
});
