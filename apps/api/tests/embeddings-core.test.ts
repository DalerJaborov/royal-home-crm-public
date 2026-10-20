import { describe, expect, it } from "vitest";
import { cosineSimilarity, propertyEmbeddingText } from "../src/ai/embeddings.js";
import { formatPrice } from "../src/ai/seoGenerator.js";

/**
 * Математика семантического подбора (23.08.2026, пункт 3 очереди ИИ) — чистые
 * функции, без сети и без базы: cosineSimilarity собирает вектор сходства,
 * propertyEmbeddingText собирает текст, который потом уходит на индексацию.
 * Обе проверяются напрямую, без мока Gemini — именно этого им и не хватает,
 * чтобы называться юнит-тестом.
 */
describe("cosineSimilarity", () => {
  it("одинаковые векторы — сходство 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("ортогональные векторы — сходство 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("противоположные векторы — сходство -1", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it("масштаб не влияет — сонаправленные векторы разной длины всё равно дают 1", () => {
    expect(cosineSimilarity([2, 0, 0], [10, 0, 0])).toBeCloseTo(1, 10);
  });

  it("нулевой вектор — сходство 0, а не NaN/деление на ноль", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("векторы разной длины — считает по общей длине, не бросает", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).not.toThrow();
  });
});

describe("propertyEmbeddingText", () => {
  const base = {
    title: "3-комн, Сино",
    type: "APARTMENT",
    rooms: 3,
    areaSqm: 82,
    price: 340000,
    currency: "TJS",
    district: { name: "Сино" },
    address: "91 мкр, дом 12",
    condition: "GOOD",
    amenities: ["балкон", "лифт"],
    description: "Светлая квартира рядом со школой.",
  };

  it("собирает все смысловые поля объекта в один текст", () => {
    const text = propertyEmbeddingText(base);
    expect(text).toContain("3-комн, Сино");
    expect(text).toContain("квартира");
    expect(text).toContain("3-комнатная");
    expect(text).toContain("82 м²");
    // formatPrice (ai/seoGenerator.ts, toLocaleString("ru-RU")) может использовать
    // не обычный пробел, а узкий неразрывный (U+202F) — сверяем её же выводом,
    // а не переписываем разделитель тысяч руками.
    expect(text).toContain(formatPrice(340000, "TJS"));
    expect(text).toContain("Сино");
    expect(text).toContain("91 мкр, дом 12");
    expect(text).toContain("хорошее состояние");
    expect(text).toContain("балкон, лифт");
    expect(text).toContain("Светлая квартира рядом со школой.");
  });

  it("необязательные поля отсутствуют — пустых кусков в тексте нет (не 'null. . .')", () => {
    const text = propertyEmbeddingText({
      ...base,
      rooms: null,
      district: null,
      amenities: [],
      description: null,
    });
    expect(text).not.toMatch(/null/i);
    expect(text).not.toMatch(/\.\s*\.\s*\./);
  });

  it("доллары форматируются как в остальной CRM — тем же formatPrice, что и SEO", () => {
    const text = propertyEmbeddingText({ ...base, price: 40000, currency: "USD" });
    expect(text).toContain(formatPrice(40000, "USD"));
    expect(text).not.toContain("USD");
  });
});
