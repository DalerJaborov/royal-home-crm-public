import { describe, expect, it } from "vitest";
import {
  RATING_MIN_PROJECTS,
  decisionYearFromQaror,
  letterForScore,
  normalizeDeveloperName,
  rateDeveloper,
  registrySourceCaption,
  scoreRegistryMatch,
  type RegistryColor,
} from "@royal-home/shared";

/**
 * Правила реестра строек (packages/shared/src/constructionRegistry.ts): рейтинг застройщика, имя, год решения, совпадение
 * с нашим объектом. Одно место на сервер и экран; здесь зафиксированы пороги и формула.
 */
const NOW = new Date("2026-11-20T08:00:00Z");
const proj = (color: RegistryColor, year: number | null = 2026) => ({ color, decisionYear: year });

describe("имя застройщика", () => {
  it("«ҶДММ «…»» и то же имя без формы и с другим регистром — одно", () => {
    expect(normalizeDeveloperName("ҶДММ «Дурахшон иншоот»")).toBe(normalizeDeveloperName("дурахшон  Иншоот"));
    expect(normalizeDeveloperName("ҶДММ «Дурахшон иншоот»")).toBe("дурахшон иншоот");
  });
  it("таджикские буквы сворачиваются: Ҷамол = Чамол", () => {
    expect(normalizeDeveloperName("Ҷамол")).toBe(normalizeDeveloperName("Чамол"));
  });
  it("фамилия с инициалами не пустеет", () => {
    expect(normalizeDeveloperName("Мирзокаримов Р. А.")).toBe("мирзокаримов р а");
  });
});

describe("год решения", () => {
  it.each([["524-2024", 2024], ["1-2020-Б", 2020], ["без года", null]])("%s → %s", (q, y) => {
    expect(decisionYearFromQaror(q)).toBe(y);
  });
});

describe("рейтинг застройщика", () => {
  it("все зелёные — A, 100", () => {
    const r = rateDeveloper([proj("green"), proj("green"), proj("green")], NOW);
    expect(r.score).toBe(100);
    expect(r.letter).toBe("A");
    expect(r.red).toBe(0);
  });
  it("жёлтый весит половину, красный ноль", () => {
    const r = rateDeveloper([proj("green"), proj("yellow"), proj("red")], NOW);
    expect(r.score).toBe(50); // (1 + 0,5 + 0) / 3
    expect(r.letter).toBe("C");
  });
  it("затянутый красный (решению 2 года и больше) штрафуется на 5 баллов за штуку, не больше 20", () => {
    const fresh = rateDeveloper([proj("green"), proj("green"), proj("red", 2026)], NOW);
    const stale = rateDeveloper([proj("green"), proj("green"), proj("red", 2023)], NOW);
    expect(fresh.score! - stale.score!).toBe(5);
    expect(stale.staleRed).toBe(1);
    const many = rateDeveloper(Array.from({ length: 8 }, () => proj("red", 2020)), NOW);
    expect(many.score).toBe(0);
    expect(many.letter).toBe("D");
  });
  it("меньше трёх проектов: буква и балл не ставятся, факты остаются", () => {
    const r = rateDeveloper([proj("red"), proj("green")], NOW);
    expect(RATING_MIN_PROJECTS).toBe(3);
    expect(r.score).toBeNull();
    expect(r.letter).toBeNull();
    expect(r.total).toBe(2);
    expect(r.reasons.join(" ")).toContain("Мало данных");
  });
  it("нет проектов — не выдумывает оценку", () => {
    const r = rateDeveloper([], NOW);
    expect(r.letter).toBeNull();
    expect(r.total).toBe(0);
  });
  it("пороги букв", () => {
    expect([100, 85, 84, 65, 64, 40, 39, 0].map(letterForScore)).toEqual(["A", "A", "B", "B", "C", "C", "D", "D"]);
  });
  it("в причинах есть составляющие простыми словами", () => {
    const r = rateDeveloper([proj("green", 2021), proj("yellow"), proj("red", 2022)], NOW);
    const text = r.reasons.join("\n");
    expect(text).toContain("Проектов в реестре: 3");
    expect(text).toContain("зелёные");
    expect(text).toContain("красные");
    expect(text).toContain("2021");
  });
});

describe("подпись источника", () => {
  it("дата по Душанбе", () => {
    // 20.11 22:30 UTC = 21.11 03:30 по Душанбе
    expect(registrySourceCaption(new Date("2026-11-20T22:30:00Z"))).toContain("на 21.11.2026");
    expect(registrySourceCaption(null)).toContain("дата обновления неизвестна");
  });
});

describe("сопоставление с нашим объектом", () => {
  const project = { lat: 38.5556, lng: 68.7575, address: "кӯчаи Р.Набиев №12", customer: "Мирзокаримов Р. А." };
  const base = { lat: 38.5556, lng: 68.7575, address: null, title: "3-комн. квартира", description: null, isNewBuilding: false };
  it("без точки у объекта — не похоже (не домысливаем)", () => {
    const m = scoreRegistryMatch({ property: { ...base, lat: null, lng: null, isNewBuilding: true }, project });
    expect(m.level).toBe("none");
  });
  it("далеко (больше 250 м) — не похоже, даже у новостройки", () => {
    const m = scoreRegistryMatch({ property: { ...base, lat: 38.5656, isNewBuilding: true }, project });
    expect(m.level).toBe("none");
  });
  it("рядом, но старый дом без общих признаков — не связываем", () => {
    const m = scoreRegistryMatch({ property: base, project });
    expect(m.level).toBe("none");
  });
  it("в 30 м: совпали улица и номер дома — связываем само", () => {
    const m = scoreRegistryMatch({ property: { ...base, address: "ул. Р. Набиев, 12" }, project });
    expect(m.level).toBe("auto");
    expect(m.reasons.join(" ")).toContain("Улица");
    expect(m.reasons.join(" ")).toContain("дома");
  });
  it("новостройка рядом без адреса — только предложение агенту", () => {
    const m = scoreRegistryMatch({ property: { ...base, isNewBuilding: true }, project });
    expect(m.level).toBe("suggest");
  });
  it("застройщик назван в карточке и рядом — связываем само", () => {
    const m = scoreRegistryMatch({ property: { ...base, title: "Новостройка от Мирзокаримов Р. А." }, project });
    expect(m.level).toBe("auto");
  });
  it("в 150 м даже с улицей и номером — только предложение", () => {
    const m = scoreRegistryMatch({ property: { ...base, lat: 38.55695, address: "Р. Набиев 12" }, project });
    expect(m.distanceM).toBeGreaterThan(80);
    expect(m.level).toBe("suggest");
  });
});
