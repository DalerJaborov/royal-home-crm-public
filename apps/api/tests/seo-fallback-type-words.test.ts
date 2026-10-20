import { describe, expect, it, vi } from "vitest";

/**
 * ЗАПАСНОЙ ТЕКСТ SEO ПО ТИПУ ОБЪЕКТА (находка О7 проверки 02.10.2026).
 *
 * Шаблон на случай отказа ИИ (ai/seoGenerator.ts::fallbackTemplate) склеивал
 * «N-комнатная» с любым типом: на сайт уходило «Продаётся 3-комнатная дом» и
 * «1-комнатная земельный участок», а в описании для поиска — «Продажа дом».
 */

const { callAiText } = vi.hoisted(() => ({ callAiText: vi.fn(async () => null as unknown) }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { generateSeoFields } = await import("../src/ai/seoGenerator.js");

const base = {
  areaSqm: 120,
  price: 900000,
  currency: "TJS",
  districtName: "Сино",
  address: "Казокон, 5",
  condition: "GOOD",
  amenities: [],
  urgent: false,
};

describe("fallbackTemplate", () => {
  it("дом: «5-комнатный дом», «Продажа дома»", async () => {
    const seo = await generateSeoFields({ ...base, type: "HOUSE", rooms: 5 });
    expect(seo.h1).toContain("5-комнатный дом");
    expect(seo.description).not.toContain("комнатная дом");
    expect(seo.seoDesc).toContain("Продажа дома");
  });

  it("участок и коммерция: без «комнатная», падеж в описании", async () => {
    const land = await generateSeoFields({ ...base, type: "LAND", rooms: 1 });
    expect(land.h1).not.toContain("комнатн");
    expect(land.seoDesc).toContain("Продажа земельного участка");
    const commercial = await generateSeoFields({ ...base, type: "COMMERCIAL", rooms: 3 });
    expect(commercial.h1).not.toContain("комнатн");
    expect(commercial.seoDesc).toContain("Продажа коммерческой недвижимости");
  });

  it("квартира: как и прежде «2-комнатная квартира», «Продажа квартиры»", async () => {
    const seo = await generateSeoFields({ ...base, type: "APARTMENT", rooms: 2 });
    expect(seo.h1).toContain("2-комнатная квартира");
    expect(seo.seoDesc).toContain("Продажа квартиры");
  });
});
