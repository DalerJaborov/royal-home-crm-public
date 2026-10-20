import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { geoMatchKey, normalizeGeoText, plainStreetQuery } from "../src/lib/geoNormalize.js";
import { toTokenVariants } from "../src/lib/searchTokens.js";
import { findDistrictIdByName } from "../src/lib/districtLookup.js";
import { legacyPropertyAddressKey, normalizePropertyAddress, propertyAddressKeys } from "../src/routes/properties/shared.js";
import { runTool } from "../src/ai/assistant.js";

/**
 * ОДИН РАЙОН, ОДНА УЛИЦА — В ЛЮБОМ НАПИСАНИИ (29.09.2026, хвосты разбора
 * docs/journal/2026-09-28-nomer-doma-i-orientiry.md).
 *
 * Латиница («Shohmansur», «Sino») и таджикские буквы («Шоҳмансур», «Деҳотӣ»)
 * не находились поиском, не совпадали в разговоре бота, заводили новый район
 * при импорте таблицы, молча снимали фильтр района у помощника и давали
 * разные ключи дубля для одного дома.
 *
 * Район — выдуманный, с меткой прогона буквами; латинская метка
 * транслитерируется ровно в кириллическую.
 */

const runId = Date.now();
const LATIN = ["a", "b", "v", "g", "d", "e", "zh", "z", "i", "k"];
const CYR = "абвгдежзик";
const markLatin = String(runId).replace(/\d/g, (d) => LATIN[Number(d)]);
const markCyr = String(runId).replace(/\d/g, (d) => CYR[Number(d)]);
const DISTRICT = `Шохтест${markCyr}`;
let districtId = "";

beforeAll(async () => {
  await prisma.district.deleteMany({ where: { name: DISTRICT } });
  districtId = (await prisma.district.create({ data: { name: DISTRICT }, select: { id: true } })).id;
});

afterAll(async () => {
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("сравнение мест (geoMatchKey)", () => {
  it("латиница и таджикские буквы — то же место", () => {
    expect(geoMatchKey("Shohmansur")).toBe(geoMatchKey("Шоҳмансур"));
    expect(geoMatchKey("Shohmansur")).toBe(geoMatchKey("Шохмансур"));
    expect(geoMatchKey("Sino")).toBe(geoMatchKey("Сино"));
    expect(geoMatchKey("Dodo")).toBe(geoMatchKey("Додо"));
  });

  it("разные места не склеиваются", () => {
    expect(geoMatchKey("Sino")).not.toBe(geoMatchKey("Сомони"));
  });
});

describe("«дж» и «ҷ», «хиёбони» (аудит 02.10.2026)", () => {
  it("Джавонон, Ҷавонон и Javonon — одно слово", () => {
    expect(geoMatchKey("Джавонон")).toBe(geoMatchKey("Ҷавонон"));
    expect(geoMatchKey("Javonon")).toBe(geoMatchKey("Ҷавонон"));
    expect(geoMatchKey("Dzhavonon")).toBe(geoMatchKey("Джавонон"));
  });

  it("«ё» не разводит написания: хиёбони = хиебони = khiyoboni", () => {
    expect(geoMatchKey("хиёбони Рудаки")).toBe(geoMatchKey("khiyoboni Rudaki"));
    expect(plainStreetQuery(normalizeGeoText("хиёбони Рудаки 45"))).toBe("рудаки 45");
  });

  it("ключ адреса объекта сводит «дж» и «ҷ»", () => {
    expect(normalizePropertyAddress("кучаи Ҷавонон 3")).toBe(normalizePropertyAddress("улица Джавонон 3"));
  });
});

describe("поиск (toTokenVariants)", () => {
  it("«Shohmansur» находит «Шохмансур», записанный без таджикских букв", () => {
    expect(toTokenVariants("Shohmansur")).toContain("шохмансур");
    expect(toTokenVariants("Shohmansur").length).toBeLessThanOrEqual(4);
  });
});

describe("район по имени (findDistrictIdByName)", () => {
  it("таджикское написание и латиница находят тот же район", async () => {
    expect(await findDistrictIdByName(`Шоҳтест${markCyr}`)).toBe(districtId);
    expect(await findDistrictIdByName(`Shohtest${markLatin}`)).toBe(districtId);
    expect(await findDistrictIdByName(DISTRICT.toUpperCase())).toBe(districtId);
  });

  it("незнакомое имя — не находит", async () => {
    expect(await findDistrictIdByName(`Нетакого${markCyr}`)).toBeUndefined();
  });

  it("помощник: неизвестный район — честный отказ, а не весь город", async () => {
    const actor = {
      id: "test-actor",
      role: "DIRECTOR",
      canViewAllClients: true,
      canViewPhone: true,
      canViewReports: true,
      canViewFinance: true,
      canViewAllDeals: true,
    };
    const res = (await runTool("search_properties", { districtName: `Нетакого${markCyr}` }, actor as never)) as { error?: string };
    expect(res.error).toContain("нет в справочнике");
    const ok = await runTool("search_properties", { districtName: `Шоҳтест${markCyr}` }, actor as never);
    expect(Array.isArray(ok)).toBe(true);
  });
});

describe("ключ адреса для дублей", () => {
  it("таджикский вид улицы, таджикские буквы и латиница — один ключ", () => {
    const key = normalizePropertyAddress("улица Дехоти 8");
    expect(normalizePropertyAddress("кучаи Деҳотӣ, 8")).toBe(key);
    expect(normalizePropertyAddress("кӯчаи Дехоти д. 8")).toBe(key);
    expect(normalizePropertyAddress("ul. Dehoti 8")).toBe(key);
    expect(normalizePropertyAddress("хиёбони Рӯдакӣ 45")).toBe(normalizePropertyAddress("пр. Рудаки 45"));
  });

  it("разные дома по-прежнему разные", () => {
    expect(normalizePropertyAddress("кучаи Дехоти 8")).not.toBe(normalizePropertyAddress("кучаи Дехоти 10"));
  });

  it("поиск дубля идёт и по прежнему ключу, пока сохранённые не пересчитаны", () => {
    const keys = propertyAddressKeys("кучаи Деҳотӣ 8");
    expect(keys).toContain(normalizePropertyAddress("кучаи Деҳотӣ 8"));
    expect(keys).toContain(legacyPropertyAddressKey("кучаи Деҳотӣ 8"));
  });
});
