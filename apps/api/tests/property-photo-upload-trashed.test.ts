import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Загрузка фото в удалённый/чужой/несуществующий объект — docs/TASKS.md, Пачка D.
 *
 * ЗАЧЕМ. Раньше запрос в Корзину тихо проходил: файлы записывались на диск и в
 * базу, а карточка объекта в Корзине их никому не показывает (readOnly в
 * PropertyPhotoManager) — снимки просто терялись молча, и повторная попытка
 * с клиента (очередь загрузки, lib/uploadQueue.ts) продолжала бы слать их
 * бесконечно, думая, что сервер отвечает успехом. 409, а не 404 — тот же язык,
 * что и у отказа по чужому ключу загрузки (upload-idempotency.test.ts):
 * объект СУЩЕСТВУЕТ, просто в этом состоянии загрузка запрещена.
 *
 * Три причины отказа — три разных кода, и код в photos.ts (POST /:id/photos)
 * их уже различал (404 → 403 → 409 по порядку проверок), но тестами были
 * закрыты только 409 (эта Корзина) и общий 403 «нет прав» на другом экране
 * (property-moderate-permission.test.ts, не про фото). Явного теста на
 * «объекта вообще нет» (404) и «объект чужой, прав нет» (403 на самой загрузке
 * фото) не было — агент мог бы молча получить регрессию порядка проверок и
 * никто бы не заметил. Дописаны оба случая.
 */

const runId = Date.now();
const password = "testpass123";

// Минимальный валидный PNG 1×1 — sharp обрабатывает его без файла-фикстуры.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let districtId: string;
let agentId: string;
let token: string;
let propertyId: string;
// «Чужой» агент — не назначен, не интейкер, не создатель, обычная роль AGENT
// без properties.editForeign: ровно та комбинация, на которой canManageProperty
// (routes/properties/shared.ts) обязана вернуть false.
let strangerId: string;
let strangerToken: string;
let strangerPropertyId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-корзина-фото-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент корзины", phone: `+992953${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992953${runId}`, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;

  const p = await prisma.property.create({
    data: {
      title: `Удалённый объект ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
      // Уже в Корзине — ровно то состояние, которое проверяет тест.
      deletedAt: new Date(),
    },
  });
  propertyId = p.id;

  strangerId = (
    await prisma.agent.create({
      data: { fullName: "Чужой агент", phone: `+992954${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const strangerRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: `+992954${runId}`, password });
  expect(strangerRes.status).toBe(200);
  strangerToken = strangerRes.body.accessToken as string;

  const sp = await prisma.property.create({
    data: {
      title: `Объект первого агента ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
      // Не в Корзине — существует и доступен своему агенту, но не «чужому».
    },
  });
  strangerPropertyId = sp.id;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: [propertyId, strangerPropertyId] } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, strangerPropertyId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, strangerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Загрузка фото в удалённый объект", () => {
  it("409 с понятным текстом, файл в базу не попадает", async () => {
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", TINY_PNG, "photo.png");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/удал/i);
    expect(await prisma.propertyPhoto.count({ where: { propertyId } })).toBe(0);
  });
});

describe("Загрузка фото — 404 и 403 различаются", () => {
  it("404, если объекта вообще нет", async () => {
    const res = await request(app)
      .post("/api/v1/properties/00000000-0000-0000-0000-000000000000/photos")
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", TINY_PNG, "photo.png");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/не найден/i);
  });

  it("403, если объект чужой (существует, но прав нет) — не 404", async () => {
    const res = await request(app)
      .post(`/api/v1/properties/${strangerPropertyId}/photos`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .attach("photos", TINY_PNG, "photo.png");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/прав/i);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: strangerPropertyId } })).toBe(0);
  });
});
