import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import {
  buildDynamics,
  daysListed,
  isRealtorSeller,
  median,
  priceCutPercent,
  type ActiveRow,
  type DynamicsSubject,
  type GoneRow,
} from "../src/lib/market/dynamics.js";

/**
 * Динамика рынка по ушедшим объявлениям. Чистая часть (медианы, пороги, «данных
 * мало») проверяется без БД; маршрут — на стенде. «Ушло» ≠ «продано»: тесты держат
 * только числа, формулировки — дело фронта.
 */

const DAY = 24 * 3600_000;
const NOW = new Date("2026-11-02T10:00:00Z");
const subject: DynamicsSubject = { propertyType: "APARTMENT", districtName: "Сино", rooms: 3, areaSqm: 75 };

function gone(i: number, over: Partial<GoneRow> & { life?: number; goneAgo?: number } = {}): GoneRow {
  const goneAgo = over.goneAgo ?? i + 1;
  const life = over.life ?? 20;
  const disappearedAt = new Date(NOW.getTime() - goneAgo * DAY);
  return {
    sourceUrl: `https://somon.tj/adv/g${i}`, source: "somon.tj", title: `Ушло ${i}`,
    priceTjs: 800000, pricePerSqmTjs: 10000,
    firstSeenAt: new Date(disappearedAt.getTime() - life * DAY), disappearedAt,
    sellerId: null, sellerName: null, sellerPhone: null, isAgency: false, snapshots: [],
    ...over,
  };
}

function active(i: number, over: Partial<ActiveRow> = {}): ActiveRow {
  return { pricePerSqmTjs: 12000, sellerId: null, sellerPhone: null, isAgency: false, ...over };
}

describe("dynamics: чистые функции", () => {
  it("median: нечётное, чётное, пусто", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("priceCutPercent: первая цена против последней; без падения и с одним снимком — null", () => {
    const t = (d: number) => new Date(NOW.getTime() - d * DAY);
    expect(priceCutPercent([{ priceTjs: 1000, seenAt: t(10) }, { priceTjs: 900, seenAt: t(5) }])).toBeCloseTo(10);
    // порядок на входе не важен
    expect(priceCutPercent([{ priceTjs: 900, seenAt: t(5) }, { priceTjs: 1000, seenAt: t(10) }])).toBeCloseTo(10);
    expect(priceCutPercent([{ priceTjs: 1000, seenAt: t(10) }])).toBeNull();
    expect(priceCutPercent([{ priceTjs: 1000, seenAt: t(10) }, { priceTjs: 1100, seenAt: t(5) }])).toBeNull();
  });

  it("isRealtorSeller: пометка агентства или ≥ 5 активных объявлений", () => {
    const owner = { sellerId: "s1", sellerPhone: null, isAgency: false };
    expect(isRealtorSeller(owner, { "id:s1": 4 })).toBe(false);
    expect(isRealtorSeller(owner, { "id:s1": 5 })).toBe(true);
    expect(isRealtorSeller({ ...owner, isAgency: true }, {})).toBe(true);
    // без sellerId ключ — телефон (arzon.tj)
    expect(isRealtorSeller({ sellerId: null, sellerPhone: "+992900000001", isAgency: false }, { "ph:+992900000001": 6 })).toBe(true);
    expect(isRealtorSeller({ sellerId: null, sellerPhone: null, isAgency: false }, {})).toBe(false);
  });

  it("мало данных — ни одной цифры, статус insufficient", () => {
    const r = buildDynamics([gone(0), gone(1)], [active(0)], {}, subject, NOW);
    expect(r.status).toBe("insufficient");
    expect(r.speed.medianDays).toBeNull();
    expect(r.speed.sampleSize).toBe(2);
    expect(r.price.diffPercent).toBeNull();
    expect(r.price.cutSharePercent).toBeNull();
    expect(r.sellers.realtorPercent).toBeNull();
    // сам список недавно ушедших показываем и при малой выборке
    expect(r.recentlyGone).toHaveLength(2);
  });

  it("порог 8: семь ушедших — нет медианы, восемь — есть", () => {
    const seven = buildDynamics(Array.from({ length: 7 }, (_, i) => gone(i)), [], {}, subject, NOW);
    expect(seven.speed.medianDays).toBeNull();
    const eight = buildDynamics(Array.from({ length: 8 }, (_, i) => gone(i)), [], {}, subject, NOW);
    expect(eight.speed.medianDays).toBe(20);
    expect(eight.status).toBe("ok");
  });

  it("история короче 3 суток не считается «ушло» (молодой каталог)", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => gone(i, { life: 10 })),
      ...Array.from({ length: 5 }, (_, i) => gone(100 + i, { life: 2 })),
    ];
    const r = buildDynamics(rows, [], {}, subject, NOW);
    expect(r.goneCount).toBe(8);
    expect(r.speed.sampleSize).toBe(8);
    expect(r.speed.medianDays).toBe(10);
    expect(r.recentlyGone.every((g) => g.daysListed >= 3)).toBe(true);
    expect(daysListed(rows[8])).toBeLessThan(3);
  });

  it("цена: ушедшие дешевле висящих — отрицательная разница в %", () => {
    const goneRows = Array.from({ length: 8 }, (_, i) => gone(i, { pricePerSqmTjs: 9000 }));
    const activeRows = Array.from({ length: 8 }, (_, i) => active(i, { pricePerSqmTjs: 12000 }));
    const r = buildDynamics(goneRows, activeRows, {}, subject, NOW);
    expect(r.price.goneMedianPerSqm).toBe(9000);
    expect(r.price.activeMedianPerSqm).toBe(12000);
    expect(r.price.diffPercent).toBe(-25);
  });

  it("цена: висящих меньше 8 — сравнения нет", () => {
    const r = buildDynamics(Array.from({ length: 8 }, (_, i) => gone(i)), [active(0), active(1)], {}, subject, NOW);
    expect(r.price.diffPercent).toBeNull();
    expect(r.price.activeSampleSize).toBe(2);
  });

  it("снижение цены до ухода: доля и средний размер по снимкам", () => {
    const t = (d: number) => new Date(NOW.getTime() - d * DAY);
    // 8 ушедших со снимками: 4 снижали на 10%, 4 нет
    const rows = Array.from({ length: 8 }, (_, i) =>
      gone(i, {
        snapshots: i < 4
          ? [{ priceTjs: 1000, seenAt: t(30) }, { priceTjs: 900, seenAt: t(25) }]
          : [{ priceTjs: 1000, seenAt: t(30) }],
      })
    );
    // без снимков вообще — в знаменатель не входят
    rows.push(gone(50), gone(51));
    const r = buildDynamics(rows, [], {}, subject, NOW);
    expect(r.price.cutSampleSize).toBe(8);
    expect(r.price.cutSharePercent).toBe(50);
    expect(r.price.avgCutPercent).toBe(10);
  });

  it("продавцы: доля риелторов и число их объявлений", () => {
    const goneRows = Array.from({ length: 4 }, (_, i) => gone(i, { sellerId: "big" }));
    const activeRows = [
      active(0, { isAgency: true }),
      active(1), active(2), active(3, { sellerId: "small" }),
    ];
    const r = buildDynamics(goneRows, activeRows, { "id:big": 12, "id:small": 1 }, subject, NOW);
    expect(r.sellers.sampleSize).toBe(8);
    expect(r.sellers.realtorListings).toBe(5);
    expect(r.sellers.realtorPercent).toBe(63);
    expect(r.sellers.ownerPercent).toBe(37);
  });

  it("недавно ушедшие: пять свежих, с ценой, сроком, снижением и телефоном", () => {
    const t = (d: number) => new Date(NOW.getTime() - d * DAY);
    const rows = Array.from({ length: 7 }, (_, i) => gone(i, { goneAgo: i + 1, life: 21 }));
    rows[0] = gone(0, {
      goneAgo: 1, life: 21, sellerName: "Фарход", sellerPhone: "+992900000002",
      snapshots: [{ priceTjs: 1000, seenAt: t(22) }, { priceTjs: 950, seenAt: t(5) }],
    });
    const r = buildDynamics(rows, [], {}, subject, NOW);
    expect(r.recentlyGone).toHaveLength(5);
    expect(r.recentlyGone[0]).toMatchObject({
      sourceUrl: "https://somon.tj/adv/g0", daysListed: 21, goneDaysAgo: 1, priceCutPercent: 5,
      sellerPhone: "+992900000002", sellerName: "Фарход",
    });
    expect(r.recentlyGone[4].goneDaysAgo).toBe(5);
  });
});

/* ---------------- маршрут на стенде ---------------- */

const runId = Date.now().toString().slice(-9);
const password = "testpass123";
const DISTRICT_NAME = `Тест-динамика-${runId}`;

let agentId: string;
let districtId: string;
let propertyId: string;
let landId: string;
let emptyPropertyId: string;
let emptyDistrictId: string;
let token: string;
const listingIds: string[] = [];

async function addListing(
  key: string,
  over: { isActive: boolean; firstSeenDaysAgo: number; goneDaysAgo?: number; perSqm: number; areaSqm?: number; rooms?: number; sellerId?: string; isAgency?: boolean; sellerPhone?: string; cut?: boolean; district?: string }
) {
  const areaSqm = over.areaSqm ?? 75;
  const priceTjs = over.perSqm * areaSqm;
  const now = Date.now();
  const l = await prisma.marketListing.create({
    data: {
      source: "test-source", sourceId: `${runId}-${key}`, sourceUrl: `https://example.tj/dyn/${runId}-${key}`,
      dealType: "SALE", propertyType: "APARTMENT", city: "Душанбе", districtName: over.district ?? DISTRICT_NAME,
      rooms: over.rooms ?? 3, areaSqm, price: priceTjs, currency: "TJS", priceTjs, pricePerSqmTjs: over.perSqm,
      title: `Динамика ${key}`, isAgency: over.isAgency ?? false, sellerId: over.sellerId ?? null,
      sellerPhone: over.sellerPhone ?? null, sellerName: over.sellerPhone ? "Тест-продавец" : null,
      isActive: over.isActive,
      firstSeenAt: new Date(now - over.firstSeenDaysAgo * DAY),
      lastSeenAt: over.isActive ? new Date() : new Date(now - (over.goneDaysAgo ?? 1) * DAY),
      disappearedAt: over.isActive ? null : new Date(now - (over.goneDaysAgo ?? 1) * DAY),
      raw: {},
    },
  });
  listingIds.push(l.id);
  await prisma.marketPriceSnapshot.create({
    data: { listingId: l.id, priceTjs, seenAt: new Date(now - over.firstSeenDaysAgo * DAY) },
  });
  if (over.cut) {
    await prisma.marketPriceSnapshot.create({
      data: { listingId: l.id, priceTjs: priceTjs * 0.9, seenAt: new Date(now - Math.max(1, (over.goneDaysAgo ?? 1) + 1) * DAY) },
    });
  }
  return l;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент динамики рынка", phone: `+992971${runId}`, role: "ADMIN", passwordHash },
  });
  agentId = agent.id;
  districtId = (await prisma.district.create({ data: { name: DISTRICT_NAME } })).id;
  emptyDistrictId = (await prisma.district.create({ data: { name: `${DISTRICT_NAME}-пусто` } })).id;
  const baseProperty = {
    areaSqm: 75, price: 900000, currency: "TJS" as const, address: "Тестовая, 1", condition: "GOOD" as const,
    assignedAgentId: agentId, ownerContact: "+992900000096",
  };
  propertyId = (await prisma.property.create({
    data: { ...baseProperty, districtId, title: `Динамика-объект-${runId}`, type: "APARTMENT", rooms: 3 },
  })).id;
  emptyPropertyId = (await prisma.property.create({
    data: { ...baseProperty, districtId: emptyDistrictId, title: `Динамика-пусто-${runId}`, type: "APARTMENT", rooms: 3 },
  })).id;
  landId = (await prisma.property.create({
    data: { ...baseProperty, districtId, title: `Динамика-участок-${runId}`, type: "LAND" },
  })).id;

  // 10 ушедших за 20 дней жизни: 5 со снижением цены, 4 от риелтора с 5 активными, 1 вне допуска по площади.
  for (let i = 0; i < 10; i++) {
    await addListing(`g${i}`, {
      isActive: false, firstSeenDaysAgo: 20 + i + 1, goneDaysAgo: i + 1, perSqm: 9000 + i * 50,
      cut: i < 5, sellerId: i < 4 ? "realtor-1" : undefined, sellerPhone: i === 0 ? "+992900000003" : undefined,
    });
  }
  // молодой каталог: ушло через сутки — не считаем
  await addListing("young", { isActive: false, firstSeenDaysAgo: 2, goneDaysAgo: 1, perSqm: 5000 });
  // не похожие: другая площадь, другие комнаты, другой район — в выборку не попадают
  await addListing("bigarea", { isActive: false, firstSeenDaysAgo: 30, goneDaysAgo: 2, perSqm: 1, areaSqm: 140 });
  await addListing("rooms2", { isActive: false, firstSeenDaysAgo: 30, goneDaysAgo: 2, perSqm: 1, rooms: 2 });
  await addListing("other", { isActive: false, firstSeenDaysAgo: 30, goneDaysAgo: 2, perSqm: 1, district: `${DISTRICT_NAME}-другой` });
  // ушло давно — вне окна 90 дней
  await addListing("old", { isActive: false, firstSeenDaysAgo: 200, goneDaysAgo: 120, perSqm: 1 });

  // 10 висящих: дороже ушедших; одно агентство и два от «realtor-1». Ещё три его активных лежат
  // в другом районе (в выборку не попадают) — счёт по всему каталогу даёт 2+3 = 5 → риелтор.
  for (let i = 0; i < 3; i++) {
    await addListing(`far${i}`, { isActive: true, firstSeenDaysAgo: 5, perSqm: 12000, sellerId: "realtor-1", district: `${DISTRICT_NAME}-другой` });
  }
  for (let i = 0; i < 10; i++) {
    await addListing(`a${i}`, {
      isActive: true, firstSeenDaysAgo: 5, perSqm: 12000 + i * 50, isAgency: i === 0,
      sellerId: i === 1 || i === 2 ? "realtor-1" : undefined,
    });
  }

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, landId, emptyPropertyId] } } });
  await prisma.district.deleteMany({ where: { id: { in: [districtId, emptyDistrictId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("GET /market/property/:id/dynamics", () => {
  it("без авторизации — 401", async () => {
    const res = await request(app).get(`/api/v1/market/property/${propertyId}/dynamics`);
    expect([401, 403]).toContain(res.status);
  });

  it("квартира: скорость, цена, снижения, продавцы и недавно ушедшие", async () => {
    const res = await request(app).get(`/api/v1/market/property/${propertyId}/dynamics`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    // 10 похожих ушедших; «young» (<3 суток) и непохожие не считаются
    expect(res.body.goneCount).toBe(10);
    expect(res.body.activeCount).toBe(10);
    // жизнь у i-го: (20+i+1) − (i+1) = 20 дней
    expect(res.body.speed.medianDays).toBe(20);
    // ушедшие ~9225, висящие ~12225 → около −25%
    expect(res.body.price.diffPercent).toBeLessThan(-20);
    expect(res.body.price.diffPercent).toBeGreaterThan(-30);
    // 5 из 10 снижали цену на 10%
    expect(res.body.price.cutSharePercent).toBe(50);
    expect(res.body.price.avgCutPercent).toBe(10);
    // риелторы: 4 ушедших + 2 висящих от realtor-1 (5 активных по каталогу) и одно агентство = 7 из 20
    expect(res.body.sellers.sampleSize).toBe(20);
    expect(res.body.sellers.realtorListings).toBe(7);
    expect(res.body.sellers.realtorPercent).toBe(35);
    expect(res.body.sellers.ownerPercent).toBe(65);
    expect(res.body.recentlyGone).toHaveLength(5);
    expect(res.body.recentlyGone[0].sourceUrl).toContain(`${runId}-g0`);
    expect(res.body.recentlyGone[0].goneDaysAgo).toBe(1);
    expect(res.body.recentlyGone[0].sellerPhone).toBe("+992900000003");
    expect(res.body.recentlyGone[0].priceCutPercent).toBe(10);
  });

  it("пустой район — insufficient без 500 и без цифр", async () => {
    const res = await request(app).get(`/api/v1/market/property/${emptyPropertyId}/dynamics`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("insufficient");
    expect(res.body.speed.medianDays).toBeNull();
    expect(res.body.recentlyGone).toEqual([]);
  });

  it("участок — unsupported", async () => {
    const res = await request(app).get(`/api/v1/market/property/${landId}/dynamics`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unsupported");
  });

  it("несуществующий и кривой id — 404", async () => {
    const a = await request(app).get(`/api/v1/market/property/00000000-0000-4000-8000-000000000000/dynamics`).set("Authorization", `Bearer ${token}`);
    expect(a.status).toBe(404);
    const b = await request(app).get(`/api/v1/market/property/not-an-id/dynamics`).set("Authorization", `Bearer ${token}`);
    expect(b.status).toBe(404);
  });

  it("удалённый объект: без archive.view — 404", async () => {
    const agent = await prisma.agent.create({
      data: { fullName: "Агент без архива", phone: `+992972${runId}`, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
    });
    const del = await prisma.property.create({
      data: {
        areaSqm: 75, price: 900000, currency: "TJS", address: "Тестовая, 2", condition: "GOOD", assignedAgentId: agent.id,
        ownerContact: "+992900000095", districtId, title: `Динамика-удалён-${runId}`, type: "APARTMENT", rooms: 3, deletedAt: new Date(),
      },
    });
    try {
      const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
      expect(login.status).toBe(200);
      const res = await request(app).get(`/api/v1/market/property/${del.id}/dynamics`).set("Authorization", `Bearer ${login.body.accessToken}`);
      expect(res.status).toBe(404);
    } finally {
      await prisma.property.deleteMany({ where: { id: del.id } });
      await prisma.agent.deleteMany({ where: { id: agent.id } });
    }
  });
});
