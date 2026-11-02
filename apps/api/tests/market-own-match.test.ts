import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const { sendPushToAgent } = vi.hoisted(() => ({ sendPushToAgent: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { extractPhoneTails, maskTail, runOwnMatching, scoreOwnMatch } = await import("../src/lib/market/ownMatch.js");
import type { OwnMatchListing, OwnMatchProperty } from "../src/lib/market/ownMatch.js";

/**
 * Наш объект на Somon/Paydo: чистая оценка (scoreOwnMatch), прогон runOwnMatching
 * со стендом (пуш ровно один раз, повтор не дублирует, DISMISSED не возвращается)
 * и маршруты /market/matches.
 */

const runId = Date.now().toString().slice(-8);
const password = "testpass123";
const DISTRICT = `Тест-совпадение-${runId}`;
/** Свой номер владельца на каждый сценарий: одинаковые параметры в разных тестах не должны склеиваться между собой. */
const tailFor = (n: number) => `90${runId.slice(-6)}${n}`;
const phoneFor = (n: number) => `+992${tailFor(n)}`;
const LAT = 38.55;
const LNG = 68.78;

const baseProperty: OwnMatchProperty = {
  type: "APARTMENT", rooms: 2, areaSqm: 60, floor: 4, totalFloors: 9, priceTjs: 700000,
  districtName: "Сино", lat: null, lng: null, ownerPhoneTails: ["900000056"],
};
const baseListing: OwnMatchListing = {
  propertyType: "APARTMENT", districtName: "Сино", rooms: 2, areaSqm: 61, floor: 4, totalFloors: 9, priceTjs: 720000,
  latitude: null, longitude: null, sellerPhone: "+992900000056",
};

describe("scoreOwnMatch (чистая оценка)", () => {
  it("телефон владельца + параметры — кандидат, номера в причинах нет", () => {
    const v = scoreOwnMatch(baseProperty, baseListing);
    expect(v.phoneMatched).toBe(true);
    expect(v.candidate).toBe(true);
    expect(v.score).toBeGreaterThanOrEqual(70);
    expect(v.reasons.some((r) => r.code === "phone")).toBe(true);
    expect(JSON.stringify(v.reasons)).not.toContain("900000056");
  });

  it("номер сравнивается по последним 9 цифрам, а не по записи", () => {
    const v = scoreOwnMatch(baseProperty, { ...baseListing, sellerPhone: "900 00 00 56" });
    expect(v.phoneMatched).toBe(true);
  });

  it("без телефона и без точки одни параметры кандидата не дают (панельные дома-близнецы)", () => {
    const v = scoreOwnMatch({ ...baseProperty, ownerPhoneTails: [] }, { ...baseListing, areaSqm: 60, priceTjs: 700000 });
    expect(v.phoneMatched).toBe(false);
    expect(v.score).toBe(80);
    expect(v.candidate).toBe(false);
  });

  it("без телефона, но точка в 100 м и сходятся параметры — кандидат", () => {
    const v = scoreOwnMatch(
      { ...baseProperty, ownerPhoneTails: [], lat: LAT, lng: LNG },
      { ...baseListing, sellerPhone: null, latitude: LAT + 0.0009, longitude: LNG },
    );
    expect(v.reasons.some((r) => r.code === "geo")).toBe(true);
    expect(v.candidate).toBe(true);
  });

  it("точка рядом, но параметры слабые (этаж неизвестен) — порог 85 не пройден", () => {
    const v = scoreOwnMatch(
      { ...baseProperty, ownerPhoneTails: [], lat: LAT, lng: LNG, floor: null, totalFloors: null },
      { ...baseListing, sellerPhone: null, floor: null, totalFloors: null, latitude: LAT, longitude: LNG, priceTjs: 790000 },
    );
    expect(v.candidate).toBe(false);
  });

  it("разные квартиры в одном доме не склеиваются: этаж, площадь, комнаты", () => {
    const near = { ...baseProperty, lat: LAT, lng: LNG };
    const same = { ...baseListing, latitude: LAT, longitude: LNG };
    expect(scoreOwnMatch(near, { ...same, floor: 7 }).rejected).toBe("floor");
    expect(scoreOwnMatch(near, { ...same, areaSqm: 68 }).rejected).toBe("area");
    expect(scoreOwnMatch(near, { ...same, rooms: 3 }).rejected).toBe("rooms");
    expect(scoreOwnMatch(near, { ...same, totalFloors: 5 }).rejected).toBe("totalFloors");
  });

  it("противоречие закрывает пару даже при совпавшем телефоне: цена дальше 15%, точка дальше 2 км", () => {
    expect(scoreOwnMatch(baseProperty, { ...baseListing, priceTjs: 900000 }).candidate).toBe(false);
    expect(scoreOwnMatch(baseProperty, { ...baseListing, priceTjs: 900000 }).rejected).toBe("price");
    const far = scoreOwnMatch({ ...baseProperty, lat: LAT, lng: LNG }, { ...baseListing, latitude: LAT + 0.05, longitude: LNG });
    expect(far.rejected).toBe("geo");
  });

  it("телефон без подтверждающих параметров — не кандидат", () => {
    const v = scoreOwnMatch(
      { ...baseProperty, areaSqm: null, floor: null, totalFloors: null, priceTjs: null, districtName: null },
      { ...baseListing, areaSqm: null, floor: null, totalFloors: null, priceTjs: null, districtName: null },
    );
    expect(v.candidate).toBe(false);
  });

  it("extractPhoneTails достаёт несколько номеров из строки и маскирует для лога", () => {
    expect(extractPhoneTails("+992 900 00 00 56, жена 927-11-22-33")).toEqual(["900000056", "927112233"]);
    expect(extractPhoneTails("позвонить днём")).toEqual([]);
    expect(maskTail("900000056")).not.toContain("900000056");
  });
});

// ───────────────────────────── стенд ─────────────────────────────

let adminId: string;
let agentId: string;
let outsiderId: string;
let districtId: string;
let adminToken: string;
let outsiderToken: string;
const propertyIds: string[] = [];
const listingIds: string[] = [];

function listingData(n: number, over: Record<string, unknown> = {}) {
  const k = listingIds.length + 1;
  return {
    source: "somon.tj",
    sourceId: `${runId}-${k}-${Math.random().toString(36).slice(2, 7)}`,
    sourceUrl: `https://somon.tj/adv/${runId}${k}_test/`,
    dealType: "SALE",
    propertyType: "APARTMENT",
    city: "Душанбе",
    districtName: DISTRICT,
    rooms: 2,
    areaSqm: 61,
    floor: 4,
    totalFloors: 9,
    price: 720000,
    currency: "TJS",
    priceTjs: 720000,
    title: "2-комн. квартира, тест",
    isAgency: false,
    sellerName: "Фируз",
    sellerPhone: phoneFor(n),
    isActive: true,
    raw: {},
    ...over,
  };
}

async function makeListing(n: number, over: Record<string, unknown> = {}) {
  const l = await prisma.marketListing.create({ data: listingData(n, over) as never });
  listingIds.push(l.id);
  return l;
}

async function makeProperty(n: number, title: string, over: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title, type: "APARTMENT", rooms: 2, areaSqm: 60, floor: 4, totalFloors: 9, price: 700000, currency: "TJS",
      districtId, address: "Тестовая, 1", condition: "GOOD", status: "AVAILABLE",
      assignedAgentId: agentId, ownerContact: phoneFor(n),
      ...over,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

const pushesFor = (title: string) =>
  sendPushToAgent.mock.calls.filter(([, payload]) => String((payload as { body: string }).body).includes(title));

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({ data: { fullName: "Админ совпадений", phone: `+992960${runId}`, role: "ADMIN", passwordHash } });
  const agent = await prisma.agent.create({ data: { fullName: "Агент совпадений", phone: `+992961${runId}`, role: "AGENT", passwordHash } });
  const outsider = await prisma.agent.create({ data: { fullName: "Чужой агент", phone: `+992962${runId}`, role: "AGENT", passwordHash } });
  adminId = admin.id;
  agentId = agent.id;
  outsiderId = outsider.id;
  districtId = (await prisma.district.create({ data: { name: DISTRICT } })).id;
  adminToken = (await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password })).body.accessToken;
  outsiderToken = (await request(app).post("/api/v1/auth/login").send({ phone: outsider.phone, password })).body.accessToken;
});

beforeEach(() => sendPushToAgent.mockClear());

afterAll(async () => {
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId, outsiderId] } } });
  await prisma.$disconnect();
});

describe("runOwnMatching (стенд)", () => {
  it("находит объект на площадке, пуш агенту уходит ровно один раз даже при параллельном запуске", async () => {
    const title = `Совпадение-${runId}-а`;
    const prop = await makeProperty(1, title);
    const same = await makeListing(1);
    await makeListing(1, { floor: 7, totalFloors: 9 }); // соседняя квартира: этаж другой

    await Promise.all([runOwnMatching(), runOwnMatching()]);

    const matches = await prisma.propertyMarketMatch.findMany({ where: { propertyId: prop.id } });
    expect(matches).toHaveLength(1);
    expect(matches[0].listingId).toBe(same.id);
    expect(matches[0].status).toBe("CANDIDATE");
    expect(matches[0].notifiedAt).not.toBeNull();
    expect(JSON.stringify(matches[0].reasons)).not.toContain(tailFor(1));

    const pushes = pushesFor(title);
    expect(pushes).toHaveLength(1);
    const [recipient, payload] = pushes[0] as [string, { body: string; url: string }];
    expect(recipient).toBe(agentId);
    expect(payload.body).toContain("Somon");
    expect(payload.body).toContain("720 000");
    expect(payload.body).toContain("у нас 700 000");
    expect(payload.body).not.toContain(tailFor(1));
    expect(payload.url).toBe(`/properties/${prop.shortId}`);

    // Повторный запуск — тишина.
    await runOwnMatching();
    expect(pushesFor(title)).toHaveLength(1);
  });

  it("повторный пуш — только при сдвиге цены на 3% и больше, и ровно один", async () => {
    const title = `Совпадение-${runId}-цена`;
    const prop = await makeProperty(2, title);
    const listing = await makeListing(2);
    await runOwnMatching();
    expect(pushesFor(title)).toHaveLength(1);

    await prisma.marketListing.update({ where: { id: listing.id }, data: { priceTjs: 715000 } }); // −0,7%
    await runOwnMatching();
    expect(pushesFor(title)).toHaveLength(1);

    await prisma.marketListing.update({ where: { id: listing.id }, data: { priceTjs: 690000 } }); // −4,2%
    await Promise.all([runOwnMatching(), runOwnMatching()]);
    const pushes = pushesFor(title);
    expect(pushes).toHaveLength(2);
    expect((pushes[1][1] as { body: string }).body).toContain("720 000 → 690 000");
    const m = await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId: prop.id } });
    expect(Number(m.lastPriceTjs)).toBe(690000);
  });

  it("объявление сняли — один пуш «больше не виден»", async () => {
    const title = `Совпадение-${runId}-снято`;
    await makeProperty(3, title);
    const listing = await makeListing(3);
    await runOwnMatching();
    await prisma.marketListing.update({ where: { id: listing.id }, data: { isActive: false, disappearedAt: new Date() } });
    await Promise.all([runOwnMatching(), runOwnMatching()]);
    await runOwnMatching();
    const pushes = pushesFor(title);
    expect(pushes).toHaveLength(2);
    expect((pushes[1][1] as { body: string }).body).toContain("больше не виден");
  });

  it("DISMISSED не возвращается и не пушится", async () => {
    const title = `Совпадение-${runId}-нет`;
    const prop = await makeProperty(4, title);
    const listing = await makeListing(4);
    await runOwnMatching();
    await prisma.propertyMarketMatch.updateMany({ where: { propertyId: prop.id }, data: { status: "DISMISSED" } });
    sendPushToAgent.mockClear();

    await prisma.marketListing.update({ where: { id: listing.id }, data: { priceTjs: 650000 } });
    await runOwnMatching();
    await prisma.marketListing.update({ where: { id: listing.id }, data: { isActive: false } });
    await runOwnMatching();

    expect(pushesFor(title)).toHaveLength(0);
    const rows = await prisma.propertyMarketMatch.findMany({ where: { propertyId: prop.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("DISMISSED");
  });

  it("у объекта нет агента — пуша нет, метка не ставится (уведомим, когда назначат)", async () => {
    const title = `Совпадение-${runId}-безагента`;
    const prop = await makeProperty(5, title, { assignedAgentId: null });
    await makeListing(5);
    await runOwnMatching();
    expect(pushesFor(title)).toHaveLength(0);
    const m = await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId: prop.id } });
    expect(m.notifiedAt).toBeNull();
  });
});

describe("маршруты /market/matches", () => {
  let propertyId: string;
  let shortId: number;
  let matchId: string;

  beforeAll(async () => {
    const prop = await makeProperty(6, `Совпадение-${runId}-маршрут`);
    propertyId = prop.id;
    shortId = prop.shortId;
    await makeListing(6);
    await runOwnMatching();
    matchId = (await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId } })).id;
  });

  it("без авторизации — 401", async () => {
    expect((await request(app).get(`/api/v1/market/matches/property/${shortId}`)).status).toBe(401);
    expect((await request(app).post(`/api/v1/market/matches/${matchId}/status`).send({ status: "CONFIRMED" })).status).toBe(401);
  });

  it("список: источник, ссылка, цена, сравнение с нашей, продавец и телефон", async () => {
    const res = await request(app).get(`/api/v1/market/matches/property/${shortId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ourPriceTjs).toBe(700000);
    expect(res.body.matches).toHaveLength(1);
    const m = res.body.matches[0];
    expect(m.source).toBe("somon.tj");
    expect(m.sourceUrl).toContain("somon.tj/adv/");
    expect(m.priceTjs).toBe(720000);
    expect(m.priceDiffPercent).toBe(3); // 720/700 − 1 = 2,9%
    expect(m.areaDiffSqm).toBe(1);
    expect(m.sellerName).toBe("Фируз");
    expect(m.sellerPhone).toBe(phoneFor(6));
    expect(m.isActive).toBe(true);
  });

  it("совпадение по телефону владельца не раскрывает телефон сотруднику без доступа к контакту владельца", async () => {
    const res = await request(app).get(`/api/v1/market/matches/property/${shortId}`).set("Authorization", `Bearer ${outsiderToken}`);
    expect(res.status).toBe(200);
    expect(res.body.matches[0].sellerPhone).toBeNull();
    expect(res.body.matches[0].sellerPhoneHidden).toBe(true);
  });

  it("несуществующий объект — 404", async () => {
    const res = await request(app).get("/api/v1/market/matches/property/99999999").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("статус: мусор — 400, неизвестное совпадение — 404, CONFIRMED и DISMISSED сохраняются", async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const url = `/api/v1/market/matches/${matchId}/status`;
    expect((await request(app).post(url).set(auth).send({ status: "CANDIDATE" })).status).toBe(400);
    expect((await request(app).post(url).set(auth).send({})).status).toBe(400);
    expect((await request(app).post("/api/v1/market/matches/no-such-id/status").set(auth).send({ status: "CONFIRMED" })).status).toBe(404);

    const ok = await request(app).post(url).set(auth).send({ status: "CONFIRMED" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("CONFIRMED");
    const list = await request(app).get(`/api/v1/market/matches/property/${shortId}`).set(auth);
    expect(list.body.matches[0].status).toBe("CONFIRMED");

    expect((await request(app).post(url).set(auth).send({ status: "DISMISSED" })).status).toBe(200);
    const after = await request(app).get(`/api/v1/market/matches/property/${shortId}`).set(auth);
    expect(after.body.matches).toHaveLength(0);
  });

  it("объект в корзине: без archive.view совпадения не видны и статус не сменить", async () => {
    await prisma.propertyMarketMatch.update({ where: { id: matchId }, data: { status: "CANDIDATE" } });
    await prisma.property.update({ where: { id: propertyId }, data: { deletedAt: new Date() } });
    const auth = { Authorization: `Bearer ${outsiderToken}` };
    expect((await request(app).get(`/api/v1/market/matches/property/${shortId}`).set(auth)).status).toBe(404);
    expect((await request(app).post(`/api/v1/market/matches/${matchId}/status`).set(auth).send({ status: "CONFIRMED" })).status).toBe(404);
    const admin = await request(app).get(`/api/v1/market/matches/property/${shortId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);
  });
});
