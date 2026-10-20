import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * «Объект принят в работу» (спецификация, «Путь продавца»/«Контроль объекта»):
 * исход звонка продавцу, который сам заводит 36-часовой таймер «Итог объекта» —
 * от МОМЕНТА ЗВОНКА, а не от создания карточки объекта (которой на этот момент
 * может ещё не быть вовсе). Таймер живёт на PendingSummary(kind="property").
 *
 * SUBJECTID — ID ЗВОНКА, А НЕ КЛИЕНТА (03.09.2026, план §I; до этого был
 * client.id). Продавец способен отдать в работу два объекта подряд, а
 * unique([kind, subjectId]) пускал по клиенту ровно одну запись — второй звонок
 * «принят» тихо не заводил ничего. Теперь у каждой договорённости свой контроль,
 * а при создании карточки объекта закрывается САМАЯ СТАРАЯ незакрытая, FIFO
 * (closeOldestSellerPropertyAgreement) — переносом subjectId на карточку, без
 * сброса dueAt, как и раньше.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(kind: "SELLER" | "BUYER") {
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец ${runId}-${clientIds.length}`,
      phone: `+992960${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind,
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-таймер-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент таймера объекта", phone: `+992961${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  token = await login(agent.phone);
});

afterAll(async () => {
  await prisma.pendingSummary.deleteMany({ where: { agentId } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Исход «Объект принят в работу» — только для продавца", () => {
  it("у покупателя такой исход ничего не заводит — понятия «объект в работе» у него нет", async () => {
    const client = await makeClient("BUYER");
    const res = await request(app)
      .post(`/api/v1/clients/${client.id}/interactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ notes: "На всякий случай", type: "CALL", outcome: "PROPERTY_ACCEPTED" });
    expect(res.status).toBe(201);

    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.propertyAcceptedAt).toBeNull();
    const summary = await prisma.pendingSummary.findFirst({ where: { kind: "property", subjectId: res.body.id } });
    expect(summary).toBeNull();
  });

});

describe("Перенос таймера на карточку объекта при создании", () => {
  /**
   * ПРАВИЛО ИЗМЕНИЛОСЬ 09.09.2026 (владелец): объект с телефоном собственника
   * теперь ЗАВОДИТ карточку продавца сам, даже если имени никто не спросил —
   * «номер автоматически уже сам прикрепляется, и руководство его видит».
   *
   * Раньше без имени карточка не создавалась, и объект оставался с телефоном в
   * поле `ownerContact` — то есть собственник существовал в базе как строка, а
   * не как человек: ни хронологии, ни тревог, ни светофора по нему не было.
   * Имя подставляется заглушкой и правится потом.
   *
   * Проверяемое здесь остаётся прежним: перенос ЧУЖИХ таймеров. Карточка
   * заводится новая, и требований на ней быть не должно.
   */
  it("создание объекта без clientId заводит карточку продавца, но чужих таймеров не трогает", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "APARTMENT",
        areaSqm: 40,
        rooms: 1,
        floor: 2,
        totalFloors: 5,
        windowCount: 2,
        price: 200000,
        currency: "TJS",
        districtId,
        address: "Тестовая, без заявки продавца",
        condition: "GOOD",
        // Не сидовый номер сотрудника (staffPhoneGuard, 17.09.2026) — здесь важно
        // само авто-создание карточки продавца, а не конкретное значение номера.
        ownerContact: `+992937${runId}`,
      });
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);

    const sellerId = res.body.sellerClientId as string | null;
    expect(sellerId).not.toBeNull();
    clientIds.push(sellerId!);
    const seller = await prisma.client.findUnique({ where: { id: sellerId! } });
    expect(seller?.phone).toBe(`+992937${runId}`);

    // Ни одного требования на новой карточке: переносить было нечего.
    // Требование живёт на subjectId — он же id клиента (см. остальные тесты файла).
    const summary = await prisma.pendingSummary.findFirst({ where: { subjectId: sellerId! } });
    expect(summary).toBeNull();
  });
});
