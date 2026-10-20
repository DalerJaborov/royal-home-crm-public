import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  BOTS_OFFER_MODE,
  botMayOffer,
  findMatchingProperties,
  identifyProperty,
  type PropertyMatchQuery,
} from "../src/lib/propertyMatch.js";
import { buyerQueryForTurn, resolveSearchPlace, roomsFromText, typeFromText, wantsCheapest } from "../src/lib/searchPlace.js";
import { isSuburbanProperty, textMentionsSuburb } from "../src/lib/suburbanProperty.js";
import { budgetWindowTjs, DEFAULT_MATCH_POLICY } from "../src/lib/matchPolicy.js";
import { loadMoneyContext } from "../src/lib/money.js";
import { voiceSearchQuery } from "../src/lib/telephony/liveVoicePropertyTools.js";
import { FOLK_PLACES, folkGeographyBlock, folkPlacesForPrompt, resetFolkCoverageCache } from "../src/ai/folkPlaces.js";
import { geoMentionBlock, resetGeoMentionIndex } from "../src/ai/geoMentions.js";

/**
 * 30 ЗАПРОСОВ ИЗ АУДИТА ПОИСКА — АВТОМАТИЧЕСКИМ ТЕСТОМ (10.10.2026,
 * docs/audit-bots-2026-10-10-search.md §4).
 *
 * Каталог — свой, тестовый (названия с меткой прогона), выборка подбора сужена на
 * него (`scope`), чтобы чужие объекты общей базы не мешали. Районы — настоящие
 * четыре (их заводит seed): именно их называют клиенты и боты.
 *
 * Запрос строится той же функцией, что у канала: чат-бот — buyerQueryForTurn(черновик,
 * реплика), робот — voiceSearchQuery(аргументы функции). Расхождение каналов краснеет здесь.
 *
 * Сторож проверен поломкой (10.10.2026): порядок по свежести и `rooms: { gte }` в
 * findMatchingProperties — краснеют №1, 2, 3, 7, 8, 9, 12, 20, 21; «за городом» всегда
 * false — №13, 14, 15; допуск бюджета 0 — №16; голосу урезанный список — тест карты.
 */

const runId = Date.now().toString(36);
const TAG = `Б30-${runId}`;
const scope = { title: { startsWith: TAG } };
const DISTRICTS = ["Исмоили Сомони", "Сино", "Фирдавси", "Шохмансур"] as const;
type D = (typeof DISTRICTS)[number];
const districtIds: Record<string, string> = {};
const createdDistricts: string[] = [];
const ids: Record<string, number> = {};
let usd = 10;
let landmarkSourceId = "";
const BRIDGE = { lat: 38.6205, lng: 68.8205 };
const OVIR = { lat: 38.571455, lng: 68.797189 };

let age = 0;
async function make(
  mark: string,
  d: D,
  data: {
    type?: "APARTMENT" | "HOUSE" | "LAND" | "COMMERCIAL";
    rooms?: number | null;
    price: number;
    currency?: "TJS" | "USD";
    area?: number;
    floor?: number;
    address?: string;
    landmark?: string;
    description?: string;
    condition?: "GOOD" | "EXCELLENT" | "NEEDS_REPAIR" | "NEW_BUILDING";
    marketType?: "NEW_BUILD" | "SECONDARY";
    details?: Record<string, string>;
    lat?: number;
    lng?: number;
    published?: boolean;
    title?: string;
  }
): Promise<void> {
  // Порядок создания = свежесть: первый в списке — самый старый.
  age += 1;
  const p = await prisma.property.create({
    data: {
      title: `${TAG} ${data.title ?? mark}`,
      type: data.type ?? "APARTMENT",
      rooms: data.rooms === undefined ? 2 : data.rooms,
      areaSqm: data.area ?? 60,
      floor: data.floor ?? 3,
      totalFloors: 9,
      price: data.price,
      currency: data.currency ?? "TJS",
      districtId: districtIds[d],
      address: data.address ?? `${d}, Тестовая улица`,
      landmark: data.landmark ?? null,
      description: data.description ?? null,
      condition: data.condition ?? "GOOD",
      marketType: data.marketType ?? null,
      details: data.details ?? undefined,
      lat: data.lat ?? null,
      lng: data.lng ?? null,
      status: "AVAILABLE",
      publishedOnSite: data.published ?? true,
      createdAt: new Date(Date.now() - 1_000_000_000 + age * 60_000),
    },
  });
  ids[mark] = p.shortId;
}

beforeAll(async () => {
  for (const name of DISTRICTS) {
    const found = await prisma.district.findUnique({ where: { name } });
    if (found) districtIds[name] = found.id;
    else {
      districtIds[name] = (await prisma.district.create({ data: { name } })).id;
      createdDistricts.push(name);
    }
  }
  usd = (await loadMoneyContext()).usdToTjs;
  landmarkSourceId = `b30-bridge-${runId}`;
  await prisma.landmark.create({
    data: { sourceId: landmarkSourceId, name: `Тестмост ${runId}`, category: "Мост", districtId: districtIds["Фирдавси"], lat: BRIDGE.lat, lng: BRIDGE.lng },
  });
  resetGeoMentionIndex();

  // Исмоили Сомони: три настоящие двушки СТАРШЕ двух семикомнатных (как на проде, №142/№128).
  await make("is2a", "Исмоили Сомони", { price: 900_000, landmark: "Овир", floor: 10, lat: OVIR.lat + 0.001, lng: OVIR.lng + 0.001 });
  await make("is2b", "Исмоили Сомони", { price: 1_000_000 });
  await make("is2c", "Исмоили Сомони", { price: 850_000 });
  await make("is3", "Исмоили Сомони", { rooms: 3, price: 1_200_000 });
  await make("is7b", "Исмоили Сомони", { rooms: 7, price: 650_000, currency: "USD" });
  await make("is7a", "Исмоили Сомони", { rooms: 7, price: 2_000_000 });
  await make("isVarzob", "Исмоили Сомони", { type: "HOUSE", rooms: 4, price: 2_500_000, description: "Дом в Чорбоге, Варзобский район" });

  // Сино.
  await make("s2usd", "Сино", { price: 60_000, currency: "USD" });
  await make("s2b", "Сино", {
    price: 950_000,
    condition: "EXCELLENT",
    marketType: "NEW_BUILD",
    address: "Сино, Зарафшон",
    details: { furniture: "Полностью", parking: "Подземный паркинг" },
  });
  await make("s2a", "Сино", { price: 700_000, condition: "NEEDS_REPAIR", marketType: "NEW_BUILD" });
  await make("s2hidden", "Сино", { price: 800_000, published: false });
  await make("land", "Сино", { type: "LAND", rooms: null, price: 300_000, area: 34 });
  await make("s3b", "Сино", { rooms: 3, price: 980_000 });
  await make("s3a", "Сино", { rooms: 3, price: 950_000 });

  // Шохмансур: городской дом самый старый, два загородных — самые свежие (№154, №146).
  await make("shHouseCity", "Шохмансур", { type: "HOUSE", rooms: 4, price: 2_000_000 });
  await make("shBuston", "Шохмансур", { rooms: 3, price: 1_850_000, area: 101, address: "Шохмансур, ул. Адхамова (Бустон Сити)" });
  await make("shFurnYes", "Шохмансур", { price: 950_000, details: { furniture: "Полностью" } });
  await make("shNear", "Шохмансур", { rooms: 3, price: 1_100_000, lat: BRIDGE.lat + 0.002, lng: BRIDGE.lng });
  await make("sh3", "Шохмансур", { rooms: 3, price: 1_030_000 });
  await make("shOther1", "Шохмансур", { rooms: 3, price: 1_500_000 });
  await make("shOther2", "Шохмансур", { rooms: 3, price: 1_400_000 });
  await make("shFurnNo", "Шохмансур", { price: 900_000, details: { furniture: "Без мебели" } });
  await make("shHouseVahdat", "Шохмансур", { type: "HOUSE", rooms: 5, price: 5_500_000, description: "Продаётся дом в городе Вахдат" });
  await make("shHouse9km", "Шохмансур", { type: "HOUSE", rooms: 4, price: 3_000_000, title: "Дом, 9 км, шиферный завод" });

  // Фирдавси: трёшка далеко от моста и дача.
  await make("f3", "Фирдавси", { rooms: 3, price: 1_200_000, lat: BRIDGE.lat - 0.05, lng: BRIDGE.lng - 0.05 });
  await make("fDacha", "Фирдавси", { type: "HOUSE", rooms: 3, price: 1_500_000, title: "Дом, дачный посёлок" });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: scope });
  await prisma.landmark.deleteMany({ where: { sourceId: landmarkSourceId } });
  for (const name of createdDistricts) await prisma.district.deleteMany({ where: { name } });
  resetGeoMentionIndex();
  await prisma.$disconnect();
});

const run = async (q: PropertyMatchQuery, limit = 3) => findMatchingProperties(q, { scope, limit });
const marks = (rows: { shortId: number }[]) => rows.map((r) => Object.keys(ids).find((k) => ids[k] === r.shortId) ?? `?${r.shortId}`);
const chat = (text: string) => buyerQueryForTurn({ intent: "buy" }, text);

describe("30 запросов аудита на тестовом каталоге", () => {
  it("№1 двушка в Исмоили Сомони — три настоящие двушки, не семикомнатные", async () => {
    const top = await run({ districtName: "Исмоили Сомони", type: "APARTMENT", rooms: 2 });
    expect(marks(top).sort()).toEqual(["is2a", "is2b", "is2c"]);
  });

  it("№2 двушка в Сино до 1 млн — двушки первыми, трёшки после", async () => {
    const top = await run({ districtName: "Сино", type: "APARTMENT", rooms: 2, budgetMax: 1_000_000 });
    expect(top.every((p) => p.rooms === 2)).toBe(true);
  });

  it("№3 первое сообщение чата «ищу двушку в Сино» — запрос собран из реплики", async () => {
    const q = await chat("Ассалому алейкум, ищу двушку в Сино");
    expect(q).toMatchObject({ districtName: "Сино", rooms: 2, type: "APARTMENT" });
    const top = await run(q);
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((p) => p.rooms === 2 && p.district?.name === "Сино")).toBe(true);
  });

  it("№4 трёшка в 82 мкр по телефону — район определяет код, не модель", async () => {
    const { query } = await voiceSearchQuery({ landmark: "82 мкр", type: "APARTMENT", rooms: 3 });
    expect(query.districtName).toBe("Сино");
    const top = await run(query);
    expect(marks(top).slice(0, 2).sort()).toEqual(["s3a", "s3b"]);
  });

  it("№5 «квартира в Зарафшоне» — падеж понят, район Сино", async () => {
    expect((await chat("квартира в Зарафшоне")).districtName).toBe("Сино");
  });

  it("№6 «Дар Зарафшон хонаи дуҳуҷра» — Сино, две комнаты", async () => {
    expect(await chat("Дар Зарафшон хонаи дуҳуҷра")).toMatchObject({ districtName: "Сино", rooms: 2 });
  });

  it("№7 квартира у ОВИРа — ближайшая к ОВИРу первой", async () => {
    const q = await chat("Квартира у ОВИРа есть?");
    expect(q.place?.name).toBeTruthy();
    const top = await run(q);
    expect(marks(top)[0]).toBe("is2a");
  });

  it("№8 в Бустон Сити — объект с Бустон Сити в адресе первым", async () => {
    const top = await run({ districtName: "Шохмансур", type: "APARTMENT", rooms: 3, placeText: "Бустон Сити" });
    expect(marks(top)[0]).toBe("shBuston");
  });

  it("№9 трёшка у моста (Фирдавси) — объект соседнего района рядом с мостом находится, с пометкой", async () => {
    const resolved = await resolveSearchPlace(`трёшка у Тестмоста ${runId}`);
    expect(resolved.place).not.toBeNull();
    const top = await run({ districtName: "Фирдавси", type: "APARTMENT", rooms: 3, place: resolved.place });
    expect(marks(top)[0]).toBe("shNear");
    expect(top[0].match.outsideDistrict).toBe(true);
  });

  it("№9б блок «места по карте» чат-бота понимает падеж («у Тестмоста»)", async () => {
    expect(await geoMentionBlock(`квартира у Тестмоста ${runId}`, false)).toContain(`Тестмост ${runId}`);
  });

  it("№10 «возле Профсоюза» — район по народному названию", async () => {
    expect((await chat("квартира возле Профсоюза")).districtName).toBe("Сино");
  });

  it("№11 «у рынка Меҳргон» по телефону — район найден кодом", async () => {
    const { query } = await voiceSearchQuery({ landmark: "у рынка Меҳргон", type: "APARTMENT" });
    expect(query.districtName).toBeTruthy();
  });

  it("№12 центр, двушка до 1,2 млн — только двушки", async () => {
    const top = await run({ type: "APARTMENT", rooms: 2, budgetMax: 1_200_000 });
    expect(top.every((p) => p.rooms === 2)).toBe(true);
  });

  it("№13 дом в Шохмансуре до 6 млн — без домов за городом", async () => {
    const top = await run({ districtName: "Шохмансур", type: "HOUSE", budgetMax: 6_000_000 });
    expect(marks(top)).toEqual(["shHouseCity"]);
  });

  it("№14 дом в Вахдате — только загородные", async () => {
    const q = await chat("Дом в Вахдате продаёте?");
    expect(q.suburban).toBe(true);
    const top = await run(q, 10);
    expect(marks(top)).toContain("shHouseVahdat");
    expect(top.every((p) => p.match.suburban)).toBe(true);
  });

  it("№15 дача в Варзобе — загородные, а не квартиры города", async () => {
    const top = await run(await chat("Дача в Варзобе нужна"), 10);
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((p) => p.match.suburban)).toBe(true);
  });

  it("№16 трёшка до 1 млн в Шохмансуре — +3 % в допуске, с пометкой", async () => {
    const top = await run({ districtName: "Шохмансур", type: "APARTMENT", rooms: 3, budgetMax: 1_000_000 });
    expect(marks(top)).toContain("sh3");
    expect(top.find((p) => p.shortId === ids.sh3)?.match.overBudget).toBe(true);
  });

  it("№17 до 60 тысяч долларов, двушка, Сино", async () => {
    const top = await run({ districtName: "Сино", type: "APARTMENT", rooms: 2, budgetMax: Math.round(60_000 * usd) });
    expect(marks(top)).toContain("s2usd");
  });

  it("№18 до 70 тысяч долларов, Сино", async () => {
    const top = await run({ districtName: "Сино", budgetMax: Math.round(70_000 * usd) }, 10);
    expect(marks(top)).toContain("s2usd");
  });

  it("№19 до 60 тысяч долларов, Фирдавси, двушка — честный ноль", async () => {
    expect(await run({ districtName: "Фирдавси", type: "APARTMENT", rooms: 2, budgetMax: Math.round(60_000 * usd) })).toHaveLength(0);
  });

  it("№20 новостройка с ремонтом в Сино до 1 млн — «требует ремонта» не первым", async () => {
    const top = await run({ districtName: "Сино", type: "APARTMENT", budgetMax: 1_000_000, renovation: "with", market: "NEW_BUILD" });
    expect(marks(top)[0]).toBe("s2b");
    expect(marks(top).indexOf("s2a")).not.toBe(0);
  });

  it("№21 с мебелью в Шохмансуре до 1 млн — с мебелью раньше «без мебели»", async () => {
    const top = await run({ districtName: "Шохмансур", type: "APARTMENT", rooms: 2, budgetMax: 1_000_000, furniture: true });
    expect(marks(top)[0]).toBe("shFurnYes");
  });

  it("№22 «не первый этаж, от 80 м²» — фильтров нет, поиск не падает (пробел, P1-3)", async () => {
    expect((await run({ type: "APARTMENT" })).length).toBeGreaterThan(0);
  });

  it("№23 «срочно, самое дешёвое» — по цене", async () => {
    const q = await chat("Срочно, самое дешёвое, квартира");
    expect(q.sort).toBe("cheap");
    const top = await run(q, 10);
    const prices = top.map((p) => (p.currency === "USD" ? Number(p.price) * usd : Number(p.price)));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("№24 участок — находится (данные №118 «34 м²» — на исправление агенту)", async () => {
    expect(marks(await run({ type: "LAND", rooms: 6 }))).toEqual(["land"]);
  });

  it("№25 коммерческое — честный ноль", async () => {
    expect(await run({ type: "COMMERCIAL" })).toHaveLength(0);
  });

  it("№26 «возле школы» — места нет, района не придумываем", async () => {
    const q = await chat("что-нибудь возле школы");
    expect(q.districtName ?? null).toBeNull();
  });

  it("№27 видел №N в Инстаграме — узнаётся по номеру", async () => {
    const found = await identifyProperty({ text: String(ids.s2b) });
    expect(found.via).toBe("hint");
  });

  it("№28 трёшка 101 м² на Адхамова за 1 850 000 — узнаётся", async () => {
    const found = await identifyProperty({ text: "Адхамова", rooms: 3, areaSqm: 101, priceTjs: 1_850_000 });
    const top = await prisma.property.findUnique({ where: { id: found.candidates[0]?.id ?? "" }, select: { shortId: true } });
    expect(top?.shortId).toBe(ids.shBuston);
  });

  it("№29 квартира у ОВИРа, 10 этаж — узнаётся", async () => {
    const found = await identifyProperty({ place: "у ОВИРа", floor: 10, rooms: 2 });
    const top = await prisma.property.findUnique({ where: { id: found.candidates[0]?.id ?? "" }, select: { shortId: true } });
    expect(top?.shortId).toBe(ids.is2a);
  });

  it("№30 объект не на сайте и без публикации — ботам не предлагается (правило одно, решение владельца 10.10)", async () => {
    // Объект с публикацией не на сайте — bots-offer-rule.test.ts.
    expect(BOTS_OFFER_MODE).toBe("site_or_publication");
    const card = { status: "AVAILABLE", deletedAt: null, offSite: false, publishedOnSite: false, instagramUrl: null, publishedChannels: [] };
    expect(botMayOffer(card)).toBe(false);
    const top = await run({ districtName: "Сино", type: "APARTMENT", rooms: 2 }, 10);
    expect(marks(top)).not.toContain("s2hidden");
  });
});

describe("разбор слов клиента и признаки", () => {
  it("комнаты и тип словами", () => {
    expect(roomsFromText("ищу двушку")).toBe(2);
    expect(roomsFromText("хонаи дуҳуҷра")).toBe(2);
    expect(roomsFromText("3-комн. квартира")).toBe(3);
    expect(roomsFromText("2 хонага")).toBe(2);
    expect(roomsFromText("в 2 км от центра")).toBeNull();
    expect(typeFromText("ищу дом")).toBe("HOUSE");
    expect(typeFromText("возле Дом печати")).toBeNull();
    expect(typeFromText("квартира")).toBe("APARTMENT");
    expect(wantsCheapest("что подешевле есть?")).toBe(true);
  });

  it("за городом — по словам карточки, без ложных «Кохи Вахдат» и «1,2 км от»", () => {
    expect(isSuburbanProperty({ description: "дом в городе Вахдат" })).toBe(true);
    expect(isSuburbanProperty({ title: "Дом, 9 км, шиферный завод" })).toBe(true);
    expect(isSuburbanProperty({ description: "Чорбог, Варзобский район" })).toBe(true);
    expect(isSuburbanProperty({ title: "дачный посёлок" })).toBe(true);
    expect(isSuburbanProperty({ landmark: "рядом Больница, 1,2 км от Академия наук" })).toBe(false);
    expect(isSuburbanProperty({ address: "Кохи Вахдат" })).toBe(false);
    expect(isSuburbanProperty({ address: "проспект Рудаки 45" })).toBe(false);
    expect(textMentionsSuburb("Варзоб ГЭС")).toBe(false);
  });

  it("допуск бюджета — одна формула для ботов и подбора агентам", () => {
    expect(budgetWindowTjs(500_000, 1_000_000, DEFAULT_MATCH_POLICY)).toEqual({ min: 450_000, max: 1_100_000 });
    expect(budgetWindowTjs(null, null, DEFAULT_MATCH_POLICY)).toEqual({ min: null, max: null });
  });
});

describe("карта города у робота (P0-3)", () => {
  it("название, которое карта знает в том же районе, голосу всё равно печатается", () => {
    const korvon = FOLK_PLACES.find((p) => p.name === "Корвон")!;
    const rows = [{ place: korvon, onMap: true, mapDistrict: korvon.district }];
    // Текстовому боту строка не нужна — у него блок «места по карте»; голосу этого блока нет.
    expect(folkPlacesForPrompt(rows, false)).toEqual([]);
    expect(folkPlacesForPrompt(rows, true)).toEqual([korvon]);
  });

  it("голосу народный список печатается целиком, и он не раздут", async () => {
    resetFolkCoverageCache();
    const voice = await folkGeographyBlock({ voice: true });
    for (const name of ["82 мкр", "46 мкр", "Корвон", "Зарафшон", "Испечак", "Мехргон", "Аэропорт"]) {
      expect(voice).toContain(name);
    }
    expect(voice).toContain("landmark");
    // Замер 10.10.2026: 2 127 знаков при справочнике голоса ~19,4 тыс. (+~600 к урезанному
    // списку на проде). Потолок с запасом — чтобы список не разрастался молча.
    expect(voice.length).toBeLessThan(2_600);
  });
});
