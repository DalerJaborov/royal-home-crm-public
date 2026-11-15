import { describe, expect, it, vi } from "vitest";
// Чистые правила: до базы не доходим.
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
import { narrationRotatedTemplateId, narrationTemplateLangs, nextNarrationTemplateId } from "@royal-home/shared";

/**
 * ВАРИАНТЫ ТЕКСТА ПО КРУГУ (14.11.2026, владелец: «несколько шаблонов, чтобы не каждый раз одинаковые»).
 * Мастер CRM показывает, а сервер (мастер CRM и Шабнам, lib/narrationAutoFlow.ts) ставит один и тот же
 * следующий вариант — поэтому правило одно, в packages/shared.
 */
const templates = [
  { id: "tg-a", lang: "tg" as const }, { id: "ru-a", lang: "ru" as const }, { id: "tg-b", lang: "tg" as const },
  { id: "tg-c", lang: "tg" as const }, { id: "ru-b", lang: "ru" as const },
];

describe("narration template rotation", () => {
  it("идёт по кругу внутри языка и не перескакивает на другой язык", () => {
    expect(nextNarrationTemplateId(templates, "tg", "tg-a")).toBe("tg-b");
    expect(nextNarrationTemplateId(templates, "tg", "tg-b")).toBe("tg-c");
    expect(nextNarrationTemplateId(templates, "tg", "tg-c")).toBe("tg-a");
    expect(nextNarrationTemplateId(templates, "ru", "ru-b")).toBe("ru-a");
  });
  it("без прошлого или с прошлым другого языка — первый вариант языка; языка нет — null", () => {
    expect(nextNarrationTemplateId(templates, "tg", null)).toBe("tg-a");
    expect(nextNarrationTemplateId(templates, "ru", "tg-a")).toBe("ru-a");
    expect(nextNarrationTemplateId([{ id: "tg-a", lang: "tg" }], "ru", null)).toBeNull();
  });
  it("новый объект получает следующий вариант после прошлого выбора сотрудника, на его языке", () => {
    expect(narrationRotatedTemplateId(templates, "ru-a")).toBe("ru-b");
    expect(narrationRotatedTemplateId(templates, "tg-c")).toBe("tg-a");
    // Один вариант на язык — он же; прошлого нет или шаблон удалили — решает умолчание владельца.
    expect(narrationRotatedTemplateId([{ id: "tg-a", lang: "tg" }], "tg-a")).toBe("tg-a");
    expect(narrationRotatedTemplateId(templates, undefined)).toBeNull();
    expect(narrationRotatedTemplateId(templates, "deleted")).toBeNull();
  });
  it("языки — только те, на которых есть шаблоны, таджикский первым", () => {
    expect(narrationTemplateLangs(templates)).toEqual(["tg", "ru"]);
    expect(narrationTemplateLangs([{ lang: "ru" }])).toEqual(["ru"]);
  });
});
