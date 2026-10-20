import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Тесты ИИ-судьи для кейсов «Инсайты от ИИ» (аудит 02.09.2026 §4.2).
 *
 * callAiText мокается — реальных вызовов Gemini нет. Проверяем:
 * - judgeCase возвращает корректную структуру для негативного и позитивного кейса
 * - judgeCase возвращает null при ошибке API
 * - checkDailyBudget возвращает true когда лимит не установлен
 * - generateVerdicts пропускает кейсы при превышении бюджета
 */

// Мокаем callAiText ДО импорта модуля под тестом.
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: vi.fn(),
}));

// Мокаем logSystemError чтобы не писать в БД во время тестов.
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));

// Мокаем Prisma — фабрика внутри vi.mock не может ссылаться на внешние
// переменные (hoisting), поэтому создаём мок прямо внутри фабрики и
// экспортируем его через отдельный модуль-посредник.
vi.mock("../src/db.js", () => {
  const mock = {
    settings: { findUnique: vi.fn() },
    aiLog: { aggregate: vi.fn() },
    insightCase: { update: vi.fn() },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { prisma: mock };
});

import { judgeCase, checkDailyBudget, generateVerdicts } from "../src/lib/insightJudge.js";
import { callAiText } from "../src/ai/client.js";
import { prisma } from "../src/db.js";

const mockedCallAiText = vi.mocked(callAiText);
const mockPrisma = vi.mocked(prisma);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("judgeCase", () => {
  it("возвращает корректную структуру для негативного кейса", async () => {
    const expected = {
      wrong: [{ quote: "Я не знаю", why: "Агент обязан знать базу объектов" }],
      better: ["Сказать: давайте подберу подходящий вариант"],
      summary: "Агент показал незнание продукта.",
    };
    mockedCallAiText.mockResolvedValue(expected);

    const result = await judgeCase({
      id: "case-1",
      kind: "call_low_score",
      severity: 3,
      timeline: [{ role: "agent", text: "Я не знаю" }],
      verdict: null,
    });

    expect(result).not.toBeNull();
    expect(result!.wrong).toHaveLength(1);
    expect(result!.wrong[0].quote).toBe("Я не знаю");
    expect(result!.better).toHaveLength(1);
    expect(result!.summary).toBe("Агент показал незнание продукта.");
    expect(mockedCallAiText).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "insight-case", effort: "low", maxTokens: 700 }),
    );
  });

  it("возвращает позитивный разбор для kind=positive", async () => {
    const expected = {
      wrong: [],
      better: ["Масштабировать технику приветствия на всю команду"],
      summary: "Отличное первое впечатление.",
    };
    mockedCallAiText.mockResolvedValue(expected);

    const result = await judgeCase({
      id: "case-pos",
      kind: "positive",
      severity: 1,
      timeline: [{ role: "agent", text: "Добрый день! Рад помочь" }],
      verdict: null,
    });

    expect(result).not.toBeNull();
    expect(result!.wrong).toHaveLength(0);
    expect(result!.better).toContain("Масштабировать технику приветствия на всю команду");
    // Промт для positive должен отличаться от негативного.
    const callArgs = mockedCallAiText.mock.calls[0][0];
    expect(callArgs.system).toContain("ПОЛОЖИТЕЛЬНЫЙ");
  });

  it("возвращает null при ошибке API (callAiText вернул null)", async () => {
    mockedCallAiText.mockResolvedValue(null);

    const result = await judgeCase({
      id: "case-err",
      kind: "complaint",
      severity: 5,
      timeline: [],
      verdict: null,
    });

    expect(result).toBeNull();
  });

  it("возвращает null при выбросе исключения", async () => {
    mockedCallAiText.mockRejectedValue(new Error("network timeout"));

    const result = await judgeCase({
      id: "case-throw",
      kind: "agent_bypass",
      severity: 4,
      timeline: [],
      verdict: null,
    });

    expect(result).toBeNull();
  });

  it("возвращает null если модель вернула невалидную структуру", async () => {
    // summary отсутствует — валидация должна отклонить.
    mockedCallAiText.mockResolvedValue({ wrong: [], better: [] } as never);

    const result = await judgeCase({
      id: "case-bad",
      kind: "score_penalty",
      severity: 2,
      timeline: [],
      verdict: null,
    });

    expect(result).toBeNull();
  });
});

describe("checkDailyBudget", () => {
  it("возвращает true когда лимит не установлен (null)", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ aiDailyCostCapUsd: null });

    const result = await checkDailyBudget();

    expect(result).toBe(true);
    // AiLog.aggregate не должен вызываться если лимита нет.
    expect(mockPrisma.aiLog.aggregate).not.toHaveBeenCalled();
  });

  it("возвращает true когда расходы ниже потолка", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ aiDailyCostCapUsd: 5.0 });
    mockPrisma.aiLog.aggregate.mockResolvedValue({ _sum: { costUsd: 2.5 } });

    const result = await checkDailyBudget();

    expect(result).toBe(true);
  });

  it("возвращает false когда расходы превышают потолок", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ aiDailyCostCapUsd: 5.0 });
    mockPrisma.aiLog.aggregate.mockResolvedValue({ _sum: { costUsd: 6.0 } });

    const result = await checkDailyBudget();

    expect(result).toBe(false);
  });

  it("возвращает true при отсутствии AiLog за сегодня (costUsd = null)", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ aiDailyCostCapUsd: 10.0 });
    mockPrisma.aiLog.aggregate.mockResolvedValue({ _sum: { costUsd: null } });

    const result = await checkDailyBudget();

    expect(result).toBe(true);
  });
});

describe("generateVerdicts", () => {
  it("пропускает кейсы при превышении бюджета", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ aiDailyCostCapUsd: 1.0 });
    mockPrisma.aiLog.aggregate.mockResolvedValue({ _sum: { costUsd: 2.0 } });

    const cases = [
      { id: "c1", kind: "complaint", severity: 5, timeline: [], verdict: null },
      { id: "c2", kind: "call_low_score", severity: 3, timeline: [], verdict: null },
    ];

    await generateVerdicts(cases);

    // judgeCase (callAiText) не должен вызываться — бюджет превышен.
    expect(mockedCallAiText).not.toHaveBeenCalled();
    expect(mockPrisma.insightCase.update).not.toHaveBeenCalled();
  });

  it("обрабатывает кейсы без вердикта и обновляет БД", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ aiDailyCostCapUsd: null });
    const verdict = {
      wrong: [{ quote: "Не знаю", why: "Плохо" }],
      better: ["Учиться"],
      summary: "Резюме",
    };
    mockedCallAiText.mockResolvedValue(verdict);
    mockPrisma.insightCase.update.mockResolvedValue({});

    const cases = [
      { id: "c1", kind: "complaint", severity: 5, timeline: [], verdict: null },
      // Этот уже с вердиктом — должен быть пропущен.
      { id: "c2", kind: "positive", severity: 1, timeline: [], verdict: { summary: "ok" } },
    ];

    await generateVerdicts(cases);

    expect(mockedCallAiText).toHaveBeenCalledTimes(1);
    expect(mockPrisma.insightCase.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.insightCase.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" } }),
    );
  });
});