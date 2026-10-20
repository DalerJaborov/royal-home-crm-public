import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { keepWhilePagingIndexed } from "../lib/keepWhilePaging";
import type { Paginated } from "../types";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  agentId: string | null;
  agentName: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export function useAuditLog(page: number, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["audit-log", page],
    queryFn: () => api<Paginated<AuditLogEntry>>(`/audit-log?page=${page}`),
    placeholderData: keepWhilePagingIndexed<Paginated<AuditLogEntry>>(["audit-log", page]),
    enabled,
  });
}

/** История одного предмета (например, объекта) — «руководитель обязан видеть,
 *  кто и когда двигал карточку», а не только глобальную ленту в Архиве. */
export function useEntityAuditLog(entityType: string, entityId: string | null, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["audit-log", "entity", entityType, entityId],
    queryFn: () =>
      api<Paginated<AuditLogEntry>>(
        `/audit-log?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId!)}`
      ),
    enabled: enabled && !!entityId,
  });
}
