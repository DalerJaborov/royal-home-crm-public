import { useQuery } from "@tanstack/react-query";
import type { AgentGlance, AgentGlanceDrill, AgentGlanceDrillKey, AgentGlancePeriod } from "@royal-home/shared";
import { api } from "../lib/api";
import { usableRouteId } from "../lib/routeId";

/** Карточка сотрудника «одним взглядом»: плитки за период, график по дням, замечания (GET /agents/:id/glance). */
export function useAgentGlance(agentId: string | undefined, period: AgentGlancePeriod) {
  return useQuery({
    queryKey: ["agent-glance", agentId, period],
    queryFn: () => api<AgentGlance>(`/agents/${agentId}/glance?period=${period}`),
    enabled: !!usableRouteId(agentId),
    staleTime: 30_000,
  });
}

/** Список записей за плиткой: открывается по клику, поэтому грузится только с ключом. */
export function useAgentGlanceDrill(agentId: string | undefined, key: AgentGlanceDrillKey | null, period: AgentGlancePeriod) {
  return useQuery({
    queryKey: ["agent-glance-drill", agentId, key, period],
    queryFn: () => api<AgentGlanceDrill>(`/agents/${agentId}/glance/drill?key=${key}&period=${period}`),
    enabled: !!usableRouteId(agentId) && key !== null,
  });
}
