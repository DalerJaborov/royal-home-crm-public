import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Google Search grounding (23.08.2026, пункт 4 очереди ИИ) — справочные вопросы о
 * рынке/законах/налогах/ипотеке Таджикистана, которые раньше падали в OFF_TOPIC,
 * при включённом Settings.groundedSearchEnabled получают ответ через
 * callGeminiGrounded вместо отказа.
 *
 * С 31.10.2026 (пачка П1 задача 1.3) отдельного классификатора нет: справочный
 * путь — инструмент web_reference, который объявляется модели ТОЛЬКО при
 * включённом тумблере, а отказ «не по теме» — правило системного промта. Поэтому
 * тест проверяет маршрутизацию по тому, ЧТО уходит модели (есть ли web_reference в
 * списке инструментов) и что происходит, когда модель его зовёт.
 *
 * geminiClient мокается целиком (сеть к Google в тестах не бьём — тот же приём,
 * что и в ai-assistant-tools.test.ts), ключи — подменой resolveGeminiRuntime, а
 * Settings.groundedSearchEnabled — реальная строка в базе: тумблер выключен по
 * умолчанию, и это тоже часть проверяемого поведения, а не деталь мока.
 */

const callGemini = vi.fn();
const callGeminiTools = vi.fn();
const callGeminiGrounded = vi.fn();
vi.mock("../src/ai/geminiClient.js", () => ({
  resolveGeminiKey: vi.fn(),
  callGemini,
  callGeminiTools,
  callGeminiGrounded,
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"],
    model: "gemini-test",
    fallbackModels: [],
    transcribeModels: [],
    imageModel: "unused",
    liteModel: "",
    explicitCaching: false,
  }),
}));

const { prisma } = await import("../src/db.js");
const { runAssistant, OFF_TOPIC_REPLY } = await import("../src/ai/assistant.js");
const { resetAssistantRuntimeCache } = await import("../src/ai/assistant/runtime.js");

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
  resetAssistantRuntimeCache();
  await prisma.$disconnect();
});

async function setGrounded(on: boolean) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { groundedSearchEnabled: on } });
  // Настройки помощника кэшируются на 15 с — тест переключает тумблер и сразу проверяет.
  resetAssistantRuntimeCache();
  callGemini.mockReset();
  callGeminiTools.mockReset();
  callGeminiGrounded.mockReset();
}

/** Ход модели, просящий справочный поиск. */
function referenceTurn(query: string) {
  const call = { name: "web_reference", args: { query } };
  return { text: "", calls: [call], modelParts: [{ functionCall: call }], tokens: 7 };
}

function declaredToolNames(): string[] {
  const params = callGeminiTools.mock.calls[0][0] as { tools: { name: string }[] };
  return params.tools.map((t) => t.name);
}

describe("классификатора нет — на вопрос один вызов модели", () => {
  it("ответ модели идёт сразу, отдельного вызова-классификатора (callGemini) нет", async () => {
    await setGrounded(false);
    callGeminiTools.mockResolvedValue({ text: "Готово.", calls: [], modelParts: [{ text: "Готово." }], tokens: 3 });

    const reply = await runAssistant([{ role: "user", content: "Сколько у меня клиентов?" }], actor);

    expect(reply).toBe("Готово.");
    expect(callGemini).not.toHaveBeenCalled();
    expect(callGeminiTools).toHaveBeenCalledTimes(1);
  });
});

describe("тумблер Settings.groundedSearchEnabled — выключен по умолчанию", () => {
  it("web_reference модели не объявляется — справочный вопрос получает прежний отказ, поиск не зовём", async () => {
    await setGrounded(false);
    // Правило промта: без web_reference справочный вопрос — «не по работе в CRM».
    callGeminiTools.mockResolvedValue({ text: OFF_TOPIC_REPLY, calls: [], modelParts: [{ text: OFF_TOPIC_REPLY }], tokens: 3 });

    const reply = await runAssistant(
      [{ role: "user", content: "Какой налог при продаже квартиры в Таджикистане?" }],
      actor
    );

    expect(declaredToolNames()).not.toContain("web_reference");
    expect(reply).toBe(OFF_TOPIC_REPLY);
    expect(callGeminiGrounded).not.toHaveBeenCalled();
  });

  it("модель выдумала web_reference при выключенном тумблере — отказ без похода в поиск", async () => {
    await setGrounded(false);
    callGeminiTools.mockResolvedValue(referenceTurn("налог при продаже квартиры"));

    const reply = await runAssistant([{ role: "user", content: "Какой налог при продаже квартиры?" }], actor);

    expect(reply).toBe(OFF_TOPIC_REPLY);
    expect(callGeminiGrounded).not.toHaveBeenCalled();
  });
});

describe("тумблер Settings.groundedSearchEnabled — включён", () => {
  it("web_reference объявлен, ответ идёт через callGeminiGrounded и включает источники — без ещё одного раунда", async () => {
    await setGrounded(true);
    const question = "Какой налог при продаже квартиры в Таджикистане?";
    callGeminiTools.mockResolvedValue(referenceTurn(question));
    callGeminiGrounded.mockResolvedValue({
      text: "Налог на прирост стоимости при продаже физлицом — 0%, если недвижимость в собственности более года.",
      sources: [{ url: "https://andoz.tj/nalog-na-nedvizhimost", title: "Налоговый комитет РТ" }],
    });

    const reply = await runAssistant([{ role: "user", content: question }], actor);

    expect(declaredToolNames()).toContain("web_reference");
    expect(callGeminiTools).toHaveBeenCalledTimes(1);
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
    await setGrounded(true);
    callGeminiTools.mockResolvedValue(referenceTurn("средняя цена квадратного метра в Душанбе"));
    callGeminiGrounded.mockResolvedValue(null);

    const reply = await runAssistant(
      [{ role: "user", content: "Какая сейчас средняя цена квадратного метра в Душанбе?" }],
      actor
    );

    expect(reply).toBeNull();
  });

  it("ответ без источников — явная пометка об этом, а не текст неотличимый от обычного ответа", async () => {
    await setGrounded(true);
    callGeminiTools.mockResolvedValue(referenceTurn("Что такое ипотека?"));
    callGeminiGrounded.mockResolvedValue({ text: "Общий ответ без обращения к поиску.", sources: [] });

    const reply = await runAssistant([{ role: "user", content: "Что такое ипотека?" }], actor);

    expect(reply).toContain("Общий ответ без обращения к поиску.");
    expect(reply).toContain("Источники не приложены");
  });
});

describe("справочный путь не расширяет отказ «не по теме» на всё подряд", () => {
  it("погода остаётся OFF_TOPIC_REPLY даже при включённом тумблере — grounded-поиск не зовём", async () => {
    await setGrounded(true);
    callGeminiTools.mockResolvedValue({ text: OFF_TOPIC_REPLY, calls: [], modelParts: [{ text: OFF_TOPIC_REPLY }], tokens: 3 });

    const reply = await runAssistant([{ role: "user", content: "Какая погода в Душанбе?" }], actor);

    expect(reply).toBe(OFF_TOPIC_REPLY);
    expect(callGeminiGrounded).not.toHaveBeenCalled();
  });

  it("правило «не по теме» и текст отказа — в системном промте, раз классификатора больше нет", async () => {
    await setGrounded(true);
    callGeminiTools.mockResolvedValue({ text: OFF_TOPIC_REPLY, calls: [], modelParts: [{ text: OFF_TOPIC_REPLY }], tokens: 3 });

    await runAssistant([{ role: "user", content: "Расскажи анекдот" }], actor);

    const params = callGeminiTools.mock.calls[0][0] as { system: string };
    expect(params.system).toContain(OFF_TOPIC_REPLY);
    expect(params.system).toContain("web_reference");
  });
});
