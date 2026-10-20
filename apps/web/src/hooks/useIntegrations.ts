import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** Экран /integrations — снимок ночной самопроверки внешних доступов
 *  (perенос мобильного макета 14.09.2026, шаг 5). Сервер: routes/integrations.ts. */
export interface IntegrationChannel {
  name: string;
  /** true — жив, false — сломан, null — не настроен. */
  ok: boolean | null;
  detail: string | null;
  checkedAt: string;
}

export function useIntegrations(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["integrations"],
    queryFn: () => api<{ channels: IntegrationChannel[] }>("/integrations"),
    // Снимок обновляется раз в сутки ночным тиком — частый опрос бессмыслен.
    refetchInterval: 300_000,
  });
}
