import { useQuery } from "@tanstack/react-query";
import type { DirectorDashboardQuery, DirectorDashboardResponse, DirectorDrillKey, DirectorDrillResponse } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * ДАШБОРД РУКОВОДИТЕЛЯ — запросы (GET /reports/director, /director/drill, /director/export.xlsx).
 * Один набор фильтров на сводку, список за цифрой и выгрузку: цифра плитки и её список
 * считаются одним и тем же периодом (критерий приёмки ТЗ №1).
 */

/** Автообновление сводки: раз в 90 секунд, пока вкладка видна (ТЗ №13: частота обновления названа явно). */
export const DIRECTOR_REFRESH_MS = 90_000;

export type DirectorFilters = Pick<DirectorDashboardQuery, "preset" | "from" | "to" | "agentId" | "source" | "kind">;

export function directorQueryString(filters: DirectorFilters, extra?: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  qs.set("preset", filters.preset);
  if (filters.preset === "custom") {
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
  }
  if (filters.agentId) qs.set("agentId", filters.agentId);
  if (filters.source) qs.set("source", filters.source);
  if (filters.kind) qs.set("kind", filters.kind);
  for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined) qs.set(k, String(v));
  return qs.toString();
}

export function useDirectorDashboard(filters: DirectorFilters, enabled: boolean) {
  return useQuery({
    queryKey: ["director-dashboard", filters],
    queryFn: () => api<DirectorDashboardResponse>(`/reports/director?${directorQueryString(filters)}`),
    enabled,
    refetchInterval: DIRECTOR_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    // Смена периода не должна гасить экран в серые плашки: прежние цифры остаются, пока едут новые.
    placeholderData: (prev) => prev,
  });
}

export const DRILL_PAGE = 50;

export function useDirectorDrill(filters: DirectorFilters, key: DirectorDrillKey | null, offset: number) {
  return useQuery({
    queryKey: ["director-drill", filters, key, offset],
    queryFn: () => api<DirectorDrillResponse>(`/reports/director/drill?${directorQueryString(filters, { key: key ?? undefined, limit: DRILL_PAGE, offset })}`),
    enabled: key !== null,
    refetchInterval: false as const,
    staleTime: 30_000,
  });
}

/** Excel с теми же фильтрами и периодом, что на экране. */
export async function downloadDirectorExport(filters: DirectorFilters): Promise<void> {
  const blob = await api<Blob>(`/reports/director/export.xlsx?${directorQueryString(filters)}`, { responseType: "blob", timeoutMs: 60_000 });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `director-dashboard-${filters.preset}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
