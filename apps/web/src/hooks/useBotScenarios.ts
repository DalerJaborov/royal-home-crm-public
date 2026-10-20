import { useQuery } from "@tanstack/react-query";
import type { ScenarioComparisonResponse, ScenarioVerdict } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Сравнение манер продажи бота. Данные закрыты правом settings.view — хук годится
 * только для экрана Настроек.
 */

/**
 * Форма ответа описана один раз — в @royal-home/shared, её же держится сервер.
 * Пока стороны описывали её порознь, копии успели разойтись: поле
 * `minConversationsPerScenario` знал только экран, а серверный тип о нём не
 * подозревал, хотя маршрут его и добавляет.
 */
export type {
  ScenarioStats,
  ScenarioVerdict,
  ScenarioComparisonResponse as ScenarioComparison,
} from "@royal-home/shared";

export function useBotScenarios() {
  return useQuery({
    queryKey: ["bot-scenarios"],
    queryFn: () => api<ScenarioComparisonResponse>("/bot-scenarios"),
  });
}

