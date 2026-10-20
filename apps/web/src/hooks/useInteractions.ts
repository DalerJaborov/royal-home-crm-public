import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ActivitySummary } from "@royal-home/shared";
import type { Interaction } from "../types";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export interface ActivityFilters {
  page?: number;
  agentId?: string;
  from?: string;
  to?: string;
  /** Тип действия (звонок/сообщение/показ/встреча/...) — шторка фильтров экрана. */
  type?: string;
}

interface ActivityFeed {
  items: Interaction[];
  total: number;
  page: number;
  pageSize: number;
}

function toQuery(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.page) params.set("page", String(filters.page));
  if (filters.agentId) params.set("agentId", filters.agentId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.type) params.set("type", filters.type);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Полная лента активности команды с пагинацией и фильтрами — раздел «Активность команды». */
export function useActivityFeed(filters: ActivityFilters) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["activity-feed", filters],
    queryFn: () => api<ActivityFeed>(`/interactions${toQuery(filters)}`),
  });
}

/**
 * Сводка «Активности» ЗА ПЕРИОД — числа для плиток экрана.
 *
 * Отдельный запрос от ленты намеренно: лента постраничная, и считать по ней
 * означало бы, что цифра меняется от того, докрутил ли человек список. Сервер
 * группирует по типу события одним запросом (routes/interactions.ts, /summary).
 *
 * `page` в фильтры не передаём: сводка от страницы не зависит, и попади она в
 * queryKey — каждое листание ленты перезапрашивало бы одни и те же числа.
 */
export function useActivitySummary(filters: Omit<ActivityFilters, "page">, options?: { enabled?: boolean }) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["activity-summary", filters],
    queryFn: () => api<ActivitySummary>(`/interactions/summary${toQuery(filters)}`),
    enabled: options?.enabled ?? true,
  });
}
