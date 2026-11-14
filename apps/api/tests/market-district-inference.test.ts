import { beforeEach, describe, expect, it, vi } from "vitest";

const byPoint = vi.fn();
const byAddress = vi.fn();
vi.mock("../src/lib/propertyDistrict.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/propertyDistrict.js")>();
  return { ...actual, districtByPoint: (...a: unknown[]) => byPoint(...a), districtByAddress: (...a: unknown[]) => byAddress(...a) };
});

import {
  addressLinesOf,
  districtByLabel,
  districtByPlace,
  districtBySegment,
  resolveDistrict,
} from "../src/lib/market/districtInference.js";

beforeEach(() => {
  byPoint.mockReset().mockResolvedValue(null);
  byAddress.mockReset().mockResolvedValue(null);
});

describe("подписанный район в тексте (ступень 3)", () => {
  it.each([
    ["❇️ Район: Шохмансур \n❇️ Адрес: Кучаи Айни", "Шохмансур"],
    ["Ноҳия: И Сомони", "Исмоили Сомони"],
    ["✅Район: сино ✅Адрес: 112 мкр", "Сино"],
    ["Нохия Сино", "Сино"],
    ["ҷойгиршавӣ н.Шохмансур 9км пушти бозорча", "Шохмансур"],
    ["Район: Исмоили Сомони", "Исмоили Сомони"],
    ["Фирдавси район, рядом школа", "Фирдавси"],
    ["Душанбе, район Шохмансур", "Шохмансур"],
    ["Район Firdavsi", "Фирдавси"],
    ["Nohiya Shohmansur", "Шохмансур"],
    ["Sino rayon", null], // латинское слово «rayon» подписью не считаем — не гадаем
  ])("%s → %s", (text, want) => {
    expect(districtByLabel(text)).toBe(want);
  });

  it("«Проспект Сино» и «Ибни Сино» — улицы, не район", () => {
    expect(districtByLabel("Проспект Сино 10 Поликлиника")).toBeNull();
    expect(districtByLabel("Ибни Сино, 5")).toBeNull();
  });

  it("голое «Сомони» без подписи — не район (проспект Сомони)", () => {
    expect(districtByLabel("проспект Сомони 4")).toBeNull();
  });

  it("два разных района в тексте — спор, а не выбор", () => {
    expect(districtByLabel("Район: Сино, рядом с районом Шохмансур")).toBe("conflict");
  });

  it("соседние районы не путаются", () => {
    expect(districtByLabel("район Шохмансур")).toBe("Шохмансур");
    expect(districtByLabel("район Фирдавси")).toBe("Фирдавси");
    expect(districtByLabel("район Сино")).toBe("Сино");
  });
});

describe("район целым фрагментом (ступень 5)", () => {
  it("«Душанбе, Шохмансур»", () => expect(districtBySegment("Душанбе, Шохмансур")).toBe("Шохмансур"));
  it("«Сино» отдельным фрагментом", () => expect(districtBySegment("Сино, 112 мкр")).toBe("Сино"));
  it("«улица Ибни Сино» — не фрагмент-район", () => expect(districtBySegment("улица Ибни Сино, 5")).toBeNull());
});

describe("известные места (ступень 6)", () => {
  it.each([
    ["3-комн. • 4 этаж • 80.0 м² • Новостройка • Кароболо", "Сино"],
    ["2-комн. • 5 этаж • 90 м² • Вторичка • Саховат", "Фирдавси"],
    ["1-комн. • 6 этаж • 40 м² • Новостройка • Дом печать", "Исмоили Сомони"],
    ["2-комн. • 9 этаж • 107 м² • Новостройка • Садбарг", "Шохмансур"],
    ["Продаётся у аэропорта", "Шохмансур"],
    ["3-комн. 91 МКР", "Сино"],
    ["3-комн. • 3 этаж • 80.0 м² • Вторичка • Каленин", null], // места нет в словаре — не гадаем
  ])("%s → %s", (text, want) => {
    expect(districtByPlace(text)).toBe(want);
  });
});

describe("строки адреса в описании", () => {
  it("достаёт «Адрес:» и «Ҷойгиршавӣ:»", () => {
    expect(addressLinesOf("Район: Сино\n❇️ Адрес: 112 мир дом Пайкар\nЦена: 5")).toEqual(["112 мир дом Пайкар"]);
    expect(addressLinesOf("📍 Ҷойгиршавӣ: Спартак")).toEqual(["Спартак"]);
  });
});

describe("resolveDistrict: лестница", () => {
  it("район источника приоритетнее всего: ни координаты, ни текст не перебивают", async () => {
    byPoint.mockResolvedValue({ id: "1", name: "Фирдавси", source: "point" });
    const r = await resolveDistrict({ sourceDistrict: "И. Сомони", latitude: 38.5, longitude: 68.7, description: "Район: Сино" });
    expect(r).toEqual({ name: "Исмоили Сомони", via: "source" });
    expect(byPoint).not.toHaveBeenCalled();
  });

  it("координаты в полигоне приоритетнее текста", async () => {
    byPoint.mockResolvedValue({ id: "1", name: "Фирдавси", source: "point" });
    const r = await resolveDistrict({ latitude: 38.5, longitude: 68.7, description: "Район: Сино" });
    expect(r).toEqual({ name: "Фирдавси", via: "point" });
  });

  it("координат вне границ нет — идём по подписи в тексте", async () => {
    const r = await resolveDistrict({ latitude: 38.5, longitude: 68.7, description: "❇️ Район: Шохмансур" });
    expect(r).toEqual({ name: "Шохмансур", via: "label" });
  });

  it("подпись приоритетнее улицы", async () => {
    byAddress.mockResolvedValue({ id: "9", name: "Сино", source: "street" });
    const r = await resolveDistrict({ address: "улица Айни 4", description: "Район: Фирдавси" });
    expect(r.name).toBe("Фирдавси");
  });

  it("улица из справочника, когда подписи нет", async () => {
    byAddress.mockResolvedValue({ id: "9", name: "Сино", source: "street" });
    expect(await resolveDistrict({ address: "улица Крупской, 6Б" })).toEqual({ name: "Сино", via: "street" });
  });

  it("место из заголовка, когда больше ничего нет", async () => {
    const r = await resolveDistrict({ title: "2-комн. • 12 этаж • 127.0 м² • Новостройка • Кароболо" });
    expect(r).toEqual({ name: "Сино", via: "place" });
  });

  it("спор двух районов в подписях — null", async () => {
    expect(await resolveDistrict({ description: "Район: Сино", address: "район Шохмансур" })).toEqual({ name: null, via: null });
  });

  it("неопределённость — null, не угадываем", async () => {
    expect(await resolveDistrict({ title: "3-комн. • 3 этаж • 80.0 м² • Вторичка • Каленин", address: "Душанбе25" })).toEqual({
      name: null,
      via: null,
    });
    expect(await resolveDistrict({})).toEqual({ name: null, via: null });
  });
});
