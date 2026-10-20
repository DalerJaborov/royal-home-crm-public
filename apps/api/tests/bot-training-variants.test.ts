import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Разбор ответа модели в ai/training.ts::generateTrainingVariants.
 *
 * База и сеть здесь не нужны — это чистый разбор JSON, который вернул callAiText.
 * Промт — просьба, а не гарантия (та же грабля, что и в ai/scoring.ts): модель
 * может вернуть один вариант вместо трёх, подсунуть число вместо строки или
 * прислать пустую строку. Ничего из этого не должно уйти владельцу как «вариант
 * ответа» — отсюда и набор проверок ниже.
 */

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: (...args: unknown[]) => callAiText(...args) }));

const groundedSearchIsEnabled = vi.fn(async () => false);
vi.mock("../src/ai/assistant.js", () => ({ groundedSearchIsEnabled: () => groundedSearchIsEnabled() }));

const callGeminiGrounded = vi.fn();
const resolveGeminiKey = vi.fn(async () => "test-key");
vi.mock("../src/ai/geminiClient.js", () => ({
  callGeminiGrounded: (...args: unknown[]) => callGeminiGrounded(...args),
  resolveGeminiKey: () => resolveGeminiKey(),
}));

const findMany = vi.fn(async () => [] as { clientText: string; agentText: string }[]);
vi.mock("../src/db.js", () => ({
  prisma: { styleExample: { findMany }, $disconnect: () => Promise.resolve() },
}));

const { generateTrainingVariants } = await import("../src/ai/training.js");

beforeEach(() => {
  callAiText.mockReset();
  findMany.mockClear();
  groundedSearchIsEnabled.mockReset().mockResolvedValue(false);
  callGeminiGrounded.mockReset();
  resolveGeminiKey.mockReset().mockResolvedValue("test-key");
});

describe("generateTrainingVariants", () => {
  it("два-три валидных варианта проходят как есть", async () => {
    callAiText.mockResolvedValue({ variants: ["Первый ответ", "Второй ответ", "Третий ответ"] });
    const result = await generateTrainingVariants("Сколько стоит квартира?");
    expect(result?.variants).toEqual(["Первый ответ", "Второй ответ", "Третий ответ"]);
    expect(result?.groundedIndex).toBeUndefined();
  });

  it("модель молчит (null) — вариантов нет, а не пустой массив", async () => {
    callAiText.mockResolvedValue(null);
    expect(await generateTrainingVariants("вопрос")).toBeNull();
  });

  it("меньше двух годных вариантов — владельцу нечего выбирать, вернуть null", async () => {
    callAiText.mockResolvedValue({ variants: ["Единственный вариант"] });
    expect(await generateTrainingVariants("вопрос")).toBeNull();
  });

  it("мусорные элементы (числа, пустые строки, пробелы) отфильтровываются", async () => {
    callAiText.mockResolvedValue({ variants: ["Годный вариант номер один", 42, "", "   ", "Годный вариант номер два"] });
    const result = await generateTrainingVariants("вопрос");
    expect(result?.variants).toEqual(["Годный вариант номер один", "Годный вариант номер два"]);
  });

  it("лишний четвёртый вариант обрезается до трёх (без grounded-добавки)", async () => {
    callAiText.mockResolvedValue({ variants: ["Раз", "Два", "Три", "Четыре"] });
    const result = await generateTrainingVariants("вопрос");
    expect(result?.variants).toHaveLength(3);
  });

  it("variants не массив — трактуем как отказ, не падаем", async () => {
    callAiText.mockResolvedValue({ variants: "просто строка" });
    expect(await generateTrainingVariants("вопрос")).toBeNull();
  });

  it("контекст черновика лида уходит в промт модели, если он есть", async () => {
    callAiText.mockResolvedValue({ variants: ["А", "Б"] });
    await generateTrainingVariants("Сколько комнат?", { leadDraft: { rooms: 3, budgetMax: 45000 } });
    const call = callAiText.mock.calls[0][0] as { user: string };
    expect(call.user).toContain("rooms");
    expect(call.user).toContain("45000");
  });

  it("пустой черновик лида не добавляет мусора в промт", async () => {
    callAiText.mockResolvedValue({ variants: ["А", "Б"] });
    await generateTrainingVariants("Сколько комнат?", { leadDraft: {} });
    const call = callAiText.mock.calls[0][0] as { user: string };
    expect(call.user).not.toContain("{}");
  });

  it("схема запроса — function-call с массивом строк, не свободный текст", async () => {
    callAiText.mockResolvedValue({ variants: ["А", "Б"] });
    await generateTrainingVariants("вопрос");
    const call = callAiText.mock.calls[0][0] as { schema: { properties: { variants: { type: string; items: { type: string } } } } };
    expect(call.schema.properties.variants.type).toBe("array");
    expect(call.schema.properties.variants.items.type).toBe("string");
  });

  describe("grounded-вариант (пункт 4 очереди ИИ, второй заход)", () => {
    it("needsGroundedFact=true, но тумблер выключен — grounding не вызывается вовсе", async () => {
      callAiText.mockResolvedValue({ variants: ["А", "Б"], needsGroundedFact: true });
      groundedSearchIsEnabled.mockResolvedValue(false);
      const result = await generateTrainingVariants("Какой налог при продаже квартиры?");
      expect(callGeminiGrounded).not.toHaveBeenCalled();
      expect(result?.variants).toEqual(["А", "Б"]);
      expect(result?.groundedIndex).toBeUndefined();
    });

    it("needsGroundedFact=false — grounding не вызывается, даже если тумблер включён", async () => {
      callAiText.mockResolvedValue({ variants: ["А", "Б"], needsGroundedFact: false });
      groundedSearchIsEnabled.mockResolvedValue(true);
      await generateTrainingVariants("Есть двушка в Сино?");
      expect(callGeminiGrounded).not.toHaveBeenCalled();
    });

    it("needsGroundedFact=true и тумблер включён — grounded-вариант добавляется четвёртым, с источниками ОТДЕЛЬНО от текста", async () => {
      callAiText.mockResolvedValue({ variants: ["А", "Б", "В"], needsGroundedFact: true });
      groundedSearchIsEnabled.mockResolvedValue(true);
      callGeminiGrounded.mockResolvedValue({
        text: "Налог при продаже квартиры физлицом — 0%, если в собственности больше года.",
        sources: [{ url: "https://example.tj/nalog", title: "Налоговый кодекс РТ" }],
      });
      const result = await generateTrainingVariants("Какой налог при продаже квартиры?");
      expect(result?.variants).toHaveLength(4);
      expect(result?.groundedIndex).toBe(3);
      expect(result?.variants[3]).toContain("0%");
      // Источники — только в groundedSources, НЕ приписаны к тексту варианта (см.
      // комментарий в training.ts: длинный текст с ссылками ломает isUselessExample
      // и не должен становиться постоянным образцом манеры).
      expect(result?.variants[3]).not.toContain("example.tj");
      expect(result?.groundedSources).toEqual([{ url: "https://example.tj/nalog", title: "Налоговый кодекс РТ" }]);
    });

    it("grounded-вызов вернул null — обычные варианты всё равно возвращаются", async () => {
      callAiText.mockResolvedValue({ variants: ["А", "Б"], needsGroundedFact: true });
      groundedSearchIsEnabled.mockResolvedValue(true);
      callGeminiGrounded.mockResolvedValue(null);
      const result = await generateTrainingVariants("Какой налог при продаже квартиры?");
      expect(result?.variants).toEqual(["А", "Б"]);
      expect(result?.groundedIndex).toBeUndefined();
    });

    it("нет ключа Gemini — grounding не вызывается, обычные варианты не страдают", async () => {
      callAiText.mockResolvedValue({ variants: ["А", "Б"], needsGroundedFact: true });
      groundedSearchIsEnabled.mockResolvedValue(true);
      resolveGeminiKey.mockResolvedValue(null);
      const result = await generateTrainingVariants("Какой налог при продаже квартиры?");
      expect(callGeminiGrounded).not.toHaveBeenCalled();
      expect(result?.variants).toEqual(["А", "Б"]);
    });
  });
});
