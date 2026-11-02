import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const { sendPushToAgent } = vi.hoisted(() => ({ sendPushToAgent: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { fetchSomonPhone } = vi.hoisted(() => ({ fetchSomonPhone: vi.fn(async (_id: string): Promise<string | null> => null) }));
vi.mock("../src/lib/somonLeads/phone.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/phone.js")>()),
  fetchSomonPhone,
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
const tailFor = (n: number) => `90${runId.slice(-5)}${String(n).padStart(2, "0")}`;
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

  it("без телефона, но точка в 40 м, этаж известен и совпал, параметры сходятся — кандидат", () => {
    const v = scoreOwnMatch(
      { ...baseProperty, ownerPhoneTails: [], lat: LAT, lng: LNG },
      { ...baseListing, sellerPhone: null, latitude: LAT + 0.00036, longitude: LNG },
    );
    expect(v.reasons.some((r) => r.code === "geo")).toBe(true);
    expect(v.candidate).toBe(true);
  });

  it("дом-близнец: точка рядом, объявление без этажа — не кандидат, хоть с баллом точки (+25) было бы 85", () => {
    const v = scoreOwnMatch(
      { ...baseProperty, ownerPhoneTails: [], lat: LAT, lng: LNG },
      { ...baseListing, sellerPhone: null, floor: null, latitude: LAT + 0.0001, longitude: LNG },
    );
    expect(v.rejected).toBeNull();
    expect(v.score).toBe(60); // параметры без этажа; прежняя точка добавила бы 25 и дотянула до порога 85
    expect(v.reasons.some((r) => r.code === "geo")).toBe(false);
    expect(v.candidate).toBe(false);
    // и наоборот: этаж неизвестен у нашего объекта
    const v2 = scoreOwnMatch(
      { ...baseProperty, ownerPhoneTails: [], lat: LAT, lng: LNG, floor: null },
      { ...baseListing, sellerPhone: null, latitude: LAT + 0.0001, longitude: LNG },
    );
    expect(v2.candidate).toBe(false);
  });

  it("точка в 100 м (дальше 50) не делает пару кандидатом даже с этажом", () => {
    const v = scoreOwnMatch(
      { ...baseProperty, ownerPhoneTails: [], lat: LAT, lng: LNG },
      { ...baseListing, sellerPhone: null, latitude: LAT + 0.0009, longitude: LNG },
    );
    expect(v.candidate).toBe(false);
  });

  it("номер агентства или номер на 3+ объявлениях опознавательным не считается, на 1–2 — считается", () => {
    expect(scoreOwnMatch(baseProperty, { ...baseListing, isAgency: true }).phoneMatched).toBe(false);
    expect(scoreOwnMatch(baseProperty, { ...baseListing, isAgency: true }).candidate).toBe(false);
    expect(scoreOwnMatch(baseProperty, { ...baseListing, sellerPhoneListings: 3 }).candidate).toBe(false);
    expect(scoreOwnMatch(baseProperty, { ...baseListing, sellerPhoneListings: 2 }).candidate).toBe(true);
    expect(scoreOwnMatch(baseProperty, { ...baseListing, sellerPhoneListings: 1, isAgency: false }).candidate).toBe(true);
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
    // два номера через пробел не склеиваются в один
    expect(extractPhoneTails("900 00 00 56 927 11 22 33")).toEqual(["900000056", "927112233"]);
    expect(extractPhoneTails("+992900000056 +992927112233")).toEqual(["900000056", "927112233"]);
    expect(extractPhoneTails("992900000056 992927112233")).toEqual(["900000056", "927112233"]);
    expect(extractPhoneTails("+992 (90) 000-00-56")).toEqual(["900000056"]);
    expect(extractPhoneTails("12 34 56")).toEqual([]);
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
let agentToken: string;
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
  agentToken = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password })).body.accessToken;
});

beforeEach(() => {
  sendPushToAgent.mockReset();
  sendPushToAgent.mockImplementation(async () => 1);
  fetchSomonPhone.mockReset();
  fetchSomonPhone.mockImplementation(async () => null);
});

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
    // Цена на момент находки записана сразу — точка отсчёта для «цена сдвинулась».
    expect(Number(m.lastPriceTjs)).toBe(720000);
  });

  it("новое совпадение доходит до агента, даже когда 501 прежних пар уже уведомлены (потолок 500 не вытесняет новые)", async () => {
    const title = `Совпадение-${runId}-501`;
    const prop = await makeProperty(12, title, { ownerContact: null });
    const k0 = listingIds.length;
    await prisma.marketListing.createMany({
      data: Array.from({ length: 502 }, (_, i) =>
        listingData(12, { sourceId: `${runId}-b${i}`, sourceUrl: `https://somon.tj/adv/${runId}b${i}_t/`, sellerPhone: null }) as never),
    });
    const rows = await prisma.marketListing.findMany({ where: { sourceId: { startsWith: `${runId}-b` } }, select: { id: true } });
    expect(rows).toHaveLength(502);
    listingIds.push(...rows.map((r) => r.id));
    expect(listingIds.length).toBe(k0 + 502);
    const [fresh, changed, ...old] = rows;
    const past = new Date(Date.now() - 86_400_000);
    await prisma.propertyMarketMatch.createMany({
      data: old.map((r) => ({ propertyId: prop.id, listingId: r.id, score: 90, reasons: [], notifiedAt: past, lastPriceTjs: 720000 })),
    });
    // «изменённая»: уведомлена по 720 000, на площадке теперь 690 000 (−4,2%).
    await prisma.propertyMarketMatch.create({
      data: { propertyId: prop.id, listingId: changed.id, score: 90, reasons: [], notifiedAt: past, lastPriceTjs: 720000 },
    });
    await prisma.marketListing.update({ where: { id: changed.id }, data: { priceTjs: 690000 } });
    // «свежая»: совпадение создано, пуша ещё не было.
    await prisma.propertyMarketMatch.create({ data: { propertyId: prop.id, listingId: fresh.id, score: 90, reasons: [] } });

    await runOwnMatching();

    const bodies = pushesFor(title).map(([, payload]) => (payload as { body: string }).body);
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.includes("найден на Somon"))).toBe(true);
    expect(bodies.some((b) => b.includes("720 000 → 690 000"))).toBe(true);
    expect((await prisma.propertyMarketMatch.findFirstOrThrow({ where: { listingId: fresh.id } })).notifiedAt).not.toBeNull();
  });

  it("пуш не ушёл (sendPushToAgent бросил) — метка снимается, следующий прогон повторяет", async () => {
    const title = `Совпадение-${runId}-сбой`;
    const prop = await makeProperty(13, title);
    await makeListing(13);
    sendPushToAgent.mockImplementation(async (_to: string, payload: unknown) => {
      if (String((payload as { body: string }).body).includes(title)) throw new Error("push service down");
      return 1;
    });
    await runOwnMatching();
    let m = await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId: prop.id } });
    expect(m.notifiedAt).toBeNull();

    sendPushToAgent.mockImplementation(async () => 1);
    await runOwnMatching();
    m = await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId: prop.id } });
    expect(m.notifiedAt).not.toBeNull();
    expect(pushesFor(title).length).toBe(2); // попытка, которая упала, и повтор
  });

  it("сбой пуша о снятии и о цене тоже снимает метку", async () => {
    const title = `Совпадение-${runId}-сбой2`;
    const prop = await makeProperty(14, title);
    const listing = await makeListing(14);
    await runOwnMatching();
    const failing = async (_to: string, payload: unknown) => {
      if (String((payload as { body: string }).body).includes(title)) throw new Error("down");
      return 1;
    };
    sendPushToAgent.mockImplementation(failing);
    await prisma.marketListing.update({ where: { id: listing.id }, data: { priceTjs: 650000 } });
    await runOwnMatching();
    let m = await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId: prop.id } });
    expect(Number(m.lastPriceTjs)).toBe(720000); // вернули прежнюю — следующий прогон повторит

    await prisma.marketListing.update({ where: { id: listing.id }, data: { isActive: false } });
    await runOwnMatching();
    m = await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId: prop.id } });
    expect(m.goneNotifiedAt).toBeNull();

    sendPushToAgent.mockImplementation(async () => 1);
    await runOwnMatching();
    m = await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId: prop.id } });
    expect(m.goneNotifiedAt).not.toBeNull();
  });

  it("объявление пропало, вернулось и пропало снова — второй пуш «сняли» уходит", async () => {
    const title = `Совпадение-${runId}-вернулось`;
    const prop = await makeProperty(15, title);
    const listing = await makeListing(15);
    await runOwnMatching();
    const gonePushes = () => pushesFor(title).filter(([, p]) => String((p as { body: string }).body).includes("больше не виден"));

    await prisma.marketListing.update({ where: { id: listing.id }, data: { isActive: false } });
    await runOwnMatching();
    expect(gonePushes()).toHaveLength(1);

    await prisma.marketListing.update({ where: { id: listing.id }, data: { isActive: true } });
    await runOwnMatching();
    expect((await prisma.propertyMarketMatch.findFirstOrThrow({ where: { propertyId: prop.id } })).goneNotifiedAt).toBeNull();

    await prisma.marketListing.update({ where: { id: listing.id }, data: { isActive: false } });
    await runOwnMatching();
    expect(gonePushes()).toHaveLength(2);
  });

  it("пуши идут своим видом «market», а не «hot» (отключённое «Объект загорелся» их не глушит)", async () => {
    const title = `Совпадение-${runId}-вид`;
    await makeProperty(16, title);
    await makeListing(16);
    await runOwnMatching();
    const pushes = pushesFor(title);
    expect(pushes).toHaveLength(1);
    expect((pushes[0][1] as { kind: string }).kind).toBe("market");
  });

  it("номер агентства и номер на 3+ объявлениях совпадения не создают", async () => {
    const agencyProp = await makeProperty(17, `Совпадение-${runId}-агентство`);
    await makeListing(17, { isAgency: true });
    const manyProp = await makeProperty(18, `Совпадение-${runId}-много`);
    await makeListing(18);
    await makeListing(18);
    await makeListing(18);
    const twoProp = await makeProperty(19, `Совпадение-${runId}-два`);
    await makeListing(19);
    await makeListing(19, { floor: 7 }); // тот же номер, другой этаж — отброшено по параметрам
    await runOwnMatching();
    expect(await prisma.propertyMarketMatch.count({ where: { propertyId: agencyProp.id } })).toBe(0);
    expect(await prisma.propertyMarketMatch.count({ where: { propertyId: manyProp.id } })).toBe(0);
    expect(await prisma.propertyMarketMatch.count({ where: { propertyId: twoProp.id } })).toBe(1);
  });

  it("объявление с другим названием района находится по телефону (район в выборку не входит)", async () => {
    const prop = await makeProperty(20, `Совпадение-${runId}-район`);
    await makeListing(20, { districtName: "Совсем другой район" });
    await runOwnMatching();
    expect(await prisma.propertyMarketMatch.count({ where: { propertyId: prop.id } })).toBe(1);
  });

  it("по точке: дом-близнец без этажа не совпадает, тот же этаж в 20 м — совпадает", async () => {
    const lat = 38.9 + Number(runId.slice(-4)) / 1_000_000;
    const lng = 68.9;
    const prop = await makeProperty(21, `Совпадение-${runId}-точка`, { ownerContact: null, lat, lng });
    await makeListing(21, { sellerPhone: null, latitude: lat + 0.0001, longitude: lng, floor: null }); // близнец без этажа
    const same = await makeListing(21, { sellerPhone: null, latitude: lat + 0.00018, longitude: lng }); // 20 м, этаж 4
    await makeListing(21, { sellerPhone: null, latitude: lat + 0.0009, longitude: lng }); // 100 м
    await runOwnMatching();
    const rows = await prisma.propertyMarketMatch.findMany({ where: { propertyId: prop.id } });
    expect(rows.map((r) => r.listingId)).toEqual([same.id]);
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

  it("статус: посторонний агент — 403 и ничего не меняется; ответственный агент и админ — 200", async () => {
    const url = `/api/v1/market/matches/${matchId}/status`;
    const denied = await request(app).post(url).set("Authorization", `Bearer ${outsiderToken}`).send({ status: "DISMISSED" });
    expect(denied.status).toBe(403);
    expect((await prisma.propertyMarketMatch.findUniqueOrThrow({ where: { id: matchId } })).status).toBe("CANDIDATE");

    const own = await request(app).post(url).set("Authorization", `Bearer ${agentToken}`).send({ status: "CONFIRMED" });
    expect(own.status).toBe(200);
    expect(own.body.status).toBe("CONFIRMED");
    const admin = await request(app).post(url).set("Authorization", `Bearer ${adminToken}`).send({ status: "CONFIRMED" });
    expect(admin.status).toBe(200);
    await prisma.propertyMarketMatch.update({ where: { id: matchId }, data: { status: "CANDIDATE" } });
  });

  it("телефон владельца не утекает, даже если причина «phone» не записана (номер у объявления появился позже)", async () => {
    const prop = await makeProperty(22, `Совпадение-${runId}-утечка`);
    const listing = await makeListing(22, { sellerPhone: null });
    await prisma.propertyMarketMatch.create({
      data: { propertyId: prop.id, listingId: listing.id, score: 80, reasons: [{ code: "rooms", label: "2 комн." }] },
    });
    await prisma.marketListing.update({ where: { id: listing.id }, data: { sellerPhone: phoneFor(22) } });
    const get = (token: string) =>
      request(app).get(`/api/v1/market/matches/property/${prop.shortId}`).set("Authorization", `Bearer ${token}`);

    const hidden = (await get(outsiderToken)).body.matches[0];
    expect(hidden.sellerPhone).toBeNull();
    expect(hidden.sellerPhoneHidden).toBe(true);
    expect((await get(agentToken)).body.matches[0].sellerPhone).toBe(phoneFor(22));
    expect((await get(adminToken)).body.matches[0].sellerPhone).toBe(phoneFor(22));
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

describe("POST /market/listing-contact", () => {
  let clock = Date.now();
  const click = (token: string, sourceUrl: string) => {
    clock += 10_000; // троттлинг «не чаще раза в 3 с на сотрудника» обходим временем, а не паузой
    return request(app).post("/api/v1/market/listing-contact").set("Authorization", `Bearer ${token}`).send({ sourceUrl });
  };

  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterAll(() => vi.restoreAllMocks());

  it("номер совпал с контактом владельца чужого объекта — 403 постороннему, 200 ответственному и админу", async () => {
    await makeProperty(23, `Совпадение-${runId}-контакт`);
    const listing = await makeListing(23);
    const outsider = await click(outsiderToken, listing.sourceUrl);
    expect(outsider.status).toBe(403);
    expect(JSON.stringify(outsider.body)).not.toContain(tailFor(23));
    const own = await click(agentToken, listing.sourceUrl);
    expect(own.status).toBe(200);
    expect(own.body.phone).toBe(phoneFor(23));
    expect((await click(adminToken, listing.sourceUrl)).status).toBe(200);
  });

  it("номер не совпал ни с одним владельцем — отдаётся всем", async () => {
    const listing = await makeListing(24, { sellerPhone: `+9929${runId.slice(-4)}0991` });
    const res = await click(outsiderToken, listing.sourceUrl);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
  });

  it("номер из сайта приводится к +992XXXXXXXXX, сохраняется и сверяется с владельцами (403 постороннему)", async () => {
    await makeProperty(25, `Совпадение-${runId}-контакт2`);
    const listing = await makeListing(25, { sellerPhone: null });
    const t = tailFor(25);
    fetchSomonPhone.mockImplementation(async () => `+992 (${t.slice(0, 2)}) ${t.slice(2, 5)}-${t.slice(5, 7)}-${t.slice(7)}`);

    const denied = await click(outsiderToken, listing.sourceUrl);
    expect(denied.status).toBe(403);
    // номер сохранён единым видом, чтобы прогон совпадений его нашёл
    expect((await prisma.marketListing.findUniqueOrThrow({ where: { id: listing.id } })).sellerPhone).toBe(phoneFor(25));

    const ok = await click(agentToken, listing.sourceUrl);
    expect(ok.status).toBe(200);
    expect(ok.body.phone).toBe(phoneFor(25));
    expect(fetchSomonPhone).toHaveBeenCalledTimes(1); // второй клик — из каталога
  });

  it("обрывок вместо номера — «нет номера»", async () => {
    const listing = await makeListing(26, { sellerPhone: null });
    fetchSomonPhone.mockImplementation(async () => "12-34");
    const res = await click(adminToken, listing.sourceUrl);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ phone: null, reason: "no_phone" });
  });
});
