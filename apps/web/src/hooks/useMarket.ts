import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { MarketEstimate, MarketPropertyEstimate } from "../types";

export interface MarketEstimateParams {
  districtName?: string | null;
  rooms?: number | null;
  areaSqm?: number | null;
  /** Цена/бюджет для сравнения "дорого/дёшево", уже в сомони. */
  priceTjs?: number | null;
}

/**
 * Рыночная оценка по аналогам (GET /market/estimate) — карточка клиента
 * ("что он может себе позволить") и карточка объекта ("дорого/в рынке/дёшево").
 * Запрос идёт только когда есть район — без него estimateFromComps не сузит
 * выборку и вернёт мусор ступенью "city_rooms" по всему городу.
 */
export function useMarketEstimate(params: MarketEstimateParams) {
  const districtName = params.districtName ?? undefined;
  const rooms = params.rooms ?? undefined;
  const areaSqm = params.areaSqm ?? undefined;
  const priceTjs = params.priceTjs ?? undefined;

  const search = new URLSearchParams();
  if (districtName) search.set("districtName", districtName);
  if (rooms) search.set("rooms", String(rooms));
  if (areaSqm) search.set("areaSqm", String(areaSqm));
  if (priceTjs) search.set("priceTjs", String(Math.round(priceTjs)));

  return useQuery({
    queryKey: ["market-estimate", districtName, rooms, areaSqm, priceTjs],
    queryFn: () => api<MarketEstimate>(`/market/estimate?${search.toString()}`),
    enabled: !!districtName,
    staleTime: 5 * 60_000,
  });
}

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
