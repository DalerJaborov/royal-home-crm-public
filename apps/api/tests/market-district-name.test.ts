import { describe, expect, it } from "vitest";
import { canonicalDistrict, detectDistrictInText, normalizeDistrictName } from "../src/lib/market/districtName.js";
import { districtOf } from "../src/lib/market/paydoParser.js";
import { detectDistrict } from "../src/lib/market/somonParser.js";

describe("normalizeDistrictName: четыре района справочника", () => {
  it.each([
    ["Исмоили Сомони", "Исмоили Сомони"],
    ["И. Сомони", "Исмоили Сомони"],
    ["И.Сомони", "Исмоили Сомони"],
    ["и сомони", "Исмоили Сомони"],
    ["Сомони", "Исмоили Сомони"],
    ["исмоили сомони", "Исмоили Сомони"],
    ["ИСМОИЛИ СОМОНИ", "Исмоили Сомони"],
    ["Исмоили Сомонӣ", "Исмоили Сомони"],
    ["район Исмоили Сомони", "Исмоили Сомони"],
    ["Исмоили Сомони район", "Исмоили Сомони"],
    ["ноҳия Сомонӣ", "Исмоили Сомони"],
    ["Шохмансур", "Шохмансур"],
    ["шохмансур", "Шохмансур"],
    ["Шомансур", "Шохмансур"],
    ["Шоҳмансур", "Шохмансур"],
    ["р-н Шохмансур", "Шохмансур"],
    ["  Шохмансур  ", "Шохмансур"],
    ["Сино", "Сино"],
    ["сино", "Сино"],
    ["Район Сино", "Сино"],
    ["р-н. Сино", "Сино"],
    ["Фирдавси", "Фирдавси"],
    ["ФИРДАВСИ", "Фирдавси"],
    ["Нохия Фирдавси", "Фирдавси"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeDistrictName(raw)).toBe(expected);
    expect(canonicalDistrict(raw)).toBe(expected);
  });

  it("незнакомое название не выбрасываем и не угадываем: как написано, без «район»", () => {
    expect(normalizeDistrictName("Рудаки")).toBe("Рудаки");
    expect(normalizeDistrictName("район Рудаки")).toBe("Рудаки");
    expect(canonicalDistrict("Рудаки")).toBeNull();
  });

  it("пусто и мусор — null", () => {
    expect(normalizeDistrictName(null)).toBeNull();
    expect(normalizeDistrictName("   ")).toBeNull();
    expect(normalizeDistrictName("район")).toBeNull();
    expect(canonicalDistrict("")).toBeNull();
  });
});

describe("Paydo и Somon сводят район одной дверью", () => {
  it("Paydo: район после черты приводится к справочнику", () => {
    expect(districtOf("Душанбе | И. Сомони")).toBe("Исмоили Сомони");
    expect(districtOf("Душанбе | шохмансур")).toBe("Шохмансур");
    expect(districtOf("Душанбе | район Сино")).toBe("Сино");
    expect(districtOf("Душанбе | Фирдавси")).toBe("Фирдавси");
    expect(districtOf("Душанбе")).toBeNull();
    expect(districtOf(null)).toBeNull();
  });

  it("Somon: поиск в тексте не изменился — те же псевдонимы, голое «Сомони» районом не считается", () => {
    const ad = (title: string, alt = "") => ({ id: 1, title, seo: { images: { alt_texts: [alt] } } }) as never;
    expect(detectDistrict(ad("", "2-комн. квартира, 11 этаж, 66 м², Шохмансур, Душанбе"))).toBe("Шохмансур");
    expect(detectDistrict(ad("3-комн. квартира, И. Сомони"))).toBe("Исмоили Сомони");
    expect(detectDistrict(ad("3-комн. квартира, И.Сомони"))).toBe("Исмоили Сомони");
    expect(detectDistrict(ad("квартира, Исмоили Сомонӣ"))).toBe("Исмоили Сомони");
    expect(detectDistrict(ad("квартира у проспекта Сомони"))).toBeNull();
    expect(detectDistrictInText("Шомансур")).toBe("Шохмансур");
    expect(detectDistrictInText("Фирдавси, Душанбе")).toBe("Фирдавси");
    expect(detectDistrictInText("")).toBeNull();
  });
});
