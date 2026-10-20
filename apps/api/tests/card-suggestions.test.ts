import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * ЧТО ОСТАЛОСЬ ОТ «ПРЕДЛОЖЕНИЯ ПО РАЗГОВОРУ» ПОСЛЕ 12.09.2026.
 *
 * Решение владельца 07.08.2026 требовало подтверждения агентом: распознавание живой
 * речи ошибается, особенно на смеси таджикского и русского. Под это жили три
 * маршрута — «что показать», «записать», «отклонить» — и баннер в карточке клиента.
 *
 * 12.09.2026 владелец отменил подтверждение целиком: «блок „После разговора:
 * проверьте, верно ли поняли клиента“ я уже сто раз убираю, чтобы он исчез у всех и
 * больше не появлялся. Я специально плачу за дорогую модель, чтобы она не
 * переспрашивала». Разбор пишет услышанное в карточку сам и молча — это проверяется
 * в card-auto-apply.test.ts.
 *
 * Здесь остались две вещи:
 *  1. ИСТОРИЯ разборов (GET /:id/card-suggestions) — единственное место, где видно,
 *     что именно машина расслышала и на каких цитатах клиента это держится;
 *  2. сторож: трёх маршрутов баннера БОЛЬШЕ НЕТ. Тест на их отсутствие существует
 *     затем, чтобы возврат баннера нельзя было сделать незаметно.
 */

const runId = Date.now();
let agentId = "";
let otherAgentId = "";
let clientId = "";
let districtId = "";
let agentToken = "";
let otherToken = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент разбора ${runId}`, phone: `+99281${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const other = await prisma.agent.create({
    data: { fullName: `Чужой агент ${runId}`, phone: `+99282${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  otherAgentId = other.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  otherToken = signAccessToken({ sub: other.id, role: "AGENT" });

  const district = await prisma.district.create({ data: { name: `Район разбора ${runId}` } });
  districtId = district.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент разбора ${runId}`,
      phone: `+99283${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

afterEach(async () => {
  await prisma.cardSuggestion.deleteMany({ where: { clientId } });
  await prisma.client.update({
    where: { id: clientId },
    data: {
      budgetMin: null,
      budgetMax: null,
      desiredDistrictId: null,
      desiredRooms: null,
      desiredType: null,
      requirementsNotes: null,
    },
  });
});

afterAll(async () => {
  await prisma.cardSuggestion.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

async function createSuggestion(status = "applied") {
  return prisma.cardSuggestion.create({
    data: {
      clientId,
      agentId,
      status,
      resolvedAt: status === "pending" ? null : new Date(),
      budgetMin: 40000,
      budgetMax: 55000,
      districtId,
      rooms: 2,
      type: "APARTMENT",
      notes: "Ищет двушку, важен свежий ремонт",
      evidence: ["двухкомнатную бы", "тысяч пятьдесят максимум"],
    },
  });
}

/**
 * СТОРОЖ ОТМЕНЁННОГО БАННЕРА. Владелец убирал этот блок «сто раз» — значит, его
 * возвращали столько же. Маршруты удалены, и это проверяется явно: пока express
 * отвечает на них 404, баннер нельзя оживить одной правкой фронтенда.
 */
describe("Маршруты подтверждения удалены вместе с баннером (12.09.2026)", () => {
  it("GET /card-suggestion больше нет", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/card-suggestion`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });

  it("POST /card-suggestion/apply больше нет", async () => {
    await createSuggestion("pending");
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/card-suggestion/apply`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ rooms: 2 });
    expect(res.status).toBe(404);

    // И карточка от этого не поменялась: записать «подтверждением» больше нечем.
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.desiredRooms).toBeNull();
  });

  it("POST /card-suggestion/dismiss больше нет", async () => {
    await createSuggestion("pending");
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/card-suggestion/dismiss`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });
});

/**
 * История предложений — п.8 ТЗ «Путь покупателя»: разворачивающийся список на
 * карточке клиента, что машина расслышала раньше и чем это кончилось.
 */
describe("История предложений по клиенту", () => {
  it("отдаёт прошлые разборы новыми сверху, со статусом, цитатами и когда решено", async () => {
    const first = await createSuggestion();
    const second = await prisma.cardSuggestion.create({
      data: {
        clientId,
        agentId,
        rooms: 3,
        notes: "Передумал: нужна трёшка",
        evidence: ["сеҳуҷрагӣ"],
        status: "applied",
        resolvedAt: new Date(),
      },
    });

    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/card-suggestions`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Новые сверху: второй разбор позже первого.
    expect(res.body[0].id).toBe(second.id);
    expect(res.body[0].status).toBe("applied");
    expect(res.body[0].resolvedAt).not.toBeNull();
    expect(res.body[1].id).toBe(first.id);
    expect(res.body[1]).toMatchObject({ budgetMin: 40000, budgetMax: 55000, rooms: 2, type: "APARTMENT" });
    // Цитаты клиента — то, ради чего история и нужна: по ним видно, из каких слов
    // машина взяла цифру, которую записала в карточку молча.
    expect(res.body[1].evidence.length).toBeGreaterThan(0);
  });

  it("чужой агент не видит историю предложений по не своему клиенту", async () => {
    await createSuggestion();

    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/card-suggestions`)
      .set("Authorization", `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  it("нет предложений вовсе — пустой список, а не ошибка", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/card-suggestions`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
