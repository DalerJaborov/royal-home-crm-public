import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client.js";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";

/**
 * Телефон клиента виден только по праву `clients.viewPhone` — и ВО ВСЕХ разделах.
 *
 * Файл появился после разбора 07.08.2026. Правило было записано в одном маршруте
 * (`routes/clients.ts`) и выглядело работающим, но остальные пять отдавали номер
 * целиком: календарь, сделки, инбокс, главная и карточка сотрудника. То есть
 * ограничение существовало ровно там, где на него смотрели.
 *
 * Поэтому здесь проверяется не функция маскировки, а КАЖДЫЙ раздел, который отдаёт
 * клиента наружу. Добавляете новый — добавьте и проверку сюда, иначе правило снова
 * станет декоративным.
 */

const runId = Date.now();
const PHONE = `+99290${String(runId).slice(-7)}`;
let agentId = "";
let directorId = "";
let clientId = "";
/** Карточка открывается по КОРОТКОМУ номеру (GET /clients/:id ждёт shortId): по uuid
 *  маршрут честно отвечает 404, и проверка «телефон закрыт» прошла бы вхолостую. */
let clientShortId = 0;
let dealId = "";
let conversationId = "";
let districtId = "";
let agentToken = "";
let directorToken = "";
/**
 * Менеджер и СБ — не «ещё две роли для полноты», а единственные, кто ловит подмену
 * права. У пресета AGENT нет НИ `clients.viewAll`, НИ `clients.viewPhone`, поэтому
 * маршрут, спрашивающий не то право, под токеном агента ведёт себя правильно, и
 * проверка проходит вхолостую. У MANAGER есть viewAll и нет viewPhone, у SECURITY —
 * securityReview и viewAll, тоже без viewPhone. На этом 09.08.2026 и попались
 * календарь (спрашивал viewAll) и кабинет СБ (не спрашивал ничего).
 */
let managerId = "";
let securityId = "";
let managerToken = "";
let securityToken = "";

/** Номер закрыт: видно начало и хвост, середина съедена. */
function isMasked(value: unknown): boolean {
  return typeof value === "string" && value.includes("•") && !value.includes(PHONE.slice(5, 9));
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент видимости ${runId}`, phone: `+99291${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const director = await prisma.agent.create({
    data: { fullName: `Директор видимости ${runId}`, phone: `+99292${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер видимости ${runId}`, phone: `+99293${String(runId).slice(-7)}`, role: "MANAGER", passwordHash: "x" },
  });
  const security = await prisma.agent.create({
    data: { fullName: `СБ видимости ${runId}`, phone: `+99294${String(runId).slice(-7)}`, role: "SECURITY", passwordHash: "x" },
  });
  agentId = agent.id;
  directorId = director.id;
  managerId = manager.id;
  securityId = security.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент видимости ${runId}`,
      phone: PHONE,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;

  // Задача живёт внутри записи взаимодействия (см. lib/tasks.ts), отдельной модели
  // задач в CRM нет. Эта попадёт и в календарь, и в «задачи на сегодня» на главной.
  await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId: agent.id,
      type: "CALL",
      notes: "проверка видимости телефона",
      nextAction: "перезвонить",
      nextActionDate: new Date(),
    },
  });

  const district = await prisma.district.create({ data: { name: `Район видимости ${runId}` } });
  districtId = district.id;
  const property = await prisma.property.create({
    data: {
      title: `Объект видимости ${runId}`,
      address: "Рудаки 1",
      price: 100000,
      areaSqm: 50,
      currency: "USD",
      type: "APARTMENT",
      condition: "GOOD",
      status: "AVAILABLE",
      districtId,
      assignedAgentId: agent.id,
    },
  });
  const deal = await prisma.deal.create({
    data: { clientId: client.id, propertyId: property.id, agentId: agent.id, stage: "NEGOTIATION" },
  });
  dealId = deal.id;

  // Диалог, ПОСЛЕДНЯЯ реплика которого — продиктованный клиентом номер. Именно такая
  // реплика чаще всего и оказывается последней, а список инбокса показывает её превью.
  const conversation = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `vis-${runId}`,
      clientId: client.id,
      lastMessageAt: new Date(),
      messages: [
        { role: "assistant", content: "Оставьте номер, агент перезвонит", at: new Date().toISOString() },
        { role: "user", content: `Мой номер ${PHONE}`, at: new Date().toISOString() },
      ],
    },
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: conversationId } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { title: `Объект видимости ${runId}` } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId, managerId, securityId] } } });
  await prisma.$disconnect();
});

describe("Телефон клиента закрыт от сотрудника во всех разделах", () => {
  it("карточка клиента", async () => {
    const res = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(isMasked(res.body.phone), `пришло: ${res.body.phone}`).toBe(true);
  });

  it("список клиентов", async () => {
    const res = await request(app).get("/api/v1/clients").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const found = res.body.items.find((c: { id: string }) => c.id === clientId);
    expect(found, "клиент не найден в списке").toBeDefined();
    expect(isMasked(found.phone), `пришло: ${found.phone}`).toBe(true);
  });

  it("календарь: задача с клиентом", async () => {
    const res = await request(app).get("/api/v1/calendar/tasks").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const task = res.body.find((t: { client?: { id: string } }) => t.client?.id === clientId);
    expect(task, "задача не найдена").toBeDefined();
    expect(isMasked(task.client.phone), `пришло: ${task.client.phone}`).toBe(true);
  });

  it("сделки", async () => {
    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const deal = res.body.find((d: { id: string }) => d.id === dealId);
    expect(deal, "сделка не найдена").toBeDefined();
    expect(isMasked(deal.client.phone), `пришло: ${deal.client.phone}`).toBe(true);
  });

  it("главная: задачи на сегодня", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const task = res.body.tasksToday?.find((t: { client?: { fullName: string } }) =>
      t.client?.fullName?.includes(String(runId))
    );
    if (task?.client?.phone) {
      expect(isMasked(task.client.phone), `пришло: ${task.client.phone}`).toBe(true);
    }
  });

  it("календарь под менеджером: viewAll не даёт права на номер", async () => {
    const res = await request(app).get("/api/v1/calendar/tasks").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const task = res.body.find((t: { client?: { id: string } }) => t.client?.id === clientId);
    expect(task, "задача не найдена").toBeDefined();
    expect(isMasked(task.client.phone), `пришло: ${task.client.phone}`).toBe(true);
  });

  it("кабинет СБ: у роли SECURITY нет права на номера", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { securityReview: "PENDING" } });
    const res = await request(app).get("/api/v1/security/lost-clients").set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((c: { id: string }) => c.id === clientId);
    expect(row, "клиент не найден в кабинете СБ").toBeDefined();
    expect(isMasked(row.phone), `пришло: ${row.phone}`).toBe(true);
    await prisma.client.update({ where: { id: clientId }, data: { securityReview: null } });
  });

  it("сохранение карточки не возвращает агенту открытый номер", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${clientId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ requirementsNotes: `проверка ответа PATCH ${runId}` });
    expect(res.status).toBe(200);
    expect(isMasked(res.body.phone), `пришло: ${res.body.phone}`).toBe(true);
  });

  /**
   * 07.09.2026. Превью последней реплики в списке диалогов бралось из jsonb сырым,
   * мимо presentMessages — той самой функции, что маскирует номера ВНУТРИ переписки.
   * Клиент диктует номер в чат постоянно, и эта реплика почти всегда последняя,
   * поэтому запрет обходился открытием списка: заходить в переписку было не нужно.
   */
  it("инбокс: номер из последней реплики не утекает в превью списка диалогов", async () => {
    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { id: string }) => i.id === conversationId);
    expect(row).toBeTruthy();
    expect(row.lastMessage.content).not.toContain(PHONE);
    expect(row.lastMessage.content).toContain("****");
  });

  it("а директору номер виден целиком — иначе звонить и проверять работу нечем", async () => {
    const res = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe(PHONE);
  });

  it("право выдаётся точечно: сотрудник с clients.viewPhone видит номер", async () => {
    // Директор может открыть номера конкретному сотруднику, не открывая ему заодно
    // чужие карточки, — ровно ради этого право отдельное.
    await prisma.agent.update({
      where: { id: agentId },
      data: { permissions: { granted: ["clients.viewPhone"], revoked: [] } },
    });
    // Права кэшируются в памяти процесса на 15 секунд (см. auth/middleware.ts).
    // В бою кэш сбрасывает сам маршрут выдачи прав; в тесте правим базу напрямую,
    // поэтому сбрасываем руками — иначе проверка ждала бы четверть минуты.
    invalidateAgentAccess(agentId);
    try {
      const res = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${agentToken}`);
      expect(res.status).toBe(200);
      expect(res.body.phone).toBe(PHONE);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { permissions: Prisma.DbNull } });
      invalidateAgentAccess(agentId);
    }
  });
});
