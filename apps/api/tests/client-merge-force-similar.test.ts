import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * РУЧНОЕ ОБЪЕДИНЕНИЕ РАЗНЫХ НОМЕРОВ + ПОДСКАЗКА ПО ЗАМЕТКАМ (владелец 19.08.2026).
 *
 * Живой случай: клиент писал в чат с одного номера, потом позвонил с другого —
 * POST /clients/merge отказывал 409-й, хотя это один человек. force снимает
 * проверку контакта, но не проверку права (clients.merge — только админ/менеджер).
 */

const runId = Date.now();
const password = "testpass123";
let adminId: string;
let token: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  adminId = (
    await prisma.agent.create({
      data: { fullName: "Админ слияния", phone: `+992969${runId}`, role: "ADMIN", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+992969${runId}`, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("Объединение с разными номерами (force)", () => {
  it("без force отдаёт 409 при разном телефоне и Telegram", async () => {
    const a = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Клиент А", phone: `+99290${runId}1`, source: "PHONE_CALL" });
    const b = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Клиент Б", phone: `+99290${runId}2`, source: "PHONE_CALL" });
    clientIds.push(a.body.id, b.body.id);

    const res = await request(app)
      .post("/api/v1/clients/merge")
      .set("Authorization", `Bearer ${token}`)
      .send({ primaryId: a.body.id, duplicateId: b.body.id });

    expect(res.status).toBe(409);
  });

  it("с force=true объединяет несмотря на разные номера", async () => {
    const a = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Клиент В", phone: `+99290${runId}3`, source: "PHONE_CALL" });
    const b = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Клиент Г", phone: `+99290${runId}4`, source: "PHONE_CALL" });
    clientIds.push(a.body.id, b.body.id);

    const res = await request(app)
      .post("/api/v1/clients/merge")
      .set("Authorization", `Bearer ${token}`)
      .send({ primaryId: a.body.id, duplicateId: b.body.id, force: true });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(a.body.id);

    const deleted = await prisma.client.findUnique({ where: { id: b.body.id } });
    expect(deleted?.deletedAt).toBeTruthy();
  });
});

describe("GET /clients/:id/similar-notes", () => {
  it("находит карточку с почти дословно совпадающими заметками", async () => {
    const notes =
      "Квартира переделана в 3-комнатную на 17 этаже дома, напротив Театра кукол, требуется быстрая продажа";
    const a = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Продавец Д", phone: `+99290${runId}5`, source: "PHONE_CALL", requirementsNotes: notes });
    const b = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Продавец Е", phone: `+99290${runId}6`, source: "PHONE_CALL", requirementsNotes: notes });
    const c = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "Продавец Ж",
        phone: `+99290${runId}7`,
        source: "PHONE_CALL",
        requirementsNotes: "Нужен однокомнатный в аренду недалеко от центра, бюджет небольшой",
      });
    clientIds.push(a.body.id, b.body.id, c.body.id);

    const res = await request(app)
      .get(`/api/v1/clients/${a.body.id}/similar-notes`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(b.body.id);
    expect(ids).not.toContain(c.body.id);
    expect(ids).not.toContain(a.body.id);
  });

  /**
   * ОБЩИЙ ЯРЛЫК — НЕ СХОДСТВО (владелец 24.08.2026, живой случай в проде: карточка
   * «Ака» получила «55-59% совпадения» сразу с тремя явно разными продавцами —
   * «Варзоб», «Хикоят», «Саидчон»). Ярлык «🏷 ПРОДАВЕЦ — хочет разместить объект
   * у нас…» (messengers/conversation.ts:1001) — фиксированный текст первой строкой
   * requirementsNotes у КАЖДОГО продавца; сравнение по нему одному не должно
   * подсказывать слияние, даже если остального содержания почти ничего общего.
   */
  it("общая строка-ярлык продавца не считается похожестью", async () => {
    const label = "🏷 ПРОДАВЕЦ — хочет разместить объект у нас (реклама бесплатно, комиссия 2% при продаже)";
    // Суффикс из ДВУХ цифр — последние 9 цифр номера не должны совпасть с другим
    // тестом этого файла (POST /clients мягко предупреждает по last-9-digits,
    // routes/clients.ts:1268, и возвращает 200 с чужой карточкой вместо создания).
    const a = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "Ака",
        phone: `+9929${runId}11`,
        source: "PHONE_CALL",
        requirementsNotes: `${label}\nМагазин дар бозори Корвон, 13 кв.м, нарх 500 000 сомонӣ`,
      });
    const b = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "Варзоб",
        phone: `+9929${runId}12`,
        source: "PHONE_CALL",
        requirementsNotes: `${label}\nУчасток в Варзобе, 6 соток, дом требует ремонта`,
      });
    clientIds.push(a.body.id, b.body.id);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);

    const res = await request(app)
      .get(`/api/v1/clients/${a.body.id}/similar-notes`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: string }) => r.id)).not.toContain(b.body.id);
  });

  it("отдаёт пустой список, если заметок нет", async () => {
    const a = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Без заметок", phone: `+99290${runId}8`, source: "PHONE_CALL" });
    clientIds.push(a.body.id);

    const res = await request(app)
      .get(`/api/v1/clients/${a.body.id}/similar-notes`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

/**
 * «ЭТО РАЗНЫЕ ЛЮДИ» (владелец 19.08.2026) — рядом с кнопкой «Объединить» нужна
 * и обратная: руководитель посмотрел на баннер похожести и решил, что совпадение
 * случайное. Отклонённая пара не должна всплывать снова — ни с одной, ни с другой
 * стороны (similarity симметрична, дублирующая карточка нашлась бы заново).
 */
describe("POST /clients/:id/similar-notes/:otherId/dismiss", () => {
  const notes = "Квартира переделана в 3-комнатную на 17 этаже дома, напротив Театра кукол, требуется продажа";

  it("отклонённая пара больше не показывается ни с одной из сторон", async () => {
    const a = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Продавец З", phone: `+99290${runId}9`, source: "PHONE_CALL", requirementsNotes: notes });
    const b = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Продавец И", phone: `+9929${runId}0`, source: "PHONE_CALL", requirementsNotes: notes });
    clientIds.push(a.body.id, b.body.id);

    const before = await request(app)
      .get(`/api/v1/clients/${a.body.id}/similar-notes`)
      .set("Authorization", `Bearer ${token}`);
    expect(before.body.map((r: { id: string }) => r.id)).toContain(b.body.id);

    const dismiss = await request(app)
      .post(`/api/v1/clients/${a.body.id}/similar-notes/${b.body.id}/dismiss`)
      .set("Authorization", `Bearer ${token}`);
    expect(dismiss.status).toBe(200);

    const afterA = await request(app)
      .get(`/api/v1/clients/${a.body.id}/similar-notes`)
      .set("Authorization", `Bearer ${token}`);
    expect(afterA.body.map((r: { id: string }) => r.id)).not.toContain(b.body.id);

    const afterB = await request(app)
      .get(`/api/v1/clients/${b.body.id}/similar-notes`)
      .set("Authorization", `Bearer ${token}`);
    expect(afterB.body.map((r: { id: string }) => r.id)).not.toContain(a.body.id);
  });
});
