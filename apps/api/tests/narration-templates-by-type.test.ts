import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
// Чистые правила выбора и текста: до базы не доходим.
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
import {
  chooseNarration, narrationConfigSchema, narrationDraftText, narrationEndingSchema, narrationFitsType, narrationTemplateError, narrationTemplateSchema,
  narrationLandAreaWords, narrationVariants, renderNarrationTemplate, type NarrationConfig, type NarrationFacts, type NarrationRandom,
} from "@royal-home/shared";
import { narrationScriptError } from "../src/lib/propertyNarration.js";

/**
 * ШАБЛОНЫ ПО ТИПУ ОБЪЕКТА, КОНЦОВКИ, СЛУЧАЙНЫЙ ВЫБОР БЕЗ ПОВТОРА (16.11.2026, владелец: «через одно ядро»,
 * «в случайном порядке»). Вся логика выбора живёт в packages/shared (chooseNarration); текст по сохранённым
 * кодам собирается детерминированно (narrationDraftText). Библиотека владельца берётся из настоящей миграции.
 */
// Утверждённая библиотека владельца лежит данными (tests/fixtures/narrationLibrary.json); в настройки её вносит отдельная миграция (PR «после #216»).
const library = z.object({ templates: narrationTemplateSchema.array(), endings: narrationEndingSchema.array() }).parse(JSON.parse(readFileSync(new URL("./fixtures/narrationLibrary.json", import.meta.url), "utf8")));
const starters = narrationTemplateSchema.array().parse(JSON.parse(readFileSync(new URL("../prisma/migrations/20261111120000_narration_flow/migration.sql", import.meta.url), "utf8").split("$json$")[1]))
  .map((t) => ({ ...t, manualOnly: true as const }));
/** Настройки после миграции: прежние шесть («только вручную») + библиотека. */
const config: Pick<NarrationConfig, "templates" | "endings" | "defaultTemplateId"> = { templates: [...starters, ...library.templates], endings: library.endings, defaultTemplateId: "tg-short" };
const facts = (over: Partial<NarrationFacts> = {}): NarrationFacts => ({ type: "APARTMENT", rooms: 3, areaSqm: "86", floor: 5, totalFloors: 9, district: "Сино", price: "85000", currency: "USD", ...over });
/** Все значения «случайного» от 0 до почти 1: перебор вместо надежды на удачный бросок. */
const sweep: NarrationRandom[] = Array.from({ length: 50 }, (_, i) => () => i / 50);
const byId = <T extends { id: string }>(items: readonly T[] | undefined, id: string | null) => items?.find((i) => i.id === id);

describe("выбор шаблона и концовки по типу объекта", () => {
  it("квартире, дому, коммерции и участку достаются только свои шаблоны и свои концовки", () => {
    for (const [type, prefix] of [["APARTMENT", "tg-apt-"], ["HOUSE", "tg-house-"], ["COMMERCIAL", "tg-shop-"], ["LAND", "tg-land-"]] as const) {
      for (const random of sweep) {
        const picked = chooseNarration(config, type, { random });
        expect(picked.templateId, type).toMatch(new RegExp(`^${prefix}[1-5]$`));
        const ending = byId(config.endings, picked.endingId);
        expect(ending, `${type}: концовка`).toBeTruthy();
        expect(narrationFitsType(ending!, type)).toBe(true);
      }
    }
    // Концовка Д (end-e) — для коммерции и участка, А–Г — для квартиры и дома.
    const endingsFor = (type: string) => new Set(sweep.map((random) => chooseNarration(config, type, { random }).endingId));
    expect([...endingsFor("APARTMENT")].sort()).toEqual(["end-a", "end-b", "end-c", "end-d"]);
    expect([...endingsFor("HOUSE")].sort()).toEqual(["end-a", "end-b", "end-c", "end-d"]);
    expect([...endingsFor("LAND")].sort()).toEqual(["end-e", "end-land-1", "end-land-2"]);
    expect([...endingsFor("COMMERCIAL")].sort()).toEqual(["end-e", "end-shop-1", "end-shop-2"]);
  });

  it("случайность настоящая: за перебор выпадают все пять шаблонов типа", () => {
    expect(new Set(sweep.map((random) => chooseNarration(config, "APARTMENT", { random }).templateId)).size).toBe(5);
  });

  it("не повторяет прошлый шаблон и прошлую концовку, если есть из чего выбрать", () => {
    for (const random of sweep) {
      const next = chooseNarration(config, "APARTMENT", { random, previous: { templateId: "tg-apt-3", endingId: "end-b" }, reroll: true });
      expect(next.templateId).not.toBe("tg-apt-3");
      expect(next.endingId).not.toBe("end-b");
      // Новый объект того же сотрудника (прошлой версии нет, есть только его прошлый выбор) — то же правило.
      const fresh = chooseNarration(config, "LAND", { random, previous: { templateId: "tg-land-2", endingId: "end-land-1" }, reroll: true });
      expect(fresh.templateId).not.toBe("tg-land-2");
      expect(fresh.endingId).not.toBe("end-land-1");
    }
    // Новый объект сотрудника: его прошлый выбор только исключается (не «остаётся», как прошлая версия того же объекта).
    for (const random of sweep) {
      const fresh = chooseNarration(config, "APARTMENT", { random, avoid: { templateId: "tg-apt-3", endingId: "end-b" } });
      expect(fresh.templateId).not.toBe("tg-apt-3");
      expect(fresh.endingId).not.toBe("end-b");
    }
    // Прошлый шаблон другого типа не мешает: у дома он всё равно не подходит, повторять нечего.
    expect(chooseNarration(config, "HOUSE", { random: () => 0, previous: { templateId: "tg-apt-1", endingId: null } }).templateId).toBe("tg-house-1");
  });

  it("если подходящий один, он и берётся (повтор лучше, чем пустой текст)", () => {
    const one = { templates: [{ id: "only", name: "Один", lang: "tg" as const, text: "{вид} барои фурӯш." }], endings: [{ id: "end", lang: "tg" as const, text: "Ба мо дар Директ нависед." }] };
    expect(chooseNarration(one, "APARTMENT", { previous: { templateId: "only", endingId: "end" }, reroll: true })).toEqual({ templateId: "only", endingId: "end" });
  });

  it("выбор человека уважается: даже шаблон другого типа и «только вручную»; выбранная концовка тоже", () => {
    expect(chooseNarration(config, "APARTMENT", { templateId: "tg-land-1", random: () => 0.9 }).templateId).toBe("tg-land-1");
    expect(chooseNarration(config, "APARTMENT", { templateId: "tg-family", endingId: "end-c", random: () => 0.1 })).toEqual({ templateId: "tg-family", endingId: "end-c" });
    // Человек выбрал шаблон, прошлая концовка подходит — она остаётся, а не меняется на случайную.
    expect(chooseNarration(config, "APARTMENT", { templateId: "tg-apt-4", previous: { templateId: "tg-apt-1", endingId: "end-d" }, random: () => 0.7 })).toEqual({ templateId: "tg-apt-4", endingId: "end-d" });
    // Кнопка «Другой шаблон» выбор человека не отменяет только без reroll; с reroll всё новое.
    const again = chooseNarration(config, "APARTMENT", { previous: { templateId: "tg-apt-4", endingId: "end-d" }, reroll: true, random: () => 0 });
    expect(again.templateId).not.toBe("tg-apt-4");
  });

  it("правка данных не меняет выбор: тот же шаблон и та же концовка, пока тип подходит; сменился тип объекта — новый шаблон", () => {
    for (const random of sweep) {
      expect(chooseNarration(config, "APARTMENT", { random, previous: { templateId: "tg-apt-2", endingId: "end-c" } })).toEqual({ templateId: "tg-apt-2", endingId: "end-c" });
    }
    const typeChanged = chooseNarration(config, "HOUSE", { random: () => 0.5, previous: { templateId: "tg-apt-2", endingId: "end-c" } });
    expect(typeChanged.templateId).toMatch(/^tg-house-/);
    expect(typeChanged.endingId).not.toBe("end-c");
  });

  it("шаблон «только вручную» сам не выбирается и концовку сам не получает", () => {
    for (const random of sweep) for (const type of ["APARTMENT", "HOUSE", "LAND", "COMMERCIAL"]) {
      expect(byId(config.templates, chooseNarration(config, type, { random }).templateId)?.manualOnly).toBeUndefined();
    }
    // Объект со старой версией на «tg-short» остаётся на нём, без концовки: свой призыв у шаблона уже есть.
    expect(chooseNarration(config, "APARTMENT", { previous: { templateId: "tg-short", endingId: null }, random: () => 0.3 })).toEqual({ templateId: "tg-short", endingId: null });
  });

  it("язык: умолчание владельца задаёт язык автовыбора; кнопка языка переключает", () => {
    const ru = { templates: [...config.templates!, { id: "ru-1", name: "Р", lang: "ru" as const, text: "В продаже {вид}. Цена {цена}." }], endings: [...config.endings!, { id: "end-ru", lang: "ru" as const, text: "Пишите нам в Директ." }], defaultTemplateId: "ru-short" };
    expect(chooseNarration(ru, "APARTMENT", { random: () => 0 })).toEqual({ templateId: "ru-1", endingId: "end-ru" });
    expect(chooseNarration(ru, "APARTMENT", { lang: "tg", reroll: true, random: () => 0 }).templateId).toMatch(/^tg-apt-/);
  });

  it("нет подходящих для случайного выбора — запасной шаблон по умолчанию; нет шаблонов — пусто", () => {
    const onlyApartments = { templates: library.templates.filter((t) => t.propertyTypes?.includes("APARTMENT")), endings: library.endings, defaultTemplateId: undefined };
    expect(chooseNarration(onlyApartments, "LAND", { random: () => 0 }).templateId).toBe("tg-apt-1");
    expect(chooseNarration({ templates: [], endings: [] }, "APARTMENT")).toEqual({ templateId: null, endingId: null });
  });

  it("старые шаблоны без поля типов подходят всем типам; список для ручного выбора фильтруется по языку и типу", () => {
    expect(narrationFitsType({}, "LAND")).toBe(true);
    expect(narrationFitsType({ propertyTypes: [] }, "LAND")).toBe(true);
    expect(narrationFitsType({ propertyTypes: ["HOUSE"] }, "LAND")).toBe(false);
    expect(narrationFitsType({ propertyTypes: ["HOUSE"] }, undefined)).toBe(true);
    expect(narrationVariants(config.templates!, "tg", "LAND").map((t) => t.id)).toEqual(["tg-short", "tg-family", "tg-offer", "tg-land-1", "tg-land-2", "tg-land-3", "tg-land-4", "tg-land-5"]);
    // Старый сохранённый шаблон (до 16.11.2026) читается схемой как есть.
    expect(narrationTemplateSchema.parse({ id: "old", name: "Старый", lang: "tg", text: "{вид} барои фурӯш." }).propertyTypes).toBeUndefined();
  });
});

describe("текст по сохранённым кодам: основная часть + концовка, без случайности", () => {
  it("одни и те же коды дают один и тот же текст сколько ни собирай; концовка стоит в конце", () => {
    const f = facts();
    const a = narrationDraftText(config, f, "tg-apt-1", "end-a");
    const body = narrationDraftText(config, f, "tg-apt-1", null).text;
    expect(narrationDraftText(config, f, "tg-apt-1", "end-a")).toEqual(a);
    expect(a.endingId).toBe("end-a");
    expect(a.text).toBe(`${body} ${byId(config.endings, "end-a")!.text}`);
    expect(a.text.endsWith("барои тамошо вақт интихоб кунед.")).toBe(true);
  });
  it("версии до 16.11.2026 (кода концовки нет) собираются как прежде; чужая или удалённая концовка текст не ломает", () => {
    const f = facts();
    const before = narrationDraftText({ templates: config.templates, defaultTemplateId: "tg-short" }, f, "tg-short").text;
    expect(narrationDraftText(config, f, "tg-short").text).toBe(before);
    expect(narrationDraftText(config, f, "tg-apt-2", "deleted-ending").text).toBe(narrationDraftText(config, f, "tg-apt-2").text);
    expect(narrationDraftText(config, f, "tg-apt-2", "end-ru-nope").endingId).toBeNull();
  });
  it("концовка получает те же слова из объекта, что и шаблон; смена цены меняет только цену", () => {
    const withTag = { ...config, endings: [{ id: "end-x", lang: "tg" as const, text: "Нархаш {цена}, Директ кушода аст." }] };
    expect(narrationDraftText(withTag, facts({ price: "50000" }), "tg-apt-3", "end-x").text).toContain("панҷоҳ ҳазор доллар, Директ кушода аст.");
  });
  it("К1 без этажа: фраза про этаж выпадает целиком, остальное на месте", () => {
    const k1 = config.templates!.find((t) => t.id === "tg-apt-1")!;
    for (const empty of [{ floor: null, totalFloors: null }, { floor: 5, totalFloors: null }, { floor: null, totalFloors: 9 }]) {
      const text = renderNarrationTemplate(k1, facts(empty));
      expect(text, JSON.stringify(empty)).not.toMatch(/ошёна/u);
      expect(text).toContain("Масоҳати умумӣ ҳаштоду шаш метри мураббаъ аст.");
      expect(text).toContain("Хона аз се ҳуҷра иборат аст.");
      expect(text).toMatch(/Нархи хона ҳаштоду панҷ ҳазор доллар\.$/u);
    }
    const full = renderNarrationTemplate(k1, facts());
    expect(full).toContain("Хона дар ошёнаи панҷуми бинои нӯҳ ошёна ҷойгир шудааст.");
  });
  it("дом без района, комнат и этажа: пустые фразы выпадают, предложения не рвутся", () => {
    const d1 = config.templates!.find((t) => t.id === "tg-house-1")!;
    const text = renderNarrationTemplate(d1, facts({ type: "HOUSE", district: null, rooms: null, floor: null, totalFloors: null }));
    expect(text).toBe("Мехоҳед соҳиби ҳавлии худ шавед? Пас, ба ин пешниҳод диққат кунед! Масоҳати умумӣ ҳаштоду шаш метри мураббаъ аст. Ин пешниҳодро барои зиндагии оилавӣ дида баромадан мумкин аст. Нархи ҳавлӣ ҳаштоду панҷ ҳазор доллар.");
  });
});

describe("ревью 17.11: язык, запасные шаблоны, «без концовки»", () => {
  const ruOnly = { templates: [
    { id: "ru-a", name: "А", lang: "ru" as const, text: "В продаже {вид}. Цена {цена}.", manualOnly: true },
    { id: "ru-b", name: "Б", lang: "ru" as const, text: "Продаётся {вид}. Цена {цена}.", manualOnly: true },
    { id: "tg-x", name: "Х", lang: "tg" as const, text: "{вид} барои фурӯш." },
  ], endings: [], defaultTemplateId: "tg-x" };
  it("русский язык не уходит в таджикский: при заданном языке берётся «вручную» этого языка, не равный прошлому", () => {
    for (const random of sweep) {
      expect(chooseNarration(ruOnly, "APARTMENT", { lang: "ru", reroll: true, random }).templateId).toMatch(/^ru-/u);
      const again = chooseNarration(ruOnly, "APARTMENT", { previous: { templateId: "ru-a" }, reroll: true, random });
      expect(again.templateId).toBe("ru-b");
    }
  });
  it("запасной шаблон учитывает язык и тип: шаблон другого типа берётся, только если подходящих языка нет", () => {
    const mixed = { templates: [
      { id: "ru-house", name: "Д", lang: "ru" as const, text: "Дом. {цена}.", manualOnly: true, propertyTypes: ["HOUSE" as const] },
      { id: "ru-any", name: "Л", lang: "ru" as const, text: "Объект. {цена}.", manualOnly: true },
    ], endings: [] };
    expect(chooseNarration(mixed, "APARTMENT", { lang: "ru", random: () => 0 }).templateId).toBe("ru-any");
    expect(chooseNarration({ templates: [mixed.templates[0]], endings: [] }, "APARTMENT", { lang: "ru" }).templateId).toBe("ru-house");
  });
  it("noEnding: концовка не подставляется ни у случайного, ни у выбранного шаблона", () => {
    for (const random of sweep) {
      expect(chooseNarration(config, "APARTMENT", { random, noEnding: true }).endingId).toBeNull();
      expect(chooseNarration(config, "APARTMENT", { templateId: "tg-apt-2", noEnding: true, random }).endingId).toBeNull();
    }
  });
  it("кнопки Шабнам: по коду шаблона, длинные коды (не влезут в callback_data) не показываются, номер не нужен", async () => {
    const { narrationTemplateChoices } = await import("../src/telegram/assistantNarration.js");
    const list = narrationTemplateChoices({ templates: [...config.templates!, { id: "x".repeat(30), name: "Длинный", lang: "tg", text: "{вид} барои фурӯш." }] }, "tg", "APARTMENT");
    expect(list.map((t) => t.id)).toContain("tg-apt-1");
    expect(list.every((t) => t.id.length <= 21)).toBe(true);
    expect(`nar:m:${"a".repeat(36)}:${list[0].id}`.length).toBeLessThanOrEqual(64);
  });
  it("структурные правила и новые правила разделены: старое проверяется только структурой", async () => {
    const { narrationTemplateStructureError, narrationTemplateRulesError } = await import("@royal-home/shared");
    expect(narrationTemplateStructureError("Хона аз 3 ҳуҷра Direct брон")).toBeNull();
    expect(narrationTemplateRulesError("Хона аз 3 ҳуҷра", "tg")).toMatch(/цифры/u);
    expect(narrationTemplateStructureError("{нет}")).toMatch(/Неизвестное/u);
  });
});

describe("сторож шаблона и концовки при сохранении", () => {
  const tgText = "Ин хона барои фурӯш аст. Нархаш {цена}.";
  it("пропускает нормальный таджикский текст со словами из объекта и «Директ»", () => {
    expect(narrationTemplateError(tgText, "tg")).toBeNull();
    expect(narrationTemplateError("Ба мо дар Директ нависед. [Ошёнаи {этаж_пор}.]", "tg")).toBeNull();
  });
  it("цифры запрещены: числа только словами (внутри фигурных скобок слово подставляет само, цифр у него нет)", () => {
    expect(narrationTemplateError("Хона аз 3 ҳуҷра иборат аст.", "tg")).toMatch(/цифры не пишем/u);
    expect(narrationTemplateError("Масоҳат 86 метр. {цена}", undefined)).toMatch(/цифры не пишем/u);
    expect(narrationTemplateError("Ошёнаи ٣ аст.", "tg")).toMatch(/цифры не пишем/u);
    expect(narrationTemplateError("Масоҳаташ {площадь} метр, ошёнаи {этаж_пор}.", "tg")).toBeNull();
    // Номер в фигурных скобках не слово из списка — ошибка про слово, а не молчаливый пропуск.
    expect(narrationTemplateError("{этаж1} ошёна", "tg")).toMatch(/Неизвестное слово/u);
    // В русском тексте озвучка читает цифры верно — владелец правило про числа вёл для таджикского.
    expect(narrationTemplateError("В продаже {вид}, 3 комнаты.", "ru")).toBeNull();
  });
  it("«Direct» латиницей запрещён в любом регистре, «Директ» кириллицей можно", () => {
    for (const bad of ["Ба мо дар Direct нависед.", "Ба мо дар direct нависед.", "Ба мо дар DIRECT нависед."]) expect(narrationTemplateError(bad, "tg"), bad).toMatch(/Директ/u);
    expect(narrationTemplateError("Ба мо дар Директ нависед.", "tg")).toBeNull();
  });
  it("слово «брон» запрещено (в любом регистре и с окончанием)", () => {
    for (const bad of ["Хонаро брон кунед.", "Хонаро Брон кунед.", "Хонаро бронь кунед.", "ЗАБРОНИРОВАТЬ хонаро."]) expect(narrationTemplateError(bad, "tg"), bad).toMatch(/брон/u);
    expect(narrationTemplateError("Хонаро барои тамошо интихоб кунед.", "tg")).toBeNull();
  });
  it("прежние правила на месте: неизвестное слово, скобки, длинное тире", () => {
    expect(narrationTemplateError("{стоимость} сомонӣ", "tg")).toMatch(/Неизвестное/u);
    expect(narrationTemplateError("[{район}", "tg")).toMatch(/Не закрыта/u);
    expect(narrationTemplateError("{район}]", "tg")).toMatch(/Лишняя/u);
    expect(narrationTemplateError("Хона — хуб", "tg")).toMatch(/тире/u);
  });
  it("схема настроек: типы только из четырёх, коды концовок не повторяются, старые настройки без концовок проходят", () => {
    const base = { modelId: "eleven_v4", voices: [], templates: library.templates, endings: library.endings };
    expect(narrationConfigSchema.safeParse(base).success).toBe(true);
    expect(narrationConfigSchema.safeParse({ modelId: "eleven_v4", voices: [], templates: starters }).success).toBe(true);
    expect(narrationConfigSchema.safeParse({ ...base, endings: [library.endings[0], library.endings[0]] }).success).toBe(false);
    expect(narrationTemplateSchema.safeParse({ ...library.templates[0], propertyTypes: ["GARAGE"] }).success).toBe(false);
  });
});

describe("библиотека владельца из данных: слово в слово, каждый текст проходит сторож", () => {
  it("20 шаблонов (по 5 на квартиру, дом, коммерцию и участок) и 9 концовок, коды не повторяются", () => {
    expect(library.templates).toHaveLength(20);
    expect(library.endings).toHaveLength(9);
    for (const type of ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"]) expect(library.templates.filter((t) => t.propertyTypes?.join() === type), type).toHaveLength(5);
    expect(new Set(library.templates.map((t) => t.id)).size).toBe(20);
    expect(new Set(library.endings.map((e) => e.id)).size).toBe(9);
    expect(library.templates.every((t) => t.lang === "tg") && library.endings.every((e) => e.lang === "tg")).toBe(true);
    // Начало и конец нескольких текстов совпадают с утверждёнными владельцем.
    expect(library.templates[0].text.startsWith("Дар ҷустуҷӯи хонаи бароҳат ҳастед? Пас, ба ин пешниҳод диққат кунед!")).toBe(true);
    expect(byId(library.endings, "end-a")!.text).toBe("Агар ин хона ба шумо писанд омад, фурсатро аз даст надиҳед! Худи ҳозир ба мо дар Директ нависед ё занг занед ва барои тамошо вақт интихоб кунед.");
    expect(byId(library.endings, "end-e")!.propertyTypes).toEqual(["COMMERCIAL", "LAND"]);
    expect(byId(library.endings, "end-b")!.propertyTypes).toEqual(["APARTMENT", "HOUSE"]);
  });
  it("все тексты проходят сторож шаблона; цена в каждом шаблоне; готовый текст без цифр и скобок", () => {
    for (const item of [...library.templates, ...library.endings]) {
      expect(narrationTemplateError(item.text, item.lang), item.id).toBeNull();
      expect(narrationScriptError(renderNarrationTemplate(item, facts())), item.id).toBeNull();
    }
    for (const template of library.templates) {
      expect(template.text, template.id).toContain("{цена}");
      for (const f of [facts(), facts({ type: "HOUSE", rooms: null, floor: null, totalFloors: 2, district: null }), facts({ type: "LAND", rooms: null, floor: null, totalFloors: null, price: null })]) {
        const text = renderNarrationTemplate(template, f);
        expect(text, template.id).not.toMatch(/[\d{}[\]]/u);
        expect(text, template.id).not.toMatch(/\s{2,}|\s[.,!?]/u);
      }
    }
    for (const ending of library.endings) expect(renderNarrationTemplate(ending, facts()), ending.id).not.toMatch(/[\d{}[\]]/u);
  });
  it("подготовленная настройка целиком проходит схему настроек, как её сохранил бы экран", () => {
    expect(narrationConfigSchema.safeParse({ modelId: "eleven_v4", voices: [], defaultTemplateId: "tg-short", templates: config.templates, endings: config.endings }).success).toBe(true);
  });
});

/** 17.11.2026, владелец: участок в озвучке называем в сотках, а не в метрах («да» на «сотки»). */
describe("{сотки}: площадь участка в сотках", () => {
  const land = (areaSqm: string): NarrationFacts => ({ type: "LAND", rooms: null, areaSqm, floor: null, totalFloors: null, district: "Сино", price: "50000", currency: "USD" });
  it("целые сотки словами по-таджикски и цифрами по-русски, с правильным окончанием", () => {
    expect(narrationLandAreaWords("LAND", 600, "tg")).toBe("шаш сотиқ");
    expect(narrationLandAreaWords("LAND", 100, "ru")).toBe("1 сотка");
    expect(narrationLandAreaWords("LAND", 300, "ru")).toBe("3 сотки");
    expect(narrationLandAreaWords("LAND", 1200, "ru")).toBe("12 соток");
  });
  it("дробные сотки не округляются: говорим метры", () => {
    expect(narrationLandAreaWords("LAND", 650, "tg")).toBe("шашсаду панҷоҳ метри мураббаъ");
    expect(narrationLandAreaWords("LAND", 650, "ru")).toBe("650 квадратных метров");
  });
  it("не участок или нет площади — пусто, и фраза в скобках выпадает", () => {
    expect(narrationLandAreaWords("HOUSE", 600, "tg")).toBe("");
    expect(narrationLandAreaWords("LAND", null, "tg")).toBe("");
    expect(renderNarrationTemplate({ text: "Замин. [Масоҳаташ {сотки} аст.]", lang: "tg" }, { ...land("600"), type: "APARTMENT" })).toBe("Замин.");
  });
  it("все пять шаблонов участка из библиотеки говорят сотки, а не метры", () => {
    for (const template of library.templates.filter((t) => t.id.startsWith("tg-land-"))) {
      expect(template.text, template.id).toContain("{сотки}");
      const text = renderNarrationTemplate(template, land("600"));
      expect(text, template.id).toContain("шаш сотиқ");
      expect(text, template.id).not.toContain("метри мураббаъ");
    }
  });
});
