import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { MarketDynamicsData, MarketPropertyEstimate, OwnMarketMatchesData } from "../types";

/**
 * Рынок вокруг одного объекта (GET /market/property/:id): вердикт, вилка,
 * 5 самых похожих объявлений. Все признаки подбора сервер берёт из самого объекта.
 */
export function useMarketProperty(propertyId: string | null | undefined) {
  return useQuery({
    queryKey: ["market-property", propertyId],
    queryFn: () => api<MarketPropertyEstimate>(`/market/property/${propertyId}`),
    enabled: !!propertyId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Динамика рынка вокруг объекта (GET /market/property/:id/dynamics): как быстро
 * уходят похожие объявления, по какой цене, кто продаёт. Считает сервер.
 */
export function useMarketDynamics(propertyId: string | null | undefined) {
  return useQuery({
    queryKey: ["market-dynamics", propertyId],
    queryFn: () => api<MarketDynamicsData>(`/market/property/${propertyId}/dynamics`),
    enabled: !!propertyId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Наш объект на чужих площадках (GET /market/matches/property/:id): клиент мог
 * выставить его ещё и сам на Somon/Paydo. Совпадения находит сервер (cron).
 */
export function useMarketMatches(propertyId: string | null | undefined) {
  return useQuery({
    queryKey: ["market-matches", propertyId],
    queryFn: () => api<OwnMarketMatchesData>(`/market/matches/property/${propertyId}`),
    enabled: !!propertyId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Агент отвечает по совпадению: «Это наш» (CONFIRMED) или «Не наш» (DISMISSED — больше не показываем и не пушим). */
export function useSetMatchStatus(propertyId: string) {
  const qc = useQueryClient();
  return useMutation<{ id: string; status: string }, Error, { matchId: string; status: "CONFIRMED" | "DISMISSED" }>({
    mutationFn: ({ matchId, status }) =>
      api(`/market/matches/${matchId}/status`, { method: "POST", body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["market-matches", propertyId] }),
  });
}
