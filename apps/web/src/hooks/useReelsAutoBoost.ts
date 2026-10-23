import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReelsAutoBoostOverview, ReelsAutoBoostSettingsPatch } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Автопродвижение роликов (api: routes/adsReelsAutoBoost.ts). Всё считает сервер,
 * здесь только доставка. Читать может тот, кто видит рекламу, менять — кто её пишет
 * (useCanWriteAds): те же права, что у остальных рекламных ручек.
 */
const KEY = ["ads", "reels-autoboost"] as const;

export function useReelsAutoBoost(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<ReelsAutoBoostOverview>("/ads/reels-autoboost"),
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdateReelsAutoBoost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ReelsAutoBoostSettingsPatch) =>
      api<ReelsAutoBoostOverview>("/ads/reels-autoboost", { method: "PATCH", body: patch }),
    onSuccess: (overview) => qc.setQueryData(KEY, overview),
  });
}

export interface ReelsAutoBoostRunResult {
  ran: boolean;
  note: string | null;
  created: number;
  paused: number;
  kept: number;
  failed: number;
}

/** «Проверить сейчас» — внеплановый проход (в пробном режиме в Meta ничего не уходит). */
export function useRunReelsAutoBoost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ result: ReelsAutoBoostRunResult; overview: ReelsAutoBoostOverview }>("/ads/reels-autoboost/run", {
        method: "POST",
        body: {},
      }),
    onSuccess: (data) => qc.setQueryData(KEY, data.overview),
  });
}
