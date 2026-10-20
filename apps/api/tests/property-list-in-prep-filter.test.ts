import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /properties?inPrep=1 — «В подготовке»: все четыре этапа конвейера сразу.
 *
 * Зачем параметр. Владелец 21.09.2026: «удали лишние разделы — на проверке,
 * ждём фото, ждём видео и так далее». Четыре пилюли этапов занимали половину
 * ряда срезов и относятся к работе маркетинга, а не к поиску объекта. Они
 * свёрнуты в одну — но свёрнуты, а не удалены: очередь подготовки маркетингу
 * нужна, а `status` принимает ровно одно состояние, поэтому одной пилюлей
 * четыре этапа было не выбрать.
 *
 * Проверяем ровно две вещи, которые сборкой и типами не ловятся:
 *   1. в выдачу попадают ВСЕ четыре этапа и не попадает «В продаже»;
 *   2. точный `status` сильнее `inPrep` — пришли оба, человек выбрал этап, и
 *      сужение идёт по нему. Без этого «N объектов ждут вашей проверки» в
 *      списке молча открывало бы весь конвейер.
 *
 * Фикстуры проверяются по своим id, а не по общему числу: каталог общий на все
 * тесты, идущие параллельно (тот же приём, что в property-list-overdue-filter).
 */

const runId = Date.now();
const password = "testpass123";
let districtId: string;
let agentId: string;
let agentPhone = "";
const propertyIds: string[] = [];

async function makeProperty(status: "PENDING_REVIEW" | "AWAITING_PHOTOS" | "AWAITING_VIDEO" | "EDITING" | "AVAILABLE") {
  const p = await prisma.property.create({
    data: {
      title: `Объект подготовки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая подготовки, 7",
      condition: "GOOD",
      status,
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-подготовка-${runId}` } })).id;
  agentPhone = `+992954${String(runId).slice(-7)}`;
  const agent = await prisma.agent.create({
    data: { fullName: `Подготовка Агент ${runId}`, phone: agentPhone, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone: agentPhone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /properties?inPrep=1", () => {
  it("собирает все четыре этапа подготовки и уступает точному статусу", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ phone: agentPhone, password });
    expect(login.status).toBe(200);
    const token = login.body.accessToken ?? login.body.token;

    const reviewId = await makeProperty("PENDING_REVIEW");
    const photosId = await makeProperty("AWAITING_PHOTOS");
    const videoId = await makeProperty("AWAITING_VIDEO");
    const editingId = await makeProperty("EDITING");
    const availableId = await makeProperty("AVAILABLE");

    const res = await request(app)
      .get(`/api/v1/properties?inPrep=1&q=${encodeURIComponent(`Объект подготовки ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids: string[] = res.body.items.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining([reviewId, photosId, videoId, editingId]));
    expect(ids).not.toContain(availableId);

    // Точный этап сильнее свёрнутого среза.
    const exact = await request(app)
      .get(`/api/v1/properties?inPrep=1&status=PENDING_REVIEW&q=${encodeURIComponent(`Объект подготовки ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(exact.status).toBe(200);
    const exactIds: string[] = exact.body.items.map((p: { id: string }) => p.id);
    expect(exactIds).toContain(reviewId);
    expect(exactIds).not.toContain(photosId);
    expect(exactIds).not.toContain(editingId);
  });
});
