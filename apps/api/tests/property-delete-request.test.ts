import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";

/**
 * Заявки агента на удаление ОБЪЕКТА (31.08.2026) — зеркало заявок на удаление
 * клиента (routes/clients/deleteRequests.ts), то же устройство: агент называет
 * причину, решение принимает человек с правом `properties.delete`. Своего теста
 * не было и у клиентской версии — заводим здесь сразу для обеих сторон
 * (маршруты + разграничение прав), чтобы не повторить пробел.
 */

const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let adminId = "";
let adminToken = "";
let agentId = "";
let agentToken = "";
let otherAgentId = "";
let otherAgentToken = "";
const propertyIds: string[] = [];
const clientIds: string[] = [];
const dealIds: string[] = [];

async function loginAs(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(overrides: Partial<{ assignedAgentId: string; intakeAgentId: string; createdById: string }> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Объект на заявку ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 50000,
      currency: "USD",
      districtId,
      address: `Тест ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      ...overrides,
    },
  });
  propertyIds.push(property.id);
  return property;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Заявка-удаление-объекта-${runId}` } })).id;

  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ заявок ${runId}`,
      phone: `+992941${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  adminId = admin.id;
  adminToken = await loginAs(admin.phone);

  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент заявок ${runId}`,
      phone: `+992942${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentId = agent.id;
  agentToken = await loginAs(agent.phone);

  const otherAgent = await prisma.agent.create({
    data: {
      fullName: `Другой агент ${runId}`,
      phone: `+992943${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  otherAgentId = otherAgent.id;
  otherAgentToken = await loginAs(otherAgent.phone);
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId, otherAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Заявка агента на удаление объекта", () => {
  it("агент без properties.delete не может удалить объект напрямую, но может попросить", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });

    const directDelete = await request(app)
      .delete(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(directDelete.status).toBe(403);

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "TEST_CARD" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const pending = await request(app)
      .get(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(pending.status).toBe(200);
    expect(pending.body.request?.status).toBe("PENDING");
    expect(pending.body.request?.reasonLabel).toContain("Тестовая карточка");
  });

  it("причина OTHER без комментария отклоняется валидацией", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "OTHER" });
    expect(res.status).toBe(400);
  });

  /**
   * Пачка 13, 11.09.2026, п.1: одного слова недостаточно — СБ нужно хоть
   * какое-то описание. Короче 20 символов (без учёта пробелов по краям) заявка
   * не проходит валидацию, даже если поле не пустое.
   */
  it("SOLD_ELSEWHERE короче 20 символов отклоняется валидацией", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });
    const tooShort = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "SOLD_ELSEWHERE", comment: "Продали сами" }); // 12 символов
    expect(tooShort.status).toBe(400);

    const longEnough = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "SOLD_ELSEWHERE", comment: "Продали через агентство «Соседний дом», подтвердили лично" });
    expect(longEnough.status).toBe(201);
  });

  it("чужой объект — заявку не завести (403)", async () => {
    const property = await makeProperty({ assignedAgentId: otherAgentId });
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "DUPLICATE" });
    expect(res.status).toBe(403);
  });

  it("вторая заявка по тому же объекту, пока первая ждёт решения — 409", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });
    const first = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "DUPLICATE" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "WRONG_DATA" });
    expect(second.status).toBe(409);
  });

  it("руководитель без properties.delete не видит очередь заявок", async () => {
    const res = await request(app)
      .get("/api/v1/properties/delete-requests")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("одобрение переносит объект в Корзину тем же путём, что и прямое удаление", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });
    const created = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "OWNER_CANCELLED", comment: "Собственник передумал" });
    expect(created.status).toBe(201);
    const requestId = created.body.id as string;

    const queue = await request(app)
      .get("/api/v1/properties/delete-requests")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body.items.some((r: { id: string }) => r.id === requestId)).toBe(true);

    const approve = await request(app)
      .post(`/api/v1/properties/delete-requests/${requestId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(200);

    const trashed = await prisma.property.findUnique({ where: { id: property.id } });
    expect(trashed?.deletedAt).not.toBeNull();

    const updatedRequest = await prisma.propertyDeleteRequest.findUnique({ where: { id: requestId } });
    expect(updatedRequest?.status).toBe("APPROVED");
    expect(updatedRequest?.decidedById).toBe(adminId);
  });

  /**
   * 07.09.2026, зеркало живого случая по клиентам (Продавец №0127). Агент просит
   * удалить, руководство удаляет объект своим путём раньше — заявка оставалась
   * PENDING и повисала в Архиве: «Удалить в корзину» упиралась в 404 «Объект не
   * найден», «Отклонить» соврала бы агенту.
   */
  it("удаление объекта закрывает висящую заявку само — сирот не остаётся", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });
    const created = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "OWNER_CANCELLED", comment: "Собственник передумал" });
    expect(created.status).toBe(201);
    const requestId = created.body.id as string;

    // Руководство удаляет объект напрямую, мимо очереди заявок.
    const direct = await request(app)
      .delete(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(direct.status).toBe(204);

    const afterDirect = await prisma.propertyDeleteRequest.findUnique({ where: { id: requestId } });
    expect(afterDirect?.status).toBe("APPROVED");
    expect(afterDirect?.decidedAt).not.toBeNull();
  });

  it("уже повисшую заявку по удалённому объекту одобрение закрывает, а не отдаёт 404", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });
    const created = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "OWNER_CANCELLED", comment: "Собственник передумал" });
    const requestId = created.body.id as string;

    // Осиротевшее состояние, каким оно было на проде: объект в Корзине, заявка
    // всё ещё ждёт решения (правку выше обходим намеренно — лечим прошлое).
    await prisma.property.update({ where: { id: property.id }, data: { deletedAt: new Date() } });
    await prisma.propertyDeleteRequest.update({
      where: { id: requestId },
      data: { status: "PENDING", decidedAt: null, decidedById: null },
    });

    const approve = await request(app)
      .post(`/api/v1/properties/delete-requests/${requestId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(200);

    const healed = await prisma.propertyDeleteRequest.findUnique({ where: { id: requestId } });
    expect(healed?.status).toBe("APPROVED");
    expect(healed?.decidedById).toBe(adminId);
  });

  it("объект со сделкой — одобрить нельзя (409), заявка остаётся PENDING", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });
    const client = await prisma.client.create({
      data: {
        fullName: `Покупатель заявки ${runId}`,
        phone: `+992944${String(runId).slice(-7)}`,
        kind: "BUYER",
        source: "PHONE_CALL",
        assignedAgentId: agentId,
      },
    });
    clientIds.push(client.id);
    const deal = await prisma.deal.create({
      data: { clientId: client.id, propertyId: property.id, agentId, stage: "NEGOTIATION" },
    });
    dealIds.push(deal.id);

    const created = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "TEST_CARD" });
    expect(created.status).toBe(201);
    const requestId = created.body.id as string;

    const approve = await request(app)
      .post(`/api/v1/properties/delete-requests/${requestId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(409);

    const stillPending = await prisma.propertyDeleteRequest.findUnique({ where: { id: requestId } });
    expect(stillPending?.status).toBe("PENDING");
  });

  it("отказ без причины отклоняется валидацией, с причиной переводит заявку в REJECTED", async () => {
    const property = await makeProperty({ assignedAgentId: agentId });
    const created = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "DUPLICATE" });
    const requestId = created.body.id as string;

    const noReason = await request(app)
      .post(`/api/v1/properties/delete-requests/${requestId}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(noReason.status).toBe(400);

    const rejected = await request(app)
      .post(`/api/v1/properties/delete-requests/${requestId}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decisionNote: "Объект реальный, оставляем" });
    expect(rejected.status).toBe(200);

    const updated = await prisma.propertyDeleteRequest.findUnique({ where: { id: requestId } });
    expect(updated?.status).toBe("REJECTED");
    expect(updated?.decisionNote).toBe("Объект реальный, оставляем");

    const property2 = await prisma.property.findUnique({ where: { id: property.id } });
    expect(property2?.deletedAt).toBeNull();
  });
});

/**
 * ОБЪЕКТЫ ИСЧЕЗЛИ У АГЕНТОВ (владелец 19.09.2026). Скрытие карточки с висящей
 * заявкой на удаление (routes/properties/list.ts) было написано «по праву
 * `properties.delete`» без сужения до автора заявки — и одна заявка одного
 * агента выносила живой объект из каталога у ВСЕХ агентов, у маркетинга и у
 * монтажёра, бессрочно, пока руководство её не рассмотрит. У клиентской
 * версии (routes/clients/list.ts) такого не было: там фильтр сам сужался через
 * `client.assignedAgentId`, у общего каталога объектов сужать было нечем.
 *
 * Тестов на эту ветку не было ни одного: все тесты фильтров списка объектов
 * ходят под ADMIN-токеном, у которого право есть, то есть ветка
 * `!can(req, "properties.delete")` не исполнялась вовсе.
 */
describe("Заявка на удаление скрывает объект только у того, кто её подал", () => {
  /**
   * Список фильтруем СВОИМ районом теста, а не поиском по номеру: номер объекта
   * не входит ни в название, ни в адрес, поэтому `?q=<номер>` ничего не сужает
   * — выдача возвращается первой страницей каталога, и попал объект в неё или
   * нет, решает порядок сортировки и чужие карточки в базе. На этом тест и
   * плавал. Район у теста свой (`beforeAll`), значит выдача — ровно его
   * карточки, а предел выборки не при чём.
   */
  async function listSeesProperty(token: string, shortId: number) {
    const res = await request(app)
      .get(`/api/v1/properties?districtId=${districtId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items = res.body.items as { shortId: number }[];
    return items.some((p) => p.shortId === shortId);
  }

  it("у автора заявки объект исчезает, у другого агента и у админа остаётся", async () => {
    const property = await makeProperty({ assignedAgentId: agentId, intakeAgentId: agentId });

    // До заявки объект виден всем трём.
    expect(await listSeesProperty(agentToken, property.shortId)).toBe(true);
    expect(await listSeesProperty(otherAgentToken, property.shortId)).toBe(true);
    expect(await listSeesProperty(adminToken, property.shortId)).toBe(true);

    const asked = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "TEST_CARD" });
    expect(asked.status).toBe(201);

    // Автор заявки больше её не видит — ровно это и просил владелец 17.09
    // («чтобы не мозолить глаза агенту»).
    expect(await listSeesProperty(agentToken, property.shortId)).toBe(false);
    // А вот это и было поломкой: у ОСТАЛЬНЫХ объект обязан остаться на месте.
    expect(await listSeesProperty(otherAgentToken, property.shortId)).toBe(true);
    // У того, кто решение выносит, — тем более: ему нужен полный контекст.
    expect(await listSeesProperty(adminToken, property.shortId)).toBe(true);
  });

  it("после отказа по заявке объект возвращается и к автору", async () => {
    const property = await makeProperty({ assignedAgentId: agentId, intakeAgentId: agentId });

    const asked = await request(app)
      .post(`/api/v1/properties/${property.id}/delete-request`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "TEST_CARD" });
    expect(asked.status).toBe(201);
    expect(await listSeesProperty(agentToken, property.shortId)).toBe(false);

    const pending = await prisma.propertyDeleteRequest.findFirst({
      where: { propertyId: property.id, status: "PENDING" },
      select: { id: true },
    });
    expect(pending).not.toBeNull();

    const rejected = await request(app)
      .post(`/api/v1/properties/delete-requests/${pending!.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decisionNote: "Объект реальный, оставляем в каталоге" });
    expect(rejected.status).toBe(200);

    expect(await listSeesProperty(agentToken, property.shortId)).toBe(true);
  });
});
