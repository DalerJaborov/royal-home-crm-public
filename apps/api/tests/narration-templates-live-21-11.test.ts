import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  estimateNarrationSec, narrationAreaWords, narrationConfigSchema, narrationDraftText, narrationFitsType, narrationObjectWords,
  narrationFactsChanges, narrationLiveWordsError, narrationRoomsWords, narrationSotkaWords, narrationTemplateError, narrationTotalFloorsError, type NarrationFacts, type NarrationLang,
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
// Владелец утвердил тексты 23.11.2026 («да включай»): файл — обычная миграция, её применяет `prisma migrate deploy`.
const migrationsDir = new URL("../prisma/migrations/", import.meta.url);
const migrationName = readdirSync(migrationsDir).find((d) => d.endsWith("_narration_templates_live"));
if (!migrationName) throw new Error("нет миграции *_narration_templates_live в prisma/migrations");
const sql = readFileSync(new URL(`../prisma/migrations/${migrationName}/migration.sql`, import.meta.url), "utf8");
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

  it("{метраж} по-русски согласуется с числом; {сотки}: целые, половина, иначе метры", () => {
    expect([121, 122, 125].map((n) => narrationAreaWords(n, "ru"))).toEqual([
      "сто двадцать один квадратный метр", "сто двадцать два квадратных метра", "сто двадцать пять квадратных метров"]);
    expect(narrationAreaWords(124.5, "tg")).toBe("яксаду бисту панҷ метри мураббаъ");
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
  const config = narrationConfigSchema.parse({ modelId: "eleven_v4", voices: [], templates: lib.templates, endings: lib.endings, liveWords: true });
  const objectWord = (f: NarrationFacts, lang: NarrationLang) => narrationObjectWords(f.type, f.rooms, lang).toLocaleLowerCase("ru");

  it("объект 217 звучит так, как владелец одобрил 21.11, но без этажности дома (#376) (без «васеъ»: у однокомнатной это было бы неправдой)", () => {
    expect(narrationDraftText(config, FACTS.APARTMENT!, "tg-apt-1", "end-a").text).toBe(
      "Барои оилаатон хона дар бинои бисёрошёна меҷӯед? Ин пешниҳодро аз даст надиҳед! Дар ноҳияи Сино хонаи чорҳуҷрагӣ фурӯхта мешавад. "
      + "Масоҳаташ яксаду бисту панҷ метри мураббаъ буда, дар ошёнаи ёздаҳум ҷойгир аст. "
      + "Нархаш ду миллиону яксаду ҳафтоду ҳашт ҳазор сомонӣ. Танҳо аз рӯйи навор баҳо надиҳед, беҳтараш худатон омада бинед! "
      + "Барои тамошо худи ҳозир ба мо нависед ё занг занед.");
  });

  it("каждый текст проходит сторож Настроек; нет кальки и анкеты", () => {
    const CALQUES = /Фурӯхта мешавад дар|иборат(?:\s|$)|интихоб кардан мехоҳед|бинои\s+\{этажей\}\s+ошёна|Комнат:|Площадь:|Этаж\s+\{/iu;
    for (const item of [...lib.templates, ...lib.endings]) {
      expect(narrationTemplateError(item.text, item.lang), item.id).toBeNull();
      // Этажность дома не говорим (#376): в библиотеке нет ни {этажей}, ни {этажность}, ни {этажность_род} (ревью #363).
      expect(narrationTotalFloorsError(item.text), item.id).toBeNull();
      expect(item.text, item.id).not.toMatch(CALQUES);
      expect(item.text, item.id).not.toMatch(/Директ|брон|доллар/iu);
    }
  });

  it("миграция не кладёт в тексты ни одного слова про этажность дома; включает рубильник; в prisma/migrations, не в pending-data", () => {
    // Только новые тексты (не knownOld: там прежние, их этажность не наша забота). Разрешён один {этаж_пор} — этаж самой квартиры.
    const texts = [...lib.templates, ...lib.endings].map((x) => x.text).join(" ");
    expect(texts).not.toMatch(/\{этажей\}|\{этажность\}|\{этажность_род\}/u);
    expect([...texts.matchAll(/\{этаж[^}]*\}/gu)].every((m) => m[0] === "{этаж_пор}")).toBe(true);
    expect(sql).toMatch(/jsonb_set\(cfg, '\{liveWords\}', 'true'::jsonb\)/);
    expect(existsSync(new URL("../prisma/pending-data/20261121_narration_templates_live.sql", import.meta.url))).toBe(false);
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

describe("рубильник «живые слова»: по умолчанию выключен, выключенный — озвучка как раньше", () => {
  const tpl = (lang: NarrationLang, text: string) => ({ id: "t1", name: "Т", lang, text });
  const config = (liveWords?: boolean, templates = [tpl("tg", "[Дар ноҳияи {район} ]{объект} фурӯхта мешавад. [Масоҳаташ {метраж}.] [{сколько_комнат}.] [Участка {сотки}.]")]) =>
    narrationConfigSchema.parse({ modelId: "eleven_v4", voices: [], templates, ...(liveWords === undefined ? {} : { liveWords }) });

  it("в настройках без поля рубильник выключен", () => {
    expect(narrationConfigSchema.parse({ modelId: "m", voices: [] }).liveWords).toBeUndefined();
    expect(config().liveWords).toBeUndefined();
  });

  it("выключен: новые слова и участок дома молчат, остальное звучит как раньше", () => {
    const off = narrationDraftText(config(false), FACTS.HOUSE!, "t1", null).text;
    expect(off).toBe("Дар ноҳияи Фирдавси фурӯхта мешавад.");
    expect(narrationDraftText(config(), FACTS.HOUSE!, "t1", null).text).toBe(off);
    const on = narrationDraftText(config(true), FACTS.HOUSE!, "t1", null).text;
    expect(on).toBe("Дар ноҳияи Фирдавси ҳавлӣ фурӯхта мешавад. Масоҳаташ дусад метри мураббаъ. Ҳашт ҳуҷра. Участка панҷ сотиқ.");
  });

  it("выключен: участок с половиной сотки — метрами, как до 21.11; включён — «ва ним»", () => {
    const land = { ...FACTS.LAND!, areaSqm: "650" };
    const only = [tpl("tg", "Участок {сотки}.")];
    expect(narrationDraftText(config(false, only), land, "t1", null).text).toBe("Участок шашсаду панҷоҳ метри мураббаъ.");
    expect(narrationDraftText(config(true, only), land, "t1", null).text).toBe("Участок шаш ва ним сотиқ.");
    // целые сотки одинаковы при любом положении
    expect(narrationDraftText(config(false, only), FACTS.LAND!, "t1", null).text).toBe(narrationDraftText(config(true, only), FACTS.LAND!, "t1", null).text);
  });

  it("этажность дома не звучит ни при каком положении: {этажность} пустое, скобка выпадает", () => {
    const only = [tpl("tg", "Хона дар ошёнаи {этаж_пор}[и бинои {этажность}] ҷойгир аст.")];
    for (const live of [false, true]) {
      expect(narrationDraftText(config(live, only), FACTS.APARTMENT!, "t1", null).text).toBe("Хона дар ошёнаи ёздаҳум ҷойгир аст.");
    }
    expect(narrationTotalFloorsError("бинои {этажность}")).not.toBeNull();
  });
});

describe("участок дома в фактах озвучки", () => {
  const house = { type: "HOUSE", rooms: 8, areaSqm: "200", floor: null, totalFloors: 2, district: { name: "Фирдавси" }, price: "2550000", currency: "TJS", landAreaSotka: "5" };
  it("участок попадает в факты дома только при «Живых словах»; квартира — никогда (её хэш фактов прежний)", () => {
    expect(narrationFacts(house, true).landSotka).toBe("5");
    expect("landSotka" in narrationFacts(house, false)).toBe(false);
    const apt = narrationFacts({ ...house, type: "APARTMENT", landAreaSotka: null }, true);
    expect("landSotka" in apt).toBe(false);
    expect(narrationHash(apt)).toBe(narrationHash({ type: "APARTMENT", rooms: 8, areaSqm: "200", floor: null, totalFloors: 2, district: "Фирдавси", price: "2550000", currency: "TJS" }));
  });
  it("ревью #363: при ВЫКЛ отпечаток дома как в main, правка соток озвучку не старит", () => {
    const off = narrationFacts(house, false);
    expect(narrationHash(off)).toBe(narrationHash({ type: "HOUSE", rooms: 8, areaSqm: "200", floor: null, totalFloors: 2, district: "Фирдавси", price: "2550000", currency: "TJS" }));
    const version = { factsHash: narrationHash(off), factsSnapshot: off };
    expect(narrationFactsCurrent(version, { ...house, landAreaSotka: "6" })).toBe(true);
    expect(narrationFactsCurrent(version, { ...house, landAreaSotka: null })).toBe(true);
    // Без снимка (вызовы, что выбирают только factsHash) — так же.
    expect(narrationFactsCurrent({ factsHash: version.factsHash }, { ...house, landAreaSotka: "6" })).toBe(true);
    expect(narrationFactsCurrent(version, { ...house, price: "2600000" })).toBe(false);
  });
  it("версия, сделанная при ВКЛ (сотки звучат в аудио): смена участка — новая озвучка, без смены — актуальна при любом положении", () => {
    const fresh = narrationFacts(house, true);
    const v = { factsHash: narrationHash(fresh), factsSnapshot: fresh };
    expect(narrationFactsCurrent(v, house)).toBe(true);
    expect(narrationFactsCurrent(v, { ...house, landAreaSotka: "6" })).toBe(false);
  });
});

describe("ревью #363: «Изменилось: участок» не врёт", () => {
  const base: NarrationFacts = { type: "HOUSE", rooms: 8, areaSqm: "200", floor: null, totalFloors: 2, district: "Фирдавси", price: "2550000", currency: "TJS" };
  it("снимок без участка (ВЫКЛ или до 21.11) против фактов с участком — не изменение; оба с участком — изменение", () => {
    expect(narrationFactsChanges(base, { ...base, landSotka: "5" })).toEqual([]);
    expect(narrationFactsChanges({ ...base, landSotka: "5" }, base)).toEqual([]);
    expect(narrationFactsChanges({ ...base, landSotka: "5" }, { ...base, landSotka: "6" })).toEqual(["участок"]);
  });
});

describe("ревью #363: при ВЫКЛ новые слова вне скобок не принимаются", () => {
  it("вне скобок — отказ с подсказкой; в скобках и старые слова — можно", () => {
    expect(narrationLiveWordsError("{объект} фурӯхта мешавад.")).toMatch(/Живых словах/u);
    expect(narrationLiveWordsError("Продаётся квартира. {метраж}.")).toMatch(/\{метраж\}/u);
    expect(narrationLiveWordsError("[Дар ноҳияи {район} {объект} фурӯхта мешавад.] Нархаш {цена}.")).toBeNull();
    expect(narrationLiveWordsError("[{сколько_комнат}.] [Участок {сотки}.]")).toBeNull();
    expect(narrationLiveWordsError("{вид}[ дар ноҳияи {район}]. Масоҳаташ {площадь} метри мураббаъ.")).toBeNull();
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
