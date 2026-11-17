import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { narrationConfigSchema, narrationTemplateError, narrationTemplateSchema } from "@royal-home/shared";
import { prisma } from "../src/db.js";

/**
 * МИГРАЦИЯ БИБЛИОТЕКИ ШАБЛОНОВ (16.11.2026): добавляет 20 шаблонов по типам и 9 концовок в живые настройки
 * озвучки, не трогая голоса, модель, пределы и шаблоны владельца; шесть стартовых шаблонов 11.11 остаются, но
 * получают «только вручную». Тест гоняет настоящий текст миграции по строке Settings: повтор ничего не дублирует.
 */
const sql = readFileSync(new URL("../prisma/migrations/20261117121000_narration_template_library/migration.sql", import.meta.url), "utf8");
const starters = narrationTemplateSchema.array().parse(JSON.parse(readFileSync(new URL("../prisma/migrations/20261111120000_narration_flow/migration.sql", import.meta.url), "utf8").split("$json$")[1]));
const STARTER_IDS = starters.map((t) => t.id);

// Тексты миграции совпадают с утверждёнными данными, на которых стоят тесты выбора (tests/fixtures/narrationLibrary.json).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/narrationLibrary.json", import.meta.url), "utf8"));
let saved: unknown;
async function setConfig(config: unknown) {
  const data = { propertyNarrationConfig: config as never };
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
}
const readConfig = async () => (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).propertyNarrationConfig as Record<string, any>;
const migrate = () => prisma.$executeRawUnsafe(sql);
/** Что может лежать в колонке до миграции (она NOT NULL): пустой объект или JSON-скаляр. */
const setRaw = (value: string) => prisma.$executeRawUnsafe(`UPDATE "Settings" SET "propertyNarrationConfig" = ${value} WHERE "id" = 'singleton'`);

beforeEach(async () => {
  saved ??= (await prisma.settings.findUnique({ where: { id: "singleton" } }))?.propertyNarrationConfig ?? null;
});
afterAll(async () => { await setConfig(saved ?? {}); });

describe("миграция библиотеки шаблонов озвучки", () => {
  it("данные миграции равны утверждённой библиотеке из тестов выбора", () => {
    expect(JSON.parse(sql.split("$json$")[1])).toEqual(fixture);
  });

  it("добавляет библиотеку к живым настройкам: голоса, модель, пределы и шаблон владельца целы, старые шесть помечены «вручную»", async () => {
    const ownerTemplate = { id: "my-own", name: "Мой", lang: "tg", text: "Хонаи ман барои фурӯш. Нархаш {цена}." };
    const before = { modelId: "eleven_v4", voices: [{ id: "anna", name: "Анна", gender: "female", settings: { stability: 0.5 } }], autoGenerate: true, mixByCrm: true,
      dailyCharLimit: 1234, defaultVoiceId: "anna", defaultTemplateId: "tg-family", templates: [...starters, ownerTemplate],
      pronunciationRules: [{ word: "Сино", alias: "Сино" }], pronunciationDictionaries: [{ id: "dict1" }] };
    await setConfig(before);
    await migrate();
    const after = await readConfig();
    // Всё прежнее на месте.
    for (const key of ["modelId", "voices", "autoGenerate", "mixByCrm", "dailyCharLimit", "defaultVoiceId", "defaultTemplateId", "pronunciationRules", "pronunciationDictionaries"]) {
      expect(after[key], key).toEqual((before as Record<string, unknown>)[key]);
    }
    // Старые шесть: те же тексты, плюс «только вручную»; шаблон владельца не тронут.
    expect(after.templates.slice(0, 6).map((t: any) => t.id)).toEqual(STARTER_IDS);
    for (const [i, t] of after.templates.slice(0, 6).entries()) expect(t).toEqual({ ...starters[i], manualOnly: true });
    expect(after.templates[6]).toEqual(ownerTemplate);
    expect(after.templates).toHaveLength(6 + 1 + 20);
    expect(after.endings).toHaveLength(9);
    // Результат читается схемой настроек, а каждый текст проходит сторож.
    const parsed = narrationConfigSchema.parse(after);
    for (const item of [...parsed.templates!, ...parsed.endings!]) expect(narrationTemplateError(item.text, item.lang), item.id).toBeNull();
  });

  it("повторный прогон ничего не дублирует и не меняет; правка владельца в добавленном шаблоне не затирается", async () => {
    await setConfig({ modelId: "eleven_v4", voices: [], templates: starters });
    await migrate();
    const once = await readConfig();
    await migrate();
    expect(await readConfig()).toEqual(once);
    const edited = { ...once, templates: once.templates.map((t: any) => t.id === "tg-apt-1" ? { ...t, text: "Хонаи ман барои фурӯш. Нархаш {цена}.", propertyTypes: ["APARTMENT", "HOUSE"] } : t),
      endings: once.endings.filter((e: any) => e.id !== "end-a") };
    await setConfig(edited);
    await migrate();
    const again = await readConfig();
    expect(again.templates.find((t: any) => t.id === "tg-apt-1")).toEqual(edited.templates.find((t: any) => t.id === "tg-apt-1"));
    // Концовку, которую владелец убрал, повторная миграция вернула бы — миграции идут один раз; повтор для проверки того, что чужое не ломается.
    expect(again.templates).toHaveLength(26);
  });

  it("пустые настройки (нет ни шаблонов, ни концовок) получают всю библиотеку; строки Settings нет — миграция молча ничего не делает", async () => {
    await setConfig({});
    await migrate();
    const filled = await readConfig();
    expect(filled.templates).toHaveLength(20);
    expect(filled.endings).toHaveLength(9);
    expect(filled.templates.every((t: any) => !t.manualOnly)).toBe(true);
    for (const raw of ["'null'::jsonb", "'\"text\"'::jsonb"]) {
      await setConfig({});
      await setRaw(raw);
      await migrate();
      const fromRaw = await readConfig();
      expect(fromRaw.templates, raw).toHaveLength(20);
      expect(fromRaw.endings, raw).toHaveLength(9);
    }
    // Строки Settings нет (чистая база): внутри транзакции, которую откатываем, чтобы не трогать общую базу тестов.
    const rolledBack = new Error("rollback");
    let rowAfter: unknown = "unset";
    await prisma.$transaction(async (tx) => {
      await tx.settings.deleteMany({ where: { id: "singleton" } });
      await tx.$executeRawUnsafe(sql);
      rowAfter = await tx.settings.findUnique({ where: { id: "singleton" } });
      throw rolledBack;
    }).catch((err) => { if (err !== rolledBack) throw err; });
    expect(rowAfter).toBeNull();
  });
});
