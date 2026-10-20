import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Interaction } from "../types";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export function useCalendarTasks(range?: { from: string; to: string }) {
  const qs = range ? `?from=${range.from}&to=${range.to}` : "";
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["calendar-tasks", range],
    queryFn: () => api<Interaction[]>(`/calendar/tasks${qs}`),
  });
}

export function useCompleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (interactionId: string) => api(`/interactions/${interactionId}/complete`, { method: "PATCH" }),
    onSuccess: () => invalidateTaskViews(qc),
  });
}

/**
 * Отменить и перенести показ руками — то же, что до этого умел только бот.
 *
 * Оба действия меняют не только календарь: показ уходит (или переезжает) в
 * карточке клиента, в цифрах дашборда и в отчётах, — поэтому сбрасываем все
 * представления разом, а не один список задач.
 */
/** Причина обязательна на сервере (владелец 16.08.2026) — Zod отклонит запрос без
 *  неё, здесь только форма параметров мутации. */
export function useCancelShowing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ interactionId, reason }: { interactionId: string; reason: string }) =>
      api(`/interactions/${interactionId}/showing/cancel`, { method: "PATCH", body: { reason } }),
    onSuccess: () => invalidateTaskViews(qc),
  });
}

export function useRescheduleShowing() {
  const qc = useQueryClient();
  return useMutation({
    // at — момент времени в ISO: сервер живёт в UTC, и отправлять «как на часах
    // агента» нельзя, иначе встреча уедет на пять часов (Душанбе UTC+5).
    mutationFn: ({ interactionId, at, reason }: { interactionId: string; at: string; reason: string }) =>
      api(`/interactions/${interactionId}/showing/reschedule`, { method: "PATCH", body: { at, reason } }),
    onSuccess: () => invalidateTaskViews(qc),
  });
}

function invalidateTaskViews(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["calendar-tasks"] });
  qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
  qc.invalidateQueries({ queryKey: ["client"] });
}
