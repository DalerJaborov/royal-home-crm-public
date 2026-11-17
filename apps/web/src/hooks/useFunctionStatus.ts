import { useQuery } from "@tanstack/react-query";
import type { FunctionStatusResponse } from "@royal-home/shared";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/** «Состояние функций» (только директор и администратор): GET /function-status. */
export function useFunctionStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["function-status"],
    queryFn: () => api<FunctionStatusResponse>("/function-status"),
    enabled,
    refetchInterval: SAFETY_REFETCH_MS,
  });
}
