import { describe, expect, it } from "vitest";
import {
  addressAgreement,
  registryBriefLine,
  registryBriefWarning,
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
  it("в 200 м даже с улицей и номером — только предложение", () => {
    const m = scoreRegistryMatch({ property: { ...base, lat: 38.5574, address: "Р. Набиев 12" }, project });
    expect(m.distanceM).toBeGreaterThan(150);
    expect(m.level).toBe("suggest");
  });
  it("в 120 м совпали улица И номер дома — связываем само (адрес сильнее точки геокодера)", () => {
    const m = scoreRegistryMatch({ property: { ...base, lat: 38.55668, address: "Р. Набиев 12" }, project });
    expect(m.distanceM).toBeGreaterThan(80);
    expect(m.distanceM).toBeLessThanOrEqual(150);
    expect(m.level).toBe("auto");
  });
  it("в 120 м одна улица без номера, даже у новостройки — только предложение", () => {
    const m = scoreRegistryMatch({ property: { ...base, lat: 38.55668, address: "улица Набиев", isNewBuilding: true }, project });
    expect(m.level).toBe("suggest");
  });
});

/**
 * ТАДЖИКСКАЯ И РУССКАЯ ЗАПИСЬ АДРЕСА (25.11.2026). Живой замер на проде: из 47 новостроек само связались 3, потому что
 * «кӯчаи М. Турсунзода №7 ва №9» и «улица Мирзо Турсунзаде, 9» не склеивались. Кейсы ниже придуманы по образцу, не выгрузка.
 */
describe("адрес: таджикская и русская запись", () => {
  it("транслитерация и указатель улицы: Турсунзаде = Турсунзода, номер из перечня", () => {
    const a = addressAgreement("улица Мирзо Турсунзаде, 15", "кӯчаи М. Турсунзода №13 ва №15");
    expect(a).toMatchObject({ street: true, streetFuzzy: true, house: true, houseConflict: false });
  });
  it("буквы ӣ/ӯ/ҳ/қ/ғ и хиёбони = проспект: Рӯдакӣ = Рудаки, Ҳисор = Хисор", () => {
    expect(addressAgreement("проспект Рудаки, 120", "хиёбони Рӯдакӣ, 120")).toMatchObject({ street: true, streetFuzzy: false, house: true });
    expect(addressAgreement("ул. Хисор 7", "кӯчаи Ҳисор №7")).toMatchObject({ street: true, house: true });
    expect(addressAgreement("ул. Гафуров 3", "кӯчаи Б.Ғафуров №3")).toMatchObject({ street: true, house: true });
  });
  it("русское «дж» = таджикское «ҷ»", () => {
    expect(addressAgreement("улица Джалола Икроми, 7", "кӯчаи Ҷалол Икромӣ №7")).toMatchObject({ street: true, house: true });
  });
  it("перечень с диапазоном: дом внутри «10-14» засчитан, а «1-2020» диапазоном не считается", () => {
    expect(addressAgreement("Шевченко 12", "кӯчаи Шевченко №№4, 10-14 ва 21")).toMatchObject({ house: true });
    expect(addressAgreement("Шевченко 1500", "кӯчаи Шевченко №1-2020")).toMatchObject({ house: false });
  });
  it("номер другой улицы того же проекта не считается номером нашей улицы", () => {
    const a = addressAgreement("улица Айни, 31", "кӯчаи Шоҳин 31, 33 ва кӯчаи Айнӣ №50");
    expect(a).toMatchObject({ street: true, house: false, houseConflict: true });
  });
  it("номера квартир и комнат — не номера домов; район после «ноҳияи» — не улица", () => {
    expect(addressAgreement("Шевченко 41", "кӯчаи Шевченко №6 квартираҳои 41, 42")).toMatchObject({ house: false, houseConflict: true });
    expect(addressAgreement("улица Сино, 5", "кӯчаи Навоӣ №5, ноҳияи Сино")).toMatchObject({ street: false });
  });
  it("буква корпуса через дефис и кавычки: 20-А = 20 «а»", () => {
    expect(addressAgreement("Шевченко 20а", "кӯчаи Шевченко №20-А")).toMatchObject({ house: true });
    expect(addressAgreement("Шевченко 20-А", "кӯчаи Шевченко №20 «а»")).toMatchObject({ house: true });
  });
  it("рядом новостройка на улице «похожего написания» без номера — только предложение; с номером — само", () => {
    const project = { lat: 38.5556, lng: 68.7575, address: "кӯчаи Қазоқон №№90, 95", customer: "Застройщик" };
    const near = { lat: 38.5559, lng: 68.7575, title: "2-комн", description: null, isNewBuilding: true };
    expect(scoreRegistryMatch({ property: { ...near, address: "ориентир Казакон" }, project }).level).toBe("suggest");
    expect(scoreRegistryMatch({ property: { ...near, address: "улица Казакон, 95" }, project }).level).toBe("auto");
  });
  it("рядом новостройка на той же улице, но дом другой — только предложение (соседний дом)", () => {
    const project = { lat: 38.5556, lng: 68.7575, address: "Кӯчаи Айнӣ, № 58 ва 60", customer: "Застройщик" };
    const m = scoreRegistryMatch({
      property: { lat: 38.5559, lng: 68.7575, address: "улица Садриддина Айни, 56", title: "2-комн", description: null, isNewBuilding: true },
      project,
    });
    expect(m.level).toBe("suggest");
    expect(m.reasons.join(" ")).toContain("соседний дом");
  });
});

/** Ревью PR #434 (25.11.2026): каждая находка закреплена тестом. */
describe("адрес: находки ревью", () => {
  it("одиночная буква после номера не клеится к нему: город, корпус, союз, «д.»", () => {
    for (const address of ["Айни 56, г. Душанбе", "Айни 56 к 2", "Айни 56г. Душанбе"]) {
      expect(addressAgreement(address, "кӯчаи Айнӣ №56"), address).toMatchObject({ house: true, houseConflict: false });
    }
    expect(addressAgreement("Турсунзода 7 и 9", "кӯчаи М. Турсунзода №9")).toMatchObject({ house: true, houseConflict: false });
    expect(addressAgreement("Рудаки 12, д. 3", "хиёбони Рӯдакӣ, 12")).toMatchObject({ house: true, houseConflict: false });
  });
  it("корпус слитно, через дефис и в кавычках — часть номера", () => {
    expect(addressAgreement("Шевченко 20-А", "кӯчаи Шевченко №20а")).toMatchObject({ house: true });
    expect(addressAgreement("Шевченко 20А", "кӯчаи Шевченко №20 «а»")).toMatchObject({ house: true });
    expect(addressAgreement("Шевченко 20", "кӯчаи Шевченко №20-А")).toMatchObject({ house: false });
  });
  it("разные фамилии с одним костяком согласных: Хусейнзода/Хасанзода и Назарова/Нозиров не улица", () => {
    expect(addressAgreement("улица Хусейнзода, 5", "кӯчаи Хасанзода №5").street).toBe(false);
    expect(addressAgreement("улица Назарова, 5", "кӯчаи Нозиров №5").street).toBe(false);
  });
  it("Карамова/Каримов совпадают только «по написанию»: в 120 м даже с номером дома само не связываем", () => {
    const a = addressAgreement("улица Карамова, 5", "кӯчаи Каримов №5");
    expect(a).toMatchObject({ street: true, streetFuzzy: true, house: true });
    const project = { lat: 38.5556, lng: 68.7575, address: "кӯчаи Каримов №5", customer: "Застройщик" };
    const at120 = { lat: 38.55668, lng: 68.7575, address: "улица Карамова, 5", title: "2-комн", description: null, isNewBuilding: true };
    expect(scoreRegistryMatch({ property: at120, project }).level).toBe("suggest");
    expect(scoreRegistryMatch({ property: { ...at120, lat: 38.5559 }, project }).level).toBe("auto"); // 33 м
  });
  it("этаж, комнаты и площадь — не номер дома", () => {
    expect(addressAgreement("Айни 56, 9 этаж", "кӯчаи Айнӣ №9")).toMatchObject({ house: false });
    expect(addressAgreement("Айни, 3-комнатная", "кӯчаи Айнӣ №3")).toMatchObject({ house: false });
    expect(addressAgreement("Айни 56, 9 этаж", "кӯчаи Айнӣ №56")).toMatchObject({ house: true, houseConflict: false });
  });
  it("район без указателя улицы — не улица; после «кӯчаи/проспект» — улица", () => {
    expect(addressAgreement("Сино, Айни 12", "кӯчаи Сино №12").street).toBe(false);
    expect(addressAgreement("проспект Исмоили Сомони, 12", "хиёбони Исмоили Сомонӣ №12")).toMatchObject({ street: true, house: true });
  });
  it("граница 150/151 м: улица и дом в 150 м — само, в 151 м — только предложение", () => {
    const project = { lat: 38.5556, lng: 68.7575, address: "кӯчаи Р.Набиев №12", customer: "Застройщик" };
    const prop = (dLatM: number) => ({ lat: 38.5556 + dLatM / 111195, lng: 68.7575, address: "ул. Р. Набиев, 12", title: "кв", description: null, isNewBuilding: false });
    const m150 = scoreRegistryMatch({ property: prop(150), project });
    const m151 = scoreRegistryMatch({ property: prop(151.2), project });
    expect(m150.distanceM).toBe(150);
    expect(m150.level).toBe("auto");
    expect(m151.distanceM).toBe(151);
    expect(m151.level).toBe("suggest");
  });
});

describe("короткий статус реестра для списка и Шабнам", () => {
  it("зелёный — без предупреждения, с оценкой застройщика", () => {
    expect(registryBriefLine({ status: "green", letter: "B" })).toBe("Реестр строек: разрешение есть, оценка застройщика B.");
    expect(registryBriefWarning({ status: "green", letter: "B" })).toBeNull();
  });
  it("жёлтый и красный — прямое предупреждение сотруднику", () => {
    expect(registryBriefWarning({ status: "yellow", letter: null })).toContain("Документы ещё оформляются");
    expect(registryBriefWarning({ status: "red", letter: "D" })).toContain("предупредите клиента");
  });
  it("нет связи у новостройки — проверить вручную", () => {
    expect(registryBriefLine({ status: "none", letter: null })).toContain("проверьте вручную");
  });
});
