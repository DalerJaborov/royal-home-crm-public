import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * ВКЛАДКА «СТАТИСТИКА» В КАРТОЧКЕ ОБЪЕКТА (24.09.2026) — lib/propertyStats.ts,
 * routes/properties/stats.ts. Светофор и «загорелся» — чистые функции,
 * проверяются без базы; путь покупателя и соседи — через адрес сервера на
 * своём районе, куда другие файлы не пишут.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { assessPropertyHealth, detectHot } = await import("../src/lib/propertyStats.js");
const { dushanbeDayKeyToDate } = await import("../src/lib/siteStats.js");
const { dushanbeDayKey } = await import("@royal-home/shared");

const runId = Date.now();
const password = "testpass123";
const phones = [`+992941${runId}`];
let districtId: string;
let token: string;
let agentId: string;
let subjectId: string;
const created: string[] = [];

const healthy = {
  status: "AVAILABLE",
  daysOnSale: 20,
  priceDiffPct: 0,
  daysToSellTypical: 60,
  siteConnected: true,
  siteViews30: 40,
  contacts30: 3,
  contactsTotal: 5,
  showingsTotal: 2,
  photos: 12,
  publishedChannels: 3,
  hot: false,
};

describe("assessPropertyHealth — светофор", () => {
  it("всё в порядке — зелёный без подсказок", () => {
    expect(assessPropertyHealth(healthy)).toEqual({ color: "green", headline: "Всё идёт хорошо", tips: [] });
  });

  it("первые дни — серый «рано судить», проблем не ищет", () => {
    const h = assessPropertyHealth({ ...healthy, daysOnSale: 1, photos: 0 });
    expect(h.color).toBe("gray");
    expect(h.headline).toMatch(/Рано судить: в продаже 1 день/);
  });

  it("цена выше соседей на 15% и больше — красный с процентом", () => {
    const h = assessPropertyHealth({ ...healthy, priceDiffPct: 17.4 });
    expect(h.color).toBe("red");
    expect(h.headline).toBe("Цена выше соседей на 17%");
  });

  it("цена выше на 8% — жёлтый", () => {
    expect(assessPropertyHealth({ ...healthy, priceDiffPct: 8 }).color).toBe("yellow");
  });

  it("смотрят много, не пишут — красный; тяжёлое первым, подсказок не больше трёх", () => {
    const h = assessPropertyHealth({ ...healthy, contacts30: 0, contactsTotal: 0, showingsTotal: 0, photos: 2, publishedChannels: 0, priceDiffPct: 7 });
    expect(h.color).toBe("red");
    expect(h.headline).toBe("Смотрят много, пишут мало");
    expect(h.tips).toHaveLength(3);
  });

  it("продаётся в полтора раза дольше похожих — красный", () => {
    const h = assessPropertyHealth({ ...healthy, daysOnSale: 100, daysToSellTypical: 60 });
    expect(h.headline).toBe("Продаётся дольше похожих");
    expect(h.tips[0]).toMatch(/100 дней, похожие обычно уходят за 60/);
  });

  it("без связи с сайтом не судит по просмотрам", () => {
    expect(assessPropertyHealth({ ...healthy, siteConnected: false, siteViews30: 0, contacts30: 0 }).color).toBe("green");
  });

  it("продан и в брони — зелёный; ещё на подготовке — серый", () => {
    expect(assessPropertyHealth({ ...healthy, status: "SOLD" }).color).toBe("green");
    expect(assessPropertyHealth({ ...healthy, status: "RESERVED" }).color).toBe("green");
    expect(assessPropertyHealth({ ...healthy, status: "EDITING" }).color).toBe("gray");
  });
});

describe("detectHot — «объект загорелся»", () => {
  const days = (views: number[]) => views.map((v, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, views: v }));

  it("в три раза больше обычного и не меньше 10 — загорелся, с какого дня", () => {
    const h = detectHot(days([...new Array(14).fill(1), 6, 8]));
    expect(h).toMatchObject({ hot: true, recentViews: 14, since: "2026-09-15" });
    expect(h.ratio).toBe(7);
  });

  it("много, но как обычно — не загорелся", () => {
    expect(detectHot(days([...new Array(14).fill(10), 11, 12])).hot).toBe(false);
  });

  it("мало просмотров — не загорелся, даже с нуля", () => {
    expect(detectHot(days([...new Array(14).fill(0), 2, 3])).hot).toBe(false);
  });
});

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-property-stats-${runId}` } })).id;
  const agent = await prisma.agent.create({ data: { fullName: "Агент статистики", phone: phones[0], role: "AGENT", passwordHash } });
  agentId = agent.id;
  token = await login(agent.phone);

  const base = { type: "APARTMENT" as const, rooms: 2, currency: "TJS" as const, districtId, address: "Тестовая, 1", condition: "GOOD" as const };
  const subject = await prisma.property.create({
    data: { ...base, title: `Объект статистики ${runId}`, areaSqm: 50, price: 600_000, status: "AVAILABLE", stageEnteredAt: new Date(Date.now() - 40 * 86_400_000) },
  });
  subjectId = subject.id;
  created.push(subject.id);
  // Соседи: три 2-комнатные в продаже по 10 000 за м² — объект дороже на 20%.
  for (let i = 0; i < 3; i++) {
    const n = await prisma.property.create({ data: { ...base, title: `Сосед ${i} ${runId}`, areaSqm: 50, price: 500_000, status: "AVAILABLE" } });
    created.push(n.id);
  }

  // Сайт: вчера 6 открытий и 2 нажатия WhatsApp, сегодня 4.
  const today = dushanbeDayKey(new Date());
  const yesterday = dushanbeDayKey(new Date(Date.now() - 86_400_000));
  await prisma.sitePropertyDay.createMany({
    data: [
      { propertyId: subjectId, day: dushanbeDayKeyToDate(yesterday), views: 6, visitors: 5, whatsappClicks: 2 },
      { propertyId: subjectId, day: dushanbeDayKeyToDate(today), views: 4, visitors: 3 },
    ],
  });

  // Двое клиентов пришли по объекту, один из них был на показе.
  const c1 = await prisma.client.create({ data: { fullName: `Покупатель 1 ${runId}`, phone: `+992942${runId}`, source: "PHONE_CALL", matchedPropertyId: subjectId } });
  const c2 = await prisma.client.create({ data: { fullName: `Покупатель 2 ${runId}`, phone: `+992943${runId}`, source: "PHONE_CALL" } });
  await prisma.interaction.create({ data: { clientId: c2.id, agentId, type: "CALL", propertyId: subjectId, notes: "звонок" } });
  await prisma.interaction.create({ data: { clientId: c2.id, agentId, type: "SHOWING", propertyId: subjectId, notes: "показ" } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { propertyId: subjectId } });
  await prisma.client.deleteMany({ where: { phone: { in: [`+992942${runId}`, `+992943${runId}`] } } });
  await prisma.property.deleteMany({ where: { id: { in: created } } });
  await prisma.agent.deleteMany({ where: { phone: { in: phones } } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("GET /properties/:id/stats", () => {
  it("путь покупателя, соседи, график и светофор одним ответом", async () => {
    const res = await request(app).get(`/api/v1/properties/${subjectId}/stats`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const funnel = Object.fromEntries(res.body.funnel.map((s: { key: string; count: number | null }) => [s.key, s.count]));
    // Два клиента в CRM + два нажатия WhatsApp на сайте; показ — один клиент.
    expect(funnel.contact).toBe(4);
    expect(funnel.showing).toBe(1);
    expect(funnel.deal).toBe(0);
    expect(funnel.seen).toBeNull();

    // Сравнение с соседями выключено (NEIGHBORS_COMPARISON_ENABLED): цены за м² объекта
    // считаются, соседей и «выше соседей» нет. Вернуть проверки при включении.
    expect(res.body.neighbors).toMatchObject({ pricePerSqm: 12000, medianPerSqm: null, diffPct: null, sample: 0 });
    expect(res.body.health.headline).not.toMatch(/соседей/);

    expect(res.body.siteDays).toHaveLength(30);
    expect(res.body.siteDays.at(-1).views).toBe(4);
    expect(res.body.siteTotals).toMatchObject({ views: 10, whatsapp: 2 });
  });

  it("по короткому номеру — тот же объект", async () => {
    const { shortId } = await prisma.property.findUniqueOrThrow({ where: { id: subjectId }, select: { shortId: true } });
    const res = await request(app).get(`/api/v1/properties/${shortId}/stats`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("чужой или несуществующий id — 404; без входа — 401", async () => {
    const res = await request(app).get(`/api/v1/properties/00000000-0000-4000-8000-000000000000/stats`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect((await request(app).get(`/api/v1/properties/${subjectId}/stats`)).status).toBe(401);
  });

  it("площадки: объект нигде не опубликован — пусто, без похода в сеть", async () => {
    const res = await request(app).get(`/api/v1/properties/${subjectId}/stats/platforms`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platforms: [], seen: null });
  });
});

describe("GET /properties/health — светофор списком (точка в каталоге)", () => {
  it("тот же цвет и та же фраза, что во вкладке «Статистика»; новый объект — серый", async () => {
    const card = await request(app).get(`/api/v1/properties/${subjectId}/stats`).set("Authorization", `Bearer ${token}`);
    const res = await request(app)
      .get(`/api/v1/properties/health?ids=${subjectId},${created[1]}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[subjectId]).toEqual({
      color: card.body.health.color,
      headline: card.body.health.headline,
      tip: card.body.health.tips[0] ?? null,
    });
    expect(res.body[created[1]].color).toBe("gray");
  });

  it("удалённый объект — без точки", async () => {
    const gone = await prisma.property.create({
      data: {
        type: "APARTMENT",
        rooms: 2,
        currency: "TJS",
        districtId,
        address: "Тестовая, 2",
        condition: "GOOD",
        title: `Удалённый ${runId}`,
        areaSqm: 50,
        price: 500_000,
        status: "AVAILABLE",
        deletedAt: new Date(),
      },
    });
    created.push(gone.id);
    const res = await request(app).get(`/api/v1/properties/health?ids=${gone.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("без списка, не id или больше 100 — 400; без входа — 401", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(app).get("/api/v1/properties/health").set(auth)).status).toBe(400);
    expect((await request(app).get("/api/v1/properties/health?ids=abc").set(auth)).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
    expect((await request(app).get(`/api/v1/properties/health?ids=${many}`).set(auth)).status).toBe(400);
    expect((await request(app).get(`/api/v1/properties/health?ids=${subjectId}`)).status).toBe(401);
  });
});

describe("GET /properties/needs-help — «Объекты, которым нужна помощь»", () => {
  it("красные первыми, не больше десяти, с числами по всему каталогу", async () => {
    const res = await request(app).get("/api/v1/properties/needs-help").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items = res.body.items as { color: string; headline: string; shortId: number }[];
    expect(items.length).toBeLessThanOrEqual(10);
    expect(items.every((it) => it.color === "red" || it.color === "yellow")).toBe(true);
    const firstYellow = items.findIndex((it) => it.color === "yellow");
    if (firstYellow >= 0) expect(items.slice(firstYellow).every((it) => it.color === "yellow")).toBe(true);
    expect(res.body.red + res.body.yellow).toBeLessThanOrEqual(res.body.checked);
    expect((await request(app).get("/api/v1/properties/needs-help")).status).toBe(401);
  });
});
