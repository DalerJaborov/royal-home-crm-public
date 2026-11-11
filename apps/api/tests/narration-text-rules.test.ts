import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// Чистые правила текста: до базы не доходим (setup.ts сбрасывает настройки только у настоящей базы).
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
import {
  narrationConfigSchema, narrationDraftText, narrationSpeechText, narrationTemplateError, narrationTemplateSchema,
  narrationModelError, pickNarrationTemplate, pickNarrationVoice, renderNarrationTemplate, tajikCardinal, tajikOrdinal, type NarrationFacts,
} from "@royal-home/shared";
import { narrationScriptError } from "../src/lib/propertyNarration.js";
import { tajikSpeechNumbers } from "../src/telegram/tajikSpeechNumbers.js";

const apartment: NarrationFacts = { type: "APARTMENT", rooms: 3, areaSqm: "86.4", floor: 5, totalFloors: 9, district: "Сино" };
const house: NarrationFacts = { type: "HOUSE", rooms: null, areaSqm: "240", floor: null, totalFloors: null, district: null };
const tg = { lang: "tg" as const, text: "Ассалому алейкум! {вид} барои фурӯш[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нарх дар тавсиф." };

// Стартовые шаблоны лежат в миграции (текст владельца живёт в настройках, не в коде).
const migration = readFileSync(new URL("../prisma/migrations/20261111120000_narration_flow/migration.sql", import.meta.url), "utf8");
const seeded = narrationTemplateSchema.array().parse(JSON.parse(migration.split("$json$")[1]));

describe("narration text rules (one builder for CRM wizard, Shabnam and server)", () => {
  it("spells Tajik numbers as words and drops optional fragments with missing facts", () => {
    expect(renderNarrationTemplate(tg, apartment)).toBe("Ассалому алейкум! Квартира барои фурӯш, ноҳияи Сино. Се ҳуҷра. Масоҳаташ ҳаштоду шаш метри мураббаъ. Ошёнаи панҷум аз нӯҳ. Нарх дар тавсиф.");
    const forHouse = renderNarrationTemplate(tg, house);
    expect(forHouse).toBe("Ассалому алейкум! Ҳавлӣ барои фурӯш. Масоҳаташ дусаду чил метри мураббаъ. Нарх дар тавсиф.");
    expect(renderNarrationTemplate(tg, { ...apartment, totalFloors: null })).toContain("Ошёнаи панҷум.");
    expect(/\d/u.test(renderNarrationTemplate(tg, apartment))).toBe(false);
  });
  it("keeps digits for Russian and capitalises sentence starts", () => {
    expect(renderNarrationTemplate({ lang: "ru", text: "в продаже {вид}. [комнат: {комнаты}.] площадь {площадь} метров." }, apartment)).toBe("В продаже квартира. Комнат: 3. Площадь 86 метров.");
  });
  it("ordinals and the moved speech-number module agree", () => {
    expect([1, 2, 3, 4, 10, 30, 31].map(tajikOrdinal)).toEqual(["якум", "дуюм", "сеюм", "чорум", "даҳум", "сиюм", "сиву якум"]);
    expect(tajikCardinal(86)).toBe("ҳаштоду шаш");
    expect(tajikSpeechNumbers("3 ҳуҷра")).toBe("се ҳуҷра");
    expect(narrationSpeechText("3 ҳуҷра, 86 м²", "tg")).toBe("се ҳуҷра, ҳаштоду шаш метри мураббаъ");
    expect(narrationSpeechText("3 комнаты", "ru")).toBe("3 комнаты");
  });
  it("rejects unknown placeholders, unbalanced brackets and long dashes in owner templates", () => {
    expect(narrationTemplateError("{цена} сомонӣ")).toMatch(/Неизвестное/);
    expect(narrationTemplateError("[{район}")).toMatch(/Не закрыта/);
    expect(narrationTemplateError("{район}]")).toMatch(/Лишняя/);
    expect(narrationTemplateError("Квартира — хорошая")).toMatch(/тире/);
    expect(narrationTemplateError(tg.text)).toBeNull();
  });
  it("seeded starter templates are valid, price-free and speak Tajik without digits", () => {
    expect(seeded.map((t) => t.id)).toEqual(["tg-short", "tg-family", "ru-short"]);
    for (const template of seeded) {
      expect(narrationTemplateError(template.text)).toBeNull();
      for (const facts of [apartment, house]) {
        const text = renderNarrationTemplate(template, facts);
        expect(narrationScriptError(text)).toBeNull();
        if (template.lang === "tg") expect(/\d/u.test(text)).toBe(false);
      }
    }
  });
  it("picks the requested, then default, then first Tajik template; falls back to the legacy text without templates", () => {
    const config = { templates: seeded, defaultTemplateId: "tg-family" };
    expect(pickNarrationTemplate(config, "ru-short")?.id).toBe("ru-short");
    expect(pickNarrationTemplate(config, "missing")?.id).toBe("tg-family");
    expect(pickNarrationTemplate({ templates: seeded }, null)?.id).toBe("tg-short");
    expect(narrationDraftText({}, apartment)).toMatchObject({ templateId: null, lang: "ru" });
    expect(narrationDraftText(config, apartment, "ru-short").lang).toBe("ru");
  });
  it("voice falls back to the owner's default, then the first voice", () => {
    const voices = [{ id: "a", name: "A" }, { id: "b", name: "B", gender: "female" as const }];
    expect(pickNarrationVoice({ voices, defaultVoiceId: "b" }, "zzz")).toBe("b");
    expect(pickNarrationVoice({ voices }, undefined)).toBe("a");
    expect(pickNarrationVoice({ voices: [] }, "a")).toBeNull();
  });
  it("old saved configs stay valid and duplicate template ids are refused", () => {
    expect(narrationConfigSchema.safeParse({ modelId: "m", voices: [{ id: "v", name: "V" }] }).success).toBe(true);
    expect(narrationConfigSchema.safeParse({ modelId: "m", voices: [], templates: [seeded[0], seeded[0]] }).success).toBe(false);
  });
  it("Tajik templates need a Tajik-capable model (v4 or v4 Turbo)", () => {
    expect(narrationModelError({ modelId: "eleven_v4", templates: seeded })).toBeNull();
    expect(narrationModelError({ modelId: "eleven_v4_turbo", templates: seeded })).toBeNull();
    expect(narrationModelError({ modelId: "eleven_multilingual_v2", templates: seeded })).toMatch(/таджикского/u);
    expect(narrationModelError({ modelId: "eleven_flash_v2_5", templates: seeded.filter((t) => t.lang === "ru") })).toBeNull();
  });
});
