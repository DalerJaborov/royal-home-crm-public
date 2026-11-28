import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CleanupMode, CleanupScope, CleanupTarget } from "@royal-home/shared";
import { api } from "../lib/api";

/** Параметры очистки: что чистим, насколько, у кого (scope — только для уведомлений). */
export interface CleanupParams {
  target: CleanupTarget;
  mode: CleanupMode;
  scope: CleanupScope;
}

/** Сколько строк будет удалено — для окна подтверждения (владелец 28.11.2026). Не кэшируем: число должно быть живым. */
export function useCleanupPreview(params: CleanupParams, enabled: boolean) {
  return useQuery<{ count: number }>({
    queryKey: ["cleanup-preview", params.target, params.mode, params.scope],
    queryFn: () => api(`/cleanup/preview?target=${params.target}&mode=${params.mode}&scope=${params.scope}`),
    enabled,
    gcTime: 0,
    staleTime: 0,
  });
}

/** Удаляет безвозвратно. Сервер пишет операцию в журнал действий. */
export function useRunCleanup() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean; count: number }, Error, CleanupParams>({
    mutationFn: (params) => api("/cleanup/run", { method: "POST", body: params }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}
