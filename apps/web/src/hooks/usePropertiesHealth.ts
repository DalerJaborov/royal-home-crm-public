import { useQueries, useQuery } from "@tanstack/react-query";
import type { PropertiesHealthResponse, PropertiesNeedsHelpResponse, PropertyHealthBrief } from "@royal-home/shared";
import { PROPERTIES_HEALTH_MAX_IDS } from "@royal-home/shared";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/**
 * Светофор объектов списком (24.09.2026): цветная точка у каждой строки
 * каталога. Один запрос на кусок ленты, а не на строку. Куски идут по порядку
 * ленты: подгрузка следующей страницы добавляет новый кусок, а уже посчитанные
 * остаются в кэше и не запрашиваются заново.
 *
 * Отказ сервера — просто нет точек: каталог работает и без них.
 */
const CHUNK = Math.min(50, PROPERTIES_HEALTH_MAX_IDS);

export function usePropertiesHealth(ids: string[]): Map<string, PropertyHealthBrief> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const results = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: ["properties-health", chunk.join(",")],
      queryFn: () =>
        api<PropertiesHealthResponse>(`/properties/health?ids=${encodeURIComponent(chunk.join(","))}`),
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });
  const out = new Map<string, PropertyHealthBrief>();
  for (const r of results) {
    if (!r.data) continue;
    for (const [id, h] of Object.entries(r.data)) out.set(id, h);
  }
  return out;
}

/** «Объекты, которым нужна помощь» в «Обзоре» маркетинга: красные первыми. */
export function usePropertiesNeedsHelp() {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["properties-needs-help"],
    queryFn: () => api<PropertiesNeedsHelpResponse>("/properties/needs-help"),
    staleTime: 10 * 60_000,
    retry: false,
  });
}
