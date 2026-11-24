import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BotGuardStatsResponse } from "@royal-home/shared";

/**
 * Счётчики фильтров с удалённого экрана «Обучение бота» живут в Настройки → «Бот» →
 * «Проверка бота» (23.11.2026): доля отброшенного у нового помощника видна, сбой
 * загрузки не выглядит как «всё спокойно».
 */
const state = vi.hoisted(() => ({ query: { data: undefined, isLoading: false, isError: false, refetch: () => {} } as Record<string, unknown> }));
vi.mock("../../../hooks/useBotGuardStats", () => ({ useBotGuardStats: () => state.query }));

const { BotGuardStatsBody } = await import("../BotGuardStatsSection");

const data: BotGuardStatsResponse = {
  days: 14,
  say: { total: 4, dropped: 0, sharePercent: 0, intentional: 9, reasons: [] },
  answer: { total: 8, dropped: 2, sharePercent: 25, intentional: 30, reasons: [{ reason: "claim", count: 2 }], factAttempts: 2 },
  filters: [
    { guard: "bot_repeat", label: "Дословный повтор реплики бота", count: 7 },
    { guard: "repeat_greeting", label: "Повторное приветствие", count: 5 },
  ],
};

describe("«Фильтры ответов бота» в Настройках", () => {
  it("доля нового помощника, не в счёт — рядом, полосы фильтров с подписями", () => {
    state.query = { data, isLoading: false, isError: false, refetch: () => {} };
    const html = renderToString(<BotGuardStatsBody />).replace(/<!-- -->/g, "");
    expect(html).toContain("Новый помощник, ответ модели: отброшено 25% (2 из 8)");
    expect(html).toContain("Модель сама написала факт: 2");
    expect(html).toContain("Не в счёт, выключено намеренно: 30");
    expect(html).toContain("quiet warn");
    expect(html).toContain("Дословный повтор реплики бота");
    expect(html).toContain("Повторное приветствие");
  });

  it("сбой загрузки — честная ошибка с повтором, а не «фильтры молчат»", () => {
    state.query = { data: undefined, isLoading: false, isError: true, refetch: () => {} };
    const html = renderToString(<BotGuardStatsBody />).replace(/<!-- -->/g, "");
    expect(html).toContain("Счётчики не загрузились");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("ни один фильтр не сработал");
  });
});
