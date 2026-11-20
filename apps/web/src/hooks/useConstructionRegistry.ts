import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RegistryMapResponse, RegistryPropertyResponse } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Реестр разрешённых строек Душанбе (memor.pro, 20.11.2026): данные ТОЛЬКО для сотрудников,
 * роуты apps/api/src/routes/constructionRegistry.ts. Типы ответов — packages/shared.
 */
export interface RegistrySyncRun {
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  trigger: string;
  fetched: number;
  created: number;
  changed: number;
  removed: number;
  linked: number;
  error: string | null;
}

export interface RegistryStatus {
  enabled: boolean;
  notify: boolean;
  activeProjects: number;
  linkedProperties: number;
  runs: RegistrySyncRun[];
}

const propertyKey = (id: string | number) => ["construction-registry", "property", String(id)] as const;

/** Блок «Разрешение на строительство» в карточке объекта; id — короткий номер или uuid. */
export function usePropertyRegistry(id: string | number | undefined) {
  return useQuery({
    queryKey: propertyKey(id ?? ""),
    queryFn: () => api<RegistryPropertyResponse>(`/construction-registry/property/${encodeURIComponent(String(id))}`),
    enabled: id !== undefined && id !== "",
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function usePropertyMutation<V>(id: string | number, run: (vars: V) => Promise<RegistryPropertyResponse>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (fresh) => {
      qc.setQueryData(propertyKey(id), fresh);
      // Цвет на карте мог измениться.
      void qc.invalidateQueries({ queryKey: ["construction-registry", "map"] });
    },
  });
}

export function useLinkRegistryProject(id: string | number) {
  return usePropertyMutation(id, (projectId: string) =>
    api<RegistryPropertyResponse>(`/construction-registry/property/${encodeURIComponent(String(id))}/link`, { method: "POST", body: { projectId } }),
  );
}

export function useRejectRegistryProject(id: string | number) {
  return usePropertyMutation(id, (projectId: string) =>
    api<RegistryPropertyResponse>(`/construction-registry/property/${encodeURIComponent(String(id))}/reject`, { method: "POST", body: { projectId } }),
  );
}

export function useUnlinkRegistryProject(id: string | number) {
  return usePropertyMutation(id, (_: void) =>
    api<RegistryPropertyResponse>(`/construction-registry/property/${encodeURIComponent(String(id))}/link`, { method: "DELETE" }),
  );
}

/** Слой «Реестр строек» на карте; запрос идёт, только когда слой или фильтр реально нужны. */
export function useRegistryMap(enabled: boolean) {
  return useQuery({
    queryKey: ["construction-registry", "map"],
    queryFn: () => api<RegistryMapResponse>("/construction-registry/map"),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRegistryStatus() {
  return useQuery({
    queryKey: ["construction-registry", "status"],
    queryFn: () => api<RegistryStatus>("/construction-registry/status"),
    staleTime: 30_000,
  });
}

/** «Забрать сейчас»: сервер отвечает сразу, сам забор идёт минуты, итог виден в статусе. */
export function useRegistrySync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ started: boolean }>("/construction-registry/sync", { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["construction-registry", "status"] });
    },
  });
}
