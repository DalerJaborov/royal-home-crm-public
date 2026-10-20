import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Google Search grounding (23.08.2026, пункт 4 очереди ИИ) — ветвление
 * REFERENCE_REAL_ESTATE в ai/assistant.ts: справочные вопросы о рынке/законах/
 * налогах/ипотеке Таджикистана, которые раньше падали в OFF_TOPIC, при включённом
 * Settings.groundedSearchEnabled получают ответ через callGeminiGrounded вместо
 * отказа.
 *
 * geminiClient мокается целиком (сеть к Google в тестах не бьём — тот же приём,
 * что и в ai-assistant-tools.test.ts), а Settings.groundedSearchEnabled — реальная
 * строка в базе, потому что именно от неё зависит ветвление: тумблер выключен по
 * умолчанию, и это тоже часть проверяемого поведения, а не деталь мока.
 */

const resolveGeminiKey = vi.fn();
const callGemini = vi.fn();
const callGeminiTools = vi.fn();
const callGeminiGrounded = vi.fn();
vi.mock("../src/ai/geminiClient.js", () => ({
  resolveGeminiKey,
  callGemini,
  callGeminiTools,
  callGeminiGrounded,
}));

const { prisma } = await import("../src/db.js");
const { runAssistant, OFF_TOPIC_REPLY } = await import("../src/ai/assistant.js");

const actor = {
  id: "grounded-search-test-actor",
  role: "AGENT",
  canViewAllClients: false,
  canViewPhone: false,
  canViewReports: false,
  canViewFinance: false,
  canViewAllDeals: false,
};

let savedToggle: boolean;

beforeAll(async () => {
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  savedToggle = settings.groundedSearchEnabled;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { groundedSearchEnabled: savedToggle } });
  await prisma.$disconnect();
});

function resetMocks() {
  resolveGeminiKey.mockReset().mockResolvedValue("fake-gemini-key");
  callGemini.mockReset();
  callGeminiTools.mockReset();
  callGeminiGrounded.mockReset();
}

describe("тумблер Settings.groundedSearchEnabled — выключен по умолчанию", () => {
  it("REFERENCE_REAL_ESTATE при выключенном тумблере — прежний отказ, Gemini для поиска не зовём", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { groundedSearchEnabled: false } });
    resetMocks();
    callGemini.mockResolvedValue({ tier: "REFERENCE_REAL_ESTATE" });

    const reply = await runAssistant(
      [{ role: "user", content: "Какой налог при продаже квартиры в Таджикистане?" }],
      actor
    );

    expect(reply).toBe(OFF_TOPIC_REPLY);
    expect(callGeminiGrounded).not.toHaveBeenCalled();
  });
});

describe("тумблер Settings.groundedSearchEnabled — включён", () => {
  it("ответ идёт через callGeminiGrounded и включает источники", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { groundedSearchEnabled: true } });
    resetMocks();
    const question = "Какой налог при продаже квартиры в Таджикистане?";
    callGemini.mockResolvedValue({ tier: "REFERENCE_REAL_ESTATE" });
    callGeminiGrounded.mockResolvedValue({
      text: "Налог на прирост стоимости при продаже физлицом — 0%, если недвижимость в собственности более года.",
      sources: [{ url: "https://andoz.tj/nalog-na-nedvizhimost", title: "Налоговый комитет РТ" }],
    });

    const reply = await runAssistant([{ role: "user", content: question }], actor);

    expect(callGeminiGrounded).toHaveBeenCalledTimes(1);
    expect(callGeminiGrounded).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "fake-gemini-key", query: question })
    );
    expect(reply).toContain("Налог на прирост стоимости");
    expect(reply).toContain("Источники:");
    expect(reply).toContain("https://andoz.tj/nalog-na-nedvizhimost");
    expect(reply).toContain("Налоговый комитет РТ");
  });

  it("Gemini не ответил (grounded вернул null) — общий отказ ассистента, а не текст-заглушка", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { groundedSearchEnabled: true } });
    resetMocks();
    callGemini.mockResolvedValue({ tier: "REFERENCE_REAL_ESTATE" });
    callGeminiGrounded.mockResolvedValue(null);

    const reply = await runAssistant(
      [{ role: "user", content: "Какая сейчас средняя цена квадратного метра в Душанбе?" }],
      actor
    );

    expect(reply).toBeNull();
  });

  it("ответ без источников — явная пометка об этом, а не текст неотличимый от обычного ответа", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { groundedSearchEnabled: true } });
    resetMocks();
    callGemini.mockResolvedValue({ tier: "REFERENCE_REAL_ESTATE" });
    callGeminiGrounded.mockResolvedValue({ text: "Общий ответ без обращения к поиску.", sources: [] });

    const reply = await runAssistant([{ role: "user", content: "Что такое ипотека?" }], actor);

    expect(reply).toContain("Общий ответ без обращения к поиску.");
    expect(reply).toContain("Источники не приложены");
  });
});

describe("классификатор REFERENCE_REAL_ESTATE не расширяет OFF_TOPIC на всё подряд", () => {
  it("погода остаётся OFF_TOPIC_REPLY даже при включённом тумблере — grounded-поиск не зовём", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { groundedSearchEnabled: true } });
    resetMocks();
    callGemini.mockResolvedValue({ tier: "OFF_TOPIC" });

    const reply = await runAssistant([{ role: "user", content: "Какая погода в Душанбе?" }], actor);

    expect(reply).toBe(OFF_TOPIC_REPLY);
    expect(callGeminiGrounded).not.toHaveBeenCalled();
  });
});
