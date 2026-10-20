import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ГЕЙТ «ПОСЛЕ ПЕРВОГО ПРОВЕДЁННОГО ПОКАЗА» (ТЗ пп. 16, 19).
 *
 * До 14.08.2026 и карточка, и сервер считали просто НАЛИЧИЕ записи type="SHOWING".
 * Показ создаётся в момент НАЗНАЧЕНИЯ, на будущую дату, — значит агент назначал
 * показ на следующий месяц и тут же получал «Передачу» и «Завершить сделку». ТЗ
 * запрещает ровно это: «предотвращает фиктивное закрытие клиента без реальной
 * работы». Отменённый показ (declinedAt) засчитывался наравне с проведённым.
 *
 * Проведённым считается показ: не отменённый И (отмечен выполненным ИЛИ записан
 * задним числом без nextActionDate ИЛИ его время уже прошло) — см.
 * lib/conductedShowing.ts.
 *
 * Здесь же — возврат клиента из «Неактивных» (ТЗ п. 27): до этой же даты
 * обратного перехода не существовало вовсе.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let secondAgentId: string;
let token: string;
let propertyId: string;
const clientIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент гейта ${runId}-${clientIds.length}`,
      phone: `+992941${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Показ в том виде, в каком его создаёт НАЗНАЧЕНИЕ: будущая дата, задача висит. */
async function scheduleFutureShowing(clientId: string) {
  return prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "SHOWING",
      propertyId,
      notes: "Показ назначен",
      nextAction: "Показ объекта",
      nextActionDate: new Date(Date.now() + 30 * 24 * 3600_000),
    },
  });
}

function transfer(clientId: string) {
  return request(app)
    .post(`/api/v1/clients/${clientId}/transfer`)
    .set("Authorization", `Bearer ${token}`)
    .send({ reason: "NO_TRUST" });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-гейт-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент гейта", phone: `+992942${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  secondAgentId = (
    await prisma.agent.create({
      data: { fullName: "Второй агент гейта", phone: `+992943${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+992942${runId}`, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект гейта ${runId}`,
        type: "APARTMENT",
        areaSqm: 45,
        price: 50000,
        currency: "TJS",
        districtId,
        address: "Тест",
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, secondAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("«Передача» считает проведённые показы, а не назначенные", () => {
  it("показ назначен на будущее — 409: работа ещё не началась", async () => {
    const c = await makeClient();
    await scheduleFutureShowing(c.id);
    const res = await transfer(c.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("после первого проведённого показа");
  });

  it("показ отмечен выполненным — передача проходит", async () => {
    const c = await makeClient();
    const showing = await scheduleFutureShowing(c.id);
    await prisma.interaction.update({ where: { id: showing.id }, data: { completedAt: new Date() } });
    expect((await transfer(c.id)).status).toBe(200);
  });

  it("время показа уже прошло — передача проходит даже без отметки «выполнен»", async () => {
    const c = await makeClient();
    await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId,
        type: "SHOWING",
        propertyId,
        notes: "Показ был вчера",
        nextAction: "Показ объекта",
        nextActionDate: new Date(Date.now() - 24 * 3600_000),
      },
    });
    expect((await transfer(c.id)).status).toBe(200);
  });

  it("показ записан задним числом (без задачи) — передача проходит", async () => {
    const c = await makeClient();
    await prisma.interaction.create({
      data: { clientId: c.id, agentId, type: "SHOWING", propertyId, notes: "Съездили, записал потом" },
    });
    expect((await transfer(c.id)).status).toBe(200);
  });

  it("показ отменён — не считается: 409", async () => {
    const c = await makeClient();
    const showing = await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId,
        type: "SHOWING",
        propertyId,
        notes: "Показ отменён клиентом",
        nextActionDate: new Date(Date.now() - 24 * 3600_000),
      },
    });
    await prisma.interaction.update({ where: { id: showing.id }, data: { declinedAt: new Date() } });
    const res = await transfer(c.id);
    expect(res.status).toBe(409);
  });
});

describe("«Завершить сделку → Без сделки» подчиняется тому же гейту", () => {
  it("показ только назначен — 409", async () => {
    const c = await makeClient();
    await scheduleFutureShowing(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/refuse`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "CHANGED_MIND", initiator: "CLIENT", comment: "Передумал покупать совсем" });
    expect(res.status).toBe(409);
  });

  it("уже потерянного клиента нельзя завершить повторно — 409, счётчик переходов не растёт", async () => {
    const c = await makeClient();
    await prisma.interaction.create({
      data: { clientId: c.id, agentId, type: "SHOWING", propertyId, notes: "Показ был" },
    });
    await prisma.client.update({ where: { id: c.id }, data: { status: "LOST", refusalCount: 3 } });

    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/refuse`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "CHANGED_MIND", initiator: "CLIENT", comment: "Ещё раз завершаю ту же карточку" });
    expect(res.status).toBe(409);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.refusalCount).toBe(3);
  });
});

describe("Возврат клиента из «Неактивных» (ТЗ п. 27)", () => {
  it("POST /clients/:id/activate возвращает работу и пишет след в хронологии", async () => {
    const c = await makeClient();
    await prisma.client.update({ where: { id: c.id }, data: { workStatus: "INACTIVE" } });

    const res = await request(app).post(`/api/v1/clients/${c.id}/activate`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.workStatus).toBe("ACTIVE");
    // Агент остаётся прежним: возврат — это не перераспределение.
    expect(after.assignedAgentId).toBe(agentId);

    const note = await prisma.interaction.findFirst({
      where: { clientId: c.id, type: "SYSTEM", notes: { contains: "возвращён в работу" } },
    });
    expect(note).not.toBeNull();
  });

  it("повторный вызов на уже активном клиенте не плодит записи в хронологии", async () => {
    const c = await makeClient();
    await prisma.client.update({ where: { id: c.id }, data: { workStatus: "INACTIVE" } });
    await request(app).post(`/api/v1/clients/${c.id}/activate`).set("Authorization", `Bearer ${token}`);
    await request(app).post(`/api/v1/clients/${c.id}/activate`).set("Authorization", `Bearer ${token}`);

    const notes = await prisma.interaction.count({
      where: { clientId: c.id, type: "SYSTEM", notes: { contains: "возвращён в работу" } },
    });
    expect(notes).toBe(1);
  });

  /**
   * 06.09.2026: до этого теста роут отклонял ЛЮБОГО клиента с kind!=="BUYER" —
   * продавец, ушедший в workStatus=INACTIVE (например, автодеактивацией за
   * молчание — та же reactivateClient() кинд не проверяет), не мог вернуться в
   * работу вообще: единственная кнопка возврата получала 409 с сервера.
   */
  it("работает и для продавца — reactivateClient() кинд не проверяет", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Продавец возврата ${runId}`,
        phone: `+992942${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        workStatus: "INACTIVE",
      },
    });
    clientIds.push(c.id);

    const res = await request(app).post(`/api/v1/clients/${c.id}/activate`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.workStatus).toBe("ACTIVE");
  });

  /**
   * POST /clients/:id/deactivate УБРАН ЦЕЛИКОМ (владелец 16.09.2026) вместе с
   * последней ручной кнопкой перевода в Неактивные — здесь раньше проверялась
   * его собственная проверка «до принятия лида нельзя». Гейт «след работы»
   * (deactivateClient/canDeactivateWithReason) остался и проверяется в
   * inactive-traffic-light.test.ts напрямую, без HTTP-слоя.
   */
});
