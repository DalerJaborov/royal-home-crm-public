/**
 * Ссылка «Клиенты» с фильтрами светофора (workStatus=INACTIVE + inactiveLevel,
 * опционально agentId) — общая для десктопной (Oversight.tsx) и мобильной
 * (MobileOversight.tsx) матрицы «Светофор неактивных — сейчас», чтобы формат
 * ссылки не разъехался между копиями (см. Clients.tsx::trafficLightDrilldown,
 * который эти параметры читает).
 */
export function trafficLightHref(level: "RED" | "YELLOW" | "GREEN", agentId?: string): string {
  const params = new URLSearchParams({ workStatus: "INACTIVE", inactiveLevel: level });
  if (agentId) params.set("agentId", agentId);
  return `/clients?${params.toString()}`;
}
