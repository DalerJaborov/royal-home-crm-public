import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MarketBuyerListingsResponse, MarketOverpricedResponse, MarketSegmentsQuery, MarketSegmentsResponse } from "@royal-home/shared";
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

/**
 * Объявления с площадок под запрос покупателя (GET /clients/:id/market-listings): отдельная секция
 * рядом с нашими объектами. Подбор и исключение «наших» считает сервер.
 */
export function useMarketBuyerListings(clientId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["client-match", clientId, "market"],
    queryFn: () => api<MarketBuyerListingsResponse>(`/clients/${clientId}/market-listings`),
    enabled: !!clientId && enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Цены по сегментам рынка (GET /market/segments): район × комнаты × ремонт; фильтры — на сервере. */
export function useMarketSegments(filters: Partial<Omit<MarketSegmentsQuery, "city">>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value != null && value !== "") params.set(key, String(value));
  const query = params.toString();
  return useQuery({
    queryKey: ["market-segments", query],
    queryFn: () => api<MarketSegmentsResponse>(`/market/segments${query ? `?${query}` : ""}`),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Наши объекты в продаже, которые просят дороже рынка (GET /market/overpriced): сравнение считает сервер. */
export function useMarketOverpriced() {
  return useQuery({
    queryKey: ["market-overpriced"],
    queryFn: () => api<MarketOverpricedResponse>("/market/overpriced"),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
