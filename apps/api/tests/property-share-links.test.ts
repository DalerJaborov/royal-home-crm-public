import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Приватная ссылка на объект для одного клиента (docs/plan-18-08-private-listings-and-video.md
 * §4): POST/GET/DELETE /properties/:id/share-links (авторизованно) и публичный
 * GET /api/v1/l/:token (без токена). Главное, что этот файл обязан ловить —
 * ownerContact и прочие служебные поля объекта НЕ должны утечь через публичный
 * маршрут: это единственная неаутентифицированная точка входа в карточку объекта.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const password = "testpass123";
// НЕ +992900000000 (17.09.2026): это номер сидового директора — в тестах
// объектов такой контакт больше не годится (lib/staffPhoneGuard.ts). Ниже
// та же строка проверяется на утечку в публичной ссылке.
const ownerContact = `+992937${runId.toString().slice(-6)}`;

let districtId: string;
let agentId: string;
let agentToken: string;
let otherAgentId: string;
let otherAgentToken: string;
let adminToken: string;
let clientId: string;
const propertyIds: string[] = [];
const agentIds: string[] = [];
const clientIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(overrides: Partial<Record<string, unknown>> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Объект ссылка ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 45000,
      currency: "TJS",
      districtId,
      address: "Тестовая ссылка, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
      createdById: agentId,
      assignedAgentId: agentId,
      ownerContact,
      documents: "секретная служебная заметка",
      ...overrides,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-ссылка-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент ссылка", phone: `+992973${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Чужой агент ссылка", phone: `+992974${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(otherAgentId);
  clientId = (
    await prisma.client.create({
      // Свой клиент агента: чужому ссылку сделать нельзя (canBindClient, 23.09.2026).
      data: { fullName: "Клиент ссылка", phone: `+992975${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
  clientIds.push(clientId);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ ссылка", phone: `+992976${runId}`, role: "ADMIN", passwordHash },
  });
  agentIds.push(admin.id);

  agentToken = await login(`+992973${runId}`);
  otherAgentToken = await login(`+992974${runId}`);
  adminToken = await login(`+992976${runId}`);
});

afterAll(async () => {
  await prisma.propertyShareLink.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("POST /properties/:id/share-links", () => {
  it("404 на несуществующий объект", async () => {
    const res = await request(app)
      .post("/api/v1/properties/00000000-0000-0000-0000-000000000000/share-links")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("403 у агента без прав на этот объект", async () => {
    const p = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${otherAgentToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("401 без токена", async () => {
    const p = await makeProperty();
    const res = await request(app).post(`/api/v1/properties/${p.id}/share-links`).send({});
    expect(res.status).toBe(401);
  });

  it("создаёт ссылку с токеном, TTL по умолчанию 30 дней, без клиента", async () => {
    const p = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThanOrEqual(24);
    expect(res.body.url).toContain(res.body.token);
    expect(res.body.clientId).toBeNull();
    const expiresAt = new Date(res.body.expiresAt).getTime();
    const days = (expiresAt - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("привязывает конкретного клиента и настраиваемый срок", async () => {
    const p = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ clientId, expiresInDays: 7 });
    expect(res.status).toBe(201);
    expect(res.body.clientId).toBe(clientId);
    expect(res.body.client.fullName).toBe("Клиент ссылка");
    const expiresAt = new Date(res.body.expiresAt).getTime();
    const days = (expiresAt - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
  });

  it("два токена разных ссылок не совпадают (не последовательные/предсказуемые)", async () => {
    const p = await makeProperty();
    const a = await request(app).post(`/api/v1/properties/${p.id}/share-links`).set("Authorization", `Bearer ${agentToken}`).send({});
    const b = await request(app).post(`/api/v1/properties/${p.id}/share-links`).set("Authorization", `Bearer ${agentToken}`).send({});
    expect(a.body.token).not.toBe(b.body.token);
  });
});

describe("GET /properties/:id/share-links", () => {
  it("возвращает список ссылок объекта, недоступен чужому агенту", async () => {
    const p = await makeProperty();
    await request(app).post(`/api/v1/properties/${p.id}/share-links`).set("Authorization", `Bearer ${agentToken}`).send({});

    const ok = await request(app).get(`/api/v1/properties/${p.id}/share-links`).set("Authorization", `Bearer ${agentToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.items.length).toBe(1);

    const forbidden = await request(app)
      .get(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${otherAgentToken}`);
    expect(forbidden.status).toBe(403);
  });
});

describe("DELETE /properties/share-links/:linkId", () => {
  it("отзывает ссылку — публичный роут после этого 404", async () => {
    const p = await makeProperty();
    const created = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    const linkId = created.body.id as string;
    const token = created.body.token as string;

    const del = await request(app).delete(`/api/v1/properties/share-links/${linkId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(del.status).toBe(204);

    const publicRes = await request(app).get(`/api/v1/l/${token}`);
    expect(publicRes.status).toBe(404);
  });
});

describe("GET /api/v1/l/:token (публичный, без авторизации)", () => {
  it("404 на несуществующий токен", async () => {
    const res = await request(app).get("/api/v1/l/does-not-exist-token");
    expect(res.status).toBe(404);
  });

  it("404 на просроченную ссылку", async () => {
    const p = await makeProperty();
    const created = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ expiresInDays: 1 });
    await prisma.propertyShareLink.update({
      where: { id: created.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(app).get(`/api/v1/l/${created.body.token}`);
    expect(res.status).toBe(404);
  });

  it("отдаёт урезанный набор полей и НИКОГДА ownerContact/документы/id агентов — и ставит viewedAt только на первый просмотр", async () => {
    const p = await makeProperty();
    const created = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ clientId });

    const first = await request(app).get(`/api/v1/l/${created.body.token}`);
    expect(first.status).toBe(200);

    // Безопасный набор полей — то, что разрешено.
    expect(first.body.property.title).toBeDefined();
    expect(first.body.property.price).toBeDefined();
    expect(first.body.property.areaSqm).toBeDefined();
    expect(first.body.agent.fullName).toBe("Агент ссылка");
    expect(first.body.agent.phone).toBe(`+992973${runId}`);

    // Утечка — то, чего там быть не должно ни при каких обстоятельствах.
    const raw = JSON.stringify(first.body);
    expect(raw).not.toContain(ownerContact);
    expect(raw).not.toContain("секретная служебная заметка"); // documents
    expect(first.body.property.ownerContact).toBeUndefined();
    expect(first.body.property.assignedAgentId).toBeUndefined();
    expect(first.body.property.intakeAgentId).toBeUndefined();
    expect(first.body.property.createdById).toBeUndefined();
    expect(first.body.property.documents).toBeUndefined();
    expect(first.body.property.sellerClientId).toBeUndefined();
    expect(first.body.clientId).toBeUndefined();
    expect(first.body.token).toBeUndefined();

    const afterFirst = await prisma.propertyShareLink.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(afterFirst.viewedAt).not.toBeNull();
    const firstViewedAt = afterFirst.viewedAt;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await request(app).get(`/api/v1/l/${created.body.token}`);
    expect(second.status).toBe(200);
    const afterSecond = await prisma.propertyShareLink.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(afterSecond.viewedAt?.getTime()).toBe(firstViewedAt?.getTime());
  });

  /**
   * Ночная проверка 24.09.2026 (№9), решение владельца: публичная ссылка без
   * входа отдавала точный адрес (улица, дом) и этаж — сайт агентства показывает
   * только район/город (см. `toSitePayload` в lib/siteSync.ts: `location` там
   * собран из `district.name` + `district.city`, без floor/totalFloors и без
   * адреса вовсе). Ссылка сведена с тем же набором.
   */
  it("не отдаёт точный адрес и этаж, район/город остаются (сведено с тем, что видно на сайте)", async () => {
    const p = await makeProperty({
      address: "Секретная непубличная улица, 1, кв. 2",
      floor: 7,
      totalFloors: 12,
    });
    const created = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});

    const res = await request(app).get(`/api/v1/l/${created.body.token}`);
    expect(res.status).toBe(200);

    expect(res.body.property.district).toBe(`Тест-район-ссылка-${runId}`);
    expect(res.body.property.address).toBeUndefined();
    expect(res.body.property.floor).toBeUndefined();
    expect(res.body.property.totalFloors).toBeUndefined();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("Секретная непубличная улица");
  });

  it("clipVideoUrl приходит только когда статус READY", async () => {
    const p = await makeProperty({ clipVideoUrl: "/uploads/video/x.mp4", clipVideoStatus: "PROCESSING" });
    const created = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    const res = await request(app).get(`/api/v1/l/${created.body.token}`);
    expect(res.body.property.clipVideoUrl).toBeNull();

    await prisma.property.update({ where: { id: p.id }, data: { clipVideoStatus: "READY" } });
    const res2 = await request(app).get(`/api/v1/l/${created.body.token}`);
    // К11 (аудит безопасности 11.09.2026): /uploads/video больше не голая статика —
    // ссылка в ответе уходит с подписанным токеном (см. lib/mediaJsonSign.ts),
    // сам путь при этом не меняется.
    expect(res2.body.property.clipVideoUrl).toMatch(/^\/uploads\/video\/x\.mp4\?t=/);
  });

  /**
   * Разведка 07.09.2026 (класс «осиротевшие спутники»): ссылка на проданный
   * объект отдавала карточку с ценой без единой пометки о продаже.
   */
  it("отмечает sold:true, если объект уже продан", async () => {
    const p = await makeProperty();
    const created = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    const before = await request(app).get(`/api/v1/l/${created.body.token}`);
    expect(before.body.property.sold).toBe(false);

    await prisma.property.update({ where: { id: p.id }, data: { status: "SOLD" } });
    const after = await request(app).get(`/api/v1/l/${created.body.token}`);
    expect(after.status).toBe(200);
    expect(after.body.property.sold).toBe(true);
  });
});

describe("Ссылка отзывается вместе с объектом (разведка 07.09.2026, осиротевшие спутники)", () => {
  it("bulk-trash объекта отзывает его активные ссылки", async () => {
    const p = await makeProperty();
    const created = await request(app)
      .post(`/api/v1/properties/${p.id}/share-links`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(created.status).toBe(201);

    const trash = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [p.id] });
    expect(trash.status).toBe(200);

    const link = await prisma.propertyShareLink.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(link.revokedAt).not.toBeNull();

    const publicRes = await request(app).get(`/api/v1/l/${created.body.token}`);
    expect(publicRes.status).toBe(404);
  });
});
