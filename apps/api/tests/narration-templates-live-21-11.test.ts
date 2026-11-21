import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  estimateNarrationSec, narrationAreaWords, narrationConfigSchema, narrationDraftText, narrationFitsType, narrationObjectWords,
  narrationRoomsWords, narrationSotkaWords, narrationStoreysWords, narrationTemplateError, type NarrationFacts, type NarrationLang,
} from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { narrationFacts, narrationFactsCurrent, narrationHash } from "../src/lib/propertyNarration.js";

/**
 * ЖИВЫЕ ТЕКСТЫ ОЗВУЧКИ (21.11.2026, решение владельца по озвучке объекта 217). Прежние шаблоны были дословной
 * калькой с русского: «хона» размыто, «Фурӯхта мешавад дар ноҳияи Сино» не говорит, ЧТО продаётся, «Аз чор ҳуҷра
 * иборат аст» в живой рекламе не говорят; русские — анкета «Комнат: три». Тест держит три вещи:
 *  1. формы новых слов ({объект}, {сколько_комнат}, {этажность}, {метраж}, {сотки} дома) для 1–6 комнат и 2–25 этажей;
 *  2. правила библиотеки: что и где — в первом или втором предложении, без калек и анкеты, влезает в ролик;
 *  3. данные-миграцию: заменяет только известные старые тексты, правку владельца не трогает, повтор ничего не меняет.
 */
const migrationsDir = new URL("../prisma/migrations/", import.meta.url);
const moved = readdirSync(migrationsDir).find((d) => d.endsWith("_narration_templates_live"));
// До «да» владельца файл лежит вне prisma/migrations (влитое в main сразу уходит на сайт); после — в обычной миграции.
const sql = readFileSync(moved
  ? new URL(`../prisma/migrations/${moved}/migration.sql`, import.meta.url)
  : new URL("../prisma/pending-data/20261121_narration_templates_live.sql", import.meta.url), "utf8");
const lib = JSON.parse(sql.split("$json$")[1]!) as {
  templates: Array<{ id: string; name: string; lang: NarrationLang; text: string; propertyTypes?: string[]; manualOnly?: boolean }>;
  endings: Array<{ id: string; lang: NarrationLang; text: string; propertyTypes?: string[] }>;
  retire: string[]; knownOld: Record<string, string[]>;
};
/** Шаблоны и концовки на проде 21.11.2026 (только чтение; без голосов и ключей). */
const prod = JSON.parse(readFileSync(new URL("./fixtures/narrationTemplatesProd-21-11.json", import.meta.url), "utf8"));

/** Факты настоящих объектов прода (217, 193, 199) и участок для примера (участков на проде нет). */
const FACTS: Record<string, NarrationFacts> = {
  APARTMENT: { type: "APARTMENT", rooms: 4, areaSqm: "124.5", floor: 11, totalFloors: 16, district: "Сино", price: "235000", currency: "USD", usdToTjs: 9.27 },
  HOUSE: { type: "HOUSE", rooms: 8, areaSqm: "200", floor: null, totalFloors: 2, district: "Фирдавси", price: "2550000", currency: "TJS", landSotka: "5" },
  COMMERCIAL: { type: "COMMERCIAL", rooms: 9, areaSqm: "287", floor: 1, totalFloors: 12, district: "Сино", price: "2120000", currency: "TJS" },
  LAND: { type: "LAND", rooms: null, areaSqm: "600", floor: null, totalFloors: null, district: "Сино", price: "450000", currency: "TJS" },
};

describe("новые слова шаблона: формы", () => {
  it("{объект}: квартира называется форматом, 1–6 комнат на обоих языках", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => narrationObjectWords("APARTMENT", n, "tg"))).toEqual([
      "хонаи якҳуҷрагӣ", "хонаи дуҳуҷрагӣ", "хонаи сеҳуҷрагӣ", "хонаи чорҳуҷрагӣ", "хонаи панҷҳуҷрагӣ", "хонаи шашҳуҷрагӣ"]);
    expect([1, 2, 3, 4, 5, 6].map((n) => narrationObjectWords("APARTMENT", n, "ru"))).toEqual([
      "однокомнатная квартира", "двухкомнатная квартира", "трёхкомнатная квартира", "четырёхкомнатная квартира", "пятикомнатная квартира", "шестикомнатная квартира"]);
    expect(narrationObjectWords("APARTMENT", null, "tg")).toBe("квартира");
    expect(narrationObjectWords("APARTMENT", 12, "ru")).toBe("многокомнатная квартира");
    expect(["HOUSE", "LAND", "COMMERCIAL"].map((t) => narrationObjectWords(t, 5, "tg"))).toEqual(["ҳавлӣ", "қитъаи замин", "ҷои тиҷоратӣ"]);
    expect(["HOUSE", "LAND", "COMMERCIAL"].map((t) => narrationObjectWords(t, 5, "ru"))).toEqual(["частный дом", "земельный участок", "коммерческое помещение"]);
  });

  it("{сколько_комнат}: число со словом, по-русски с согласованием", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => narrationRoomsWords(n, "tg"))).toEqual(["як ҳуҷра", "ду ҳуҷра", "се ҳуҷра", "чор ҳуҷра", "панҷ ҳуҷра", "шаш ҳуҷра"]);
    expect([1, 2, 3, 4, 5, 6].map((n) => narrationRoomsWords(n, "ru"))).toEqual(["одна комната", "две комнаты", "три комнаты", "четыре комнаты", "пять комнат", "шесть комнат"]);
    expect(narrationRoomsWords(null, "tg")).toBe("");
  });

  it("{этажность}: слитно, 2–25 этажей; по-русски именительный и родительный", () => {
    const tg = Array.from({ length: 24 }, (_, i) => narrationStoreysWords(i + 2, "tg"));
    expect(tg).toEqual(["дуошёна", "сеошёна", "чорошёна", "панҷошёна", "шашошёна", "ҳафтошёна", "ҳаштошёна", "нӯҳошёна", "даҳошёна",
      "ёздаҳошёна", "дувоздаҳошёна", "сенздаҳошёна", "чордаҳошёна", "понздаҳошёна", "шонздаҳошёна", "ҳабдаҳошёна", "ҳаждаҳошёна", "нуздаҳошёна",
      "бистошёна", "бисту якошёна", "бисту дуошёна", "бисту сеошёна", "бисту чорошёна", "бисту панҷошёна"]);
    const ru = Array.from({ length: 24 }, (_, i) => narrationStoreysWords(i + 2, "ru"));
    expect(ru).toEqual(["двухэтажный", "трёхэтажный", "четырёхэтажный", "пятиэтажный", "шестиэтажный", "семиэтажный", "восьмиэтажный", "девятиэтажный",
      "десятиэтажный", "одиннадцатиэтажный", "двенадцатиэтажный", "тринадцатиэтажный", "четырнадцатиэтажный", "пятнадцатиэтажный",
      "шестнадцатиэтажный", "семнадцатиэтажный", "восемнадцатиэтажный", "девятнадцатиэтажный", "двадцатиэтажный", "двадцатиодноэтажный",
      "двадцатидвухэтажный", "двадцатитрёхэтажный", "двадцатичетырёхэтажный", "двадцатипятиэтажный"]);
    expect(narrationStoreysWords(16, "ru", true)).toBe("шестнадцатиэтажного");
    expect(narrationStoreysWords(16, "tg", true)).toBe("шонздаҳошёна");
    expect(narrationStoreysWords(1, "ru")).toBe("одноэтажный");
    expect(narrationStoreysWords(1, "tg")).toBe("якошёна");
    expect(narrationStoreysWords(null, "tg")).toBe("");
  });

  it("{метраж} по-русски согласуется с числом; {сотки}: целые, половина, иначе метры", () => {
    expect([121, 122, 125].map((n) => narrationAreaWords(n, "ru"))).toEqual([
      "сто двадцать один квадратный метр", "сто двадцать два квадратных метра", "сто двадцать пять квадратных метров"]);
    expect(narrationAreaWords(124.5, "tg")).toBe("саду бисту панҷ метри мураббаъ");
    expect(narrationSotkaWords(500, "tg")).toBe("панҷ сотиқ");
    expect(narrationSotkaWords(350, "tg")).toBe("се ва ним сотиқ");
    expect(narrationSotkaWords(150, "tg")).toBe("якуним сотиқ");
    expect(narrationSotkaWords(150, "ru")).toBe("полторы сотки");
    expect(narrationSotkaWords(250, "ru")).toBe("две с половиной сотки");
    expect(narrationSotkaWords(550, "ru")).toBe("пять с половиной соток");
    expect(narrationSotkaWords(270, "tg")).toBe("дусаду ҳафтод метри мураббаъ");
  });
});

describe("библиотека 21.11.2026: правила текста", () => {
  const config = narrationConfigSchema.parse({ modelId: "eleven_v4", voices: [], templates: lib.templates, endings: lib.endings });
  const objectWord = (f: NarrationFacts, lang: NarrationLang) => narrationObjectWords(f.type, f.rooms, lang).toLocaleLowerCase("ru");

  it("объект 217 звучит так, как владелец одобрил (без «васеъ»: у однокомнатной это было бы неправдой)", () => {
    expect(narrationDraftText(config, FACTS.APARTMENT!, "tg-apt-1", "end-a").text).toBe(
      "Барои оилаатон хона дар бинои бисёрошёна меҷӯед? Ин пешниҳодро аз даст надиҳед! Дар ноҳияи Сино хонаи чорҳуҷрагӣ фурӯхта мешавад. "
      + "Масоҳаташ саду бисту панҷ метри мураббаъ буда, дар ошёнаи ёздаҳуми бинои шонздаҳошёна ҷойгир аст. "
      + "Нархаш ду миллиону саду ҳафтоду ҳашт ҳазор сомонӣ. Танҳо аз рӯйи навор баҳо надиҳед, беҳтараш худатон омада бинед! "
      + "Барои тамошо худи ҳозир ба мо нависед ё занг занед.");
  });

  it("каждый текст проходит сторож Настроек; нет кальки и анкеты", () => {
    const CALQUES = /Фурӯхта мешавад дар|иборат(?:\s|$)|интихоб кардан мехоҳед|бинои\s+\{этажей\}\s+ошёна|Комнат:|Площадь:|Этаж\s+\{/iu;
    for (const item of [...lib.templates, ...lib.endings]) {
      expect(narrationTemplateError(item.text, item.lang), item.id).toBeNull();
      expect(item.text, item.id).not.toMatch(CALQUES);
      expect(item.text, item.id).not.toMatch(/Директ|брон|доллар/iu);
    }
  });

  it("что и где — в первом или втором предложении; любая концовка влезает в ролик (≤ 40 с по осторожной скорости)", () => {
    for (const t of lib.templates) {
      for (const [type, facts] of Object.entries(FACTS)) {
        if (!narrationFitsType(t, type)) continue;
        const ends = t.manualOnly ? [null] : lib.endings.filter((e) => e.lang === t.lang && narrationFitsType(e, type));
        if (!t.manualOnly) expect(ends.length, `${t.id}/${type}: нет концовки`).toBeGreaterThan(0);
        for (const e of ends) {
          const { text } = narrationDraftText(config, facts, t.id, e?.id ?? null);
          // tg-apt-1 — текст владельца 21.11 слово в слово: «что» уже в первом предложении («хона дар бинои бисёрошёна»),
          // а «Дар ноҳияи Сино хонаи чорҳуҷрагӣ» идёт третьим, после короткого «Ин пешниҳодро аз даст надиҳед!».
          const sentences = text.split(/(?<=[.!?])\s+/u);
          const head = sentences.slice(0, t.id === "tg-apt-1" ? 3 : 2).join(" ").toLocaleLowerCase("ru");
          expect(head, `${t.id}/${type}`).toContain(objectWord(facts, t.lang));
          expect(head, `${t.id}/${type}`).toContain(facts.district!.toLocaleLowerCase("ru"));
          expect(estimateNarrationSec(text, t.lang), `${t.id}+${e?.id}/${type}`).toBeLessThanOrEqual(40);
          expect(text, `${t.id}/${type}`).not.toMatch(/\{|\}|\[|\]|\s[.,]|\.\./u);
        }
      }
    }
  });

  it("на каждый тип и язык — от двух случайных вариантов; пустые данные не рвут фразу", () => {
    for (const lang of ["tg", "ru"] as const) {
      for (const type of Object.keys(FACTS)) {
        expect(lib.templates.filter((t) => t.lang === lang && !t.manualOnly && narrationFitsType(t, type)).length, `${lang}/${type}`).toBeGreaterThanOrEqual(2);
      }
    }
    const bare: NarrationFacts = { type: "APARTMENT", rooms: 2, areaSqm: "61", floor: null, totalFloors: null, district: null, price: null, currency: null };
    for (const t of lib.templates.filter((x) => narrationFitsType(x, "APARTMENT"))) {
      const { text } = narrationDraftText(config, bare, t.id, null);
      expect(text, t.id).not.toMatch(/\{|\}|\[|\]|\s[.,]|,\.|\.\.|ноҳияи\s*\.|районе\s*\./u);
      expect(text.toLocaleLowerCase("ru"), t.id).toContain(t.lang === "tg" ? "хонаи дуҳуҷрагӣ" : "двухкомнатная квартира");
    }
    // Дом без этажности и с дробным участком, цена в долларах без курса — предложение с ценой выпадает целиком.
    const house: NarrationFacts = { type: "HOUSE", rooms: 5, areaSqm: "183", floor: null, totalFloors: null, district: "Сино", price: "130000", currency: "USD", landSotka: "3.5" };
    for (const t of lib.templates.filter((x) => !x.manualOnly && narrationFitsType(x, "HOUSE"))) {
      const { text } = narrationDraftText(config, house, t.id, null);
      expect(text, t.id).not.toMatch(/Нарх|Цена|\{|\[|\s[.,]/u);
    }
  });
});

describe("участок дома в фактах озвучки", () => {
  const house = { type: "HOUSE", rooms: 8, areaSqm: "200", floor: null, totalFloors: 2, district: { name: "Фирдавси" }, price: "2550000", currency: "TJS", landAreaSotka: "5" };
  it("дом получает landSotka, квартира — нет (её хэш фактов прежний)", () => {
    expect(narrationFacts(house).landSotka).toBe("5");
    const apt = narrationFacts({ ...house, type: "APARTMENT", landAreaSotka: null });
    expect("landSotka" in apt).toBe(false);
    expect(narrationHash(apt)).toBe(narrationHash({ type: "APARTMENT", rooms: 8, areaSqm: "200", floor: null, totalFloors: 2, district: "Фирдавси", price: "2550000", currency: "TJS" }));
  });
  it("озвучка дома, сделанная до 21.11 (в снимке нет landSotka), не становится «устаревшей»; смена цены — становится", () => {
    const { landSotka: _drop, ...before } = narrationFacts(house);
    const version = { factsHash: narrationHash(before), factsSnapshot: before };
    expect(narrationFactsCurrent(version, house)).toBe(true);
    expect(narrationFactsCurrent(version, { ...house, price: "2600000" })).toBe(false);
    // Версия уже с участком: смена участка — новая озвучка.
    const fresh = narrationFacts(house);
    expect(narrationFactsCurrent({ factsHash: narrationHash(fresh), factsSnapshot: fresh }, { ...house, landAreaSotka: "6" })).toBe(false);
  });
});

describe("данные-миграция живых текстов", () => {
  let saved: unknown;
  const setConfig = async (config: unknown) => {
    const data = { propertyNarrationConfig: config as never };
    await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
  };
  const readConfig = async () => (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).propertyNarrationConfig as Record<string, any>;
  const migrate = () => prisma.$executeRawUnsafe(sql);
  beforeEach(async () => { saved ??= (await prisma.settings.findUnique({ where: { id: "singleton" } }))?.propertyNarrationConfig ?? null; });
  afterAll(async () => { await setConfig(saved ?? {}); });

  it("прод 21.11: тексты заменены по тем же кодам, лишние убраны, новые добавлены; голоса и пределы целы", async () => {
    const before = { modelId: "eleven_v4", voices: [{ id: "anna", name: "Анна" }], defaultVoiceId: "anna", autoGenerate: true, dailyCharLimit: 1234,
      pronunciationRules: [{ word: "Сино", alias: "Сино" }], templates: prod.templates, endings: prod.endings };
    await setConfig(before);
    await migrate();
    const after = await readConfig();
    for (const key of ["modelId", "voices", "defaultVoiceId", "autoGenerate", "dailyCharLimit", "pronunciationRules"]) expect(after[key], key).toEqual((before as any)[key]);
    const ids = after.templates.map((t: any) => t.id);
    for (const id of lib.retire) expect(ids, id).not.toContain(id);
    const byId = new Map<string, any>([...after.templates, ...after.endings].map((t: any) => [t.id, t]));
    for (const item of [...lib.templates, ...lib.endings]) expect(byId.get(item.id), item.id).toEqual(item);
    expect(after.templates).toHaveLength(lib.templates.length);
    expect(after.endings).toHaveLength(lib.endings.length);
    // Порядок прежних кодов сохранён, новые — в конце.
    expect(ids.slice(0, 6)).toEqual(["tg-short", "tg-family", "tg-offer", "ru-short", "ru-family", "ru-offer"]);
    const parsed = narrationConfigSchema.parse(after);
    for (const item of [...parsed.templates!, ...parsed.endings!]) expect(narrationTemplateError(item.text, item.lang), item.id).toBeNull();
  });

  it("правку владельца после 21.11 не трогает (и не убирает); повтор ничего не меняет", async () => {
    const edited = prod.templates.map((t: any) => t.id === "tg-apt-2" || t.id === "tg-apt-5" ? { ...t, text: `${t.text} Хона тайёр аст.` } : t);
    const editedEndings = prod.endings.map((e: any) => e.id === "end-b" ? { ...e, text: "Ба мо нависед." } : e);
    await setConfig({ modelId: "eleven_v4", voices: [], templates: edited, endings: editedEndings });
    await migrate();
    const once = await readConfig();
    expect(once.templates.find((t: any) => t.id === "tg-apt-2").text).toMatch(/Хона тайёр аст\.$/u);
    expect(once.templates.find((t: any) => t.id === "tg-apt-5")?.text).toMatch(/Хона тайёр аст\.$/u);
    expect(once.endings.find((e: any) => e.id === "end-b").text).toBe("Ба мо нависед.");
    expect(once.templates.find((t: any) => t.id === "tg-apt-1")).toEqual(lib.templates.find((t) => t.id === "tg-apt-1"));
    await migrate();
    expect(await readConfig()).toEqual(once);
  });

  it("пустые настройки получают всю библиотеку", async () => {
    await setConfig({});
    await migrate();
    const filled = await readConfig();
    expect(filled.templates).toEqual(lib.templates);
    expect(filled.endings).toEqual(lib.endings);
  });
});
