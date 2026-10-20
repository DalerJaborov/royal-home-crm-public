import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Пачка 8 (11.09.2026, docs/flow-audit-deal-11-09.md, «Не покрыто тестами»):
 * параллельное закрытие сделки по одному объекту. Директор может открыть
 * карточку сделки в двух вкладках (или дважды нажать «Одобрить» до перезагрузки
 * страницы) — только ОДИН запрос обязан реально продать объект и поставить
 * пост-коммит задание; второй должен получить конфликт, а не вторую продажу.
 */

const runId = Date.now();
const password = "testpass123";

/**
 * Повтор (`retry: 1`) идёт В ТОМ ЖЕ процессе с тем же `runId`, поэтому запись,
 * собранная из одного только `runId`, на втором заходе падает на своём же
 * уникальном индексе — и настоящая причина падения прячется за
 * «Unique constraint failed on `Client_phone_key`» (грабля из CLAUDE.md,
 * поймана здесь 21.09.2026). Каждая запись берёт свой номер.
 */
let uniqueCounter = 0;
const nextUnique = () => `${runId}${(uniqueCounter += 1)}`;

let districtId: string;
let directorId: string;
let agentId: string;
let directorToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-параллель-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор параллели", phone: `+992964${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент параллели", phone: `+992965${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const dirLogin = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(dirLogin.status).toBe(200);
  directorToken = dirLogin.body.accessToken as string;
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: dealIds.map((id) => `deal-close-followup:${id}`) } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

it("два одновременных PATCH COMPLETED на одну сделку — только один продаёт объект", async () => {
  const clientSuffix = nextUnique();
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент параллели ${clientSuffix}`,
      phone: `+992966${clientSuffix}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  const property = await prisma.property.create({
    data: {
      title: `Объект параллели ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, параллель",
      condition: "GOOD",
    },
  });
  propertyIds.push(property.id);
  await prisma.interaction.create({
    data: { clientId: client.id, propertyId: property.id, agentId, type: "SHOWING", notes: "Показ", completedAt: new Date() },
  });
  const created = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${directorToken}`)
    .send({ clientId: client.id, propertyId: property.id, agentId });
  expect(created.status).toBe(201);
  dealIds.push(created.body.id);
  const dealId = created.body.id as string;

  await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${directorToken}`).send({
    stage: "PENDING_APPROVAL",
    soldPrice: 95000,
    commissionRealtorAmount: 500,
    commissionCompanyAmount: 1000,
  });

  const [first, second] = await Promise.all([
    request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${directorToken}`).send({ stage: "COMPLETED" }),
    request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${directorToken}`).send({ stage: "COMPLETED" }),
  ]);

  const statuses = [first.status, second.status].sort();
  /**
   * Исходов у честного кода ДВА, и зависят они от того, успели ли запросы
   * наложиться друг на друга, — а этим тест не управляет:
   *
   * - запросы наложились: оба прочитали сделку ещё незакрытой (routes/deals.ts,
   *   `existing` читается ДО транзакции), оба пошли продавать объект, и второму
   *   `updateMany` с `where: status IN (AVAILABLE, RESERVED)` не находит строки
   *   → DealConflictError → 409;
   * - запросы разошлись во времени: второй прочитал сделку уже со
   *   `stage: "COMPLETED"`, поэтому `isCompleting` у него false, объект он не
   *   трогает вовсе и честно отвечает 200 — повторное «Одобрить» по закрытой
   *   сделке и должно быть безобидным no-op, а не ошибкой.
   *
   * Прежнее жёсткое `[200, 409]` считало вторым исходом поломку и краснело на
   * загруженном раннике при полностью исправном коде (21.09.2026). Проверяем то,
   * ради чего тест написан: объект продан РОВНО ОДИН раз и пост-коммит задание
   * поставлено РОВНО ОДНО — это ниже и не зависит от совпадения по времени.
   */
  expect(statuses[0]).toBe(200);
  expect([200, 409]).toContain(statuses[1]);

  const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
  expect(propertyAfter?.status).toBe("SOLD");
  expect(Number(propertyAfter?.soldPrice)).toBe(95000);

  // «Сделка закрыта» в хронологии клиента пишется ровно там, где этап реально
  // сменился (routes/deals.ts, `data.stage !== existing.stage`), и внутри той же
  // транзакции. Значит две такие записи означали бы, что закрытие прошло дважды,
  // — а это и есть то, что тест сторожит, в обоих исходах по времени.
  const closeEntries = await prisma.interaction.findMany({
    where: { clientId: client.id, type: "SYSTEM", notes: "Сделка закрыта" },
    select: { id: true },
  });
  expect(closeEntries).toHaveLength(1);

  // Пост-коммит задание поставлено ровно один раз — dedupeKey держит остальные
  // попытки как no-op, а не создаёт вторую строку.
  const jobs = await prisma.backgroundJob.findMany({ where: { dedupeKey: `deal-close-followup:${dealId}` } });
  expect(jobs).toHaveLength(1);
});
