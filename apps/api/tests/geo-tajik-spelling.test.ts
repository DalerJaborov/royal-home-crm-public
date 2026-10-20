import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { resolveBuildingByText, resolveGeoText } from "../src/lib/geoResolve.js";
import { suggestGeoAddress } from "../src/lib/geoSuggest.js";
import { districtByAddress } from "../src/lib/propertyDistrict.js";
import { plainStreetQuery } from "../src/lib/geoNormalize.js";
import { landmarkCategoryKey, landmarkCategorySpellings, readableLandmarkName } from "../src/lib/landmarkCategory.js";

/**
 * ОДНО МЕСТО В ТРЁХ НАПИСАНИЯХ (28.09.2026, владелец: «ищи такие похожие баги
 * классов, чтобы не было таких проблем вообще»).
 *
 * Адрес пишут «кучаи Дехоти 8», «хиёбони Рудаки 45», «Рӯдакӣ 45»; справочник
 * знает «улица Дехоти» и «кӯчаи деҳотӣ». Поиск по карте, геокодер адреса
 * объекта, подсказки и район по адресу промахивались мимо таких строк. А
 * категории ориентиров в справочнике записаны как в источнике («ВУЗ»,
 * «Торговый центр»), тогда как таблицы весов — «Вуз», «ТЦ».
 *
 * Улица и дом — выдуманные, с меткой прогона буквами: цифра в названии
 * читалась бы как номер дома.
 */

const runId = Date.now();
// Без «д»: «д»+«ж» (цифры 4 и 6 подряд) foldTajikLetters сворачивает в «ч», и метка переставала совпадать (08.10.2026).
const mark = String(runId).replace(/\d/g, (d) => "абвглежзик"[Number(d)]);
const RU = `Дехотитест${mark}`;
const TJ = `Деҳотӣтест${mark}`;
const STREET_NAME = `улица ${RU}`;
const HOUSE = { lat: 38.5334, lng: 68.7558 };
const sourcePrefix = `test-geo-tajik-${runId}`;
let districtId = "";
let streetId = "";

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-таджик-${runId}` } })).id;
  streetId = (
    await prisma.street.create({
      data: {
        sourceId: `${sourcePrefix}-street`,
        name: STREET_NAME,
        nameTj: `кӯчаи ${TJ}`,
        kind: "улица",
        districtId,
        lat: 38.533,
        lng: 68.755,
      },
    })
  ).id;
  // Словарь синонимов — как его собирает импорт (prisma/scripts/import-geo.ts).
  await prisma.geoAlias.createMany({
    data: [STREET_NAME, RU, `ул ${RU}`, `кӯчаи ${TJ}`, TJ].map((text) => ({
      text,
      normalized: text.toLowerCase(),
      targetType: "street",
      targetId: streetId,
      source: "agent",
    })),
  });
  await prisma.building.create({
    data: { sourceId: `${sourcePrefix}-house`, street: STREET_NAME, houseNumber: "8", districtId, lat: HOUSE.lat, lng: HOUSE.lng },
  });
});

afterAll(async () => {
  await prisma.building.deleteMany({ where: { sourceId: { startsWith: sourcePrefix } } });
  await prisma.geoAlias.deleteMany({ where: { targetId: streetId } });
  await prisma.street.deleteMany({ where: { id: streetId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("plainStreetQuery — запрос без таджикского написания", () => {
  it("снимает вид улицы впереди и сворачивает таджикские буквы", () => {
    expect(plainStreetQuery("кучаи дехоти 8")).toBe("дехоти 8");
    expect(plainStreetQuery("хиёбони рӯдакӣ 45")).toBe("рудаки 45");
    expect(plainStreetQuery("ул айни 5")).toBe("айни 5");
    expect(plainStreetQuery("улугбек 5")).toBe("улугбек 5");
  });
});

describe("Дом по адресу, написанному по-таджикски", () => {
  it("«кучаи … 8» — геокодер адреса объекта находит дом справочника", async () => {
    const found = await resolveBuildingByText(`кучаи ${RU} 8`);
    expect(found?.targetType).toBe("building");
    expect(found?.lat).toBeCloseTo(HOUSE.lat, 4);
  });

  it("«кучаи Деҳотӣ… 8» — поиск по карте ведёт на дом, а не на улицу", async () => {
    const found = await resolveGeoText(`кучаи ${TJ} 8`);
    expect(found?.targetType).toBe("building");
    expect(found?.confidence).toBe("exact");
  });

  it("подсказки поиска показывают дом", async () => {
    const items = await suggestGeoAddress(`кучаи ${RU} 8`);
    expect(items.some((i) => i.kind === "building" && i.label === `${STREET_NAME}, 8`)).toBe(true);
  });

  it("русское написание работает как раньше", async () => {
    const found = await resolveBuildingByText(`${STREET_NAME} 8`);
    expect(found?.targetType).toBe("building");
  });
});

describe("Район по адресу без координат", () => {
  it("«Шохмансур, кучаи … 8» — район улицы из справочника", async () => {
    const d = await districtByAddress(`Шохмансур, кучаи ${RU} 8`);
    expect(d?.id).toBe(districtId);
  });

  it("голое имя с номером дома — тоже", async () => {
    const d = await districtByAddress(`${RU} 8/2`);
    expect(d?.id).toBe(districtId);
  });

  it("голое имя без номера и без вида улицы — не улица", async () => {
    const d = await districtByAddress(`${RU}`);
    expect(d).toBeNull();
  });
});

describe("Категория и название ориентира", () => {
  const table = { Вуз: 5, ТЦ: 5, Хостел: 0 };

  it("«ВУЗ» и «Торговый центр» — ключи «Вуз» и «ТЦ»", () => {
    expect(landmarkCategoryKey("ВУЗ", table)).toBe("Вуз");
    expect(landmarkCategoryKey("Торговый центр", table)).toBe("ТЦ");
    expect(landmarkCategoryKey("Академическое учебное заведение", table)).toBe("Вуз");
  });

  it("ключ таблицы важнее синонима, неизвестное — как есть", () => {
    expect(landmarkCategoryKey("хостел", table)).toBe("Хостел");
    expect(landmarkCategoryKey("хостел", { Гостиница: 2 })).toBe("Гостиница");
    expect(landmarkCategoryKey("Кладбище", table)).toBe("Кладбище");
  });

  it("фильтр по «ТЦ» находит и «Торговый центр»", () => {
    expect(landmarkCategorySpellings("ТЦ").map((c) => c.toLowerCase())).toEqual(
      expect.arrayContaining(["тц", "торговый центр"])
    );
    expect(landmarkCategorySpellings("Торговый центр").map((c) => c.toLowerCase())).toContain("тц");
  });

  it("латинское имя — русский синоним или ничего", () => {
    expect(readableLandmarkName("Bozori Korvon", ["Корвон"])).toBe("Корвон");
    expect(readableLandmarkName("Vadanasos Park", [])).toBeNull();
    expect(readableLandmarkName("Аграрный университет", [])).toBe("Аграрный университет");
  });
});
