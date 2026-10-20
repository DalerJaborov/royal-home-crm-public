import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface PointsEntry {
  id: string;
  createdAt: string;
  agentName: string;
  meta: { points: number; reason: string; targetAgentName: string } | null;
}

export interface PointsJournal {
  total: number;
  entries: PointsEntry[];
}

/** Только чтение: ручное начисление баллов запрещено спецификацией Fair Play
 * (03.08.2026) — история старых начислений видна, новых быть не может. */
export function usePointsJournal(agentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["points", agentId],
    queryFn: () => api<PointsJournal>(`/agents/${agentId}/points`),
    enabled: enabled && !!agentId,
  });
}
