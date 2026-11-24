import { useQuery } from "@tanstack/react-query";
import type { BotGuardStatsResponse } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Счётчики фильтров ответа бота за 14 дней (Настройки → «Бот» → «Проверка бота»).
 * Закрыты правом settings.view — хук только для экрана Настроек. Форма ответа — в
 * @royal-home/shared, её же держится сервер.
 */
export function useBotGuardStats() {
  return useQuery({
    queryKey: ["settings", "bot-guard-stats"],
    queryFn: () => api<BotGuardStatsResponse>("/settings/bot-guard-stats"),
    staleTime: 60_000,
  });
}
