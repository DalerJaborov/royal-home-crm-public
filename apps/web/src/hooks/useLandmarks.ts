import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Landmark, LandmarkAlias, Paginated } from "../types";
import type { LandmarkUpdateInput } from "@royal-home/shared";

/**
 * Справочник ориентиров ведут агенты (12.09.2026, docs/geo-match-plan-12-09.md,
 * блок J). Устройство — по образцу useDistricts.ts, но со своим фильтром (поиск
 * по названию/синонимам, категория, показ скрытых) и отдельными действиями для
 * скрытия/возврата/удаления и синонимов.
 */
export interface LandmarkFilters {
  q?: string;
  category?: string;
  showHidden?: boolean;
  page?: number;
  pageSize?: number;
}

function toQuery(filters: LandmarkFilters) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.category) params.set("category", filters.category);
  if (filters.showHidden) params.set("showHidden", "1");
  if (filters.page) params.set("page", String(filters.page));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useLandmarks(filters: LandmarkFilters = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["landmarks", filters],
    // enabled по умолчанию true (обычное поведение react-query) — параметр нужен
    // только вызывающим, которые сами решают, когда список вообще нужен
    // (например, подсказка ориентира в мастере объекта — StepPlace.tsx —
    // не должна дёргать /landmarks, пока поле не в фокусе и текст короче двух букв).
    enabled: options.enabled ?? true,
    queryFn: () => api<Paginated<Landmark>>(`/landmarks${toQuery(filters)}`),
  });
}

export interface LandmarkInput {
  name: string;
  category: string;
  address?: string;
  districtId?: string;
  lat: number;
  lng: number;
  radiusM?: number;
  /** 0/50/100 — «обычный»/«важный»/«очень важный». */
  weight?: 0 | 50 | 100;
  isCityCenter?: boolean;
}

function useInvalidateLandmarks() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["landmarks"] });
}

export function useCreateLandmark() {
  const invalidate = useInvalidateLandmarks();
  return useMutation({
    mutationFn: (input: LandmarkInput) => api<Landmark>("/landmarks", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateLandmark() {
  const invalidate = useInvalidateLandmarks();
  return useMutation({
    mutationFn: ({ id, ...patch }: LandmarkUpdateInput & { id: string }) =>
      api<Landmark>(`/landmarks/${id}`, { method: "PATCH", body: patch }),
    onSuccess: invalidate,
  });
}

export function useHideLandmark() {
  const invalidate = useInvalidateLandmarks();
  return useMutation({
    mutationFn: (id: string) => api<Landmark>(`/landmarks/${id}/hide`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useShowLandmark() {
  const invalidate = useInvalidateLandmarks();
  return useMutation({
    mutationFn: (id: string) => api<Landmark>(`/landmarks/${id}/show`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useDeleteLandmark() {
  const invalidate = useInvalidateLandmarks();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/landmarks/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useAddLandmarkAlias() {
  const invalidate = useInvalidateLandmarks();
  return useMutation({
    mutationFn: ({ landmarkId, text }: { landmarkId: string; text: string }) =>
      api<LandmarkAlias>(`/landmarks/${landmarkId}/aliases`, { method: "POST", body: { text } }),
    onSuccess: invalidate,
  });
}

export function useRemoveLandmarkAlias() {
  const invalidate = useInvalidateLandmarks();
  return useMutation({
    mutationFn: ({ landmarkId, aliasId }: { landmarkId: string; aliasId: string }) =>
      api<void>(`/landmarks/${landmarkId}/aliases/${aliasId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}
