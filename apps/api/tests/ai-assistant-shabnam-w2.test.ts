import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@royal-home/shared";

/**
 * ШАБНАМ, ВОЛНА 2 (17.11.2026): ложные отказы сторожа ссылок и сбои attempt_limit — через цикл
 * помощницы целиком (модель подменена, живых вызовов Gemini нет).
 *
 *  - неподтверждённая ссылка на карточку становится текстом, ответ уходит, причина — в журнал хода;
 *  - кончился предел попыток ХОДА — честное «что успела / что не вышло», а не «лимит ИИ достигнут»;
 *  - повтор вызова, который уже отказал, считается повтором (раньше кружил до предела попыток);
 *  - инструмент отказал TOOL_FAILURE_LIMIT раз — следующий шаг только ответ.
 */

const callGeminiTools = vi.fn();
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGeminiTools,
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"], model: "gemini-test", fallbackModels: [], transcribeModels: [],
    imageModel: "unused", liteModel: "", explicitCaching: false,
  }),
}));

const { prisma } = await import("../src/db.js");
const { runAssistantDetailed, TOOL_FAILURE_LIMIT } = await import("../src/ai/assistant.js");
const { resetAssistantRuntimeCache } = await import("../src/ai/assistant/runtime.js");
const { AssistantAttemptLimitError } = await import("../src/ai/assistant/attemptLimit.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

type Actor = Parameters<typeof runAssistantDetailed>[1];
const RUN = String(Date.now()).slice(-6);
const WORD = `Шв2${RUN}`;
let agent = "";
let saved: { aiAssistantMaxRounds: number; aiAssistantEnabled: boolean };

function actor(id: string): Actor {
  const perms: PermissionId[] = [];
  return {
    id, role: "AGENT", canViewAllClients: false, canViewPhone: false, canViewReports: false,
    canViewFinance: false, canViewAllDeals: false, canAssignClients: false, canEditForeignProperties: false,
    canModerate: false, canRequestChange: false, permissions: new Set<PermissionId>(perms),
  } as Actor;
}
const textTurn = (text: string) => ({ text, calls: [], modelParts: [{ text }], tokens: 1 });
const callTurn = (name: string, args: Record<string, unknown>) => ({
  text: "", calls: [{ name, args }], modelParts: [{ functionCall: { name, args } }], tokens: 1,
});
// Метки без цифр: вопрос в журнале хода проходит маску телефона, цифры в нём могут измениться.
const turnRow = (marker: string) =>
  waitFor(() => prisma.aiAssistantTurnLog.findFirst({ where: { agentId: agent, question: { contains: marker } }, orderBy: { createdAt: "desc" } }));

beforeAll(async () => {
  agent = await createTestAgent(`Агент волны 2 ${WORD}`);
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = { aiAssistantMaxRounds: settings.aiAssistantMaxRounds, aiAssistantEnabled: settings.aiAssistantEnabled };
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true, aiAssistantMaxRounds: 30 } });
  resetAssistantRuntimeCache();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  resetAssistantRuntimeCache();
  await deleteAgentsWithTraces([agent]);
  await prisma.$disconnect();
});

describe("сторож ссылок: три живые фразы прода больше не дают отказ на весь ответ", () => {
  it("«изменить цену, объект 164…»: ссылка из слов человека — текстом, ответ уходит", async () => {
    callGeminiTools.mockReset();
    callGeminiTools.mockResolvedValueOnce(textTurn("Подготовила заявку: [ОБ-000164](/properties/164), новая цена 1 350 000 сомони. Подтвердите."));
    const outcome = await runAssistantDetailed([{ role: "user", content: `изменить цену, объект 164, новая цена 1 350 000 сомони метка-альфа` }], actor(agent));
    expect(outcome).toEqual({ ok: true, reply: "Подготовила заявку: ОБ-000164, новая цена 1 350 000 сомони. Подтвердите." });
    expect(await turnRow(`метка-альфа`)).toMatchObject({ outcome: "answer", reason: "card_link_unverified" });
  });

  it("«Покажи 2-комнатные до 400 000 с.»: ссылка на список с фильтрами проходит как есть", async () => {
    callGeminiTools.mockReset();
    const reply = "Подходящих 2-комнатных до 400 000 с. сейчас нет. Весь список: [Объекты](/properties?rooms=2&maxPrice=400000).";
    callGeminiTools.mockResolvedValueOnce(textTurn(reply));
    const outcome = await runAssistantDetailed([{ role: "user", content: `Покажи 2-комнатные до 400 000 с. метка-бета` }], actor(agent));
    expect(outcome).toEqual({ ok: true, reply });
    expect(await turnRow(`метка-бета`)).toMatchObject({ outcome: "answer", reason: null });
  });

  it("«если файл отправлю, сможешь загрузить?» без инструментов: [Новый объект](/properties/new) проходит", async () => {
    callGeminiTools.mockReset();
    const reply = "Пришлите файл сюда — разберу. Или откройте [Новый объект](/properties/new).";
    callGeminiTools.mockResolvedValueOnce(textTurn(reply));
    const outcome = await runAssistantDetailed([{ role: "user", content: `если файл отправлю, сможешь загрузить и выпустить метка-гамма` }], actor(agent));
    expect(outcome).toEqual({ ok: true, reply });
  });
});

describe("предел попыток и круги по отказам", () => {
  it("кончились попытки ХОДА — честная остановка, а не «лимит ИИ достигнут»", async () => {
    callGeminiTools.mockReset();
    callGeminiTools.mockRejectedValueOnce(new AssistantAttemptLimitError("attempt_cap"));
    const outcome = await runAssistantDetailed([{ role: "user", content: `закрой право метка-дельта` }], actor(agent));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reply).toMatch(/^Не успела закончить/u);
    expect(outcome.reply).not.toContain("Лимит вызовов");
    expect(outcome.reply).not.toMatch(/Сузьте/u);
    expect(await turnRow(`метка-дельта`)).toMatchObject({ outcome: "partial", reason: "attempt_cap" });
  });

  // Сведено с #316 (22.11.2026): дневной счётчик — своя причина и свой текст (limitText.ts), не честная остановка.
  it("дневной предел вызовов (reason «attempts_daily») — по-прежнему отказ, код daily_limit", async () => {
    callGeminiTools.mockReset();
    callGeminiTools.mockRejectedValueOnce(new AssistantAttemptLimitError("attempts_daily"));
    const outcome = await runAssistantDetailed([{ role: "user", content: `проверка бюджета метка-эпсилон` }], actor(agent));
    expect(outcome).toEqual({ ok: false, code: "daily_limit", retryable: false });
  });

  it("тот же отказавший вызов по кругу: исполняется, но считается повтором — «loop» на третьем шаге", async () => {
    callGeminiTools.mockReset();
    const args = { districtName: `Нет района ${WORD}` };
    callGeminiTools.mockImplementation(async () => callTurn("search_properties", args));
    const outcome = await runAssistantDetailed([{ role: "user", content: `найди в районе метка-дзета` }], actor(agent));
    expect(callGeminiTools).toHaveBeenCalledTimes(3);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reply).toContain("Не получилось: Района");
    expect(await turnRow(`метка-дзета`)).toMatchObject({ outcome: "partial", reason: "loop", rounds: 3 });
  });

  it(`инструмент отказал ${TOOL_FAILURE_LIMIT} раза с разными аргументами — следующий шаг только ответ`, async () => {
    callGeminiTools.mockReset();
    let n = 0;
    callGeminiTools.mockImplementation(async () => {
      n += 1;
      return n <= TOOL_FAILURE_LIMIT ? callTurn("search_properties", { districtName: `Нет ${WORD} ${n}` }) : textTurn("Такого района не нашла, уточните название.");
    });
    const outcome = await runAssistantDetailed([{ role: "user", content: `район метка-эта` }], actor(agent));
    expect(callGeminiTools).toHaveBeenCalledTimes(TOOL_FAILURE_LIMIT + 1);
    const last = callGeminiTools.mock.calls[TOOL_FAILURE_LIMIT][0] as { system: string };
    expect(last.system).toContain("Инструмент несколько раз вернул отказ");
    expect(outcome).toEqual({ ok: true, reply: "Такого района не нашла, уточните название." });
  });

  it("на шаге «только ответ» модель опять зовёт инструмент — честная остановка «tool_failures»", async () => {
    callGeminiTools.mockReset();
    let n = 0;
    callGeminiTools.mockImplementation(async () => {
      n += 1;
      return callTurn("search_properties", { districtName: `Нет ${WORD} ${n} h` });
    });
    const outcome = await runAssistantDetailed([{ role: "user", content: `район метка-тета` }], actor(agent));
    expect(callGeminiTools).toHaveBeenCalledTimes(TOOL_FAILURE_LIMIT + 1);
    expect(outcome.ok).toBe(true);
    expect(await turnRow(`метка-тета`)).toMatchObject({ outcome: "partial", reason: "tool_failures" });
  });
});
