import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PultModuleId, PultModuleState } from "@royal-home/shared";
import { api } from "../lib/api";

/** Модули пульта директора — список и тумблер (routes/pultModules.ts). */
export function usePultModules(enabled = true) {
  return useQuery({
    queryKey: ["pult-modules"],
    queryFn: () => api<{ modules: PultModuleState[] }>("/dashboard/modules"),
    enabled,
  });
}

export function useUpdatePultModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: PultModuleId; enabled: boolean }) =>
      api<{ id: PultModuleId; enabled: boolean }>(`/dashboard/modules/${id}`, { method: "PATCH", body: { enabled } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pult-modules"] });
      // Пульт перечитывает секции сразу, не дожидаясь следующего 15-секундного опроса.
      void qc.invalidateQueries({ queryKey: ["mission-control"] });
    },
  });
}
