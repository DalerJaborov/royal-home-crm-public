import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";

/**
 * ОРИЕНТИР ДЛЯ НОВОГО ОБЪЕКТА (25.09.2026, владелец: «когда добавляешь объект,
 * они сами должны ставиться автоматически, один ориентир или два»).
 *
 * `suggestLandmarks` берёт до двух ориентиров тем же отбором, что строка места
 * на карте (`describePlace`), а `GET /geo/landmarks` отдаёт их мастеру объекта
 * готовым текстом для поля «Ориентир».
 */

const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { describePlace, suggestLandmarks } = await import("../src/lib/landmarkPick.js");

const runId = Date.now();
const tail = String(runId).slice(-6);
const password = "testpass123";
const sourcePrefix = `test-landmark-suggest-${runId}`;

// Точка в Душанбе, в стороне от точек других тестов ориентиров
// (landmark-prominence 38.4911/68.9123, properties-map-route 38.5733/68.8021).
const POINT = { lat: 38.612, lng: 68.745 };
const MALL = { lat: POINT.lat + 0.0018, lng: POINT.lng }; // ~200 м
const MALL_TWIN = { lat: POINT.lat + 0.0019, lng: POINT.lng }; // тот же ТЦ, заведён второй раз
const BAZAR = { lat: POINT.lat - 0.0045, lng: POINT.lng }; // ~500 м
const CAFE = { lat: POINT.lat, lng: POINT.lng + 0.0006 }; // ~50 м, мелочь
// Точка без единого ориентира в потолке (все ориентиры теста в ~1,5+ км).
const EMPTY = { lat: POINT.lat + 0.03, lng: POINT.lng + 0.03 };

// Вторая точка (28.09.2026) — за городом, где нет ни справочника, ни объектов:
// ориентиры агентов, латиница, категории как в источнике, тесный предел.
const HOME = { lat: 38.7, lng: 68.6 };
const at = (dLatM: number, dLngM = 0) => ({ lat: HOME.lat + dLatM / 111_000, lng: HOME.lng + dLngM / 87_000 });
const propertyTitle = `landmark-suggest-${runId}`;
// Метка прогона буквами: цифры подряд в подсказке читаются как телефон и отсекаются.
const mark = String(runId).replace(/\d/g, (d) => "абвглежзик"[Number(d)]);

let agentId = "";
let token = "";

async function addLandmark(key: string, name: string, category: string, at: { lat: number; lng: number }, weight = 0) {
  await prisma.landmark.create({
    data: { sourceId: `${sourcePrefix}-${key}`, name, category, weight, lat: at.lat, lng: at.lng },
  });
}

beforeAll(async () => {
  await prisma.landmark.deleteMany({ where: { sourceId: { startsWith: sourcePrefix } } });
  await addLandmark("mall", `ТЦ Садбарг ${runId}`, "ТЦ", MALL);
  await addLandmark("mall-twin", `Садбарг ${runId}`, "ТЦ", MALL_TWIN);
  await addLandmark("bazar", `Бозори ${runId}`, "Базар", BAZAR);
  await addLandmark("cafe", `Кафе ${runId}`, "Кафе", CAFE);

  const phone = `+992369${tail}`;
  await prisma.agent.deleteMany({ where: { phone } });
  const agent = await prisma.agent.create({
    data: { fullName: `Ориентир ${runId}`, phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentId = agent.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { title: { startsWith: propertyTitle } } });
  await prisma.landmark.deleteMany({ where: { sourceId: { startsWith: sourcePrefix } } });
  if (agentId) await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("suggestLandmarks — один-два ориентира для поля «Ориентир»", () => {
  it("два знаменитых, без повтора того же места и без мелочи рядом", async () => {
    const s = await suggestLandmarks(POINT.lat, POINT.lng);
    expect(s.landmarks.map((l) => l.name)).toEqual([`ТЦ Садбарг ${runId}`, `Бозори ${runId}`]);
    expect(s.text).toBe(`рядом ТЦ Садбарг ${runId}, 500 м от Бозори ${runId}`);
  });

  it("первый ориентир тот же, что у строки места на карте", async () => {
    const [s, described] = await Promise.all([
      suggestLandmarks(POINT.lat, POINT.lng),
      describePlace(POINT.lat, POINT.lng),
    ]);
    expect(described.landmark?.id).toBe(s.landmarks[0]?.id);
  });

  it("нет ничего рядом — пустой текст, а не улица или далёкий ориентир", async () => {
    const s = await suggestLandmarks(EMPTY.lat, EMPTY.lng);
    expect(s).toEqual({ text: "", landmarks: [] });
  });

  it("текст всегда влезает в поле (120 знаков)", async () => {
    const longName = `Очень длинное название ориентира ${"а".repeat(90)} ${runId}`;
    await prisma.landmark.updateMany({ where: { sourceId: `${sourcePrefix}-bazar` }, data: { name: longName } });
    try {
      const s = await suggestLandmarks(POINT.lat, POINT.lng);
      expect(s.text.length).toBeLessThanOrEqual(120);
      expect(s.landmarks[0]?.name).toBe(`ТЦ Садбарг ${runId}`);
    } finally {
      await prisma.landmark.updateMany({ where: { sourceId: `${sourcePrefix}-bazar` }, data: { name: `Бозори ${runId}` } });
    }
  });
});

async function addProperty(key: string, landmark: string | null, place: { lat: number; lng: number }, extra: Record<string, unknown> = {}) {
  await prisma.property.create({
    data: {
      title: `${propertyTitle}-${key}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      address: "Тестовая, 1",
      condition: "GOOD",
      landmark,
      lat: place.lat,
      lng: place.lng,
      ...extra,
    } as never,
  });
}

describe("suggestLandmarks — ближние ориентиры, которые знает город (28.09.2026)", () => {
  beforeAll(async () => {
    await prisma.property.deleteMany({ where: { title: { startsWith: propertyTitle } } });
  });
  afterEach(async () => {
    await prisma.property.deleteMany({ where: { title: { startsWith: propertyTitle } } });
    await prisma.landmark.deleteMany({ where: { sourceId: { startsWith: `${sourcePrefix}-home` } } });
  });

  it("«ВУЗ» и «Торговый центр» из справочника весят как «Вуз» и «ТЦ», латиница не называется", async () => {
    // Как на Рудаки: вуз в 250 м, «парк» латиницей в 100 м. Раньше «ВУЗ» не
    // находился в таблице весов, и побеждала латинская запись.
    await addLandmark("home-uni", `Аграрный университет ${runId}`, "ВУЗ", at(250));
    await addLandmark("home-park", `Vadanasos Park ${runId}`, "Парк", at(100));
    const s = await suggestLandmarks(HOME.lat, HOME.lng);
    expect(s.text).toBe(`рядом Аграрный университет ${runId}`);
  });

  it("латинская запись с русским синонимом называется по-русски", async () => {
    await prisma.landmark.create({
      data: {
        sourceId: `${sourcePrefix}-home-bazar`,
        name: `Bozori Korvon ${runId}`,
        aliases: [`Корвон ${runId}`],
        category: "Базар",
        weight: 0,
        lat: at(120).lat,
        lng: at(120).lng,
      },
    });
    const s = await suggestLandmarks(HOME.lat, HOME.lng);
    expect(s.text).toBe(`рядом Корвон ${runId}`);
  });

  it("обычный ориентир дальше 400 м не предлагается, знаменитый — до 800 м", async () => {
    await addLandmark("home-school", `Школа ${runId}`, "Школа", at(600));
    await addLandmark("home-mall", `ТЦ Пайкар ${runId}`, "Торговый центр", at(700));
    await addLandmark("home-far-bazar", `Бозори дур ${runId}`, "Базар", at(1500));
    const s = await suggestLandmarks(HOME.lat, HOME.lng);
    expect(s.text).toBe(`700 м от ТЦ Пайкар ${runId}`);
  });

  it("ориентир, который агенты вписали у соседних объектов, идёт первым", async () => {
    await addLandmark("home-uni", `Аграрный университет ${runId}`, "ВУЗ", at(250));
    await addProperty("a", `напротив Додо пиццы ${mark}, Супермаркет Б1`, at(40));
    await addProperty("b", `напротив Додо пиццы ${mark}`, at(-60, 30));
    await addProperty("c", `Супермаркет Б1`, at(90));
    // Регистр и «ё» не делают фразу новой: это третий голос за Додо.
    await addProperty("b2", `Напротив Додо пиццы ${mark}`, at(70));
    await addProperty("d", `за Супермаркетом ${mark}`, at(10));
    // Эхо самого сайта, телефон и объект дальше 150 м — не подсказки.
    await addProperty("e", `рядом Аграрный университет ${runId}`, at(5));
    await addProperty("f", `звонить 90 123 45 67`, at(5));
    await addProperty("g", `у дальнего магазина ${mark}`, at(400));
    await addProperty("h", `в удалённой карточке ${mark}`, at(5), { deletedAt: new Date() });

    const s = await suggestLandmarks(HOME.lat, HOME.lng);
    // Из одинаковых по сути фраз берётся свежее написание.
    expect(s.text).toBe(`Напротив Додо пиццы ${mark}, Супермаркет Б1`);
    expect(s.landmarks).toEqual([]);
  });

  it("одна фраза агента — вторым идёт ближний ориентир справочника", async () => {
    await addLandmark("home-uni", `Аграрный университет ${runId}`, "ВУЗ", at(250));
    await addProperty("a", `рядом с Додо пиццей ${mark}`, at(40));
    const s = await suggestLandmarks(HOME.lat, HOME.lng);
    expect(s.text).toBe(`рядом с Додо пиццей ${mark}, рядом Аграрный университет ${runId}`);
    expect(s.landmarks.map((l) => l.name)).toEqual([`Аграрный университет ${runId}`]);
  });
});

describe("GET /api/v1/geo/landmarks", () => {
  it("без входа — 401", async () => {
    const res = await request(app).get(`/api/v1/geo/landmarks?lat=${POINT.lat}&lng=${POINT.lng}`);
    expect(res.status).toBe(401);
  });

  it("без координат — 400", async () => {
    const res = await request(app).get("/api/v1/geo/landmarks").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("точка в городе — готовый текст для поля", async () => {
    const res = await request(app)
      .get(`/api/v1/geo/landmarks?lat=${POINT.lat}&lng=${POINT.lng}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.text).toBe(`рядом ТЦ Садбарг ${runId}, 500 м от Бозори ${runId}`);
    expect(res.body.landmarks).toHaveLength(2);
  });

  it("точка за городом — пусто", async () => {
    const res = await request(app).get("/api/v1/geo/landmarks?lat=40.28&lng=69.62").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "", landmarks: [] });
  });
});
