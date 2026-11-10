import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sentAgoText } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { computeDemandCounts, findMatchingClients, propertyMatchSelect } from "../src/routes/matching.js";
import { clientPropertyMatchingCatalog } from "../src/lib/clientPropertyMatchingCatalog.js";
import { currentBuyerMatchingCriteria, matchClientProperty } from "../src/lib/clientPropertyMatching.js";
import { clientDoneBuying, DEFAULT_MATCH_POLICY } from "../src/lib/matchPolicy.js";

/**
 * ПОДБОР 2.0: ОДНА МОДЕЛЬ «КЛИЕНТ ↔ ОБЪЕКТ» В ОБЕ СТОРОНЫ (владелец 10.11.2026).
 *
 * До правки «Кому подходит» (объект → клиенты) считала процент своей шкалой и
 * своим фильтром, а «Подбор» под клиента (клиент → объекты) — уровни другой
 * функцией. Одна и та же пара получала разные ответы. Здесь сторож: одна пара —
 * один уровень и одни причины с обеих сторон; купившие и передумавшие не «ждут».
 */
const runId = Date.now();
const suffix = runId.toString().slice(-7);
let districtId: string;
let propertyId: string;
const clientIds: string[] = [];

async function makeClient(name: string, data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name}-${runId}`,
      phone: `+99291${suffix}${clientIds.length}`,
      status: "CONTACTED",
      kind: "BUYER",
      source: "WEBSITE",
      lastContactAt: new Date(),
      desiredDistrictId: districtId,
      desiredRooms: 3,
      budgetMax: 500_000,
      currency: "TJS",
      ...data,
    } as never,
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Одна-модель-${runId}` } })).id;
  propertyId = (await prisma.property.create({
    data: {
      title: `Одна модель ${runId}`, type: "APARTMENT", areaSqm: 64, rooms: 3, floor: 1, totalFloors: 9,
      price: 520_000, currency: "TJS", districtId, address: "Тестовая, 2", condition: "GOOD",
    },
  })).id;
});

afterAll(async () => {
  await prisma.propertyExposure.deleteMany({ where: { propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("одна пара — один ответ с обеих сторон", () => {
  it("«Кому подходит» и «Подбор» под клиента дают тот же уровень, причины и уступки", async () => {
    const buyer = await makeClient("Двусторонний", { requirementsNotes: "С ремонтом, документы в порядке" });
    const { items } = await findMatchingClients(propertyId, 50);
    const fromProperty = items.find((c) => c.id === buyer.id)?.match;
    expect(fromProperty).toBeDefined();

    const stored = await prisma.client.findUniqueOrThrow({ where: { id: buyer.id }, include: { desiredPlaces: true } });
    const catalog = await clientPropertyMatchingCatalog(buyer.id, currentBuyerMatchingCriteria(stored), {
      viewerId: "nobody", canDeleteProperties: true, page: 1, pageSize: 30, scope: "all",
    });
    const fromClient = catalog.properties.find((p) => p.id === propertyId)?.match;
    expect(fromClient).toBeDefined();

    const pick = (m: { tier: string; reasons: string[]; tradeoffs: string[]; unknowns: string[]; ask: string[] }) =>
      ({ tier: m.tier, reasons: m.reasons, tradeoffs: m.tradeoffs, unknowns: m.unknowns, ask: m.ask });
    expect(pick(fromProperty!)).toEqual(pick(fromClient!));
    // И это не пустое совпадение: 520 000 при бюджете 500 000 — честная уступка, а не процент.
    expect(fromProperty!.tier).toBe("alternative");
    expect(fromProperty!.tradeoffs).toContain("На 4% дороже бюджета (+20 000 сомони)");
    expect(fromProperty!.reasons).toEqual(expect.arrayContaining(["Нужный район", "3 комнаты, как просил", "Ремонт: готовый"]));
    expect(fromProperty!.unknowns).toContain("Документы: нужно уточнить");
    expect(fromProperty!.ask[0]).toBe("Клиент не говорил про этаж (здесь 1 из 9) — спросите");
  });

  it("счётчик «ждут N покупателей» и «Кому подходит» считают одно множество", async () => {
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: propertyMatchSelect });
    const demand = (await computeDemandCounts([property])).get(propertyId) ?? 0;
    const { total } = await findMatchingClients(propertyId, 50);
    expect(demand).toBe(total);
  });
});

describe("купившие и передумавшие не ждут объект", () => {
  it("LOST «купил сам» / «через другое агентство» / «передумал» — вне подбора; «дорого» и без причины — в подборе", async () => {
    const boughtSelf = await makeClient("Купил-сам", { status: "LOST", refusalReason: "BOUGHT_SELF" });
    const boughtOther = await makeClient("Купил-у-других", { status: "LOST", refusalReason: "BOUGHT_VIA_OTHER_AGENCY" });
    const changedMind = await makeClient("Передумал", { status: "LOST", refusalReason: "CHANGED_MIND" });
    const expensive = await makeClient("Дорого", { status: "LOST", refusalReason: "EXPENSIVE" });
    // NULL-ловушка SQL: LOST без причины не должен выпасть из-за NOT(NULL).
    const noReason = await makeClient("Без-причины", { status: "LOST", refusalReason: null });

    const ids = new Set((await findMatchingClients(propertyId, 50)).items.map((c) => c.id));
    expect(ids.has(boughtSelf.id)).toBe(false);
    expect(ids.has(boughtOther.id)).toBe(false);
    expect(ids.has(changedMind.id)).toBe(false);
    expect(ids.has(expensive.id)).toBe(true);
    expect(ids.has(noReason.id)).toBe(true);

    expect(clientDoneBuying({ status: "LOST", refusalReason: "BOUGHT_SELF" })).toBe(true);
    expect(clientDoneBuying({ status: "LOST", refusalReason: "EXPENSIVE" })).toBe(false);
    expect(clientDoneBuying({ status: "DEAL_CLOSED" })).toBe(true);
    expect(clientDoneBuying({ status: "HOT", refusalReason: "BOUGHT_SELF" })).toBe(false);
  });
});

describe("«уже отправляли N дней назад»", () => {
  it("история отправок приходит в «Кому подходит»", async () => {
    const buyer = await makeClient("Отправляли", {});
    const sentAt = new Date(Date.now() - 3 * 86_400_000);
    await prisma.propertyExposure.create({
      data: { channel: "TELEGRAM", recipientId: `test-${runId}`, clientId: buyer.id, propertyId, shortId: 1, kind: "manual", sentAt },
    });
    const match = (await findMatchingClients(propertyId, 50)).items.find((c) => c.id === buyer.id)!.match;
    expect(match.sentCount).toBe(1);
    expect(match.lastSentAt).toBe(sentAt.toISOString());
    expect(sentAgoText(match, "ru", new Date(sentAt.getTime() + 3 * 86_400_000))).toBe("Уже отправляли 3 дня назад");
  });

  it("дни — по календарю Душанбе, повтор назван", () => {
    const now = new Date("2026-11-10T08:00:00Z");
    expect(sentAgoText({ lastSentAt: "2026-11-09T19:30:00Z", sentCount: 1 }, "ru", now)).toBe("Уже отправляли сегодня");
    expect(sentAgoText({ lastSentAt: "2026-11-09T10:00:00Z", sentCount: 2 }, "ru", now)).toBe("Уже отправляли вчера (2 раза)");
    expect(sentAgoText({ lastSentAt: "2026-11-05T10:00:00Z", sentCount: 1 }, "ru", now)).toBe("Уже отправляли 5 дней назад");
    expect(sentAgoText({ lastSentAt: "2026-11-09T10:00:00Z", sentCount: 1 }, "tg", now)).toBe("Аллакай фиристода шуда буд дирӯз");
    expect(sentAgoText({ lastSentAt: null, sentCount: 0 })).toBeNull();
  });
});

describe("правила пары", () => {
  const money = { usdToTjs: 11 };
  const buyer = { budgetMin: null, budgetMax: 600_000, currency: "TJS", desiredDistrictId: "d", desiredRooms: 2 };
  const flat = { id: "p", type: "APARTMENT", districtId: "d", price: 550_000, currency: "TJS", rooms: 2, floor: 1, totalFloors: 5 };

  it("«не первый раз покупаю» — не про этаж; «не первый этаж» — про этаж", () => {
    expect(matchClientProperty({ ...buyer, requirementsNotes: "Не первый раз покупаю квартиру" }, flat, money, DEFAULT_MATCH_POLICY)).not.toBeNull();
    expect(matchClientProperty({ ...buyer, requirementsNotes: "Только не первый этаж" }, flat, money, DEFAULT_MATCH_POLICY)).toBeNull();
    expect(matchClientProperty({ ...buyer, requirementsNotes: "не первый и не последний" }, flat, money, DEFAULT_MATCH_POLICY)).toBeNull();
  });

  it("просил комнаты — участок и коммерция без комнат не предлагаются (кадр 10.11)", () => {
    const land = { ...flat, type: "LAND", rooms: null, floor: null, totalFloors: null };
    expect(matchClientProperty(buyer, land, money, DEFAULT_MATCH_POLICY)).toBeNull();
    expect(matchClientProperty({ ...buyer, desiredRooms: null }, land, money, DEFAULT_MATCH_POLICY)).not.toBeNull();
    expect(matchClientProperty({ ...buyer, desiredType: "LAND" }, land, money, DEFAULT_MATCH_POLICY)).not.toBeNull();
  });

  it("главное не названо — «уточнить», а не «точно подходит»", () => {
    const noBudget = matchClientProperty({ ...buyer, budgetMax: null }, flat, money, DEFAULT_MATCH_POLICY)!;
    expect(noBudget.tier).toBe("needs_verification");
    expect(noBudget.unknowns).toContain("Клиент не назвал бюджет");
    const full = matchClientProperty(buyer, flat, money, DEFAULT_MATCH_POLICY)!;
    expect(full.tier).toBe("exact");
    // Вопрос про этаж уровень не снижает.
    expect(full.ask).toContain("Клиент не говорил про этаж (здесь 1 из 5) — спросите");
  });

  it("бюджет в долларах сравнивается по курсу", () => {
    const usd = matchClientProperty({ ...buyer, budgetMax: 50_000, currency: "USD" }, flat, money, DEFAULT_MATCH_POLICY)!;
    expect(usd.reasons).toContain("В бюджете");
    expect(matchClientProperty({ ...buyer, budgetMax: 40_000, currency: "USD" }, flat, money, DEFAULT_MATCH_POLICY)).toBeNull();
  });
});

describe("сторож: правило совпадения живёт в одном месте", () => {
  /** Шкалу и уровни считает только lib/clientPropertyMatching.ts. Новая копия
   *  арифметики в другом файле сервера — вторая модель того же отношения. */
  it("MATCH_SCORE_WEIGHTS и проверку tier читает только единая модель", () => {
    const root = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === "generated") continue;
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.ts$/.test(name)) continue;
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (rel === "lib/clientPropertyMatching.ts") continue;
        const text = readFileSync(full, "utf8");
        if (/MATCH_SCORE_WEIGHTS|scoreClientProperty|isMatchTradeoff/.test(text)) offenders.push(rel);
        if (/tier\s*:\s*[^,]*\?\s*"alternative"/.test(text)) offenders.push(`${rel} (своё правило уровня)`);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
